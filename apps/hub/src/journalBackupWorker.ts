import Database from 'better-sqlite3'
import { snapshotJournal, type JournalBackupOptions, type SnapshotResult } from './journalBackup.js'
import type { JournalProgressUpdate } from './journalProgress.js'

type BackupWorkerMessage =
  | { type: 'journal-backup-log'; message: string }
  | { type: 'journal-backup-progress'; progress: JournalProgressUpdate }
  | { type: 'journal-backup-result'; result: SnapshotResult }

type BackupParentMessage = { type: 'journal-backup-result-ack' }

const [journalPath, rawOptions] = process.argv.slice(2)

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 512)
}

function send(message: BackupWorkerMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) {
      resolve()
      return
    }
    try {
      process.send(message, () => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * Keep the worker alive until the parent has actually consumed the terminal result.
 *
 * `process.send(..., callback)` only confirms that Node handed the frame to the IPC channel. On
 * Windows the child can then exit with code 0 before the parent's `message` callback runs, so a fully
 * published and verified snapshot was occasionally reported as "worker exited without a result".
 * The explicit acknowledgement makes terminal delivery a protocol invariant rather than an event-loop
 * timing assumption. The timeout is only a child-leak backstop when the parent has already disappeared.
 */
function sendResult(result: SnapshotResult): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) {
      resolve()
      return
    }
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)
      process.off('disconnect', finish)
      resolve()
    }
    const onMessage = (raw: unknown): void => {
      const message = raw as BackupParentMessage
      if (message?.type === 'journal-backup-result-ack') finish()
    }
    // The parent hub should acknowledge immediately, but another synchronous native operation can
    // briefly delay its event loop. IPC disconnect resolves at once when the parent is actually gone;
    // this longer timer is only a last-resort guard for a live but permanently wedged parent.
    const timeout = setTimeout(finish, 30_000)
    process.on('message', onMessage)
    process.once('disconnect', finish)
    try {
      process.send({ type: 'journal-backup-result', result }, (error) => {
        if (error) finish()
      })
    } catch {
      finish()
    }
  })
}

async function main(): Promise<void> {
  let db: Database.Database | undefined
  let result: SnapshotResult
  try {
    if (!journalPath) throw new Error('journal backup worker requires a database path')
    if (!rawOptions) throw new Error('journal backup worker requires serialized options')
    const options = JSON.parse(rawOptions) as JournalBackupOptions
    if (!options || typeof options.dir !== 'string' || options.dir.length === 0) {
      throw new Error('journal backup worker options are invalid')
    }
    db = new Database(journalPath, { fileMustExist: true })
    db.pragma('busy_timeout = 30000')
    result = await snapshotJournal(db, {
      ...options,
      log: (message) => void send({ type: 'journal-backup-log', message }),
      onProgress: (progress) =>
        void send({ type: 'journal-backup-progress', progress }),
    })
  } catch (error) {
    result = { ok: false, error: boundedError(error) }
  } finally {
    try {
      db?.close()
    } catch (error) {
      result = { ok: false, error: `journal backup worker close failed: ${boundedError(error)}` }
    }
  }
  await sendResult(result)
  if (process.connected) process.disconnect()
}

await main()
