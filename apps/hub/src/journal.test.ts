import { describe, it, expect, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Journal } from './journal.js'
import { JOURNAL_BLOB_KEY } from './journalBlobStore.js'

describe('journal wseq — Phase 2 additions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-jrnl-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('appendWorker tags wseq; lastJournaledWseq returns the per-session max (0 when none)', () => {
    const j = new Journal(path.join(tmp, 'a.db'))
    expect(j.lastJournaledWseq('s1')).toBe(0)
    j.appendWorker('s1', 'claude/assistant', { text: 'a' }, 1)
    j.appendWorker('s1', 'claude/assistant', { text: 'b' }, 2)
    j.appendWorker('s2', 'codex/item', { text: 'x' }, 1)
    expect(j.lastJournaledWseq('s1')).toBe(2)
    expect(j.lastJournaledWseq('s2')).toBe(1)
    expect(j.lastJournaledWseq('unknown')).toBe(0)
    j.db.close()
  })

  it('appendWorker emits an event exactly like append (so it reaches WS panes)', () => {
    const j = new Journal(path.join(tmp, 'b.db'))
    const seen: string[] = []
    j.on('event', (e) => seen.push(e.kind))
    const ev = j.appendWorker('s', 'claude/assistant', { text: 'hi' }, 1)
    expect(seen).toEqual(['claude/assistant'])
    expect(ev.payload).toEqual({ text: 'hi' })
    j.db.close()
  })

  it('migration is idempotent: re-opening a migrated DB does not throw + preserves the cursor', () => {
    const f = path.join(tmp, 'reopen.db')
    const j1 = new Journal(f)
    j1.appendWorker('s', 'k', {}, 5)
    j1.db.close()
    const j2 = new Journal(f) // re-runs the guarded ALTER on an already-migrated DB
    expect(j2.lastJournaledWseq('s')).toBe(5)
    // a legacy append (NULL wseq) coexists and never lowers the cursor
    j2.append('s', 'session/status', { status: 'idle' })
    expect(j2.lastJournaledWseq('s')).toBe(5)
    j2.db.close()
  })
})

describe('journal payload bulk defense', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-jrnl-payload-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('keeps attachment metadata and a visible marker but never persists caller-supplied base64 bytes', () => {
    const j = new Journal(path.join(tmp, 'attachment-bytes.db'))
    try {
      const bytes = Buffer.alloc(128 * 1024, 0xab)
      const base64 = bytes.toString('base64')
      const event = j.append('s', 'session/input', {
        text: 'Inspect this image.',
        attachments: [
          {
            id: 'att-1',
            name: 'screenshot.png',
            mime: 'image/png',
            size: bytes.length,
            path: 'attachments/att-1/screenshot.png',
            base64,
            bytes,
          },
        ],
      })

      const stored = j.db.prepare('SELECT payload FROM events WHERE seq = ?').get(event.seq) as {
        payload: string
      }
      expect(stored.payload).not.toContain(base64.slice(0, 1024))
      expect(() => JSON.parse(stored.payload)).not.toThrow()
      expect(event.payload).toEqual({
        text: 'Inspect this image.',
        attachments: [
          {
            id: 'att-1',
            name: 'screenshot.png',
            mime: 'image/png',
            size: bytes.length,
            path: 'attachments/att-1/screenshot.png',
            __allmyagentsJournalTruncated: {
              reason: 'attachment-metadata-only',
              omittedFields: ['base64', 'bytes'],
            },
          },
        ],
      })
      expect(j.since(0)[0]?.payload).toEqual(event.payload)
    } finally {
      j.db.close()
    }
  })

  it('externalizes ordinary large transcript text losslessly and rehydrates it after reopen', () => {
    const j = new Journal(path.join(tmp, 'large-text.db'))
    const file = path.join(tmp, 'large-text.db')
    try {
      const output = 'ordinary textual command output: build step completed successfully\n'.repeat(16_384)
      const event = j.append('s', 'codex/item/completed', {
        threadId: 'thread',
        turnId: 'turn',
        item: { id: 'command', type: 'commandExecution', aggregatedOutput: output },
      })

      const stored = j.db.prepare('SELECT payload FROM events WHERE seq = ?').get(event.seq) as {
        payload: string
      }
      const persisted = JSON.parse(stored.payload) as {
        item: { aggregatedOutput: Record<string, unknown> }
      }
      expect(persisted.item.aggregatedOutput).toHaveProperty(JOURNAL_BLOB_KEY)
      expect(stored.payload).not.toContain(output.slice(0, 1024))
      expect((event.payload as { item: { aggregatedOutput: string } }).item.aggregatedOutput).toBe(output)
      expect(stored.payload).not.toContain('__allmyagentsJournalTruncated')
      expect((j.since(0)[0]?.payload as { item: { aggregatedOutput: string } }).item.aggregatedOutput).toBe(output)
    } finally {
      j.db.close()
    }
    const reopened = new Journal(file)
    try {
      expect((reopened.since(0)[0]?.payload as { item: { aggregatedOutput: string } }).item.aggregatedOutput).toBe(
        'ordinary textual command output: build step completed successfully\n'.repeat(16_384),
      )
    } finally {
      reopened.db.close()
    }
  })

  it('keeps SQLite bounded under many oversized payloads and deduplicates identical bytes', () => {
    const file = path.join(tmp, 'bounded-large-text.db')
    const j = new Journal(file)
    const output = `stable tool result ${'x'.repeat(1024 * 1024)}`
    try {
      for (let index = 0; index < 24; index += 1) {
        j.append('session', 'claude/user', { message: { role: 'user', content: output } })
      }
      j.db.pragma('wal_checkpoint(TRUNCATE)')
      expect(fs.statSync(file).size).toBeLessThan(2 * 1024 * 1024)
      const blobs = fs.readdirSync(path.join(tmp, 'journal-blobs', 'sha256'), { recursive: true })
        .filter((entry) => /^[0-9a-f]{64}$/u.test(path.basename(String(entry))))
      const digest = crypto.createHash('sha256').update(output, 'utf8').digest('hex')
      expect(blobs.filter((entry) => path.basename(String(entry)) === digest)).toHaveLength(1)
      expect((j.since(0, 1)[0]?.payload as { message: { content: string } }).message.content).toBe(output)
    } finally {
      j.db.close()
    }
  })

  it('migrates legacy oversized rows resumably and VACUUM reclaims their SQLite pages', () => {
    const file = path.join(tmp, 'legacy-large-text.db')
    // Simulate a pre-upgrade journal. New Journal databases start in incremental-vacuum mode and should
    // never need the one-time full rewrite.
    const legacy = new Database(file)
    legacy.exec(
      'CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL)',
    )
    legacy.close()
    const j = new Journal(file)
    const insert = j.db.prepare(
      'INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)',
    )
    try {
      for (let index = 0; index < 12; index += 1) {
        const output = `${index}:${String.fromCharCode(65 + index).repeat(256 * 1024)}`
        insert.run(
          new Date(2026, 0, 1, 0, 0, index).toISOString(),
          'legacy',
          'claude/user',
          JSON.stringify({ message: { content: output } }),
        )
      }
      j.db.pragma('wal_checkpoint(TRUNCATE)')
      const before = fs.statSync(file).size
      let complete = false
      for (let attempts = 0; attempts < 20 && !complete; attempts += 1) {
        complete = j.externalizeLegacyPayloads(3, 1024 * 1024).complete
      }
      expect(complete).toBe(true)
      expect(j.since(0)).toHaveLength(12)
      const upgrade = j.completeLegacyStorageUpgrade()
      expect(upgrade).toMatchObject({ alreadyComplete: false, vacuumRan: true })
      expect(j.completeLegacyStorageUpgrade()).toMatchObject({ alreadyComplete: true, vacuumRan: false })
      j.db.pragma('wal_checkpoint(TRUNCATE)')
      expect(fs.statSync(file).size).toBeLessThan(before / 2)
      expect(j.db.pragma('auto_vacuum', { simple: true })).toBe(2)
      expect((j.since(0, 1)[0]?.payload as { message: { content: string } }).message.content.length)
        .toBeGreaterThan(256 * 1024)
    } finally {
      j.db.close()
    }
  })
})
