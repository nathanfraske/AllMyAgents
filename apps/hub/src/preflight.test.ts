import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION } from './restartHandshake.js'
import { recordSchemaVersion, runHubPreflight } from './preflight.js'

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
  db.prepare('INSERT INTO events (payload) VALUES (?)').run('healthy')
  db.pragma(`user_version = ${userVersion}`)
  db.close()
  return journalPath
}

function addPersistedSessions(journalPath: string, count: number): void {
  const db = new Database(journalPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL, updated TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO sessions (id, record, updated) VALUES (?, ?, ?)')
  for (let i = 0; i < count; i++) {
    insert.run(`session-${i}`, JSON.stringify({ id: `session-${i}` }), new Date(i).toISOString())
  }
  db.close()
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

  it('skips an inconclusive write probe instead of blocking a healthy boot', () => {
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

    expect(result.ok).toBe(true)
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: 'data-dir-writable', status: 'skipped' })
    )
  })

  it('runs the full integrity check for a healthy existing journal', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir)

    const result = runHubPreflight({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })

    expect(result.ok).toBe(true)
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: 'database-integrity', status: 'passed', detail: 'ok' })
    )
  })

  it('does not create a data directory when an expected existing root is missing', () => {
    const parent = tempDataDir()
    const dataDir = path.join(parent, 'missing-data')
    const journalPath = path.join(dataDir, 'hub.db')

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      dataRootExpectation: 'existing',
      expectedRestoredSessions: 0,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('expected-data-root-missing')
    expect(fs.existsSync(dataDir)).toBe(false)
  })

  it('does not create hub.db when an expected existing journal is missing', () => {
    const dataDir = tempDataDir()
    const journalPath = path.join(dataDir, 'hub.db')

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      dataRootExpectation: 'existing',
      expectedRestoredSessions: 0,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('expected-journal-missing')
    expect(fs.existsSync(journalPath)).toBe(false)
  })

  it('allows an explicit first run with expectation zero to create the data root', () => {
    const parent = tempDataDir()
    const dataDir = path.join(parent, 'new-data')
    const journalPath = path.join(dataDir, 'hub.db')

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      dataRootExpectation: 'first-run',
      expectedRestoredSessions: 0,
    })

    expect(result.ok).toBe(true)
    expect(fs.existsSync(dataDir)).toBe(true)
    expect(fs.existsSync(journalPath)).toBe(false)
  })

  it('fails read-only when a positive expected roster floor finds zero persisted sessions', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir, SCHEMA_VERSION)
    addPersistedSessions(journalPath, 0)
    const before = fs.readFileSync(journalPath)
    const openSpy = vi.spyOn(fs, 'openSync')

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      dataRootExpectation: 'existing',
      expectedRestoredSessions: 4,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({ code: 'restored-session-floor-missed' })
    expect(result.failure.message).toMatch(/expected at least 4|zero persisted sessions/i)
    expect(fs.readFileSync(journalPath)).toEqual(before)
    expect(openSpy.mock.calls.some(([, flags]) => flags === 'wx')).toBe(false)
  })

  it('accepts an existing journal whose persisted roster satisfies a positive floor', () => {
    const dataDir = tempDataDir()
    const journalPath = validJournal(dataDir, SCHEMA_VERSION)
    addPersistedSessions(journalPath, 3)

    const result = runHubPreflight({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      dataRootExpectation: 'existing',
      expectedRestoredSessions: 3,
    })

    expect(result.ok).toBe(true)
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: 'restored-session-floor', status: 'passed' })
    )
  })
})
