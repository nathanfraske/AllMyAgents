import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import { snapshotJournal } from './journalBackup.js'

/**
 * The operator's journal was corrupted twice in two days and truncated once, and the only copy that saved
 * their history was one a human happened to take by hand. These tests cover the two properties that make
 * an automatic backup worth having: it must be CONSISTENT while the hub is writing, and it must never
 * retain a snapshot it cannot verify.
 */

const dirs: string[] = []
const journals: Journal[] = []
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-journal-backup-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
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
