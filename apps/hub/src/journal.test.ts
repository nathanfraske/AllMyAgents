import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Journal } from './journal.js'

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

  it('leaves ordinary large textual transcript fields byte-for-byte intact', () => {
    const j = new Journal(path.join(tmp, 'large-text.db'))
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
      expect((JSON.parse(stored.payload) as { item: { aggregatedOutput: string } }).item.aggregatedOutput).toBe(
        output
      )
      expect((event.payload as { item: { aggregatedOutput: string } }).item.aggregatedOutput).toBe(output)
      expect(stored.payload).not.toContain('__allmyagentsJournalTruncated')
    } finally {
      j.db.close()
    }
  })
})
