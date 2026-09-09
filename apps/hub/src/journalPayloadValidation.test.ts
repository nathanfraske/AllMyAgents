import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateJournalPayloadBatch } from './journalPayloadValidation.js'

const handles: Database.Database[] = []
const directories: string[] = []
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true })
})
function fixture() {
  const db = new Database(':memory:'); handles.push(db)
  db.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO events VALUES (?, ?)')
  for (let i = 1; i <= 5; i++) insert.run(i, JSON.stringify({ text: 'event ' + i }))
  return db
}
describe('bounded journal JSON validation', () => {
  it('resumes bounded batches and does zero content reads on a compliant next cycle', () => {
    const db = fixture()
    expect(validateJournalPayloadBatch(db, 2)).toEqual({ scannedThrough: 2, rowsScanned: 2, complete: false })
    expect(validateJournalPayloadBatch(db, 2)).toEqual({ scannedThrough: 4, rowsScanned: 2, complete: false })
    expect(validateJournalPayloadBatch(db, 2)).toEqual({ scannedThrough: 5, rowsScanned: 1, complete: true })
    expect(validateJournalPayloadBatch(db, 2)).toEqual({ scannedThrough: 5, rowsScanned: 0, complete: true })
    db.prepare('INSERT INTO events VALUES (?, ?)').run(6, '{}')
    expect(validateJournalPayloadBatch(db, 2)).toEqual({ scannedThrough: 6, rowsScanned: 1, complete: true })
  })
  it('refuses invalid new rows without advancing the validated cursor', () => {
    const db = fixture()
    validateJournalPayloadBatch(db)
    db.prepare('INSERT INTO events VALUES (?, ?)').run(6, 'not-json')
    expect(() => validateJournalPayloadBatch(db)).toThrow(/invalid JSON.*6.*maintenance refused/)
    expect(db.prepare('SELECT scanned_through FROM journal_payload_validation').pluck().get()).toBe(5)
  })
  it('rewinds on old rewrites, including writes not made through Journal', () => {
    const db = fixture()
    validateJournalPayloadBatch(db)
    db.prepare('UPDATE events SET payload=? WHERE seq=2').run('not-json')
    expect(() => validateJournalPayloadBatch(db)).toThrow(/invalid JSON.*2/)
    db.prepare('UPDATE events SET payload=? WHERE seq=2').run('{}')
    expect(validateJournalPayloadBatch(db)).toMatchObject({ rowsScanned: 4, complete: true })
  })
  it('checks inserted/rekeyed rows below the cursor but does not rescan unchanged updates', () => {
    const db = fixture()
    validateJournalPayloadBatch(db)
    db.exec('UPDATE events SET payload=payload')
    expect(validateJournalPayloadBatch(db).rowsScanned).toBe(0)
    db.exec('DELETE FROM events WHERE seq=2')
    db.prepare('INSERT INTO events VALUES (2, ?)').run('not-json')
    expect(() => validateJournalPayloadBatch(db)).toThrow(/invalid JSON.*2/)
    db.prepare('UPDATE events SET payload=? WHERE seq=2').run('{}')
    validateJournalPayloadBatch(db)
    db.prepare('INSERT INTO events VALUES (9, ?)').run('not-json')
    db.exec('DELETE FROM events WHERE seq=1; UPDATE events SET seq=1 WHERE seq=9')
    expect(() => validateJournalPayloadBatch(db)).toThrow(/invalid JSON.*1/)
  })
  it('rejects unbounded batch requests', () => {
    expect(() => validateJournalPayloadBatch(fixture(), 5001)).toThrow(/between 1 and 5000/)
  })
  it('survives a connection restart and observes another writer invalidating the cursor', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-validation-restart-'))
    directories.push(directory)
    const file = path.join(directory, 'fixture.db')
    const first = new Database(file); handles.push(first)
    first.pragma('journal_mode=WAL')
    first.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY, payload TEXT); INSERT INTO events VALUES (1, '{}'),(2, '{}')")
    validateJournalPayloadBatch(first)
    first.close()
    const resumed = new Database(file); handles.push(resumed)
    expect(validateJournalPayloadBatch(resumed).rowsScanned).toBe(0)
    const writer = new Database(file); handles.push(writer)
    writer.prepare('UPDATE events SET payload=? WHERE seq=1').run('invalid JSON')
    expect(() => validateJournalPayloadBatch(resumed)).toThrow(/invalid JSON.*1/)
  })
})
