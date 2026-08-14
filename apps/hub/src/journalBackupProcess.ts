import { fork, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  cleanupJournalBackupPartials,
  journalBackupCopyWallMs,
  type JournalBackupOptions,
  type JournalSnapshotTask,
  type SnapshotResult,
} from './journalBackup.js'
import type { JournalProgressUpdate } from './journalProgress.js'

type SerializableBackupOptions = Pick<
  JournalBackupOptions,
  | 'dir'
  | 'keep'
  | 'maxRetainedBytes'
  | 'minimumFreeBytes'
  | 'minimumSnapshotAgeMs'
  | 'maxCopyWallMs'
  | 'maxCopyWorkRatio'
  | 'maxCopyRestarts'
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
    ...(options.minimumSnapshotAgeMs !== undefined
      ? { minimumSnapshotAgeMs: options.minimumSnapshotAgeMs }
      : {}),
    ...(options.maxCopyWallMs !== undefined ? { maxCopyWallMs: options.maxCopyWallMs } : {}),
    ...(options.maxCopyWorkRatio !== undefined
      ? { maxCopyWorkRatio: options.maxCopyWorkRatio }
      : {}),
    ...(options.maxCopyRestarts !== undefined
      ? { maxCopyRestarts: options.maxCopyRestarts }
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
      let copyDeadline: NodeJS.Timeout | undefined
      let forcedCopyFailure: string | undefined
      const clearCopyDeadline = (): void => {
        if (copyDeadline) clearTimeout(copyDeadline)
        copyDeadline = undefined
      }
      const finish = (result: SnapshotResult): void => {
        if (settled) return
        settled = true
        clearCopyDeadline()
        resolve(result)
      }
      child.on('message', (raw: unknown) => {
        const message = raw as BackupWorkerMessage
        if (message?.type === 'journal-backup-log') {
          options.log?.(message.message)
        } else if (message?.type === 'journal-backup-progress') {
          if (message.progress.active && message.progress.phase === 'copying') {
            copyDeadline ??= setTimeout(() => {
              forcedCopyFailure =
                `journal snapshot copy exceeded its ${journalBackupCopyWallMs(options.maxCopyWallMs)}ms ` +
                `out-of-process wall-clock budget and was terminated`
              try {
                child.kill('SIGKILL')
              } catch {
                /* exit handling below owns the terminal result */
              }
            }, journalBackupCopyWallMs(options.maxCopyWallMs) + 1_000)
          } else {
            clearCopyDeadline()
          }
          options.onProgress?.(message.progress)
        } else if (message?.type === 'journal-backup-result') {
          // A send callback in the worker does not mean this handler has run yet. Acknowledge the
          // terminal frame before allowing the child to exit so Windows cannot deliver `exit` first
          // and turn a successful, published snapshot into a false maintenance failure.
          if (child.connected) {
            try {
              child.send({ type: 'journal-backup-result-ack' }, () => {})
            } catch {
              /* the result is already durable in this process; child teardown is best effort */
            }
          }
          finish(message.result)
        }
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearCopyDeadline()
        reject(error)
      })
      child.once('exit', (code, signal) => {
        children.delete(child)
        if (settled) return
        if (forcedCopyFailure) {
          cleanupJournalBackupPartials(options.dir, options.log)
          finish({ ok: false, error: forcedCopyFailure })
          return
        }
        settled = true
        clearCopyDeadline()
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
