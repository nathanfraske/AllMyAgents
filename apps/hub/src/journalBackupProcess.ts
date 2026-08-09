import { fork, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type {
  JournalBackupOptions,
  JournalSnapshotTask,
  SnapshotResult,
} from './journalBackup.js'
import type { JournalProgressUpdate } from './journalProgress.js'

type SerializableBackupOptions = Pick<
  JournalBackupOptions,
  | 'dir'
  | 'keep'
  | 'maxRetainedBytes'
  | 'minimumFreeBytes'
  | 'recoveryDataDir'
  | 'recoveryKeep'
  | 'recoveryMaxRetainedBytes'
>

type BackupWorkerMessage =
  | { type: 'journal-backup-log'; message: string }
  | { type: 'journal-backup-progress'; progress: JournalProgressUpdate }
  | { type: 'journal-backup-result'; result: SnapshotResult }

function serializableOptions(options: JournalBackupOptions): SerializableBackupOptions {
  return {
    dir: options.dir,
    ...(options.keep !== undefined ? { keep: options.keep } : {}),
    ...(options.maxRetainedBytes !== undefined
      ? { maxRetainedBytes: options.maxRetainedBytes }
      : {}),
    ...(options.minimumFreeBytes !== undefined
      ? { minimumFreeBytes: options.minimumFreeBytes }
      : {}),
    ...(options.recoveryDataDir !== undefined
      ? { recoveryDataDir: options.recoveryDataDir }
      : {}),
    ...(options.recoveryKeep !== undefined ? { recoveryKeep: options.recoveryKeep } : {}),
    ...(options.recoveryMaxRetainedBytes !== undefined
      ? { recoveryMaxRetainedBytes: options.recoveryMaxRetainedBytes }
      : {}),
  }
}

/**
 * Run the complete copy + integrity verification + lineage publication pipeline outside the hub.
 *
 * `better-sqlite3` integrity checks, SHA-256 reads, and recovery-generation verification are synchronous.
 * Running them on the HTTP/WebSocket process froze every renderer for 8-30 seconds on a 1.7 GB journal.
 * The supervisor still owns scheduling and blue/green exclusion; this task only moves one owned generation
 * into a child whose lifetime remains tied to the hub process.
 */
export function createJournalSnapshotChildTask(journalPath: string): JournalSnapshotTask {
  const children = new Set<ChildProcess>()
  process.once('exit', () => {
    for (const child of children) {
      try {
        child.kill()
      } catch {
        /* process exit already makes an incomplete .partial non-authoritative */
      }
    }
  })

  return async (_db, options): Promise<SnapshotResult> => {
    if (options.now || options.availableBytes) {
      throw new Error('injected journal backup probes are not supported by the production child task')
    }
    const sourceMode = import.meta.url.endsWith('.ts')
    const entry = path.join(
      import.meta.dirname,
      sourceMode ? 'journalBackupWorker.ts' : 'journalBackupWorker.js'
    )
    const execArgv = sourceMode
      ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href]
      : []

    return await new Promise<SnapshotResult>((resolve, reject) => {
      const child = fork(
        entry,
        [journalPath, JSON.stringify(serializableOptions(options))],
        { execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
      )
      children.add(child)
      let settled = false
      const finish = (result: SnapshotResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      child.on('message', (raw: unknown) => {
        const message = raw as BackupWorkerMessage
        if (message?.type === 'journal-backup-log') {
          options.log?.(message.message)
        } else if (message?.type === 'journal-backup-progress') {
          options.onProgress?.(message.progress)
        } else if (message?.type === 'journal-backup-result') {
          finish(message.result)
        }
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
      child.once('exit', (code, signal) => {
        children.delete(child)
        if (settled) return
        settled = true
        reject(
          new Error(
            `journal backup worker exited without a result (${
              signal ? `signal ${signal}` : `code ${String(code)}`
            })`
          )
        )
      })
    })
  }
}
