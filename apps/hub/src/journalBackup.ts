import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

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
 *    already broken. A snapshot that fails quick_check is deleted and reported, never retained as if it
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
  /** Injectable for tests. */
  now?: () => Date
  log?: (message: string) => void
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000
const DEFAULT_KEEP = 6
const PREFIX = 'hub-'
const SUFFIX = '.db'

export interface SnapshotResult {
  ok: boolean
  file?: string
  bytes?: number
  error?: string
}

export type JournalSnapshotTask = (
  db: Database.Database,
  options: JournalBackupOptions
) => Promise<SnapshotResult>

export interface JournalBackupSupervisor {
  /**
   * Declare that the HTTP server has bound and announced readiness. Idempotent; no backup work or timer
   * exists before this call.
   */
  serverReady(): void
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
  fs.mkdirSync(options.dir, { recursive: true })

  const stamp = now().toISOString().replace(/[:.]/g, '-')
  const target = path.join(options.dir, `${PREFIX}${stamp}${SUFFIX}`)
  let sourceHadEvents = false
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
    await db.backup(target)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`[journal-backup] snapshot FAILED: ${message}`)
    try {
      fs.rmSync(target, { force: true })
    } catch {
      /* nothing to clean up */
    }
    return { ok: false, error: message }
  }

  const verified = options.verify ? options.verify(target) : defaultVerify(target, sourceHadEvents)
  if (!verified) {
    // A snapshot that does not pass its own integrity check is worse than none: it would sit there
    // looking like insurance. Remove it and say so loudly.
    log(`[journal-backup] snapshot at ${target} FAILED verification and was discarded — the live journal may already be damaged`)
    try {
      fs.rmSync(target, { force: true })
    } catch {
      /* best effort */
    }
    return { ok: false, error: 'snapshot failed integrity verification' }
  }

  const bytes = fs.statSync(target).size
  log(`[journal-backup] verified snapshot ${path.basename(target)} (${(bytes / 1_048_576).toFixed(1)} MB)`)
  rotate(options.dir, options.keep ?? DEFAULT_KEEP, log)
  return { ok: true, file: target, bytes }
}

function hasAnyEvents(db: Pick<Database.Database, 'prepare'>): boolean {
  const row = db
    .prepare('SELECT EXISTS(SELECT 1 FROM events LIMIT 1) AS hasEvents')
    .get() as { hasEvents?: unknown } | undefined
  return row?.hasEvents === 1
}

function defaultVerify(file: string, sourceHadEvents: boolean): boolean {
  // Required lazily so this module stays importable in environments without the native addon (tests that
  // only exercise rotation, for instance).
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  let db: import('better-sqlite3').Database | undefined
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    const rows = db.pragma('quick_check') as Array<Record<string, unknown>>
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

function rotate(dir: string, keep: number, log: (m: string) => void): void {
  let entries: string[]
  try {
    entries = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
      .sort()
  } catch {
    return
  }
  // Oldest first; drop from the front only.
  while (entries.length > keep) {
    const victim = entries.shift()
    if (!victim) break
    try {
      fs.rmSync(path.join(dir, victim), { force: true })
      log(`[journal-backup] rotated out ${victim}`)
    } catch {
      /* leaving an extra generation is harmless */
    }
  }
}

/**
 * Supervise initial + periodic backups without putting journal IO on the startup critical path.
 *
 * `serverReady()` is the lifecycle gate: it schedules the initial snapshot for the next event-loop turn,
 * after the listening callback and readiness announcement have returned. Each completion schedules the
 * next interval, so a slow snapshot can never overlap another generation. Timers are unref'd so they do
 * not hold the hub open; `stop()` clears pending work and joins the single in-flight promise.
 */
export function createJournalBackupSupervisor(
  db: Database.Database,
  options: JournalBackupOptions,
  takeSnapshot: JournalSnapshotTask = snapshotJournal
): JournalBackupSupervisor {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const log = options.log ?? (() => {})
  let ready = false
  let stopped = false
  let initialTask: NodeJS.Immediate | undefined
  let periodicTimer: NodeJS.Timeout | undefined
  let inFlight: Promise<void> | undefined

  const schedulePeriodic = (): void => {
    if (stopped) return
    periodicTimer = setTimeout(() => {
      periodicTimer = undefined
      launch('snapshot')
    }, intervalMs)
    periodicTimer.unref?.()
  }

  const launch = (label: 'initial snapshot' | 'snapshot'): void => {
    if (stopped || inFlight) return
    const task = Promise.resolve()
      .then(() => takeSnapshot(db, options))
      .then(() => undefined)
      .catch((error: unknown) => {
        log(`[journal-backup] ${label} failed: ${String(error)}`)
      })
      .finally(() => {
        if (inFlight === task) inFlight = undefined
        schedulePeriodic()
      })
    inFlight = task
  }

  return {
    serverReady(): void {
      if (ready || stopped) return
      ready = true
      // One snapshot promptly after readiness. setImmediate is a lifecycle yield, not a time guess: the
      // server's listening callback (including its supervisor-ready IPC) completes before backup IO begins.
      initialTask = setImmediate(() => {
        initialTask = undefined
        launch('initial snapshot')
      })
      initialTask.unref?.()
    },
    async stop(): Promise<void> {
      stopped = true
      if (initialTask) clearImmediate(initialTask)
      initialTask = undefined
      if (periodicTimer) clearTimeout(periodicTimer)
      periodicTimer = undefined
      const active = inFlight
      if (active) await active
    },
  }
}
