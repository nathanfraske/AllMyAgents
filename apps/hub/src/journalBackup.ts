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

  const verify = options.verify ?? defaultVerify
  if (!verify(target)) {
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

function defaultVerify(file: string): boolean {
  // Required lazily so this module stays importable in environments without the native addon (tests that
  // only exercise rotation, for instance).
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  let db: import('better-sqlite3').Database | undefined
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    const rows = db.pragma('quick_check') as Array<Record<string, unknown>>
    const findings = rows.flatMap((row) => Object.values(row).map(String))
    if (findings.length !== 1 || findings[0]?.toLowerCase() !== 'ok') return false
    // Presence of the events table matters as much as structural integrity: a schema-only file passes
    // quick_check happily, and a schema-only file is exactly what a truncation looks like.
    db.prepare('SELECT COUNT(*) AS n FROM events').get()
    return true
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

/** Start periodic snapshots. Returns a stop function. The timer is unref'd so it never holds the hub open. */
export function startJournalBackups(db: Database.Database, options: JournalBackupOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const log = options.log ?? (() => {})
  let stopped = false

  // One snapshot promptly after boot. If the hub is about to be killed — by an update, a supervisor, or a
  // forced reboot — the most valuable copy is the one taken before that happens, not thirty minutes in.
  void snapshotJournal(db, options).catch((e: unknown) => log(`[journal-backup] initial snapshot failed: ${String(e)}`))

  const timer = setInterval(() => {
    if (stopped) return
    void snapshotJournal(db, options).catch((e: unknown) => log(`[journal-backup] snapshot failed: ${String(e)}`))
  }, intervalMs)
  timer.unref?.()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
