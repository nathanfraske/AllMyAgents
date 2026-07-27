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
})
