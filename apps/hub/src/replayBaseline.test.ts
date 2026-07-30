import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import { durableReplaySessions } from './replayBaseline.js'
import { SessionStore } from './store.js'
import type { SessionRecord } from './types.js'

describe('durable replay baseline snapshot', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-replay-baseline-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('cannot pair a post-checkpoint cross-process session update with the earlier watermark', () => {
    const file = path.join(tmp, 'race.db')
    const journal = new Journal(file)
    const store = new SessionStore(journal.db)
    const oldRecord: SessionRecord = {
      id: 's',
      profileId: 'p',
      provider: 'claude',
      cwd: tmp,
      status: 'idle',
      createdAt: '2026-07-30T12:00:00.000Z',
    }
    store.upsert(oldRecord)
    journal.append('s', 'session/created', oldRecord)

    const writer = new Database(file)
    writer.pragma('journal_mode = WAL')
    const updated = { ...oldRecord, status: 'active' as const }
    try {
      const first = journal.readReplaySnapshot((checkpoint) => {
        writer.transaction(() => {
          writer
            .prepare(
              `INSERT INTO sessions (id, record, updated)
               VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET record = excluded.record, updated = excluded.updated`
            )
            .run('s', JSON.stringify(updated), '2026-07-30T12:00:01.000Z')
          writer
            .prepare(
              'INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)'
            )
            .run(
              '2026-07-30T12:00:01.000Z',
              's',
              'session/status',
              JSON.stringify({ status: 'active' })
            )
        }).immediate()
        return {
          checkpoint,
          sessions: durableReplaySessions(journal.db, new Map()),
        }
      })
      expect(first.checkpoint.cursor).toBe(1)
      expect(first.sessions[0]?.status).toBe('idle')

      const second = journal.readReplaySnapshot((checkpoint) => ({
        checkpoint,
        sessions: durableReplaySessions(journal.db, new Map()),
      }))
      expect(second.checkpoint.cursor).toBe(2)
      expect(second.sessions[0]?.status).toBe('active')
    } finally {
      writer.close()
      journal.db.close()
    }
  })

  it('lets a new client baseline after more than 5,000 foreign events without a reset loop', () => {
    const file = path.join(tmp, 'foreign-firehose.db')
    const publicJournal = new Journal(file)
    const store = new SessionStore(publicJournal.db)
    const record: SessionRecord = {
      id: 's',
      profileId: 'p',
      provider: 'claude',
      cwd: tmp,
      status: 'idle',
      createdAt: '2026-07-30T12:00:00.000Z',
    }
    store.upsert(record)
    publicJournal.append('s', 'session/created', record)
    const writer = new Database(file)
    writer.pragma('journal_mode = WAL')
    try {
      const active = { ...record, status: 'active' as const }
      writer.transaction(() => {
        writer
          .prepare('UPDATE sessions SET record = ?, updated = ? WHERE id = ?')
          .run(JSON.stringify(active), '2026-07-30T12:01:00.000Z', 's')
        const insert = writer.prepare(
          'INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)'
        )
        for (let index = 0; index < 6_001; index += 1) {
          insert.run(
            '2026-07-30T12:01:00.000Z',
            's',
            index === 6_000 ? 'session/status' : 'test/foreign',
            index === 6_000 ? '{"status":"active"}' : '{"value":1}'
          )
        }
      }).immediate()

      const baseline = publicJournal.readReplaySnapshot((checkpoint) => ({
        checkpoint,
        sessions: durableReplaySessions(publicJournal.db, new Map()),
      }))
      expect(baseline.checkpoint.cursor).toBe(6_002)
      expect(baseline.sessions[0]?.status).toBe('active')
      const tail = publicJournal.boundedReplayPage(
        baseline.checkpoint.cursor,
        baseline.checkpoint.cursor,
        { maxRows: 5_000, maxBytes: 2 * 1024 * 1024, maxFrameBytes: 512 * 1024 }
      )
      expect(tail.events).toEqual([])
      expect(tail.hasMore).toBe(false)
    } finally {
      writer.close()
      publicJournal.db.close()
    }
  })
})
