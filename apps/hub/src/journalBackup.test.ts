import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Journal } from './journal.js'
import {
  createJournalBackupSupervisor,
  pruneJournalBackupGenerations,
  sizeAwareJournalBackupIntervalMs,
  snapshotJournal,
  type SnapshotResult,
} from './journalBackup.js'

/**
 * The operator's journal was corrupted twice in two days and truncated once, and the only copy that saved
 * their history was one a human happened to take by hand. These tests cover the two properties that make
 * an automatic backup worth having: it must be CONSISTENT while the hub is writing, and it must never
 * retain a snapshot it cannot verify.
 */

const dirs: string[] = []
const journals: Journal[] = []
const servers: http.Server[] = []
const children: ChildProcess[] = []
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-journal-backup-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.useRealTimers()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  }
  for (const server of servers.splice(0)) {
    if (!server.listening) continue
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const j of journals.splice(0)) {
    try {
      j.db.close()
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function makeJournal(root: string, events = 50): Journal {
  const journal = new Journal(path.join(root, 'hub.db'))
  journals.push(journal)
  for (let i = 0; i < events; i++) journal.append(`session-${i % 3}`, 'test/event', { i })
  return journal
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function get(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', reject)
  })
}

function spawnEvalModule(source: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '--eval', source],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  )
  children.push(child)
  return child
}

function spawnBuiltEvalModule(source: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  )
  children.push(child)
  return child
}

async function buildHubForEsmRuntime(): Promise<string> {
  const hubRoot = path.resolve(import.meta.dirname, '..')
  const buildRoot = fs.mkdtempSync(path.join(hubRoot, '.journal-backup-esm-'))
  dirs.push(buildRoot)
  const outDir = path.join(buildRoot, 'dist')
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  const compiler = spawn(
    process.execPath,
    [tsc, '-p', path.join(hubRoot, 'tsconfig.build.json'), '--outDir', outDir],
    {
      cwd: hubRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  children.push(compiler)
  let output = ''
  compiler.stdout?.setEncoding('utf8')
  compiler.stderr?.setEncoding('utf8')
  compiler.stdout?.on('data', (chunk: string) => (output += chunk))
  compiler.stderr?.on('data', (chunk: string) => (output += chunk))
  const [code, signal] = await once(compiler, 'exit') as [
    number | null,
    NodeJS.Signals | null,
  ]
  if (code !== 0) {
    throw new Error(
      `temporary hub ESM build failed (code=${String(code)} signal=${String(signal)}): ${output}`
    )
  }
  return pathToFileURL(path.join(outDir, 'journalBackup.js')).href
}

function spawnBackupSupervisorChild(backups: string): ChildProcess {
  const backupModule = pathToFileURL(path.join(import.meta.dirname, 'journalBackup.ts')).href
  return spawnEvalModule(`
    const fs = await import('node:fs')
    const { createJournalBackupSupervisor } = await import(${JSON.stringify(backupModule)})
    let releaseSnapshot
    const snapshotGate = new Promise((resolve) => {
      releaseSnapshot = resolve
    })
    fs.mkdirSync(${JSON.stringify(backups)}, { recursive: true })
    const backups = createJournalBackupSupervisor(
      {},
      { dir: ${JSON.stringify(backups)}, intervalMs: 60_000 },
      async () => {
        const partial = ${JSON.stringify(path.join(backups, 'hub-held.db.partial'))}
        fs.writeFileSync(partial, String(process.pid))
        process.send?.({ type: 'snapshot-started', partial })
        await snapshotGate
        return { ok: true }
      }
    )
    process.on('message', (message) => {
      if (message?.type === 'release-snapshot') {
        releaseSnapshot()
        return
      }
      if (message?.type !== 'journal-backup-control') return
      void backups.applyControl(message).then((result) => process.send?.({
        type: 'control-result',
        result
      }))
    })
    process.send?.({ type: 'child-ready' })
    setInterval(() => {}, 60_000)
  `)
}

function spawnHungRetireChild(backups: string): ChildProcess {
  const backupModule = pathToFileURL(path.join(import.meta.dirname, 'journalBackup.ts')).href
  return spawnEvalModule(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { createJournalBackupSupervisor } = await import(${JSON.stringify(backupModule)})
    fs.mkdirSync(${JSON.stringify(backups)}, { recursive: true })
    const partial = path.join(${JSON.stringify(backups)}, 'hub-never-resolving.db.partial')
    const backups = createJournalBackupSupervisor(
      {},
      {
        dir: ${JSON.stringify(backups)},
        intervalMs: 60_000,
        shutdownWaitMs: 50
      },
      async () => {
        fs.writeFileSync(partial, String(process.pid))
        process.send?.({ type: 'snapshot-started', partial })
        await new Promise(() => {})
      }
    )
    let retiring = false
    const retire = () => {
      if (retiring) return
      retiring = true
      void backups.stop().then(() => {
        if (!process.send) process.exit(0)
        process.send({ type: 'retire-stopped' }, () => process.exit(0))
      })
    }
    process.on('message', (message) => {
      if (message?.type === 'journal-backup-control') {
        void backups.applyControl(message).then((result) => process.send?.({
          type: 'control-result',
          result
        }))
        return
      }
      if (message?.type !== 'retire') return
      retire()
    })
    process.on('SIGTERM', retire)
    process.send?.({ type: 'child-ready' })
    setInterval(() => {}, 60_000)
  `)
}

function waitForChildMessage<T extends { type: string }>(
  child: ChildProcess,
  type: T['type'],
  timeoutMs = 20_000
): Promise<T> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => (stderr += chunk))
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`child timed out waiting for ${type}${stderr ? `: ${stderr}` : ''}`))
    }, timeoutMs)
    const onMessage = (raw: unknown): void => {
      const message = raw as T & { error?: string }
      if (message?.type === 'snapshot-error') {
        cleanup()
        reject(new Error(message.error ?? 'snapshot child failed'))
        return
      }
      if (message?.type !== type) return
      cleanup()
      resolve(message)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(new Error(`child exited before ${type} (code=${String(code)} signal=${String(signal)})${stderr ? `: ${stderr}` : ''}`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
  })
}

async function controlBackupChild(
  child: ChildProcess,
  requestId: string,
  epoch: number,
  active: boolean
): Promise<{
  type: 'journal-backup-control-result'
  requestId: string
  epoch: number
  active: boolean
  applied: boolean
  error?: string
}> {
  const response = waitForChildMessage<{
    type: 'control-result'
    result: {
      type: 'journal-backup-control-result'
      requestId: string
      epoch: number
      active: boolean
      applied: boolean
      error?: string
    }
  }>(child, 'control-result')
  child.send({
    type: 'journal-backup-control',
    requestId,
    epoch,
    active,
  })
  return (await response).result
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

async function snapshotInChild(
  sourceFile: string,
  backups: string,
  timestamp: string
): Promise<SnapshotResult> {
  const backupModule = pathToFileURL(path.join(import.meta.dirname, 'journalBackup.ts')).href
  const databaseModule = pathToFileURL(createRequire(import.meta.url).resolve('better-sqlite3')).href
  const child = spawnEvalModule(`
    if (typeof require !== 'undefined') {
      throw new Error('snapshot child unexpectedly has a CommonJS require global')
    }
    const [{ snapshotJournal }, databaseModule] = await Promise.all([
      import(${JSON.stringify(backupModule)}),
      import(${JSON.stringify(databaseModule)})
    ])
    const Database = databaseModule.default
    const db = new Database(${JSON.stringify(sourceFile)}, { readonly: true, fileMustExist: true })
    try {
      const result = await snapshotJournal(db, {
        dir: ${JSON.stringify(backups)},
        now: () => new Date(${JSON.stringify(timestamp)})
      })
      await new Promise((resolve, reject) => process.send?.(
        { type: 'snapshot-result', result },
        (error) => error ? reject(error) : resolve()
      ))
    } catch (error) {
      process.send?.({ type: 'snapshot-error', error: String(error) })
    } finally {
      db.close()
      process.disconnect?.()
    }
  `)
  const message = await waitForChildMessage<{
    type: 'snapshot-result'
    result: SnapshotResult
  }>(child, 'snapshot-result')
  await waitForExit(child)
  return message.result
}

async function snapshotBuiltEsmInChild(
  sourceFile: string,
  backups: string,
  timestamp: string
): Promise<SnapshotResult> {
  const backupModule = await buildHubForEsmRuntime()
  const databaseModule = pathToFileURL(createRequire(import.meta.url).resolve('better-sqlite3')).href
  const child = spawnBuiltEvalModule(`
    if (typeof require !== 'undefined') {
      throw new Error('compiled snapshot child unexpectedly has a CommonJS require global')
    }
    const [{ snapshotJournal }, databaseModule] = await Promise.all([
      import(${JSON.stringify(backupModule)}),
      import(${JSON.stringify(databaseModule)})
    ])
    const Database = databaseModule.default
    const db = new Database(${JSON.stringify(sourceFile)}, { readonly: true, fileMustExist: true })
    try {
      const result = await snapshotJournal(db, {
        dir: ${JSON.stringify(backups)},
        now: () => new Date(${JSON.stringify(timestamp)})
      })
      await new Promise((resolve, reject) => process.send?.(
        { type: 'snapshot-result', result },
        (error) => error ? reject(error) : resolve()
      ))
    } catch (error) {
      process.send?.({ type: 'snapshot-error', error: String(error) })
    } finally {
      db.close()
      process.disconnect?.()
    }
  `)
  const message = await waitForChildMessage<{
    type: 'snapshot-result'
    result: SnapshotResult
  }>(child, 'snapshot-result')
  await waitForExit(child)
  return message.result
}

async function interruptSnapshotInChild(backups: string): Promise<string> {
  const backupModule = pathToFileURL(path.join(import.meta.dirname, 'journalBackup.ts')).href
  const child = spawnEvalModule(`
    const fs = await import('node:fs')
    const { snapshotJournal } = await import(${JSON.stringify(backupModule)})
    const db = {
      prepare: () => ({ get: () => ({ hasEvents: 1 }) }),
      backup: async (target) => {
        fs.writeFileSync(target, 'not a verified sqlite database')
        process.send?.({ type: 'partial-created', target })
        await new Promise(() => {})
      }
    }
    await snapshotJournal(db, { dir: ${JSON.stringify(backups)} })
  `)
  const message = await waitForChildMessage<{
    type: 'partial-created'
    target: string
  }>(child, 'partial-created')
  child.kill('SIGKILL')
  await waitForExit(child)
  return message.target
}

describe('journal snapshots', () => {
  it('uses a size-aware cadence instead of copying a multi-gigabyte journal every 30 minutes', () => {
    expect(sizeAwareJournalBackupIntervalMs(128 * 1024 * 1024)).toBe(30 * 60 * 1000)
    expect(sizeAwareJournalBackupIntervalMs(1024 * 1024 * 1024)).toBe(2 * 60 * 60 * 1000)
    expect(sizeAwareJournalBackupIntervalMs(3 * 1024 * 1024 * 1024)).toBe(6 * 60 * 60 * 1000)
  })

  it('reuses a recent verified lineage generation on activation', async () => {
    const root = tmp()
    const journal = makeJournal(root, 5)
    const backups = path.join(root, 'backups')
    const first = await snapshotJournal(journal.db, { dir: backups, recoveryDataDir: root })
    const second = await snapshotJournal(journal.db, {
      dir: backups,
      recoveryDataDir: root,
      minimumSnapshotAgeMs: 60_000,
    })

    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true, skipped: true, file: first.file })
    expect(fs.readdirSync(backups).filter((name) => name.endsWith('.db'))).toHaveLength(1)
  })

  it('prunes a legacy backup pile idempotently without touching the newest evidence', () => {
    const root = tmp()
    const backups = path.join(root, 'backups')
    fs.mkdirSync(backups, { recursive: true })
    for (const stamp of ['01', '02', '03', '04']) {
      const name = `hub-2026-08-14T00-00-${stamp}.db`
      fs.writeFileSync(path.join(backups, name), Buffer.alloc(12))
      fs.writeFileSync(path.join(backups, `${name}-wal`), Buffer.alloc(0))
    }

    pruneJournalBackupGenerations(backups, 2, 1024)
    pruneJournalBackupGenerations(backups, 2, 1024)
    expect(fs.readdirSync(backups).filter((name) => name.endsWith('.db')).sort()).toEqual([
      'hub-2026-08-14T00-00-03.db',
      'hub-2026-08-14T00-00-04.db',
    ])
    expect(fs.readdirSync(backups).some((name) => name.includes('01.db'))).toBe(false)
  })

  it('writes a verified snapshot containing the journal contents', async () => {
    const root = tmp()
    const journal = makeJournal(root, 40)
    const backups = path.join(root, 'backups')

    const result = await snapshotJournal(journal.db, { dir: backups })
    expect(result.ok).toBe(true)
    expect(result.file).toBeDefined()

    // The point of a snapshot is that the DATA is in it — a file of the right size proves nothing.
    const Database = (await import('better-sqlite3')).default
    const copy = new Database(result.file as string, { readonly: true })
    expect((copy.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(40)
    expect(copy.pragma('quick_check')).toEqual([{ quick_check: 'ok' }])
    expect(copy.pragma('journal_mode', { simple: true })).toBe('delete')
    copy.close()
  })

  it('reports copy progress and protects synchronous verification and lineage publication', async () => {
    const root = tmp()
    const journal = makeJournal(root, 40)
    const backups = path.join(root, 'backups')
    const progress: Array<{
      phase: string
      active: boolean
      suspendWatchdog?: boolean
      operationId: string
    }> = []

    const result = await snapshotJournal(journal.db, {
      dir: backups,
      recoveryDataDir: root,
      onProgress: (update) => progress.push(update),
    })

    expect(result.ok).toBe(true)
    expect(new Set(progress.map((update) => update.operationId)).size).toBe(1)
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'copying', active: true, suspendWatchdog: false }),
        expect.objectContaining({
          phase: 'verifying-snapshot',
          active: true,
          suspendWatchdog: true,
        }),
        expect.objectContaining({
          phase: 'publishing-lineage',
          active: true,
          suspendWatchdog: true,
        }),
        expect.objectContaining({ phase: 'completed', active: false, suspendWatchdog: false }),
      ])
    )
  })

  it('verifies and retains a snapshot through the compiled Node ESM runtime without a require global', async () => {
    const root = tmp()
    const journal = makeJournal(root, 3)
    const backups = path.join(root, 'backups')

    const result = await snapshotBuiltEsmInChild(
      path.join(root, 'hub.db'),
      backups,
      '2026-07-29T12:00:00.000Z'
    )

    expect(result.ok).toBe(true)
    expect(result.file).toEqual(expect.stringMatching(/\.db$/))
    expect(fs.existsSync(result.file as string)).toBe(true)
    expect(fs.readdirSync(backups).filter((name) => name.endsWith('.partial'))).toEqual([])

    const Database = (await import('better-sqlite3')).default
    const copy = new Database(result.file as string, { readonly: true, fileMustExist: true })
    expect(copy.pragma('quick_check')).toEqual([{ quick_check: 'ok' }])
    expect(copy.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 3 })
    copy.close()
  }, 60_000)

  it('snapshots a LIVE journal that is still being written', async () => {
    // The failure this guards against is a plain file copy of a database mid-write, which captures a torn
    // file plus a mismatched WAL — the exact state we spent two days recovering from.
    const root = tmp()
    const journal = makeJournal(root, 10)
    const backups = path.join(root, 'backups')
    for (let i = 0; i < 256; i++) {
      journal.append('busy', 'test/large-event', { i, payload: 'x'.repeat(32 * 1024) })
    }

    const writing = setInterval(() => journal.append('busy', 'test/event', { t: Date.now() }), 1)
    let result
    try {
      result = await snapshotJournal(journal.db, { dir: backups })
    } finally {
      clearInterval(writing)
    }
    expect(result.ok).toBe(true)
    expect(result.copyTelemetry).toMatchObject({
      stableReadSnapshot: true,
      restarts: 0,
      totalPages: expect.any(Number),
      pagesTransferred: expect.any(Number),
    })
    expect(result.copyTelemetry?.pagesTransferred).toBeLessThanOrEqual(
      result.copyTelemetry?.totalPages ?? 0,
    )

    const Database = (await import('better-sqlite3')).default
    const copy = new Database(result.file as string, { readonly: true })
    expect(copy.pragma('quick_check')).toEqual([{ quick_check: 'ok' }])
    copy.close()
  })

  it('aborts and cleans a copy that repeatedly restarts instead of transferring without a bound', async () => {
    const root = tmp()
    const journal = makeJournal(root, 1)
    const backups = path.join(root, 'backups')
    const restartLoop = {
      prepare: (sql: string) => journal.db.prepare(sql),
      backup: async (
        target: string,
        options: { progress: (state: { totalPages: number; remainingPages: number }) => number },
      ) => {
        fs.writeFileSync(target, 'incomplete')
        for (const remainingPages of [50, 90, 40, 95]) {
          options.progress({ totalPages: 100, remainingPages })
        }
      },
    } as unknown as typeof journal.db

    const result = await snapshotJournal(restartLoop, {
      dir: backups,
      maxCopyRestarts: 1,
      maxCopyWorkRatio: 3,
    })

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/restart budget/i),
      copyTelemetry: {
        totalPages: 100,
        restarts: 2,
        stableReadSnapshot: false,
      },
    })
    expect(fs.readdirSync(backups).filter((name) => name.includes('.partial'))).toEqual([])
  })

  it('aborts and cleans a copy that exceeds its wall-clock budget', async () => {
    const root = tmp()
    const journal = makeJournal(root, 1)
    const backups = path.join(root, 'backups')
    const stalledCopy = {
      prepare: (sql: string) => journal.db.prepare(sql),
      backup: async (
        target: string,
        options: { progress: (state: { totalPages: number; remainingPages: number }) => number },
      ) => {
        fs.writeFileSync(target, 'incomplete')
        const until = performance.now() + 5
        while (performance.now() < until) {
          // Deliberately consume the tiny test budget before the next native progress callback.
        }
        options.progress({ totalPages: 100, remainingPages: 90 })
      },
    } as unknown as typeof journal.db

    const result = await snapshotJournal(stalledCopy, { dir: backups, maxCopyWallMs: 1 })

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/wall-clock budget/i),
    })
    expect(fs.readdirSync(backups).filter((name) => name.includes('.partial'))).toEqual([])
  })

  it('DISCARDS a snapshot that fails verification instead of keeping it', async () => {
    // An unverified backup is a belief, not a backup. Silent corruption is precisely the case where the
    // thing you saved was already broken, so a snapshot that cannot be verified must not survive to be
    // mistaken for insurance later.
    const root = tmp()
    const journal = makeJournal(root, 5)
    const backups = path.join(root, 'backups')

    const result = await snapshotJournal(journal.db, { dir: backups, verify: () => false })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/verification/i)
    expect(fs.readdirSync(backups).filter((f) => f.endsWith('.db'))).toEqual([])
    expect(fs.readdirSync(backups).filter((f) => f.endsWith('.partial'))).toEqual([])
  })

  it('rotates old verified generations even when the new snapshot fails', async () => {
    const root = tmp()
    const journal = makeJournal(root, 5)
    const backups = path.join(root, 'backups')
    fs.mkdirSync(backups, { recursive: true })
    for (const stamp of ['01', '02', '03', '04']) {
      fs.writeFileSync(path.join(backups, `hub-2026-07-29T00-0${stamp}-00.db`), stamp)
    }

    const result = await snapshotJournal(journal.db, {
      dir: backups,
      keep: 2,
      verify: () => false,
    })

    expect(result.ok).toBe(false)
    expect(fs.readdirSync(backups).filter((name) => name.endsWith('.db')).sort()).toEqual([
      'hub-2026-07-29T00-003-00.db',
      'hub-2026-07-29T00-004-00.db',
    ])
  })

  it('enforces a byte retention budget while preserving the newest verified generation', async () => {
    const root = tmp()
    const journal = makeJournal(root, 5)
    const backups = path.join(root, 'backups')
    fs.mkdirSync(backups, { recursive: true })
    for (const stamp of ['01', '02', '03']) {
      fs.writeFileSync(path.join(backups, `hub-2026-07-29T00-00-${stamp}.db`), Buffer.alloc(12))
    }

    await snapshotJournal(journal.db, {
      dir: backups,
      keep: 10,
      maxRetainedBytes: 20,
      verify: () => false,
    })

    expect(fs.readdirSync(backups).filter((name) => name.endsWith('.db'))).toEqual([
      'hub-2026-07-29T00-00-03.db',
    ])
  })

  it('refuses to start an online backup without room for the source and reserve', async () => {
    const root = tmp()
    const journal = makeJournal(root, 5)
    const backups = path.join(root, 'backups')
    let backupCalled = false
    const source = {
      prepare: (sql: string) => journal.db.prepare(sql),
      pragma: (source: string, options?: { simple?: boolean }) =>
        journal.db.pragma(source, options),
      backup: async () => {
        backupCalled = true
      },
    } as unknown as typeof journal.db

    const result = await snapshotJournal(source, {
      dir: backups,
      availableBytes: () => 0n,
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/insufficient free space/i) })
    expect(backupCalled).toBe(false)
  })

  it('accepts a genuinely empty source journal', async () => {
    const root = tmp()
    const journal = makeJournal(root, 0)
    const backups = path.join(root, 'backups')

    const result = await snapshotJournal(journal.db, { dir: backups })

    expect(result.ok).toBe(true)
    const Database = (await import('better-sqlite3')).default
    const copy = new Database(result.file as string, { readonly: true, fileMustExist: true })
    expect(copy.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 })
    copy.close()
  })

  it('rejects a schema-only snapshot when the source already contained events', async () => {
    const root = tmp()
    const journal = makeJournal(root, 5)
    const backups = path.join(root, 'backups')
    const sourceWithBrokenBackup = {
      prepare: (sql: string) => journal.db.prepare(sql),
      backup: async (target: string) => {
        const empty = new Journal(target)
        empty.db.close()
      },
    } as unknown as typeof journal.db

    const result = await snapshotJournal(sourceWithBrokenBackup, { dir: backups })

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/verification/i) })
    expect(fs.readdirSync(backups).filter((f) => f.endsWith('.db'))).toEqual([])
  })

  it('accepts an empty point-in-time snapshot when an initially empty source gains an event during backup', async () => {
    const root = tmp()
    const journal = makeJournal(root, 0)
    const backups = path.join(root, 'backups')
    const concurrentlyWrittenSource = {
      prepare: (sql: string) => journal.db.prepare(sql),
      backup: async (target: string) => {
        const emptyAtBackupStart = new Journal(target)
        emptyAtBackupStart.db.close()
        journal.append('concurrent', 'test/event', { arrived: 'during backup' })
      },
    } as unknown as typeof journal.db

    const result = await snapshotJournal(concurrentlyWrittenSource, { dir: backups })

    expect(result.ok).toBe(true)
    expect(journal.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
    const Database = (await import('better-sqlite3')).default
    const copy = new Database(result.file as string, { readonly: true, fileMustExist: true })
    expect(copy.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 })
    copy.close()
  })

  it('keeps N generations, dropping the OLDEST first', async () => {
    // Corruption is often noticed long after it starts, so one rolling copy can be overwritten by a bad
    // one before anybody looks. Rotation must cost the oldest generation, never the newest.
    const root = tmp()
    const journal = makeJournal(root, 5)
    const backups = path.join(root, 'backups')
    fs.mkdirSync(backups, { recursive: true })
    const interrupted = path.join(backups, 'hub-interrupted.db.partial')
    fs.writeFileSync(interrupted, 'incomplete')

    let clock = Date.parse('2026-07-29T00:00:00.000Z')
    for (let i = 0; i < 5; i++) {
      await snapshotJournal(journal.db, {
        dir: backups,
        keep: 3,
        now: () => new Date((clock += 60_000)),
      })
    }

    const kept = fs.readdirSync(backups).filter((f) => f.endsWith('.db')).sort()
    expect(kept).toHaveLength(3)
    // The three most recent stamps survive.
    expect(kept[2]).toContain('2026-07-29T00-05-00')
    expect(kept[0]).toContain('2026-07-29T00-03-00')
    expect(fs.existsSync(interrupted)).toBe(true) // rotation considers verified finals only
  })

  it('publishes collision-free verified finals across processes sharing an identical clock', async () => {
    const root = tmp()
    const journal = makeJournal(root, 12)
    const sourceFile = path.join(root, 'hub.db')
    const backups = path.join(root, 'backups')
    const timestamp = '2026-07-29T12:34:56.789Z'

    const [first, second] = await Promise.all([
      snapshotInChild(sourceFile, backups, timestamp),
      snapshotInChild(sourceFile, backups, timestamp),
    ])

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.file).not.toBe(second.file)
    const entries = fs.readdirSync(backups)
    expect(entries.filter((name) => name.endsWith('.db'))).toHaveLength(2)
    expect(entries.filter((name) => name.endsWith('.partial'))).toEqual([])
  })

  it('a forced process exit can leave only a partial, which the next exclusive owner cleans', async () => {
    const root = tmp()
    const backupsDir = path.join(root, 'backups')
    const interruptedTarget = await interruptSnapshotInChild(backupsDir)

    expect(path.dirname(interruptedTarget)).toBe(backupsDir)
    expect(path.basename(interruptedTarget)).toMatch(/\.db\.partial$/)
    expect(fs.readdirSync(backupsDir).filter((name) => name.endsWith('.db'))).toEqual([])
    expect(fs.existsSync(interruptedTarget)).toBe(true)

    const journal = makeJournal(root, 4)
    const published = deferred<SnapshotResult>()
    const backups = createJournalBackupSupervisor(
      journal.db,
      { dir: backupsDir, intervalMs: 60_000 },
      async (db, options) => {
        const result = await snapshotJournal(db, options)
        published.resolve(result)
        return result
      }
    )
    backups.activateStandalone()
    const result = await published.promise
    await backups.stop()

    expect(result.ok).toBe(true)
    expect(fs.existsSync(interruptedTarget)).toBe(false)
    expect(fs.readdirSync(backupsDir).filter((name) => name.endsWith('.partial'))).toEqual([])
  })
})

describe('journal backup lifecycle', () => {
  it.each([
    {
      name: 'returned failure',
      task: async (): Promise<SnapshotResult> => ({
        ok: false,
        error: 'snapshot verification rejected the generation',
      }),
      message: /verification rejected/i,
    },
    {
      name: 'thrown failure',
      task: async (): Promise<SnapshotResult> => {
        throw new Error('snapshot task threw')
      },
      message: /task threw/i,
    },
  ])('surfaces a $name as degraded backup health', async ({ task, message }) => {
    const root = tmp()
    const journal = makeJournal(root, 1)
    const states: Array<{ status: string; error?: string }> = []
    const degraded = deferred<void>()
    const backups = createJournalBackupSupervisor(
      journal.db,
      {
        dir: path.join(root, 'backups'),
        intervalMs: 60_000,
        onStateChange: (state) => {
          states.push(state)
          if (state.status === 'degraded') degraded.resolve()
        },
      },
      task
    )

    backups.activateStandalone()
    await degraded.promise

    expect(states.at(-1)).toMatchObject({
      status: 'degraded',
      error: expect.stringMatching(message),
    })
    await backups.stop()
  })

  it('returns a visible activation failure and can recover after the live lease owner releases', async () => {
    const root = tmp()
    const journal = makeJournal(root, 1)
    const options = { dir: path.join(root, 'backups'), intervalMs: 60_000 }
    const takeSnapshot = async (): Promise<SnapshotResult> => ({ ok: true })
    const owner = createJournalBackupSupervisor(journal.db, options, takeSnapshot)
    const contenderStates: string[] = []
    const contender = createJournalBackupSupervisor(
      journal.db,
      {
        ...options,
        activationRetryMs: [5],
        onStateChange: (state) => contenderStates.push(state.status),
      },
      takeSnapshot
    )

    try {
      expect(owner.activateStandalone()).toEqual({ ok: true })
      expect(contender.activateStandalone()).toMatchObject({
        ok: false,
        error: expect.stringMatching(/lease|owned|locked/i),
      })
      expect(contenderStates).toContain('degraded')

      await owner.stop()
      await vi.waitFor(() => expect(contenderStates.at(-1)).toBe('active'))
      expect(contender.activateStandalone()).toEqual({ ok: true })
    } finally {
      await Promise.allSettled([owner.stop(), contender.stop()])
    }
  })

  it('hands the cross-process lease from settled blue to promoted green', async () => {
    const root = tmp()
    const backupsDir = path.join(root, 'backups')
    const blue = spawnBackupSupervisorChild(backupsDir)
    await waitForChildMessage(blue, 'child-ready')
    const blueSnapshotStarted = waitForChildMessage(blue, 'snapshot-started')
    expect(await controlBackupChild(blue, 'blue-active', 1, true)).toMatchObject({
      applied: true,
      active: true,
    })
    await blueSnapshotStarted

    const paused = controlBackupChild(blue, 'blue-pause', 2, false)
    blue.send({ type: 'release-snapshot' })
    expect(await paused).toMatchObject({ applied: true, active: false })

    const green = spawnBackupSupervisorChild(backupsDir)
    await waitForChildMessage(green, 'child-ready')
    const greenSnapshotStarted = waitForChildMessage(green, 'snapshot-started')
    expect(await controlBackupChild(green, 'green-active', 1, true)).toMatchObject({
      applied: true,
      active: true,
    })
    await greenSnapshotStarted
  })

  it('keeps a surviving hub fenced after supervisor IPC loss and lets a replacement acquire only after owner death', async () => {
    const root = tmp()
    const backupsDir = path.join(root, 'backups')
    const survivingHub = spawnBackupSupervisorChild(backupsDir)
    await waitForChildMessage(survivingHub, 'child-ready')
    const oldSnapshotStarted = waitForChildMessage(survivingHub, 'snapshot-started')
    expect(await controlBackupChild(survivingHub, 'old-owner', 1, true)).toMatchObject({
      applied: true,
      active: true,
    })
    await oldSnapshotStarted

    // Model hubctl disappearing while its detached hub survives. The old hub is no longer reachable by
    // its parent, so an in-memory epoch cannot protect a replacement process.
    survivingHub.disconnect()
    expect(survivingHub.exitCode).toBeNull()

    const blockedReplacement = spawnBackupSupervisorChild(backupsDir)
    await waitForChildMessage(blockedReplacement, 'child-ready')
    expect(await controlBackupChild(blockedReplacement, 'replacement-while-live', 1, true)).toMatchObject({
      applied: false,
      active: false,
      error: expect.stringMatching(/owned|lease|process/i),
    })

    survivingHub.kill('SIGKILL')
    await waitForExit(survivingHub)

    const successor = spawnBackupSupervisorChild(backupsDir)
    await waitForChildMessage(successor, 'child-ready')
    const successorSnapshotStarted = waitForChildMessage(successor, 'snapshot-started')
    expect(await controlBackupChild(successor, 'replacement-after-death', 1, true)).toMatchObject({
      applied: true,
      active: true,
    })
    await successorSnapshotStarted
  }, 30_000)

  it('bounds retire with a never-resolving snapshot, then lets a successor clean its partial and acquire', async () => {
    const root = tmp()
    const backupsDir = path.join(root, 'backups')
    const hung = spawnHungRetireChild(backupsDir)
    await waitForChildMessage(hung, 'child-ready')
    const started = waitForChildMessage<{
      type: 'snapshot-started'
      partial: string
    }>(hung, 'snapshot-started')
    expect(await controlBackupChild(hung, 'hung-owner', 1, true)).toMatchObject({
      applied: true,
      active: true,
    })
    const { partial } = await started
    expect(fs.existsSync(partial)).toBe(true)

    const retired = waitForChildMessage(hung, 'retire-stopped', 1_000)
    hung.send({ type: 'retire' })
    await retired
    await waitForExit(hung)

    const successor = spawnBackupSupervisorChild(backupsDir)
    await waitForChildMessage(successor, 'child-ready')
    const successorStarted = waitForChildMessage(successor, 'snapshot-started')
    expect(await controlBackupChild(successor, 'successor-owner', 1, true)).toMatchObject({
      applied: true,
      active: true,
    })
    await successorStarted
    expect(fs.existsSync(partial)).toBe(false)
  }, 10_000)

  it('contains a never-resolving snapshot on SIGTERM and releases the lease for a successor', async () => {
    const root = tmp()
    const backupsDir = path.join(root, 'backups')
    const hung = spawnHungRetireChild(backupsDir)
    await waitForChildMessage(hung, 'child-ready')
    const started = waitForChildMessage<{
      type: 'snapshot-started'
      partial: string
    }>(hung, 'snapshot-started')
    expect(await controlBackupChild(hung, 'signal-owner', 1, true)).toMatchObject({
      applied: true,
      active: true,
    })
    const { partial } = await started

    hung.kill('SIGTERM')
    await Promise.race([
      waitForExit(hung),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('hung snapshot child ignored SIGTERM guard')), 1_000)
      ),
    ])
    expect(fs.existsSync(partial)).toBe(true)

    const successor = spawnBackupSupervisorChild(backupsDir)
    await waitForChildMessage(successor, 'child-ready')
    const successorStarted = waitForChildMessage(successor, 'snapshot-started')
    expect(await controlBackupChild(successor, 'signal-successor', 1, true)).toMatchObject({
      applied: true,
      active: true,
    })
    await successorStarted
    expect(fs.existsSync(partial)).toBe(false)
  }, 10_000)

  it('binds and answers readiness while a deliberately slow initial snapshot is still in flight', async () => {
    const root = tmp()
    const journal = makeJournal(root, 5)
    const releaseSnapshot = deferred<void>()
    const snapshotStarted = deferred<void>()
    let snapshotSettled = false
    let listeningAt = 0
    let snapshotStartedAt = 0
    let readinessAnsweredAt = 0
    let snapshotFinishedAt = 0
    const origin = performance.now()

    const server = http.createServer((request, response) => {
      if (request.url === '/ready') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ready":true}')
        return
      }
      response.writeHead(404)
      response.end()
    })
    servers.push(server)

    const backups = createJournalBackupSupervisor(
      journal.db,
      { dir: path.join(root, 'backups'), intervalMs: 60_000 },
      async (): Promise<SnapshotResult> => {
        expect(server.listening).toBe(true)
        snapshotStartedAt = performance.now()
        snapshotStarted.resolve()
        await releaseSnapshot.promise
        snapshotSettled = true
        snapshotFinishedAt = performance.now()
        return { ok: true }
      }
    )

    expect(snapshotStartedAt).toBe(0)
    server.once('listening', () => {
      listeningAt = performance.now()
      backups.activateStandalone()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    await snapshotStarted.promise

    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
    const response = await get(address.port, '/ready')
    readinessAnsweredAt = performance.now()

    expect(response).toEqual({ status: 200, body: '{"ready":true}' })
    expect(snapshotSettled).toBe(false)
    expect(listeningAt).toBeLessThanOrEqual(snapshotStartedAt)

    releaseSnapshot.resolve()
    await backups.stop()

    expect(snapshotFinishedAt).toBeGreaterThanOrEqual(readinessAnsweredAt)
    if (process.env.AMA_BACKUP_TIMING_PROOF === '1') {
      console.log(
        `[journal-backup timing] listening=${(listeningAt - origin).toFixed(3)}ms ` +
          `snapshot-start=${(snapshotStartedAt - origin).toFixed(3)}ms ` +
          `readiness-response=${(readinessAnsweredAt - origin).toFixed(3)}ms ` +
          `snapshot-finish=${(snapshotFinishedAt - origin).toFixed(3)}ms`
      )
    }
  })

  it('never overlaps periodic snapshots and clears pending schedule state on stop', async () => {
    vi.useFakeTimers()
    const root = tmp()
    const journal = makeJournal(root, 5)
    const gates: Array<ReturnType<typeof deferred<SnapshotResult>>> = []
    let active = 0
    let maxActive = 0
    const takeSnapshot = vi.fn(async (): Promise<SnapshotResult> => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const gate = deferred<SnapshotResult>()
      gates.push(gate)
      try {
        return await gate.promise
      } finally {
        active -= 1
      }
    })
    const backups = createJournalBackupSupervisor(
      journal.db,
      { dir: path.join(root, 'backups'), intervalMs: 10 },
      takeSnapshot
    )

    backups.activateStandalone()
    await vi.advanceTimersByTimeAsync(0)
    expect(takeSnapshot).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(40)
    expect(takeSnapshot).toHaveBeenCalledTimes(1)
    expect(maxActive).toBe(1)

    gates[0]?.resolve({ ok: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(takeSnapshot).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1)

    const stopping = backups.stop()
    gates[1]?.resolve({ ok: true })
    await stopping
    expect(active).toBe(0)

    await vi.advanceTimersByTimeAsync(100)
    expect(takeSnapshot).toHaveBeenCalledTimes(2)
  })

  it('waits for in-flight bookkeeping on shutdown without damaging an already completed generation', async () => {
    const root = tmp()
    const journal = makeJournal(root, 7)
    const backupsDir = path.join(root, 'backups')
    const published = deferred<SnapshotResult>()
    const releaseBookkeeping = deferred<void>()
    let calls = 0
    const backups = createJournalBackupSupervisor(
      journal.db,
      { dir: backupsDir, intervalMs: 60_000 },
      async (db, options): Promise<SnapshotResult> => {
        calls += 1
        const result = await snapshotJournal(db, options)
        published.resolve(result)
        await releaseBookkeeping.promise
        return result
      }
    )

    backups.activateStandalone()
    const result = await published.promise
    expect(result.ok).toBe(true)

    let stopped = false
    const stopping = backups.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    releaseBookkeeping.resolve()
    await stopping
    expect(stopped).toBe(true)
    expect(calls).toBe(1)

    const Database = (await import('better-sqlite3')).default
    const copy = new Database(result.file as string, { readonly: true, fileMustExist: true })
    expect(copy.pragma('quick_check')).toEqual([{ quick_check: 'ok' }])
    expect(copy.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 7 })
    copy.close()
  })

  it('keeps supervised work inactive until activated and ignores a late pause after a newer resume', async () => {
    vi.useFakeTimers()
    const root = tmp()
    const journal = makeJournal(root, 5)
    const firstRun = deferred<SnapshotResult>()
    const takeSnapshot = vi.fn(() => firstRun.promise)
    const backups = createJournalBackupSupervisor(
      journal.db,
      { dir: path.join(root, 'backups'), intervalMs: 60_000 },
      takeSnapshot
    )

    await vi.advanceTimersByTimeAsync(60_000)
    expect(takeSnapshot).not.toHaveBeenCalled()

    const activated = await backups.applyControl({
      type: 'journal-backup-control',
      requestId: 'activate-blue-after-health',
      epoch: 1,
      active: true,
    })
    expect(activated).toMatchObject({ applied: true, active: true, epoch: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(takeSnapshot).toHaveBeenCalledTimes(1)

    let pauseSettled = false
    const pausing = backups
      .applyControl({
        type: 'journal-backup-control',
        requestId: 'pause-blue-before-drain',
        epoch: 2,
        active: false,
      })
      .then((result) => {
        pauseSettled = true
        return result
      })
    await Promise.resolve()
    expect(pauseSettled).toBe(false)

    const resumed = await backups.applyControl({
      type: 'journal-backup-control',
      requestId: 'resume-blue-after-rollback',
      epoch: 3,
      active: true,
    })
    expect(resumed).toMatchObject({ applied: true, active: true, epoch: 3 })

    firstRun.resolve({ ok: true })
    const supersededPause = await pausing
    expect(supersededPause).toMatchObject({ applied: false, active: true, epoch: 2 })

    const latePause = await backups.applyControl({
      type: 'journal-backup-control',
      requestId: 'late-pause-blue',
      epoch: 2,
      active: false,
    })
    expect(latePause).toMatchObject({ applied: false, active: true, epoch: 2 })
    await backups.stop()
  })
})
