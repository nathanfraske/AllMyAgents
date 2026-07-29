import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Journal } from './journal.js'
import { createJournalBackupSupervisor, snapshotJournal, type SnapshotResult } from './journalBackup.js'

/**
 * The operator's journal was corrupted twice in two days and truncated once, and the only copy that saved
 * their history was one a human happened to take by hand. These tests cover the two properties that make
 * an automatic backup worth having: it must be CONSISTENT while the hub is writing, and it must never
 * retain a snapshot it cannot verify.
 */

const dirs: string[] = []
const journals: Journal[] = []
const servers: http.Server[] = []
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-journal-backup-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.useRealTimers()
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

describe('journal snapshots', () => {
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
    copy.close()
  })

  it('snapshots a LIVE journal that is still being written', async () => {
    // The failure this guards against is a plain file copy of a database mid-write, which captures a torn
    // file plus a mismatched WAL — the exact state we spent two days recovering from.
    const root = tmp()
    const journal = makeJournal(root, 10)
    const backups = path.join(root, 'backups')

    const writing = setInterval(() => journal.append('busy', 'test/event', { t: Date.now() }), 1)
    let result
    try {
      result = await snapshotJournal(journal.db, { dir: backups })
    } finally {
      clearInterval(writing)
    }
    expect(result.ok).toBe(true)

    const Database = (await import('better-sqlite3')).default
    const copy = new Database(result.file as string, { readonly: true })
    expect(copy.pragma('quick_check')).toEqual([{ quick_check: 'ok' }])
    copy.close()
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
  })
})

describe('journal backup lifecycle', () => {
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
      backups.serverReady()
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

    backups.serverReady()
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

    backups.serverReady()
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
})
