/**
 * One-shot, post-ready journal maintenance child.
 *
 * Every write transaction is row/byte bounded. The child first advances crash-resumable projections,
 * then independently verifies a recent local snapshot before it may delete even one superseded row.
 * Lifecycle evidence is global journal audit, not a fabricated per-chat model-compaction event.
 */
import path from 'node:path'
import {
  isTransientSqliteContention,
  Journal,
  JOURNAL_SQLITE_TARGET_BYTES,
  TransientHistoryIndexingError,
  type JournalCondenseResult,
} from './journal.js'
import { verifyRecentCompactionSnapshot } from './journalCompactionGate.js'
import {
  JOURNAL_BACKUP_KEEP_DEFAULT,
  JOURNAL_BACKUP_MAX_RETAINED_BYTES_DEFAULT,
  pruneJournalBackupGenerations,
} from './journalBackup.js'
import {
  newestStrongRecoverySnapshotClaim,
  pruneRecoveryGenerations,
  verifyStrongRecoverySnapshotCoverage,
} from './journalRecovery.js'
import { reserveReplicationPruneGate } from './journalReplication.js'
import { SCHEMA_VERSION } from './restartHandshake.js'

type MaintenanceMessage =
  | {
      type: 'journal-condensed'
      operationId: string
      result: JournalCondenseResult
    }
  | {
      type: 'journal-condense-deferred'
      operationId: string
      reason: string
    }
  | { type: 'journal-condense-error'; operationId: string; error: string }

const [
  file,
  backupDirectory,
  operationId,
  graceRaw,
  commandLimitRaw,
  agentMessageLimitRaw,
  diffLimitRaw,
  byteLimitRaw,
  workBudgetRaw,
  sqliteTargetBytesRaw,
  snapshotKeepRaw,
  snapshotMaxBytesRaw,
] = process.argv.slice(2)

const PROJECTION_BATCH_ROWS = 5_000
const PROJECTION_PROGRESS_ROWS = 50_000
const DELETE_PROGRESS_BATCHES = 10
const MAINTENANCE_BUSY_TIMEOUT_MS = 30_000
const parsedWorkBudgetMs = Number(workBudgetRaw)
const WORK_BUDGET_MS =
  Number.isSafeInteger(parsedWorkBudgetMs) &&
  parsedWorkBudgetMs >= 60_000 &&
  parsedWorkBudgetMs <= 30 * 60_000
    ? parsedWorkBudgetMs
    : 4 * 60 * 1000
const processStart = Date.now()
const parsedSqliteTargetBytes = Number(sqliteTargetBytesRaw)
const SQLITE_TARGET_BYTES =
  Number.isSafeInteger(parsedSqliteTargetBytes) &&
  parsedSqliteTargetBytes >= 128 * 1024 * 1024
    ? parsedSqliteTargetBytes
    : JOURNAL_SQLITE_TARGET_BYTES
const parsedSnapshotKeep = Number(snapshotKeepRaw)
const SNAPSHOT_KEEP =
  Number.isSafeInteger(parsedSnapshotKeep) && parsedSnapshotKeep >= 1 && parsedSnapshotKeep <= 16
    ? parsedSnapshotKeep
    : JOURNAL_BACKUP_KEEP_DEFAULT
const parsedSnapshotMaxBytes = Number(snapshotMaxBytesRaw)
const SNAPSHOT_MAX_BYTES =
  Number.isSafeInteger(parsedSnapshotMaxBytes) &&
  parsedSnapshotMaxBytes >= 128 * 1024 * 1024
    ? parsedSnapshotMaxBytes
    : JOURNAL_BACKUP_MAX_RETAINED_BYTES_DEFAULT

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 512)
}

function reportProgress(
  phase: string,
  rowsCompleted: number,
  bytesCompleted: number,
  suspendWatchdog = false,
): void {
  if (!process.send || !operationId) return
  try {
    process.send({
      type: 'journal-condense-progress',
      operationId,
      phase,
      rowsCompleted: Math.max(0, Math.trunc(rowsCompleted)),
      bytesCompleted: Math.max(0, Math.trunc(bytesCompleted)),
      suspendWatchdog,
    })
  } catch {
    // The durable lifecycle remains authoritative if the observation channel disappears.
  }
}

async function main(): Promise<{ message: MaintenanceMessage; exitCode: number }> {
  let journal: Journal | undefined
  let rowsDeleted = 0
  let payloadBytesDeleted = 0
  let aggregate: JournalCondenseResult | undefined
  try {
    if (!file) throw new Error('journal database path is required')
    if (!backupDirectory) throw new Error('journal backup directory is required')
    if (!operationId) throw new Error('journal maintenance operation id is required')
    reportProgress('starting', 0, 0)
    // The live hub must remain responsive and wins ordinary writer races. Maintenance runs out of
    // process and can wait longer for its bounded write transaction without blocking the renderer,
    // HTTP, WebSocket, or worker-ingestion loops.
    journal = new Journal(file, { busyTimeoutMs: MAINTENANCE_BUSY_TIMEOUT_MS })
    // Content validation is intentionally post-ready. It used to share the ordinary preflight step
    // with quick_check, turning a full table scan into a 10+ second cold-start gate on a multi-GB
    // journal. Keep the proof (and keep recovery classification fail-closed), but isolate this scan in
    // the maintenance child so the UI, HTTP listener, WebSocket, and liveness heartbeat remain live.
    reportProgress('validating-payloads', 0, 0)
    const invalidPayload = journal.db
      .prepare('SELECT seq FROM events WHERE json_valid(payload) = 0 ORDER BY seq LIMIT 1')
      .get() as { seq?: unknown } | undefined
    if (invalidPayload) {
      throw new Error(
        `journal contains invalid JSON in event sequence ${String(invalidPayload.seq)}; ` +
          'maintenance refused to mutate it',
      )
    }
    journal.recordCompactionLifecycle(operationId, 'started', {
      detail: 'Bounded journal maintenance started after payload validation.',
    })
    journal.recordCompactionLifecycle(operationId, 'progress', {
      detail: 'Post-ready event payload JSON validation passed.',
    })
    // Retention is idempotent and metadata-only. Do it before generating any new evidence so an upgrade
    // immediately stops the legacy N x multi-GB footprint from climbing, even if payload migration needs
    // several later windows. Both policies retain the newest independently published generation.
    pruneJournalBackupGenerations(backupDirectory, SNAPSHOT_KEEP, SNAPSHOT_MAX_BYTES)
    pruneRecoveryGenerations(path.dirname(file), SNAPSHOT_KEEP, SNAPSHOT_MAX_BYTES)

    let blobRowsRewritten = 0
    let blobSqliteBytesReleased = 0
    let blobMigrationComplete = false
    while (Date.now() - processStart < WORK_BUDGET_MS) {
      const migration = journal.externalizeLegacyPayloads()
      blobRowsRewritten += migration.rowsRewritten
      blobSqliteBytesReleased += migration.sqliteBytesReleased
      reportProgress('externalizing-payloads', migration.scannedThrough, blobSqliteBytesReleased)
      if (migration.rowsRewritten > 0 || migration.complete) {
        journal.recordCompactionLifecycle(operationId, 'progress', {
          rowsDeleted: 0,
          payloadBytesDeleted: blobSqliteBytesReleased,
          detail: migration.complete
            ? `Lossless payload externalization is current (${blobRowsRewritten} row(s) rewritten).`
            : `Losslessly externalized ${blobRowsRewritten} oversized row(s); migration will resume.`,
        })
      }
      if (migration.complete) {
        blobMigrationComplete = true
        break
      }
      await nextTurn()
    }
    if (!blobMigrationComplete) {
      const reason =
        `lossless payload externalization paused at its size-aware work budget ` +
        `(${blobRowsRewritten} row(s), ${blobSqliteBytesReleased} SQLite payload bytes released)`
      journal.recordCompactionLifecycle(operationId, 'deferred', {
        payloadBytesDeleted: blobSqliteBytesReleased,
        detail: reason,
      })
      return {
        message: { type: 'journal-condense-deferred', operationId, reason },
        exitCode: 0,
      }
    }

    reportProgress('enforcing-storage-ceiling', blobRowsRewritten, blobSqliteBytesReleased)
    journal.recordCompactionLifecycle(operationId, 'progress', {
      payloadBytesDeleted: blobSqliteBytesReleased,
      detail:
        `Lossless payload projection is current; enforcing the ordinary ` +
        `${SQLITE_TARGET_BYTES}-byte resident SQLite ceiling.`,
    })
    const storage = journal.enforceStorageCeiling(SQLITE_TARGET_BYTES)
    reportProgress('storage-ceiling-enforced', blobRowsRewritten, blobSqliteBytesReleased)
    if (storage.action !== 'none' || !storage.withinTarget) {
      journal.recordCompactionLifecycle(operationId, 'progress', {
        payloadBytesDeleted: blobSqliteBytesReleased,
        detail:
          `Resident SQLite enforcement ${storage.action} (${storage.bytesBefore} -> ` +
          `${storage.bytesAfter} bytes; target ${storage.targetBytes}; ` +
          `${storage.withinTarget ? 'within target' : 'more bounded cycles or retention work required'}).`,
      })
    }

    let lastProjectionProgress = 0
    while (Date.now() - processStart < WORK_BUDGET_MS) {
      const session = journal.backfillSessionEventIndex(PROJECTION_BATCH_ROWS)
      const transient = journal.backfillTransientEventIndex(PROJECTION_BATCH_ROWS)
      const progress = Math.min(session.scannedThrough, transient.scannedThrough)
      reportProgress('projecting', progress, payloadBytesDeleted)
      if (
        progress - lastProjectionProgress >= PROJECTION_PROGRESS_ROWS ||
        (session.complete && transient.complete)
      ) {
        lastProjectionProgress = progress
        journal.recordCompactionLifecycle(operationId, 'progress', {
          rowsDeleted,
          payloadBytesDeleted,
          detail:
            session.complete && transient.complete
              ? 'Bounded journal projections are current.'
              : `Bounded journal projection advanced through event ${progress}.`,
        })
      }
      if (session.complete && transient.complete) break
      await nextTurn()
    }

    const sessionProjection = journal.backfillSessionEventIndex(1)
    const transientProjection = journal.backfillTransientEventIndex(1)
    if (!sessionProjection.complete || !transientProjection.complete) {
      const reason = 'bounded projection time budget elapsed; deletion was not attempted'
      journal.recordCompactionLifecycle(operationId, 'deferred', {
        rowsDeleted,
        payloadBytesDeleted,
        detail: reason,
      })
      return {
        message: { type: 'journal-condense-deferred', operationId, reason },
        exitCode: 0,
      }
    }

    const maintenanceNow = Date.now()
    let candidateFrontier = journal.condensationCandidateFrontier({
      nowMs: maintenanceNow,
      graceMs: Number(graceRaw),
      maxTransientPayloadBytes: Number(byteLimitRaw),
    })
    if (candidateFrontier === 0) {
      // Snapshot verification hashes and integrity-checks the complete recovery generation. On a
      // multi-gigabyte journal that consumed 14-19 seconds every five minutes even after maintenance had
      // reached steady state and there was not one row it was authorized to delete. A zero frontier also
      // bounds history rollup to seq 0, so there is no destructive work requiring snapshot coverage.
      aggregate = {
        commandOutputDeltasDeleted: 0,
        agentMessageDeltasDeleted: 0,
        diffSnapshotsDeleted: 0,
        itemStartedDeleted: 0,
        transientPayloadBytesDeleted: 0,
        oversizedTransientRowsRetained: 0,
        writerLockMs: 0,
        cursorCheckpointsWritten: 0,
        historyTurnsRolledUp: 0,
        historyTurnsDeferred: 0,
        historyTurnsExpired: 0,
        historyRowsDeleted: 0,
        historyPayloadBytesSelected: 0,
        historyPayloadBytesWritten: 0,
        replication: reserveReplicationPruneGate(journal.db),
      }
      journal.recordCompactionLifecycle(operationId, 'completed', {
        detail: 'Journal maintenance is current; no snapshot verification or deletion was needed.',
      })
      reportProgress('completed', 0, 0)
      return {
        message: { type: 'journal-condensed', operationId, result: aggregate },
        exitCode: 0,
      }
    }
    // A recovery generation is a point-in-time snapshot, while superseded rows keep aging into the
    // candidate set. Requiring that snapshot to cover the NEWEST candidate rejected the entire pass as
    // soon as one later row became eligible, even though a large older prefix remained safely covered.
    // Read only the manifest claim first (never deletion authority) to constrain candidate discovery. If
    // nothing remains below it, skip the multi-GB hash/integrity pass and wait cheaply for the next backup.
    let snapshotClaim: ReturnType<typeof newestStrongRecoverySnapshotClaim>
    try {
      snapshotClaim = newestStrongRecoverySnapshotClaim({
        dataDir: path.dirname(file),
        journalPath: file,
      })
    } catch (error) {
      const reason = boundedMessage(error)
      journal.recordCompactionLifecycle(operationId, 'deferred', {
        detail: `Deletion deferred: ${reason}`,
      })
      return {
        message: { type: 'journal-condense-deferred', operationId, reason },
        exitCode: 0,
      }
    }
    const claimedFrontierBig = BigInt(snapshotClaim.snapshotMaxSeq) < BigInt(snapshotClaim.snapshotEventHighWater)
      ? BigInt(snapshotClaim.snapshotMaxSeq)
      : BigInt(snapshotClaim.snapshotEventHighWater)
    const claimedFrontier = Number(claimedFrontierBig)
    if (!Number.isSafeInteger(claimedFrontier) || claimedFrontier < 0) {
      const reason = 'newest strong recovery generation has an unsupported event frontier'
      journal.recordCompactionLifecycle(operationId, 'deferred', { detail: `Deletion deferred: ${reason}` })
      return {
        message: { type: 'journal-condense-deferred', operationId, reason },
        exitCode: 0,
      }
    }
    if (candidateFrontier > claimedFrontier) {
      candidateFrontier = journal.condensationCandidateFrontier({
        nowMs: maintenanceNow,
        graceMs: Number(graceRaw),
        maxTransientPayloadBytes: Number(byteLimitRaw),
        maxSeq: claimedFrontier,
      })
    }
    if (candidateFrontier === 0) {
      const reason =
        `Journal cleanup is current through recovery generation ${snapshotClaim.generation}; ` +
        'newer superseded rows are waiting for the next verified snapshot.'
      journal.recordCompactionLifecycle(operationId, 'deferred', { detail: reason })
      reportProgress('deferred', lastProjectionProgress, payloadBytesDeleted)
      return {
        message: { type: 'journal-condense-deferred', operationId, reason },
        exitCode: 0,
      }
    }
    reportProgress('verifying-snapshot-coverage', lastProjectionProgress, payloadBytesDeleted)
    const snapshot = verifyRecentCompactionSnapshot(
      backupDirectory,
      candidateFrontier,
      maintenanceNow,
      (_ignoredBackupDirectory, requiredThroughSeq, verifiedAtMs) => {
        try {
          const coverage = verifyStrongRecoverySnapshotCoverage({
            dataDir: path.dirname(file),
            journalPath: file,
            maxSchemaVersion: SCHEMA_VERSION,
            deleteThroughSeq: String(requiredThroughSeq),
          })
          return {
            ok: true,
            evidence: {
              rootId: coverage.rootId,
              journalId: coverage.journalId,
              generation: coverage.generation,
              snapshotMaxSeq: coverage.snapshotMaxSeq,
              snapshotEventHighWater: coverage.snapshotEventHighWater,
              verifiedAt: new Date(verifiedAtMs).toISOString(),
            },
          }
        } catch (error) {
          return { ok: false, reason: boundedMessage(error) }
        }
      }
    )
    if (!snapshot.ok) {
      journal.recordCompactionLifecycle(operationId, 'deferred', {
        detail: `Deletion deferred: ${snapshot.reason}`,
      })
      return {
        message: {
          type: 'journal-condense-deferred',
          operationId,
          reason: snapshot.reason,
        },
        exitCode: 0,
      }
    }

    let batches = 0
    while (Date.now() - processStart < WORK_BUDGET_MS) {
      const currentProjection = journal.backfillTransientEventIndex(PROJECTION_BATCH_ROWS)
      if (!currentProjection.complete) {
        await nextTurn()
        continue
      }
      let result: JournalCondenseResult
      try {
        result = journal.condenseCompletedCodex({
          nowMs: maintenanceNow,
          graceMs: Number(graceRaw),
          deleteThroughSeq: candidateFrontier,
          maxCommandOutputDeltas: Number(commandLimitRaw),
          maxAgentMessageDeltas: Number(agentMessageLimitRaw),
          maxDiffSnapshots: Number(diffLimitRaw),
          maxTransientPayloadBytes: Number(byteLimitRaw),
        })
      } catch (error) {
        // A live writer can commit in the tiny window between the projection check and candidate
        // selection. Yield and advance the durable frontier; ordinary traffic must not make maintenance
        // fail every five minutes.
        if (error instanceof TransientHistoryIndexingError) {
          await nextTurn()
          continue
        }
        throw error
      }
      if (!aggregate) {
        aggregate = { ...result }
      } else {
        aggregate.commandOutputDeltasDeleted += result.commandOutputDeltasDeleted
        aggregate.agentMessageDeltasDeleted += result.agentMessageDeltasDeleted
        aggregate.diffSnapshotsDeleted += result.diffSnapshotsDeleted
        aggregate.itemStartedDeleted += result.itemStartedDeleted
        aggregate.transientPayloadBytesDeleted += result.transientPayloadBytesDeleted
        aggregate.oversizedTransientRowsRetained = result.oversizedTransientRowsRetained
        aggregate.writerLockMs = Math.max(aggregate.writerLockMs, result.writerLockMs)
        aggregate.cursorCheckpointsWritten += result.cursorCheckpointsWritten
        aggregate.historyTurnsRolledUp += result.historyTurnsRolledUp
        aggregate.historyTurnsDeferred += result.historyTurnsDeferred
        aggregate.historyTurnsExpired += result.historyTurnsExpired
        aggregate.historyRowsDeleted += result.historyRowsDeleted
        aggregate.historyPayloadBytesSelected += result.historyPayloadBytesSelected
        aggregate.historyPayloadBytesWritten += result.historyPayloadBytesWritten
        aggregate.replication = result.replication
      }
      const deleted =
        result.commandOutputDeltasDeleted +
        result.agentMessageDeltasDeleted +
        result.diffSnapshotsDeleted +
        result.itemStartedDeleted +
        result.historyRowsDeleted
      rowsDeleted += deleted
      payloadBytesDeleted +=
        result.transientPayloadBytesDeleted +
        result.historyPayloadBytesSelected
      batches += 1
      reportProgress('deleting', rowsDeleted, payloadBytesDeleted)
      if (deleted === 0) break
      if (batches % DELETE_PROGRESS_BATCHES === 0) {
        journal.recordCompactionLifecycle(operationId, 'progress', {
          rowsDeleted,
          payloadBytesDeleted,
          detail: `Committed ${batches} bounded cleanup batches behind a verified snapshot.`,
        })
      }
      await nextTurn()
    }
    if (!aggregate) throw new Error('journal maintenance produced no bounded result')
    const reclaimed = journal.reclaimFreelistPages()
    const detail =
      Date.now() - processStart >= WORK_BUDGET_MS
        ? 'Bounded cleanup paused at its time budget and will continue in a later operation.'
        : `Bounded journal cleanup completed${
            reclaimed.supported
              ? `; incremental vacuum reclaimed ${Math.max(0, reclaimed.before - reclaimed.after)} page(s).`
              : '; a one-time full VACUUM is still required to enable incremental reclaim on this legacy journal.'
          }`
    journal.recordCompactionLifecycle(operationId, 'completed', {
      rowsDeleted,
      payloadBytesDeleted,
      detail,
    })
    reportProgress('completed', rowsDeleted, payloadBytesDeleted)
    return {
      message: {
        type: 'journal-condensed',
        operationId,
        result: aggregate,
      },
      exitCode: 0,
    }
  } catch (error) {
    const message = boundedMessage(error)
    if (isTransientSqliteContention(error)) {
      const reason = `transient SQLite writer contention; retrying at the next maintenance interval (${message})`
      try {
        if (journal && operationId) {
          journal.recordCompactionLifecycle(operationId, 'deferred', {
            rowsDeleted,
            payloadBytesDeleted,
            detail: reason,
          })
        }
      } catch {
        // The parent still receives a truthful deferred result. A later maintenance operation is
        // independent and resumes from the durable projection/delete frontier.
      }
      return {
        message: {
          type: 'journal-condense-deferred',
          operationId: operationId ?? 'unknown',
          reason,
        },
        exitCode: 0,
      }
    }
    try {
      if (journal && operationId) {
        journal.recordCompactionLifecycle(operationId, 'failed', {
          rowsDeleted,
          payloadBytesDeleted,
          detail: message,
        })
      }
    } catch {
      // The parent records an explicit observation-lost boundary if this child cannot durably do so.
    }
    return {
      message: {
        type: 'journal-condense-error',
        operationId: operationId ?? 'unknown',
        error: message,
      },
      exitCode: 1,
    }
  } finally {
    journal?.db.close()
  }
}

const outcome = await main()
process.exitCode = outcome.exitCode
if (process.send) {
  process.send(outcome.message, () => process.disconnect?.())
} else if (outcome.message.type === 'journal-condensed') {
  console.log(JSON.stringify(outcome.message.result))
} else if (outcome.message.type === 'journal-condense-deferred') {
  console.log(outcome.message.reason)
} else {
  console.error(outcome.message.error)
}
