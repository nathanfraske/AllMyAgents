import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const LEASE_FILE = '.journal-backup-owner.sqlite'
const require = createRequire(import.meta.url)

/**
 * A crash-released, cross-process ownership fence for one backup directory.
 *
 * Parent-side epochs prevent stale IPC commands inside one hubctl lifetime, but they cannot survive the
 * parent process. SQLite's own exclusive transaction is the independent fence: the OS releases it when
 * the owning hub dies, while a detached hub that survives its parent keeps it. No age heuristic, PID
 * probe, or arbitrary delay is involved.
 */
export class JournalBackupLease {
  private db: import('better-sqlite3').Database | undefined

  constructor(
    private readonly dir: string,
    private readonly log: (message: string) => void
  ) {}

  acquire(): void {
    if (this.db) return
    fs.mkdirSync(this.dir, { recursive: true })
    const leaseFile = path.join(this.dir, LEASE_FILE)
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    let candidate: import('better-sqlite3').Database | undefined
    try {
      candidate = new Database(leaseFile, { timeout: 0 })
      // DELETE mode gives BEGIN EXCLUSIVE one ordinary filesystem lock with process-death cleanup.
      // The lease database stores no journal data and never participates in snapshot rotation.
      candidate.pragma('journal_mode = DELETE')
      candidate.exec('BEGIN EXCLUSIVE')
      this.db = candidate
      this.log(`[journal-backup] acquired cross-process lease ${leaseFile}`)
    } catch (error) {
      try {
        candidate?.close()
      } catch {
        /* the acquisition error is the useful one */
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`journal backup lease is owned by another process or unavailable: ${message}`)
    }
  }

  release(): void {
    const held = this.db
    if (!held) return
    this.db = undefined
    let failure: unknown
    try {
      held.exec('ROLLBACK')
    } catch (error) {
      failure = error
    }
    try {
      held.close()
    } catch (error) {
      failure ??= error
    }
    if (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      throw new Error(`journal backup lease release failed: ${message}`)
    }
    this.log('[journal-backup] released cross-process lease')
  }
}
