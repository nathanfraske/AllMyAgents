import Database from 'better-sqlite3'
import { snapshotJournal, type JournalBackupOptions, type SnapshotResult } from './journalBackup.js'
import type { JournalProgressUpdate } from './journalProgress.js'

type BackupWorkerMessage =
  | { type: 'journal-backup-log'; message: string }
  | { type: 'journal-backup-progress'; progress: JournalProgressUpdate }
  | { type: 'journal-backup-result'; result: SnapshotResult }

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
  await send({ type: 'journal-backup-result', result })
}

await main()
