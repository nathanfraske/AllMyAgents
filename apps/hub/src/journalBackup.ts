import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type {
  JournalBackupControlCommand,
  JournalBackupControlResult,
} from './restartHandshake.js'
import { JournalBackupLease } from './journalBackupLease.js'
import {
  ensureRecoveryEnrollment,
  publishRecoveryGeneration,
} from './journalRecovery.js'
import { SCHEMA_VERSION } from './restartHandshake.js'
import type { JournalProgressUpdate } from './journalProgress.js'

/**
 * Periodic, verified snapshots of the journal.
 *
 * WHY THIS EXISTS. The operator's journal was corrupted twice in two days. The second time it was also
 * TRUNCATED — 428 MB down to 127 KB, the size of an empty schema — and the only thing that saved fourteen
 * hours of their history was a backup a human had happened to take by hand the previous evening. Their
 * words: "just destroying arbitrary data with no backup whatsoever."
 *
 * A journal is the one component whose entire job is to still be there afterwards. Shipping it with no
 * automatic copy makes every other durability guarantee in this app conditional on nothing going wrong.
 *
 * DESIGN NOTES, each one paid for:
 *
 *  - Uses SQLite's ONLINE BACKUP API, not a file copy. Copying hub.db while a hub is writing captures a
 *    torn file plus a WAL that may not match it — which is exactly the state we have been recovering
 *    from. `db.backup()` produces a consistent snapshot of a live database.
 *
 *  - VERIFIES the snapshot before keeping it. An unverified backup is a belief, not a backup, and the
 *    failure we are guarding against is silent corruption — the case where the thing you saved was
 *    already broken. A snapshot that fails integrity_check is deleted and reported, never retained as if it
 *    were good.
 *
 *  - Keeps SEVERAL generations. Corruption is often noticed long after it starts; a single rolling copy
 *    can be overwritten by a bad one before anybody looks. Rotating N means a bad snapshot costs one
 *    generation rather than the whole safety net.
 *
 *  - NEVER deletes an unverified or newest snapshot to make room. Rotation removes the OLDEST verified
 *    copy only, so a run of failures shrinks the interval covered rather than emptying the directory.
 */

export interface JournalBackupOptions {
  /** Directory for snapshots. Created if absent. */
  dir: string
  /** How often to snapshot. */
  intervalMs?: number
  /** How many verified generations to keep. */
  keep?: number
  /** Total compatibility-snapshot budget. The newest verified generation is always retained. */
  maxRetainedBytes?: number
  /** Free space reserved in addition to the source journal's estimated snapshot size. */
  minimumFreeBytes?: number
  /** Injectable disk-capacity probe for tests. */
  availableBytes?: (dir: string) => bigint
  /** Injectable for tests. */
  now?: () => Date
  log?: (message: string) => void
  /** Capped retry schedule used only after standalone/orphan listener activation fails. */
  activationRetryMs?: readonly number[]
  /** Maximum graceful wait for an in-flight generation during process shutdown. */
  shutdownWaitMs?: number
  /** Surfaces intentional inactivity and activation failures through hub health. */
  onStateChange?: (state: JournalBackupRuntimeState) => void
  /**
   * Healthy installed hubs set this to their data root. The compatibility flat file and the owned,
   * identity-bound generation become hard links to one verified inode, avoiding doubled retention.
   */
  recoveryDataDir?: string
  recoveryKeep?: number
  /** Out-of-band supervisor heartbeat; failures are diagnostic and can never fail a snapshot. */
  onProgress?: (progress: JournalProgressUpdate) => void
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000
const DEFAULT_KEEP = 6
const DEFAULT_MAX_RETAINED_BYTES = 8 * 1024 * 1024 * 1024
const DEFAULT_MINIMUM_FREE_BYTES = 256 * 1024 * 1024
const DEFAULT_ACTIVATION_RETRY_MS = [250, 1_000, 5_000, 10_000, 30_000] as const
const DEFAULT_SHUTDOWN_WAIT_MS = 2_000
const PREFIX = 'hub-'
const SUFFIX = '.db'
const PARTIAL_SUFFIX = `${SUFFIX}.partial`
/** SQLite writes these beside any database it opens — including a read-only verification open. */
const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const

export interface SnapshotResult {
  ok: boolean
  file?: string
  bytes?: number
  error?: string
  recoveryGeneration?: string
}

export type JournalBackupRuntimeState =
  | { status: 'inactive' }
  | { status: 'active' }
  | { status: 'degraded'; error: string }

export type JournalBackupActivationResult =
  | { ok: true }
  | { ok: false; error: string }

export type JournalSnapshotTask = (
  db: Database.Database,
  options: JournalBackupOptions
) => Promise<SnapshotResult>

export interface JournalBackupSupervisor {
  /** Activate an unsupervised hub after its HTTP listener is ready. */
  activateStandalone(): JournalBackupActivationResult
  /** Apply one parent-supervisor ownership command, ordered by monotonically increasing epoch. */
  applyControl(command: JournalBackupControlCommand): Promise<JournalBackupControlResult>
  /** Pause new work, clear timers, and settle the current generation without becoming terminal. */
  pause(): Promise<void>
  /** Stop future work and wait for the one supervised snapshot, if any, to settle. */
  stop(): Promise<void>
}

/** Take ONE verified snapshot. Exported so an operator action and the timer share a single code path. */
export async function snapshotJournal(
  db: Database.Database,
  options: JournalBackupOptions & { verify?: (file: string) => boolean }
): Promise<SnapshotResult> {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})
  const progressOperationId = randomUUID()
  let progressCompleted = false
  let sourceBytes = 0n
  let bytesCompleted = 0
  const reportProgress = (
    phase: string,
    active: boolean,
    suspendWatchdog = false,
    detail = ''
  ): void => {
    try {
      options.onProgress?.({
        operationId: progressOperationId,
        phase,
        active,
        suspendWatchdog,
        bytesCompleted,
        databaseBytes: Number(sourceBytes),
        detail,
      })
    } catch (error) {
      log(
        `[journal-backup] progress heartbeat failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  fs.mkdirSync(options.dir, { recursive: true })
  reportProgress('preparing', true)
  const keep = Math.max(1, Math.trunc(options.keep ?? DEFAULT_KEEP))
  const maxRetainedBytes = positiveByteLimit(
    options.maxRetainedBytes,
    DEFAULT_MAX_RETAINED_BYTES
  )
  const rotateSnapshots = (): void =>
    rotate(options.dir, keep, maxRetainedBytes, log)

  // Rotation is both a precondition (old generations must not crowd out the next snapshot) and a
  // finally action. In particular, enrollment, source-validation, backup, verification, and publication
  // failures must not allow a legacy pile to grow forever.
  rotateSnapshots()
  try {
    sourceBytes = estimateSourceBytes(db)
    if (sourceBytes > 0n) {
      const reserveBytes = BigInt(
        positiveByteLimit(options.minimumFreeBytes, DEFAULT_MINIMUM_FREE_BYTES)
      )
      try {
        const availableBytes = options.availableBytes
          ? options.availableBytes(options.dir)
          : filesystemAvailableBytes(options.dir)
        const requiredBytes = sourceBytes + reserveBytes
        if (availableBytes < requiredBytes) {
          const message =
            `insufficient free space for journal snapshot: ${formatBytes(availableBytes)} available; ` +
            `${formatBytes(requiredBytes)} required (${formatBytes(sourceBytes)} source + ` +
            `${formatBytes(reserveBytes)} reserve)`
          log(`[journal-backup] snapshot SKIPPED: ${message}`)
          return { ok: false, error: message }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`[journal-backup] snapshot FAILED free-space preflight: ${message}`)
        return { ok: false, error: message }
      }
    }

    const stamp = now().toISOString().replace(/[:.]/g, '-')
    // Timestamp-only names collide across blue/green processes and even within one millisecond. The UUID
    // makes both the staging file and final generation unique across processes sharing this directory.
    const generation = `${PREFIX}${stamp}-${process.pid}-${randomUUID()}`
    const target = path.join(options.dir, `${generation}${SUFFIX}`)
    const partial = path.join(options.dir, `${generation}${PARTIAL_SUFFIX}`)
    let sourceHadEvents = false
    if (options.recoveryDataDir) {
      try {
        ensureRecoveryEnrollment(db, options.recoveryDataDir)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`[journal-backup] recovery enrollment FAILED: ${message}`)
        return { ok: false, error: message }
      }
    }
    if (!options.verify) {
      try {
        // Capture the weakest useful source invariant before the online backup starts. An empty source is
        // legitimate; a source that already has history must not turn into a schema-only snapshot.
        sourceHadEvents = hasAnyEvents(db)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`[journal-backup] snapshot FAILED source validation: ${message}`)
        return { ok: false, error: message }
      }
    }

    try {
      // Online backup: consistent even while the hub is mid-turn.
      reportProgress('copying', true)
      await db.backup(partial, {
        progress: ({ totalPages, remainingPages }) => {
          const copiedPages = Math.max(0, totalPages - remainingPages)
          bytesCompleted = totalPages > 0
            ? Number((sourceBytes * BigInt(copiedPages)) / BigInt(totalPages))
            : 0
          reportProgress('copying', true, false, `${copiedPages}/${totalPages} SQLite pages copied`)
          return 1_000
        },
      })
      bytesCompleted = fs.statSync(partial).size
      // SQLite online backup preserves the source's WAL journal-mode header. A standalone snapshot has
      // no live WAL to replay, and opening that header read-only on Windows manufactures `-wal`/`-shm`
      // files that can remain locked long enough to break strong-generation publication. Normalize the
      // private staging database to DELETE mode before verification or hard-link publication.
      normalizeSnapshotJournalMode(partial)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[journal-backup] snapshot FAILED: ${message}`)
      try {
        fs.rmSync(partial, { force: true })
      } catch {
        /* nothing to clean up */
      }
      return { ok: false, error: message }
    }

    let verified = false
    try {
      // integrity_check is synchronous native work with no progress callback. This explicit phase tells
      // hubctl never to kill this process in the middle of the verification/lineage safety boundary.
      reportProgress('verifying-snapshot', true, true)
      verified = options.verify ? options.verify(partial) : defaultVerify(partial, sourceHadEvents)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[journal-backup] snapshot FAILED verification: ${message}`)
      try {
        fs.rmSync(partial, { force: true })
      } catch {
        /* best effort */
      }
      return { ok: false, error: message }
    }
    if (!verified) {
      // A snapshot that does not pass its own integrity check is worse than none: it would sit there
      // looking like insurance. Remove it and say so loudly.
      log(`[journal-backup] snapshot at ${partial} FAILED verification and was discarded — the live journal may already be damaged`)
      try {
        fs.rmSync(partial, { force: true })
      } catch {
        /* best effort */
      }
      return { ok: false, error: 'snapshot failed integrity verification' }
    }

    let bytes: number
    try {
      bytes = fs.statSync(partial).size
      // Same-directory rename is the publication boundary. A hard kill before it leaves only `.partial`;
      // a kill after it leaves a fully verified final. The collision-free target is never overwritten.
      fs.renameSync(partial, target)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[journal-backup] snapshot FAILED publication: ${message}`)
      try {
        fs.rmSync(partial, { force: true })
      } catch {
        /* best effort */
      }
      return { ok: false, error: message }
    }
    log(`[journal-backup] verified snapshot ${path.basename(target)} (${(bytes / 1_048_576).toFixed(1)} MB)`)
    let recoveryGeneration: string | undefined
    if (options.recoveryDataDir) {
      try {
        reportProgress('publishing-lineage', true, true)
        const generation = publishRecoveryGeneration({
          dataDir: options.recoveryDataDir,
          snapshotFile: target,
          maxSchemaVersion: SCHEMA_VERSION,
          keep: options.recoveryKeep ?? options.keep ?? DEFAULT_KEEP,
        })
        recoveryGeneration = generation.manifest.generation
        log(
          `[journal-backup] enrolled recovery generation ${recoveryGeneration} for journal ${generation.manifest.journalId}`
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`[journal-backup] recovery generation FAILED: ${message}`)
        // The compatibility flat file remains operator evidence, but it is intentionally NOT recovery
        // eligible. Keep it inside the same bounded retention budget rather than accumulating a second,
        // unbounded failure stream, and surface degraded state so self-heal is never silently assumed.
        return { ok: false, file: target, bytes, error: message }
      }
    }
    progressCompleted = true
    return { ok: true, file: target, bytes, ...(recoveryGeneration ? { recoveryGeneration } : {}) }
  } finally {
    reportProgress(
      progressCompleted ? 'completed' : 'failed',
      false,
      false,
      progressCompleted ? 'Verified snapshot and lineage publication completed.' : 'Snapshot did not complete.'
    )
    rotateSnapshots()
  }
}

function hasAnyEvents(db: Pick<Database.Database, 'prepare'>): boolean {
  const row = db
    .prepare('SELECT EXISTS(SELECT 1 FROM events LIMIT 1) AS hasEvents')
    .get() as { hasEvents?: unknown } | undefined
  return row?.hasEvents === 1
}

function defaultVerify(file: string, sourceHadEvents: boolean): boolean {
  let db: import('better-sqlite3').Database | undefined
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    const rows = db.pragma('integrity_check') as Array<Record<string, unknown>>
    const findings = rows.flatMap((row) => Object.values(row).map(String))
    if (findings.length !== 1 || findings[0]?.toLowerCase() !== 'ok') return false
    // Querying the table proves it exists. Requiring a row only when the source already had one rejects
    // the truncation shape without falsely rejecting a brand-new, legitimately empty journal. EXISTS also
    // avoids a full COUNT(*) scan of a hundreds-of-megabytes journal.
    const snapshotHasEvents = hasAnyEvents(db)
    return !sourceHadEvents || snapshotHasEvents
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

function positiveByteLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.trunc(value)
}

function normalizeSnapshotJournalMode(file: string): void {
  let db: import('better-sqlite3').Database | undefined
  let closeError: unknown
  try {
    db = new Database(file, { fileMustExist: true })
    const mode = String(db.pragma('journal_mode = DELETE', { simple: true })).toLowerCase()
    if (mode !== 'delete') {
      throw new Error(`snapshot refused standalone DELETE journal mode (${mode})`)
    }
  } finally {
    try {
      db?.close()
    } catch (error) {
      closeError = error
    }
    if (closeError) {
      throw new Error(
        `snapshot journal-mode handle could not close: ${closeError instanceof Error ? closeError.message : String(closeError)}`
      )
    }
  }
}

function estimateSourceBytes(db: Database.Database): bigint {
  try {
    const pageCount = db.pragma('page_count', { simple: true }) as number
    const pageSize = db.pragma('page_size', { simple: true }) as number
    if (!Number.isSafeInteger(pageCount) || !Number.isSafeInteger(pageSize)) return 0n
    if (pageCount <= 0 || pageSize <= 0) return 0n
    return BigInt(pageCount) * BigInt(pageSize)
  } catch {
    // Test doubles and non-file sources may not expose pragmas. Snapshot verification remains the final
    // authority; the preflight is applied whenever the real SQLite connection can report its size.
    return 0n
  }
}

function filesystemAvailableBytes(dir: string): bigint {
  const stats = fs.statfsSync(dir, { bigint: true })
  return stats.bavail * stats.bsize
}

function formatBytes(bytes: bigint): string {
  const mib = Number(bytes / 1_048_576n)
  return `${mib.toLocaleString('en-US')} MiB`
}

function rotate(
  dir: string,
  keep: number,
  maxRetainedBytes: number,
  log: (m: string) => void
): void {
  let entries: Array<{ name: string; bytes: bigint }>
  try {
    entries = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
      .sort()
      .map((name) => ({ name, bytes: BigInt(fs.statSync(path.join(dir, name)).size) }))
  } catch {
    return
  }
  let retainedBytes = entries.reduce((total, entry) => total + entry.bytes, 0n)
  const byteLimit = BigInt(maxRetainedBytes)
  // Oldest first; drop from the front only.
  while (entries.length > 1 && (entries.length > keep || retainedBytes > byteLimit)) {
    const victim = entries.shift()
    if (!victim) break
    try {
      fs.rmSync(path.join(dir, victim.name), { force: true })
      // Retire the WHOLE SQLite family, not just the main file. Verification opens each snapshot, and on
      // Windows even a read-only open manufactures `-wal`/`-shm` beside it (see the note in verify()).
      // Rotation used to delete only the `.db`, so every generation it retired left its two sidecars
      // behind permanently — they match neither this filter (`.db-wal` does not end in `.db`) nor the
      // partial sweep. Hundreds accumulated in one operator's backups directory.
      for (const sidecar of SIDECAR_SUFFIXES) {
        fs.rmSync(path.join(dir, `${victim.name}${sidecar}`), { force: true })
      }
      retainedBytes -= victim.bytes
      log(`[journal-backup] rotated out ${victim.name}`)
    } catch {
      // Preserve oldest-first semantics: if this victim cannot be removed, do not sacrifice newer
      // verified generations to pretend the retention target was met.
      break
    }
  }
}

/**
 * Ownership makes every recognized partial stale: this runs only as an inactive supervisor becomes the
 * exclusive owner. Rotation never sees these names, so a crash cannot evict a verified generation.
 */
function cleanupStalePartials(dir: string, log: (m: string) => void): void {
  let entries: string[]
  try {
    entries = fs
      .readdirSync(dir)
      // A staged partial is a whole SQLite family too. Matching only the exact `.db.partial` left every
      // `.db.partial-wal` / `.db.partial-shm` on disk forever, since rotation's `.db` filter never sees
      // them either — the same orphan class the rotation fix above closes.
      .filter(
        (name) =>
          name.startsWith(PREFIX) &&
          (name.endsWith(PARTIAL_SUFFIX) ||
            SIDECAR_SUFFIXES.some((sidecar) => name.endsWith(`${PARTIAL_SUFFIX}${sidecar}`)))
      )
  } catch {
    return
  }
  for (const entry of entries) {
    try {
      fs.rmSync(path.join(dir, entry), { force: true })
      log(`[journal-backup] removed stale partial ${entry}`)
    } catch (error) {
      log(
        `[journal-backup] stale partial cleanup FAILED for ${entry}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}

/**
 * Supervise initial + periodic backups without putting journal IO on the startup critical path.
 *
 * Standalone callers activate after listening. Supervised callers remain inactive until an epoch-ordered
 * parent command grants ownership. Each completion schedules the next interval, so a slow snapshot can
 * never overlap another generation. Timers are unref'd so they do not hold the hub open; pause/stop clear
 * pending work and join the single in-flight promise.
 */
export function createJournalBackupSupervisor(
  db: Database.Database,
  options: JournalBackupOptions,
  takeSnapshot: JournalSnapshotTask = snapshotJournal
): JournalBackupSupervisor {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const log = options.log ?? (() => {})
  const activationRetryMs =
    options.activationRetryMs?.length ? options.activationRetryMs : DEFAULT_ACTIVATION_RETRY_MS
  const shutdownWaitMs = Math.max(0, options.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS)
  const onStateChange = options.onStateChange ?? (() => {})
  const lease = new JournalBackupLease(options.dir, log)
  let active = false
  let stopped = false
  let activationRetryTimer: NodeJS.Timeout | undefined
  let activationRetryAttempt = 0
  let initialTask: NodeJS.Immediate | undefined
  let periodicTimer: NodeJS.Timeout | undefined
  let inFlight: Promise<void> | undefined
  let runWhenIdle = false
  let cleanupPending = false
  let activationWaitingForInFlight = false
  let deferredStopCleanup = false
  let latestControl:
    | {
        epoch: number
        requestId: string
        result: Promise<JournalBackupControlResult>
      }
    | undefined

  const clearActivationRetry = (): void => {
    if (activationRetryTimer) clearTimeout(activationRetryTimer)
    activationRetryTimer = undefined
  }

  const schedulePeriodic = (): void => {
    if (stopped || !active || periodicTimer) return
    periodicTimer = setTimeout(() => {
      periodicTimer = undefined
      launch('snapshot')
    }, intervalMs)
    periodicTimer.unref?.()
  }

  const launch = (label: 'initial snapshot' | 'snapshot'): void => {
    if (stopped || !active || inFlight) return
    runWhenIdle = false
    if (cleanupPending) {
      cleanupPending = false
      cleanupStalePartials(options.dir, log)
    }
    const task = Promise.resolve()
      .then(() => takeSnapshot(db, options))
      .then((result) => {
        if (!result.ok) {
          const error = result.error ?? 'snapshot returned an unknown failure'
          onStateChange({ status: 'degraded', error })
          log(`[journal-backup] ${label} failed: ${error}`)
          return
        }
        if (active && !stopped) onStateChange({ status: 'active' })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        onStateChange({ status: 'degraded', error: message })
        log(`[journal-backup] ${label} failed: ${message}`)
      })
      .finally(() => {
        if (inFlight === task) inFlight = undefined
        activationWaitingForInFlight = false
        if (stopped || !active) return
        if (runWhenIdle) scheduleImmediate()
        else schedulePeriodic()
      })
    inFlight = task
  }

  const scheduleImmediate = (): void => {
    if (stopped || !active || inFlight || initialTask) return
    initialTask = setImmediate(() => {
      initialTask = undefined
      launch('initial snapshot')
    })
    initialTask.unref?.()
  }

  const activate = (): string | undefined => {
    if (stopped) return 'backup supervisor is stopped'
    if (active) return undefined
    try {
      // Acquire before stale-partial cleanup or scheduling. A replacement process that loses this race
      // cannot touch an old owner's in-progress partial, even if the old hubctl no longer exists.
      lease.acquire()
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    active = true
    cleanupPending = true
    runWhenIdle = true
    activationWaitingForInFlight = inFlight !== undefined
    scheduleImmediate()
    return undefined
  }

  const attemptActivation = (): JournalBackupActivationResult => {
    const wasActive = active
    const error = activate()
    if (error) {
      onStateChange({ status: 'degraded', error })
      return { ok: false, error }
    }
    if (activationWaitingForInFlight && inFlight) {
      const settlingError =
        'previous journal backup generation is still settling before ownership can resume'
      onStateChange({ status: 'degraded', error: settlingError })
      // The higher epoch is applied immediately so the older pause cannot later release the lease.
      // Health stays degraded until that exact generation settles; no second generation can overlap it.
      return { ok: true }
    }
    activationRetryAttempt = 0
    if (!wasActive) onStateChange({ status: 'active' })
    return { ok: true }
  }

  const scheduleStandaloneActivationRetry = (
    failure: JournalBackupActivationResult & { ok: false }
  ): void => {
    if (stopped || active || activationRetryTimer) return
    const delay =
      activationRetryMs[
        Math.min(activationRetryAttempt, activationRetryMs.length - 1)
      ] ?? DEFAULT_ACTIVATION_RETRY_MS[DEFAULT_ACTIVATION_RETRY_MS.length - 1]
    activationRetryAttempt += 1
    log(
      `[journal-backup] activation retry in ${delay}ms after failure: ${failure.error}`
    )
    activationRetryTimer = setTimeout(() => {
      activationRetryTimer = undefined
      const result = attemptActivation()
      if (!result.ok) scheduleStandaloneActivationRetry(result)
    }, delay)
    activationRetryTimer.unref?.()
  }

  const pause = async (): Promise<void> => {
    clearActivationRetry()
    active = false
    activationWaitingForInFlight = false
    runWhenIdle = false
    if (initialTask) clearImmediate(initialTask)
    initialTask = undefined
    if (periodicTimer) clearTimeout(periodicTimer)
    periodicTimer = undefined
    onStateChange({ status: 'inactive' })
    const current = inFlight
    if (current) await current
    // A higher-epoch resume can arrive while this pause is settling a generation. In that case active is
    // true again and the old pause must neither release the lease nor defeat the resume.
    if (!active) {
      try {
        lease.release()
        onStateChange({ status: 'inactive' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        onStateChange({ status: 'degraded', error: message })
        log(`[journal-backup] pause failed to release ownership: ${message}`)
        throw error
      }
    }
  }

  const controlResult = (
    command: JournalBackupControlCommand,
    applied: boolean,
    error?: string
  ): JournalBackupControlResult => ({
    type: 'journal-backup-control-result',
    requestId: command.requestId,
    epoch: command.epoch,
    active,
    applied,
    ...(error ? { error } : {}),
  })

  const applyControl = (
    command: JournalBackupControlCommand
  ): Promise<JournalBackupControlResult> => {
    if (
      !Number.isSafeInteger(command.epoch) ||
      command.epoch < 0 ||
      typeof command.requestId !== 'string' ||
      command.requestId.length === 0
    ) {
      return Promise.resolve(controlResult(command, false, 'invalid backup ownership command'))
    }
    if (stopped) {
      return Promise.resolve(controlResult(command, false, 'backup supervisor is stopped'))
    }
    if (
      latestControl?.epoch === command.epoch &&
      latestControl.requestId === command.requestId
    ) {
      return latestControl.result
    }
    if (latestControl && command.epoch <= latestControl.epoch) {
      return Promise.resolve(controlResult(command, false))
    }

    // Defer the operation one microtask so latestControl is installed before a synchronous activation
    // result is formed. A pause mutates `active` before awaiting; a newer resume can therefore supersede
    // it while the old in-flight generation settles, and the late pause completion cannot flip it back.
    const result = Promise.resolve().then(async () => {
      let error: string | undefined
      try {
        if (command.active) {
          const activation = attemptActivation()
          if (!activation.ok) error = activation.error
        } else {
          await pause()
        }
      } catch (controlError) {
        error =
          controlError instanceof Error ? controlError.message : String(controlError)
      }
      const stillCurrent =
        latestControl?.epoch === command.epoch &&
        latestControl.requestId === command.requestId
      return controlResult(command, stillCurrent && !error, error)
    })
    latestControl = {
      epoch: command.epoch,
      requestId: command.requestId,
      result,
    }
    return result
  }

  return {
    activateStandalone(): JournalBackupActivationResult {
      const result = attemptActivation()
      if (!result.ok) {
        log(`[journal-backup] standalone activation failed: ${result.error}`)
        scheduleStandaloneActivationRetry(result)
      }
      return result
    },
    applyControl(command): Promise<JournalBackupControlResult> {
      return applyControl(command)
    },
    pause(): Promise<void> {
      return pause()
    },
    async stop(): Promise<void> {
      stopped = true
      clearActivationRetry()
      active = false
      activationWaitingForInFlight = false
      runWhenIdle = false
      if (initialTask) clearImmediate(initialTask)
      initialTask = undefined
      if (periodicTimer) clearTimeout(periodicTimer)
      periodicTimer = undefined
      onStateChange({ status: 'inactive' })

      const current = inFlight
      if (!current) {
        lease.release()
        return
      }

      let timeout: NodeJS.Timeout | undefined
      const settled = await Promise.race([
        current.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), shutdownWaitMs)
        }),
      ])
      if (timeout) clearTimeout(timeout)
      if (settled) {
        lease.release()
        onStateChange({ status: 'inactive' })
        return
      }

      const error = `journal backup generation did not settle within ${shutdownWaitMs}ms shutdown guard`
      onStateChange({ status: 'degraded', error })
      log(`[journal-backup] ${error}; process exit will contain the unpublished partial`)
      if (!deferredStopCleanup) {
        deferredStopCleanup = true
        void current.then(() => {
          try {
            lease.release()
            onStateChange({ status: 'inactive' })
          } catch (releaseError) {
            const message =
              releaseError instanceof Error ? releaseError.message : String(releaseError)
            onStateChange({ status: 'degraded', error: message })
            log(`[journal-backup] deferred shutdown lease release failed: ${message}`)
          }
        })
      }
    },
  }
}
