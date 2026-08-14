import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION } from './restartHandshake.js'
import {
  recordSchemaVersion,
  runHubPreflight,
  runHubPreflightInWorker,
} from './preflight.js'

const dirs: string[] = []

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-preflight-'))
  dirs.push(dir)
  return dir
}

function validJournal(dataDir: string, userVersion = 0): string {
  const journalPath = path.join(dataDir, 'hub.db')
  const db = new Database(journalPath)
  db.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
  db.prepare('INSERT INTO events (payload) VALUES (?)').run(JSON.stringify('healthy'))
  db.pragma(`user_version = ${userVersion}`)
  db.close()
  return journalPath
}

function copiedLiveWalJournal(dataDir: string): {
  journalPath: string
  wal: Buffer
  shm: Buffer
} {
  const journalPath = path.join(dataDir, 'hub.db')
  const db = new Database(journalPath)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  db.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)')
  db.prepare('INSERT INTO events (payload) VALUES (?)').run(JSON.stringify('main'))
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.prepare('INSERT INTO events (payload) VALUES (?)').run(JSON.stringify('wal'))
  db.prepare('INSERT INTO events (payload) VALUES (?)').run(JSON.stringify('wal-2'))
  const main = fs.readFileSync(journalPath)
  const wal = fs.readFileSync(`${journalPath}-wal`)
  const shm = fs.readFileSync(`${journalPath}-shm`)
  db.close()
  fs.writeFileSync(journalPath, main)
  fs.writeFileSync(`${journalPath}-wal`, wal)
  fs.writeFileSync(`${journalPath}-shm`, shm)
  return { journalPath, wal, shm }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('hub preflight', () => {
  it('reports a corrupt journal before Journal can throw during boot', () => {
    const dataDir = tempDataDir()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(200 * 1024, 0x6e))

    const result = runHubPreflight({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('database-corrupt')
    expect(result.failure.message).toMatch(/integrity|database|journal/i)
  })

  it('rejects a database whose durable schema version is newer than this hub', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir, SCHEMA_VERSION + 1)

    const result = runHubPreflight({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'schema-too-new' })
    expect(result.failure.message).toContain(String(SCHEMA_VERSION + 1))
    expect(result.failure.recovery).toMatch(/newer|compatible|restore/i)
  })

  it('records the running schema version only through the real writable connection', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    const db = new Database(journalPath)

    recordSchemaVersion(db, SCHEMA_VERSION)

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('reports a known data-dir write failure such as a full disk', () => {
    const dataDir = tempDataDir()
    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
      throw error
    })

    const result = runHubPreflight({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'data-dir-not-writable' })
    expect(result.failure.message).toMatch(/ENOSPC|disk full/i)
  })

  it('fails closed when the unique write probe is busy', () => {
    const dataDir = tempDataDir()
    const error = Object.assign(new Error('scanner briefly held the probe'), { code: 'EBUSY' })
    vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
      throw error
    })

    const result = runHubPreflight({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
  })

  it('uses quick_check on the ordinary boot path', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)

    const result = runHubPreflight({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })

    expect(result.ok).toBe(true)
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'database-integrity',
        status: 'passed',
        detail: 'quick_check ok; event payload JSON is valid',
      })
    )
  })

  it('runs the same bounded boot proof while the hub maintains a liveness lease', async () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    let livenessRenewals = 0

    const result = await runHubPreflightInWorker({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      onLiveness: () => {
        livenessRenewals += 1
      },
    })

    expect(result.ok).toBe(true)
    expect(livenessRenewals).toBeGreaterThan(0)
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'database-integrity',
        status: 'passed',
        detail: 'quick_check ok; event payload JSON is valid',
      })
    )
  })

  it('keeps full integrity_check on the isolated suspicion classifier', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      stableFamily: true,
    })
    expect(result.ok).toBe(true)
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'database-integrity',
      detail: 'integrity_check ok; event payload JSON is valid',
    }))
  })

  it('reuses an unchanged pass within one supervisor boot without another content scan', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      reuseVerifiedIdentity: true,
    })
    expect(result.ok).toBe(true)
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'database-integrity',
      status: 'skipped',
      detail: expect.stringMatching(/already passed.*supervisor boot/u),
    }))
  })

  it('fails closed on an unknown data-root write-probe error', () => {
    const dataDir = tempDataDir()
    vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('stale filesystem handle'), { code: 'ESTALE' })
    })

    const result = runHubPreflight({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
  })

  it('classifies valid SQLite pages containing invalid event JSON as recoverable corruption', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    const db = new Database(journalPath)
    db.prepare('UPDATE events SET payload = ? WHERE seq = 1').run('secret-like-not-json')
    db.close()

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      stableFamily: true,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      code: 'database-corrupt',
      recoveryCause: 'sqlite-corruption',
    })
    expect(result.failure.message).toMatch(/invalid JSON/i)
  })

  it('validates a clean copied live WAL before SQLite interprets the family', () => {
    const dataDir = tempDataDir()
    const { journalPath } = copiedLiveWalJournal(dataDir)

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      stableFamily: true,
    })

    expect(result.ok).toBe(true)
  })

  it.each([
    ['header checksum', 24],
    ['frame checksum', 64],
    ['page size', 8],
  ])('classifies recognized WAL %s corruption before SQLite can ignore its tail', (_kind, offset) => {
    const dataDir = tempDataDir()
    const { journalPath, wal } = copiedLiveWalJournal(dataDir)
    wal[offset] = wal[offset]! ^ 0xff
    fs.writeFileSync(`${journalPath}-wal`, wal)

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      stableFamily: true,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      code: 'database-corrupt',
      recoveryCause: 'sqlite-corruption',
    })
    expect(result.failure.message).toMatch(/WAL/i)
  })

  it('ignores a truncated non-committed WAL tail after a valid main database', () => {
    const dataDir = tempDataDir()
    const { journalPath, wal } = copiedLiveWalJournal(dataDir)
    fs.writeFileSync(`${journalPath}-wal`, wal.subarray(0, wal.length - 1))

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      stableFamily: true,
    })

    expect(result.ok).toBe(true)
  })

  it('does not treat an ambiguous first-frame WAL salt bit flip as healthy', () => {
    const dataDir = tempDataDir()
    const { journalPath, wal } = copiedLiveWalJournal(dataDir)
    wal[40] = wal[40]! ^ 0xff
    fs.writeFileSync(`${journalPath}-wal`, wal)

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      stableFamily: true,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toMatch(/database-(corrupt|validation-unavailable)/)
  })

  it('does not treat a page-zero bit flip before a committed frame as healthy', () => {
    const dataDir = tempDataDir()
    const { journalPath, wal } = copiedLiveWalJournal(dataDir)
    wal.writeUInt32BE(0, 32)
    fs.writeFileSync(`${journalPath}-wal`, wal)

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      stableFamily: true,
    })

    expect(result.ok).toBe(false)
  })

  it('detects a corrupted frame between two committed WAL transactions', () => {
    const dataDir = tempDataDir()
    const { journalPath, wal } = copiedLiveWalJournal(dataDir)
    const encodedPageSize = wal.readUInt32BE(8)
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize
    const frameSize = pageSize + 24
    const frameCount = Math.floor((wal.length - 32) / frameSize)
    const commitFrames = Array.from({ length: frameCount }, (_, index) => index).filter(
      (index) => wal.readUInt32BE(32 + index * frameSize + 4) !== 0
    )
    expect(commitFrames.length).toBeGreaterThanOrEqual(2)
    const corruptedFrame = commitFrames[0]! + 1
    expect(corruptedFrame).toBeLessThan(commitFrames.at(-1)!)
    const saltOffset = 32 + corruptedFrame * frameSize + 8
    wal[saltOffset] = wal[saltOffset]! ^ 0xff
    fs.writeFileSync(`${journalPath}-wal`, wal)

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      stableFamily: true,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      code: 'database-corrupt',
      recoveryCause: 'sqlite-corruption',
    })
    expect(result.failure.message).toMatch(/salt mismatch hides a later committed frame/i)
  })

  it('keeps an unrecognized WAL-like sidecar offline without recovery authority', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    fs.writeFileSync(`${journalPath}-wal`, Buffer.from('not-a-sqlite-wal'))

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      stableFamily: true,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
    expect(result.failure).not.toHaveProperty('recoveryCause')
  })

  it('keeps a malformed SHM sidecar offline without treating it as corruption proof', () => {
    const dataDir = tempDataDir()
    const { journalPath, shm } = copiedLiveWalJournal(dataDir)
    fs.writeFileSync(`${journalPath}-shm`, shm.subarray(0, shm.length - 1))

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      stableFamily: true,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
    expect(result.failure).not.toHaveProperty('recoveryCause')
  })

  it('accepts an empty WAL sidecar beside a healthy main database', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    fs.writeFileSync(`${journalPath}-wal`, Buffer.alloc(0))

    const result = runHubPreflight({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })

    expect(result.ok).toBe(true)
  })

  it('allows same-inode blue writes while a normal green performs SQLite validation', () => {
    const dataDir = tempDataDir()
    const journalPath = path.join(dataDir, 'hub.db')
    const writer = new Database(journalPath)
    writer.pragma('journal_mode = WAL')
    writer.exec(
      'CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)'
    )
    writer.prepare('INSERT INTO events (payload) VALUES (?)').run(JSON.stringify('before'))

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      openReadonly: (file) => {
        writer.prepare('INSERT INTO events (payload) VALUES (?)').run(JSON.stringify('during'))
        return new Database(file, { readonly: true, fileMustExist: true })
      },
    })

    expect(result.ok).toBe(true)
    writer.close()
  })

  it('never derives automatic recovery authority from a normal concurrent WAL scan', () => {
    const dataDir = tempDataDir()
    const { journalPath, wal } = copiedLiveWalJournal(dataDir)
    wal[64] = wal[64]! ^ 0xff
    fs.writeFileSync(`${journalPath}-wal`, wal)

    const result = runHubPreflight({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
    expect(result.failure).not.toHaveProperty('recoveryCause')
  })

  it('classifies orphan SQLite sidecars as recoverable corruption instead of a new empty root', () => {
    const dataDir = tempDataDir()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(`${journalPath}-wal`, Buffer.from('orphaned-wal'))

    const result = runHubPreflight({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      code: 'database-orphan-family',
      recoveryCause: 'orphan-family',
    })
    expect(fs.readFileSync(`${journalPath}-wal`, 'utf8')).toBe('orphaned-wal')
    expect(fs.existsSync(journalPath)).toBe(false)
  })

  it.each(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR', 'SQLITE_FULL', 'SQLITE_CANTOPEN'])(
    'fails closed without declaring %s auto-recoverable',
    (code) => {
      const dataDir = tempDataDir()
      const journalPath = validJournal(dataDir)
      const error = Object.assign(new Error(`injected ${code}`), { code })

      const result = runHubPreflight({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        openReadonly: () => {
          throw error
        },
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
      expect(result.failure).not.toHaveProperty('recoveryCause')
    }
  )

  it('does not parse corruption wording when the structured SQLite code is non-recoverable', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    const error = Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_IOERR',
    })

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      openReadonly: () => {
        throw error
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
    expect(result.failure).not.toHaveProperty('recoveryCause')
  })

  it('fails closed before SQLite open when lstat cannot conclusively classify the journal', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    const openReadonly = vi.fn()

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      lstat: ((file: fs.PathLike) => {
        if (String(file) === journalPath) {
          throw Object.assign(new Error('access denied'), { code: 'EACCES' })
        }
        return fs.lstatSync(file)
      }) as typeof fs.lstatSync,
      openReadonly,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
    expect(openReadonly).not.toHaveBeenCalled()
  })

  it('fails closed when the main database identity changes between classification and open', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    const originalLstat = fs.lstatSync
    let mainStats = 0
    const openReadonly = vi.fn()

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      lstat: ((file: fs.PathLike) => {
        if (String(file) === journalPath && ++mainStats === 2) {
          const old = `${journalPath}.old`
          fs.renameSync(journalPath, old)
          fs.copyFileSync(old, journalPath)
        }
        return originalLstat(file)
      }) as typeof fs.lstatSync,
      openReadonly,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
    expect(openReadonly).not.toHaveBeenCalled()
  })

  it('revokes validation when the WAL identity changes while SQLite is opening', () => {
    const dataDir = tempDataDir()
    const { journalPath, wal } = copiedLiveWalJournal(dataDir)

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      openReadonly: (file) => {
        fs.renameSync(`${journalPath}-wal`, `${journalPath}-wal.old`)
        fs.writeFileSync(`${journalPath}-wal`, wal)
        return new Database(file, { readonly: true, fileMustExist: true })
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
    expect(result.failure).not.toHaveProperty('recoveryCause')
  })

  it.each([
    ['healthy', [{ quick_check: 'ok' }]],
    ['corrupt', [{ quick_check: 'malformed page' }]],
  ])('revokes a %s validation result when the readonly handle cannot close', (_kind, integrity) => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)
    const fake = {
      pragma(statement: string, options?: { simple?: boolean }) {
        if (statement === 'user_version' && options?.simple) return 0
        if (statement === 'quick_check') return integrity
        return undefined
      },
      close() {
        throw Object.assign(new Error('close failed'), { code: 'SQLITE_IOERR' })
      },
    } as unknown as Database.Database

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      openReadonly: () => fake,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
    expect(result.failure).not.toHaveProperty('recoveryCause')
    expect(result.failure.message).toMatch(/close/i)
  })

  it('fails closed on an unknown read-only validation failure', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      openReadonly: () => {
        throw new Error('unknown validation failure')
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'database-validation-unavailable' })
  })
})
