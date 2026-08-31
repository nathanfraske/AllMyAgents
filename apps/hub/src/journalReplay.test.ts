import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Journal } from './journal.js'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-07-30T12:00:00.000Z')
const OLD = new Date(NOW - 2 * HOUR)
const RECENT = new Date(NOW - 30 * 60 * 1000)

function at(when: Date, run: () => void): void {
  vi.setSystemTime(when)
  run()
}

function indexAll(journal: Journal): void {
  while (!journal.backfillSessionEventIndex(10).complete) {
    // Deliberately small batches exercise the resumable cursor.
  }
}

describe('bounded replay checkpoints and journal history', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-replay-'))

  afterEach(() => vi.useRealTimers())
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('serves a versioned current cursor and a latest-first bounded session page', async () => {
    const journal = new Journal(path.join(tmp, 'checkpoint.db'))
    try {
      expect(journal.replayCheckpoint()).toEqual({
        version: 1,
        generation: 1,
        cursor: 0,
        resetFloorSeq: 0,
      })
      for (let index = 0; index < 12; index += 1) {
        journal.append('s', 'session/input', { text: `message-${index}` })
      }
      journal.append('other', 'session/input', { text: 'not in this page' })

      const checkpoint = journal.replayCheckpoint()
      expect(checkpoint).toEqual({
        version: 1,
        generation: 1,
        cursor: 13,
        resetFloorSeq: 0,
      })
      expect((await journal.sessionHistoryPage('s')).events).toHaveLength(12)
      indexAll(journal)
      const page = await journal.sessionHistoryPage('s', {
        beforeSeq: checkpoint.cursor + 1,
        maxRows: 5,
        maxBytes: 8 * 1024,
      })
      expect(page.events.map((event) => (event.payload as { text: string }).text)).toEqual([
        'message-7',
        'message-8',
        'message-9',
        'message-10',
        'message-11',
      ])
      expect(page.events.every((event) => event.sessionId === 's')).toBe(true)
      expect(page.hasOlder).toBe(true)
      expect(page.olderCursor).toBe(page.events[0]?.seq)
      expect(page.checkpointGeneration).toBe(1)

      const older = await journal.sessionHistoryPage('s', {
        beforeSeq: page.olderCursor!,
        maxRows: 5,
        maxBytes: 8 * 1024,
      })
      expect(older.events.map((event) => (event.payload as { text: string }).text)).toEqual([
        'message-2',
        'message-3',
        'message-4',
        'message-5',
        'message-6',
      ])
      expect(older.hasOlder).toBe(true)
    } finally {
      journal.db.close()
    }
  })

  it('pages transcript semantics instead of letting streaming deltas hide completed replies', async () => {
    const journal = new Journal(path.join(tmp, 'semantic-history.db'))
    try {
      journal.append('s', 'session/input', { text: 'operator prompt' })
      for (let index = 0; index < 200; index += 1) {
        journal.append('s', 'codex/item/agentMessage/delta', {
          itemId: 'reply',
          delta: `fragment-${index}`,
        })
      }
      journal.append('s', 'codex/item/completed', {
        item: { id: 'reply', type: 'agentMessage', text: 'durable completed reply' },
      })
      // This is the exact live failure shape: a completed commentary item followed by enough noisy
      // output from the next long-running command to crowd it out of an 80-raw-row history page.
      for (let index = 0; index < 400; index += 1) {
        journal.append('s', 'codex/item/commandExecution/outputDelta', {
          itemId: 'command',
          delta: `test-output-${index}\n`,
        })
      }
      indexAll(journal)

      const page = await journal.sessionHistoryPage('s', { maxRows: 5, maxBytes: 64 * 1024 })
      expect(page.events.map((event) => event.kind)).toEqual([
        'session/input',
        'codex/item/completed',
      ])
      expect(page.events[1]?.payload).toEqual(
        expect.objectContaining({
          item: expect.objectContaining({ text: 'durable completed reply' }),
        }),
      )
      expect(page.hasOlder).toBe(false)
      expect(page.olderCursor).toBeNull()
    } finally {
      journal.db.close()
    }
  })

  it('never exceeds the page byte budget and progresses past an individually oversized row', async () => {
    const journal = new Journal(path.join(tmp, 'bytes.db'))
    try {
      journal.append('s', 'session/input', { text: 'a'.repeat(700) })
      journal.append('s', 'session/input', { text: 'b'.repeat(700) })
      indexAll(journal)
      const page = await journal.sessionHistoryPage('s', {
        maxRows: 80,
        maxBytes: 1_024,
      })
      expect(page.events).toHaveLength(1)
      expect(page.encodedBytes).toBeLessThanOrEqual(1_024)
      expect(page.hasOlder).toBe(true)

      journal.db
        .prepare('INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)')
        .run(OLD.toISOString(), 's', 'session/input', `{"unparseable":"${'x'.repeat(2 * 1024 * 1024)}`)
      indexAll(journal)
      const oversized = await journal.sessionHistoryPage('s', {
        maxRows: 80,
        maxBytes: 1_024,
      })
      expect(oversized.events).toEqual([
        expect.objectContaining({
          kind: 'journal/history-event-oversized',
          payload: expect.objectContaining({
            originalKind: 'session/input',
            originalPayloadBytes: expect.any(Number),
          }),
        }),
      ])
      expect(oversized.olderCursor).toBe(oversized.events[0]?.seq)
      const progressed = await journal.sessionHistoryPage('s', {
        beforeSeq: oversized.olderCursor!,
        maxRows: 80,
        maxBytes: 1_024,
      })
      expect(progressed.events[0]?.seq).toBeLessThan(oversized.events[0]!.seq)
    } finally {
      journal.db.close()
    }
  })

  it('does not read a blob body that metadata proves cannot fit in a history page', async () => {
    const journal = new Journal(path.join(tmp, 'blob-page-budget.db'))
    try {
      journal.append('s', 'codex/item/completed', {
        item: {
          id: 'large-command',
          type: 'commandExecution',
          aggregatedOutput: 'cold output\n'.repeat(64 * 1024),
        },
      })
      indexAll(journal)
      const read = vi.spyOn(fs.promises, 'readFile')

      const page = await journal.sessionHistoryPage('s', {
        maxRows: 80,
        maxBytes: 512 * 1024,
      })

      expect(page.events).toEqual([
        expect.objectContaining({ kind: 'journal/history-event-oversized' }),
      ])
      expect(read).not.toHaveBeenCalled()
    } finally {
      journal.db.close()
    }
  })

  it('hydrates only the cold blob working set that can fit in one page', async () => {
    const journal = new Journal(path.join(tmp, 'blob-working-set.db'))
    try {
      for (let index = 0; index < 12; index += 1) {
        journal.append('s', 'session/input', {
          text: `${index}:` + String.fromCharCode(65 + index).repeat(70 * 1024),
        })
      }
      indexAll(journal)
      const read = vi.spyOn(fs.promises, 'readFile')

      const page = await journal.sessionHistoryPage('s', {
        maxRows: 80,
        maxBytes: 256 * 1024,
      })

      expect(page.events).toHaveLength(3)
      expect(page.hasOlder).toBe(true)
      expect(read).toHaveBeenCalledTimes(3)
    } finally {
      journal.db.close()
    }
  })

  it('keeps a completed projection frontier complete across appends, deletes, and reopen', async () => {
    const file = path.join(tmp, 'frontier.db')
    let journal = new Journal(file)
    try {
      journal.append('s', 'session/input', { text: 'first' })
      indexAll(journal)
      journal.append('s', 'session/input', { text: 'second' })
      expect((await journal.sessionHistoryPage('s')).events).toHaveLength(2)
      journal.db.prepare('DELETE FROM events WHERE seq = 2').run()
      expect((await journal.sessionHistoryPage('s')).events).toHaveLength(1)
      journal.db.close()

      journal = new Journal(file)
      journal.append('s', 'session/input', { text: 'after restart' })
      expect((await journal.sessionHistoryPage('s')).events.map((row) => row.seq)).toEqual([1, 3])
    } finally {
      if (journal.db.open) journal.db.close()
    }
  })

  it('does not decode an oversized raw replay row before returning a bounded refusal', () => {
    const journal = new Journal(path.join(tmp, 'raw-replay.db'))
    try {
      journal.db
        .prepare('INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)')
        .run(OLD.toISOString(), 's', 'session/input', `{"secret":"${'z'.repeat(2 * 1024 * 1024)}`)
      const checkpoint = journal.replayCheckpoint()
      const page = journal.boundedReplayPage(0, checkpoint.cursor, {
        maxRows: 10,
        maxBytes: 2 * 1024 * 1024,
        maxFrameBytes: 512 * 1024,
      })
      expect(page.events).toEqual([])
      expect(page.tooLarge).toEqual(expect.objectContaining({ seq: 1 }))
      expect(page.checkpoint).toEqual(checkpoint)
    } finally {
      journal.db.close()
    }
  })

  it('does not synchronously hydrate an external blob that metadata proves cannot fit a replay frame', () => {
    const journal = new Journal(path.join(tmp, 'blob-replay-budget.db'))
    try {
      journal.append('s', 'session/input', { text: 'z'.repeat(700 * 1024) })
      const read = vi.spyOn(fs, 'readFileSync')
      const checkpoint = journal.replayCheckpoint()
      const page = journal.boundedReplayPage(0, checkpoint.cursor, {
        maxRows: 10,
        maxBytes: 2 * 1024 * 1024,
        maxFrameBytes: 128 * 1024,
      })
      expect(page.events).toEqual([])
      expect(page.tooLarge).toEqual(expect.objectContaining({ seq: 1 }))
      expect(read).not.toHaveBeenCalled()
    } finally {
      journal.db.close()
    }
  })

  it('skips an unobserved oversized row without hydrating it and advances the durable cursor', () => {
    const journal = new Journal(path.join(tmp, 'filtered-raw-replay.db'))
    try {
      journal.db
        .prepare('INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)')
        .run(OLD.toISOString(), 'hidden', 'session/input', `{"secret":"${'z'.repeat(2 * 1024 * 1024)}`)
      const checkpoint = journal.replayCheckpoint()
      const page = journal.boundedReplayPage(0, checkpoint.cursor, {
        maxRows: 10,
        maxBytes: 512 * 1024,
        maxFrameBytes: 128 * 1024,
        eventFilter: ({ sessionId }) => sessionId === 'visible',
      })
      expect(page.events).toEqual([])
      expect(page.tooLarge).toBeUndefined()
      expect(page.lastSeq).toBe(checkpoint.cursor)
      expect(page.hasMore).toBe(false)
    } finally {
      journal.db.close()
    }
  })

  it('uses the bounded session projection instead of scanning the payload-heavy event tree', async () => {
    const journal = new Journal(path.join(tmp, 'sparse.db'))
    try {
      for (let index = 0; index < 300; index += 1) {
        journal.append(index % 149 === 0 ? 'needle' : `other-${index % 17}`, 'session/input', {
          text: 'x'.repeat(256),
        })
      }
      indexAll(journal)
      const plan = journal.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT event.seq
           FROM journal_session_event_index AS session_event
           JOIN events AS event ON event.seq = session_event.seq
           WHERE session_event.session = ? AND session_event.seq < ?
           ORDER BY session_event.seq DESC
           LIMIT ?`
        )
        .all('needle', Number.MAX_SAFE_INTEGER, 80) as Array<{ detail: string }>
      expect(plan.map((row) => row.detail).join('\n')).toMatch(/PRIMARY KEY \(session=\? AND seq<\?\)/i)
      expect((await journal.sessionHistoryPage('needle')).events).toHaveLength(3)
    } finally {
      journal.db.close()
    }
  })

  it('advances the replay generation atomically when superseded terminal data is removed', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'generation.db'))
    let highestDeletedSeq = 0
    try {
      at(OLD, () => {
        journal.append('s', 'codex/item/agentMessage/delta', {
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'answer',
          delta: 'hel',
        })
        highestDeletedSeq = journal.appendWorker(
          's',
          'codex/item/agentMessage/delta',
          { threadId: 'thread', turnId: 'turn', itemId: 'answer', delta: 'lo' },
          9
        ).seq
        journal.append('s', 'codex/item/completed', {
          threadId: 'thread',
          turnId: 'turn',
          item: { id: 'answer', type: 'agentMessage', text: 'hello' },
        })
        highestDeletedSeq = journal.append('s', 'codex/turn/diff/updated', {
          threadId: 'thread',
          turnId: 'stuck-turn',
          diff: 'first',
        }).seq
        journal.append('s', 'codex/turn/diff/updated', {
          threadId: 'thread',
          turnId: 'stuck-turn',
          diff: 'final',
        })
      })

      const before = journal.replayCheckpoint()
      const result = journal.condenseCompletedCodex({
        nowMs: NOW,
        graceMs: HOUR,
        maxCommandOutputDeltas: 10_000,
        maxAgentMessageDeltas: 10_000,
        maxDiffSnapshots: 10_000,
      })
      const after = journal.replayCheckpoint()

      expect(result.agentMessageDeltasDeleted).toBe(2)
      expect(result.diffSnapshotsDeleted).toBe(1)
      expect(result.cursorCheckpointsWritten).toBe(1)
      expect(after.generation).toBe(before.generation + 1)
      expect(after.resetFloorSeq).toBe(highestDeletedSeq)
      expect(journal.lastJournaledWseq('s')).toBe(9)
      expect(
        journal.since(0, 100).filter((event) => event.kind === 'codex/item/agentMessage/delta')
      ).toHaveLength(0)
      expect(
        journal.since(0, 100).filter((event) => event.kind === 'codex/turn/diff/updated')
      ).toEqual([
        expect.objectContaining({
          payload: { threadId: 'thread', turnId: 'stuck-turn', diff: 'final' },
        }),
      ])
    } finally {
      journal.db.close()
    }
  })

  it('keeps active, recent, malformed, and non-canonical message data fail closed', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'fail-closed.db'))
    try {
      at(OLD, () => {
        journal.append('s', 'codex/item/agentMessage/delta', {
          threadId: 'thread',
          turnId: 'active',
          itemId: 'no-terminal',
          delta: 'keep',
        })
        journal.append('s', 'codex/item/agentMessage/delta', {
          threadId: 'thread',
          turnId: 'unknown',
          itemId: 'missing-final-text',
          delta: 'keep',
        })
        journal.append('s', 'codex/item/completed', {
          threadId: 'thread',
          turnId: 'unknown',
          item: { id: 'missing-final-text', type: 'agentMessage' },
        })
        journal.db
          .prepare('INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)')
          .run(OLD.toISOString(), 's', 'codex/item/agentMessage/delta', '{"broken":"\\')
      })
      at(RECENT, () => {
        journal.append('s', 'codex/item/agentMessage/delta', {
          threadId: 'thread',
          turnId: 'recent',
          itemId: 'recent',
          delta: 'keep',
        })
        journal.append('s', 'codex/item/completed', {
          threadId: 'thread',
          turnId: 'recent',
          item: { id: 'recent', type: 'agentMessage', text: 'keep' },
        })
      })

      const before = journal.replayCheckpoint()
      const result = journal.condenseCompletedCodex({
        nowMs: NOW,
        graceMs: HOUR,
        maxAgentMessageDeltas: 10_000,
      })
      expect(result.agentMessageDeltasDeleted).toBe(0)
      expect(journal.replayCheckpoint().generation).toBe(before.generation)
      expect(
        journal.since(0, 100).filter((event) => event.kind === 'codex/item/agentMessage/delta')
      ).toHaveLength(4)
    } finally {
      journal.db.close()
    }
  })

  it('journals a bounded global maintenance lifecycle across restart with idempotent terminal evidence', () => {
    const file = path.join(tmp, 'compaction-lifecycle.db')
    const operationId = '11111111-1111-4111-8111-111111111111'
    let journal = new Journal(file)
    try {
      journal.recordCompactionLifecycle(operationId, 'started', {
        detail: 'started',
        now: '2026-07-30T12:00:00.000Z',
      })
      journal.recordCompactionLifecycle(operationId, 'progress', {
        rowsDeleted: 10,
        payloadBytesDeleted: 1_024,
        detail: 'bounded progress',
        now: '2026-07-30T12:00:01.000Z',
      })
    } finally {
      journal.db.close()
    }

    journal = new Journal(file)
    try {
      const completed = journal.recordCompactionLifecycle(operationId, 'completed', {
        rowsDeleted: 10,
        payloadBytesDeleted: 1_024,
        detail: 'complete',
        now: '2026-07-30T12:00:02.000Z',
      })
      expect(journal.latestCompactionLifecycle()).toEqual(completed)
      const beforeDuplicate = journal.replayCheckpoint().cursor
      expect(
        journal.recordCompactionLifecycle(operationId, 'completed', {
          rowsDeleted: 10,
          payloadBytesDeleted: 1_024,
          detail: 'complete',
          now: '2026-07-30T12:00:03.000Z',
        })
      ).toEqual(completed)
      expect(journal.replayCheckpoint().cursor).toBe(beforeDuplicate)
      expect(() =>
        journal.recordCompactionLifecycle(operationId, 'failed', {
          rowsDeleted: 10,
          payloadBytesDeleted: 1_024,
          detail: 'conflicting terminal',
        })
      ).toThrow(/already terminal/)
      expect(
        journal
          .since(0, 100)
          .filter((event) => event.kind.startsWith('journal/compaction-'))
          .map((event) => event.kind)
      ).toEqual([
        'journal/compaction-started',
        'journal/compaction-progress',
        'journal/compaction-completed',
      ])
    } finally {
      journal.db.close()
    }
  })

  it('widens the persisted maintenance lifecycle schema before recording an intentional deferral', () => {
    const file = path.join(tmp, 'compaction-deferred-migration.db')
    const initial = new Journal(file)
    initial.db.close()
    const legacy = new Database(file)
    legacy.exec(`
      DROP INDEX idx_journal_compaction_runs_updated;
      DROP TABLE journal_compaction_runs;
      CREATE TABLE journal_compaction_runs (
        operation_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL CHECK (
          phase IN ('started', 'progress', 'completed', 'failed', 'unobservable')
        ),
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        rows_deleted INTEGER NOT NULL CHECK (rows_deleted >= 0),
        payload_bytes_deleted INTEGER NOT NULL CHECK (payload_bytes_deleted >= 0),
        detail TEXT NOT NULL CHECK (length(detail) <= 512)
      );
      CREATE INDEX idx_journal_compaction_runs_updated
        ON journal_compaction_runs(updated_at DESC, operation_id DESC);
    `)
    legacy.close()

    const journal = new Journal(file)
    try {
      const operationId = '22222222-2222-4222-8222-222222222222'
      journal.recordCompactionLifecycle(operationId, 'started', { detail: 'started' })
      const deferred = journal.recordCompactionLifecycle(operationId, 'deferred', {
        detail: 'waiting for the next verified recovery snapshot',
      })
      expect(deferred.phase).toBe('deferred')
      expect(journal.latestCompactionLifecycle()).toEqual(deferred)
    } finally {
      journal.db.close()
    }
  })
})
