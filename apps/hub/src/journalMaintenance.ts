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
  TransientHistoryIndexingError,
  type JournalCondenseResult,
} from './journal.js'
import { verifyRecentCompactionSnapshot } from './journalCompactionGate.js'
import { verifyStrongRecoverySnapshotCoverage } from './journalRecovery.js'
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
  bytesCompleted: number
): void {
  if (!process.send || !operationId) return
  try {
    process.send({
      type: 'journal-condense-progress',
      operationId,
      phase,
      rowsCompleted: Math.max(0, Math.trunc(rowsCompleted)),
      bytesCompleted: Math.max(0, Math.trunc(bytesCompleted)),
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
    journal.recordCompactionLifecycle(operationId, 'started', {
      detail: 'Bounded journal maintenance started.',
    })

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
      journal.recordCompactionLifecycle(operationId, 'unobservable', {
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
    const candidateFrontier = journal.condensationCandidateFrontier({
      nowMs: maintenanceNow,
      graceMs: Number(graceRaw),
      maxTransientPayloadBytes: Number(byteLimitRaw),
    })
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
      journal.recordCompactionLifecycle(operationId, 'unobservable', {
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
    const detail =
      Date.now() - processStart >= WORK_BUDGET_MS
        ? 'Bounded cleanup paused at its time budget and will continue in a later operation.'
        : 'Bounded journal cleanup completed.'
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
          journal.recordCompactionLifecycle(operationId, 'unobservable', {
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
