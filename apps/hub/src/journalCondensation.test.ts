import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  isTransientSqliteContention,
  Journal,
  TransientHistoryIndexingError,
  WSEQ_RESET_KIND,
} from './journal.js'
import { verifyRecentCompactionSnapshot } from './journalCompactionGate.js'

type CondenseResult = {
  commandOutputDeltasDeleted: number
  diffSnapshotsDeleted: number
  itemStartedDeleted: number
  transientPayloadBytesDeleted: number
  oversizedTransientRowsRetained: number
  cursorCheckpointsWritten: number
}

type CondensableJournal = Journal & {
  condenseCompletedCodex(options: {
    nowMs: number
    graceMs: number
    deleteThroughSeq?: number
    maxCommandOutputDeltas?: number
    maxDiffSnapshots?: number
    maxItemStarted?: number
    maxTransientPayloadBytes?: number
  }): CondenseResult
}

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-07-26T12:00:00.000Z')
const OLD = new Date(NOW - 2 * HOUR)
const RECENT = new Date(NOW - 30 * 60 * 1000)

function condense(
  journal: Journal,
  options: {
    maxCommandOutputDeltas?: number
    maxDiffSnapshots?: number
    maxItemStarted?: number
    maxTransientPayloadBytes?: number
  } = {}
): CondenseResult {
  return (journal as CondensableJournal).condenseCompletedCodex({
    nowMs: NOW,
    graceMs: HOUR,
    ...options,
  })
}

function at(when: Date, run: () => void): void {
  vi.setSystemTime(when)
  run()
}

function commandDelta(itemId: string, turnId: string, delta: string): Record<string, unknown> {
  return { threadId: 'thread-1', turnId, itemId, delta }
}

function completedCommand(itemId: string, turnId: string): Record<string, unknown> {
  return {
    threadId: 'thread-1',
    turnId,
    item: { type: 'commandExecution', id: itemId, command: 'echo test', aggregatedOutput: 'test\n', exitCode: 0 },
  }
}

function startedItem(itemId: string, turnId: string, type = 'commandExecution'): Record<string, unknown> {
  return { threadId: 'thread-1', turnId, item: { type, id: itemId, command: 'echo test' } }
}

function diff(turnId: string, value: string): Record<string, unknown> {
  return { threadId: 'thread-1', turnId, diff: value }
}

function completedTurn(turnId: string): Record<string, unknown> {
  return { threadId: 'thread-1', turn: { id: turnId, status: 'completed', items: [] } }
}

describe('completed Codex journal condensation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-condense-'))

  afterEach(() => vi.useRealTimers())
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('gives the maintenance connection a bounded longer writer wait and classifies only lock contention', () => {
    const journal = new Journal(path.join(tmp, 'maintenance-busy-timeout.db'), { busyTimeoutMs: 30_000 })
    try {
      expect(journal.db.pragma('busy_timeout', { simple: true })).toBe(30_000)
      expect(isTransientSqliteContention(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }))).toBe(true)
      expect(isTransientSqliteContention(Object.assign(new Error('database table is locked'), { code: 'SQLITE_LOCKED' }))).toBe(true)
      expect(isTransientSqliteContention(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }))).toBe(false)
    } finally {
      journal.db.close()
    }
  })

  it('keeps the durable worker cursor after the event row carrying its high wseq is gone', () => {
    const file = path.join(tmp, 'legacy-cursor.db')
    const raw = new Database(file)
    raw.exec(
      'CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, wseq INTEGER)'
    )
    raw
      .prepare('INSERT INTO events (ts, session, kind, payload, wseq) VALUES (?, ?, ?, ?, ?)')
      .run(OLD.toISOString(), 's', 'codex/item/commandExecution/outputDelta', '{}', 9)
    raw.close()

    const journal = new Journal(file)
    try {
      journal.db.prepare('DELETE FROM events WHERE session = ?').run('s')
      expect(journal.lastJournaledWseq('s')).toBe(9)
    } finally {
      journal.db.close()
    }
  })

  it('keeps the new-era cursor after a reset even if its high-wseq event is removed', () => {
    const journal = new Journal(path.join(tmp, 'reset-cursor.db'))
    try {
      journal.appendWorker('s', 'codex/item/commandExecution/outputDelta', {}, 12)
      journal.append('s', WSEQ_RESET_KIND, { reason: 'worker respawn' })
      const fresh = journal.appendWorker('s', 'codex/item/commandExecution/outputDelta', {}, 3)
      journal.db.prepare('DELETE FROM events WHERE seq = ?').run(fresh.seq)
      expect(journal.lastJournaledWseq('s')).toBe(3)
    } finally {
      journal.db.close()
    }
  })

  it('removes old completed command deltas but keeps terminal, live, recent, mismatched, and malformed rows', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'commands.db'))
    try {
      at(OLD, () => {
        journal.append('s', 'codex/item/commandExecution/outputDelta', commandDelta('done', 'turn-done', 'a'))
        journal.append('s', 'codex/item/commandExecution/outputDelta', commandDelta('done', 'turn-done', 'b'))
        journal.append('s', 'codex/item/completed', completedCommand('done', 'turn-done'))
        journal.append('s', 'codex/item/commandExecution/outputDelta', commandDelta('live', 'turn-live', 'keep'))
        // Same item id, but a different turn: item ids are expected to be unique, yet a destructive
        // maintenance job must scope its proof rather than rely on that vendor convention.
        journal.append('s', 'codex/item/commandExecution/outputDelta', commandDelta('done', 'turn-other', 'keep'))
        journal.append('s', 'codex/item/commandExecution/outputDelta', commandDelta('no-final', 'turn-no-final', 'keep'))
        journal.append('s', 'codex/item/completed', {
          threadId: 'thread-1',
          turnId: 'turn-no-final',
          item: { type: 'commandExecution', id: 'no-final', command: 'echo lost' },
        })
        journal.db
          .prepare('INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)')
          .run(OLD.toISOString(), 's', 'codex/item/commandExecution/outputDelta', '{"orphaned":"\\')
      })
      at(RECENT, () => {
        journal.append('s', 'codex/item/commandExecution/outputDelta', commandDelta('recent', 'turn-recent', 'keep'))
        journal.append('s', 'codex/item/completed', completedCommand('recent', 'turn-recent'))
      })

      const result = condense(journal)
      expect(result.commandOutputDeltasDeleted).toBe(2)
      const rows = journal.since(0, 100)
      // Deleted seqs make intentional holes. The paged replay cursor is `seq > lastSeen`, not arithmetic;
      // prove a small page still drains every retained row instead of stopping at the first hole.
      expect([...journal.replay(0, 2)]).toEqual(rows)
      expect(rows.filter((event) => event.kind === 'codex/item/completed')).toHaveLength(3)
      expect(
        rows
          .filter((event) => event.kind === 'codex/item/commandExecution/outputDelta')
          .map((event) => (event.payload as { itemId?: string }).itemId)
      ).toEqual(['live', 'done', 'no-final', undefined, 'recent'])
      expect((rows.find((event) => (event.payload as { __unreadable?: boolean }).__unreadable)?.payload as { __unreadable: boolean }).__unreadable).toBe(true)
    } finally {
      journal.db.close()
    }
  })

  it('removes an old item start only after the exact completed item is durable', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'completed-starts.db'))
    try {
      at(OLD, () => {
        journal.append('s', 'codex/item/started', startedItem('done', 'turn-done'))
        journal.append('s', 'codex/item/completed', completedCommand('done', 'turn-done'))
        journal.append('s', 'codex/item/started', startedItem('live', 'turn-live'))
        journal.append('s', 'codex/item/started', startedItem('same-id', 'turn-a'))
        journal.append('s', 'codex/item/completed', completedCommand('same-id', 'turn-b'))
        // A context-compaction lifecycle without full correlation remains visible and fails closed.
        journal.append('s', 'codex/item/started', { item: { type: 'contextCompaction', id: 'compact' } })
        journal.append('s', 'codex/item/completed', { item: { type: 'contextCompaction', id: 'compact' } })
      })
      at(RECENT, () => {
        journal.append('s', 'codex/item/started', startedItem('recent', 'turn-recent'))
        journal.append('s', 'codex/item/completed', completedCommand('recent', 'turn-recent'))
      })

      const result = condense(journal)
      expect(result.itemStartedDeleted).toBe(1)
      expect(journal.since(0, 100).filter((event) => event.kind === 'codex/item/started').map((event) => {
        const payload = event.payload as { turnId?: string; item?: { id?: string } }
        return [payload.turnId, payload.item?.id]
      })).toEqual([
        ['turn-live', 'live'],
        ['turn-a', 'same-id'],
        [undefined, 'compact'],
        ['turn-recent', 'recent'],
      ])
    } finally {
      journal.db.close()
    }
  })

  it('rewinds only the bounded projection frontier when upgrading a journal that predates start indexing', () => {
    vi.useFakeTimers()
    const file = path.join(tmp, 'started-projection-upgrade.db')
    let journal = new Journal(file)
    at(OLD, () => {
      journal.append('s', 'codex/item/started', startedItem('upgrade', 'turn-upgrade'))
      journal.append('s', 'codex/item/completed', completedCommand('upgrade', 'turn-upgrade'))
    })
    while (!journal.backfillTransientEventIndex(10).complete) {}
    const target = journal.db.prepare('SELECT MAX(seq) FROM events').pluck().get() as number
    // Recreate the exact old-version state: frontier complete, but the new kind absent and migration unseen.
    journal.db.prepare("DELETE FROM journal_transient_event_index WHERE kind = 'codex/item/started'").run()
    journal.db.prepare('UPDATE journal_transient_index_state SET scanned_through = ? WHERE singleton = 1').run(target)
    journal.db.prepare("DELETE FROM journal_migrations WHERE name = 'transient-item-started-v1'").run()
    journal.db.close()

    journal = new Journal(file)
    try {
      expect(journal.db.prepare('SELECT scanned_through FROM journal_transient_index_state').pluck().get()).toBe(0)
      while (!journal.backfillTransientEventIndex(1).complete) {}
      expect(condense(journal).itemStartedDeleted).toBe(1)
    } finally {
      journal.db.close()
    }
  })

  it('keeps one cumulative diff per old correlated turn without claiming a missing terminal outcome', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'diffs.db'))
    try {
      at(OLD, () => {
        journal.append('s', 'codex/turn/diff/updated', diff('done', 'first'))
        journal.append('s', 'codex/turn/diff/updated', diff('done', 'second'))
        journal.append('s', 'codex/turn/diff/updated', diff('done', 'final'))
        journal.append('s', 'codex/turn/completed', completedTurn('done'))
        journal.append('s', 'codex/turn/diff/updated', diff('live', 'live-1'))
        journal.append('s', 'codex/turn/diff/updated', diff('live', 'live-2'))
      })
      at(RECENT, () => {
        journal.append('s', 'codex/turn/diff/updated', diff('recent', 'recent-1'))
        journal.append('s', 'codex/turn/diff/updated', diff('recent', 'recent-final'))
        journal.append('s', 'codex/turn/completed', completedTurn('recent'))
      })

      const result = condense(journal)
      expect(result.diffSnapshotsDeleted).toBe(3)
      const remaining = journal
        .since(0, 100)
        .filter((event) => event.kind === 'codex/turn/diff/updated')
        .map((event) => event.payload as { turnId: string; diff: string })
      expect(remaining).toEqual([
        { threadId: 'thread-1', turnId: 'done', diff: 'final' },
        { threadId: 'thread-1', turnId: 'live', diff: 'live-2' },
        { threadId: 'thread-1', turnId: 'recent', diff: 'recent-1' },
        { threadId: 'thread-1', turnId: 'recent', diff: 'recent-final' },
      ])
    } finally {
      journal.db.close()
    }
  })

  it('caps each synchronous sweep so the periodic job cannot monopolize the hub event loop', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'bounded.db'))
    try {
      at(OLD, () => {
        for (let i = 0; i < 5; i += 1) {
          journal.append('s', 'codex/item/commandExecution/outputDelta', commandDelta(`item-${i}`, `turn-${i}`, 'x'))
          journal.append('s', 'codex/item/completed', completedCommand(`item-${i}`, `turn-${i}`))
        }
      })
      expect(condense(journal, { maxCommandOutputDeltas: 2 }).commandOutputDeltasDeleted).toBe(2)
      expect(condense(journal, { maxCommandOutputDeltas: 2 }).commandOutputDeltasDeleted).toBe(2)
      expect(condense(journal, { maxCommandOutputDeltas: 2 }).commandOutputDeltasDeleted).toBe(1)
    } finally {
      journal.db.close()
    }
  })

  it('freezes snapshot coverage at the exact deletion frontier instead of lifecycle high-water', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'snapshot-frontier.db'))
    try {
      let firstCandidate = 0
      at(OLD, () => {
        journal.append('s', 'codex/item/completed', completedCommand('done', 'turn-done'))
        firstCandidate = journal.append(
          's',
          'codex/item/commandExecution/outputDelta',
          commandDelta('done', 'turn-done', 'covered')
        ).seq
      })
      while (!journal.backfillTransientEventIndex(5).complete) {
        // bounded projection catch-up is deliberately resumable
      }

      const deleteThroughSeq = journal.condensationCandidateFrontier({
        nowMs: NOW,
        graceMs: HOUR,
      })
      expect(deleteThroughSeq).toBe(firstCandidate)

      const operationId = '11111111-1111-4111-8111-111111111111'
      const lifecycle = journal.recordCompactionLifecycle(operationId, 'started', {
        detail: 'Bounded journal maintenance child is being launched.',
        now: new Date(NOW).toISOString(),
      })
      const startSeq = journal.replayCheckpoint().cursor
      expect(startSeq).toBe(deleteThroughSeq + 1)
      expect(lifecycle.phase).toBe('started')

      const verifier = vi.fn((_directory: string, requiredThroughSeq: number) => ({
        ok: true as const,
        evidence: {
          rootId: 'root-1',
          journalId: 'journal-1',
          generation: '1',
          snapshotMaxSeq: String(requiredThroughSeq),
          snapshotEventHighWater: String(requiredThroughSeq),
          verifiedAt: new Date(NOW).toISOString(),
        },
      }))
      expect(
        verifyRecentCompactionSnapshot('/owned', deleteThroughSeq, NOW, verifier)
      ).toMatchObject({ ok: true })
      expect(verifier).toHaveBeenCalledWith('/owned', firstCandidate, NOW)

      let laterCandidate = 0
      at(OLD, () => {
        laterCandidate = journal.append(
          's',
          'codex/item/commandExecution/outputDelta',
          commandDelta('done', 'turn-done', 'not covered yet')
        ).seq
      })
      while (!journal.backfillTransientEventIndex(5).complete) {
        // catch up without changing the operation's immutable deletion frontier
      }
      expect(journal.condensationCandidateFrontier({ nowMs: NOW, graceMs: HOUR })).toBe(laterCandidate)
      expect(
        journal.condensationCandidateFrontier({
          nowMs: NOW,
          graceMs: HOUR,
          maxSeq: firstCandidate,
        })
      ).toBe(firstCandidate)
      expect(
        journal.condensationCandidateFrontier({
          nowMs: NOW,
          graceMs: HOUR,
          maxSeq: firstCandidate - 1,
        })
      ).toBe(0)
      const result = (journal as CondensableJournal).condenseCompletedCodex({
        nowMs: NOW,
        graceMs: HOUR,
        deleteThroughSeq,
      })
      expect(result.commandOutputDeltasDeleted).toBe(1)
      expect(journal.db.prepare('SELECT seq FROM events WHERE seq = ?').get(firstCandidate)).toBeUndefined()
      expect(journal.db.prepare('SELECT seq FROM events WHERE seq = ?').get(startSeq)).toEqual({
        seq: startSeq,
      })
      expect(journal.db.prepare('SELECT seq FROM events WHERE seq = ?').get(laterCandidate)).toEqual({
        seq: laterCandidate,
      })
    } finally {
      journal.db.close()
    }
  })

  it('builds its maintenance projection in bounded resumable batches without a live events index build', () => {
    const file = path.join(tmp, 'projection-upgrade.db')
    const raw = new Database(file)
    raw.exec(
      'CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, wseq INTEGER)'
    )
    const insert = raw.prepare(
      'INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)'
    )
    for (let i = 0; i < 12; i += 1) {
      insert.run(
        OLD.toISOString(),
        's',
        'codex/item/commandExecution/outputDelta',
        JSON.stringify(commandDelta(`item-${i}`, `turn-${i}`, 'x'))
      )
      insert.run(
        OLD.toISOString(),
        's',
        'codex/item/completed',
        JSON.stringify(completedCommand(`item-${i}`, `turn-${i}`))
      )
    }
    raw.close()

    const journal = new Journal(file)
    try {
      expect(() => condense(journal)).toThrow(TransientHistoryIndexingError)
      const first = journal.backfillTransientEventIndex(5)
      expect(first).toMatchObject({ complete: false, scannedThrough: 5 })
      let pass = first
      while (!pass.complete) pass = journal.backfillTransientEventIndex(5)
      expect(pass.target).toBe(24)
      expect(condense(journal).commandOutputDeltasDeleted).toBe(12)
      expect(
        journal.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND name LIKE 'idx_events_condense_%'"
          )
          .all()
      ).toEqual([])
    } finally {
      journal.db.close()
    }
  })

  it('retains an individually oversized transient without starving later bounded cleanup', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'oversized-transient.db'))
    try {
      at(OLD, () => {
        journal.append(
          's',
          'codex/item/commandExecution/outputDelta',
          commandDelta('huge', 'turn-huge', 'x'.repeat(4_096))
        )
        journal.append('s', 'codex/item/completed', completedCommand('huge', 'turn-huge'))
        journal.append(
          's',
          'codex/item/commandExecution/outputDelta',
          commandDelta('small', 'turn-small', 'ok')
        )
        journal.append('s', 'codex/item/completed', completedCommand('small', 'turn-small'))
      })

      const result = condense(journal, { maxTransientPayloadBytes: 1_024 })
      expect(result.commandOutputDeltasDeleted).toBe(1)
      expect(result.transientPayloadBytesDeleted).toBeLessThanOrEqual(1_024)
      expect(result.oversizedTransientRowsRetained).toBe(1)
      const remaining = journal
        .since(0, 20)
        .filter((candidate) => candidate.kind === 'codex/item/commandExecution/outputDelta')
      expect(remaining).toHaveLength(1)
      expect((remaining[0]?.payload as { itemId?: string }).itemId).toBe('huge')
    } finally {
      journal.db.close()
    }
  })

  it('writes a compact wseq anchor before pruning, preserving rollback compatibility with the old MAX query', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'rollback-anchor.db'))
    try {
      at(OLD, () => {
        journal.append('s', WSEQ_RESET_KIND, { reason: 'new worker era' })
        journal.appendWorker(
          's',
          'codex/item/commandExecution/outputDelta',
          commandDelta('done', 'turn-done', 'large transient output'),
          7
        )
        // A null-wseq terminal row models a mixed-version/in-process completion. The delta is the only
        // legacy-query-visible high-water row, so deleting it without an anchor makes rollback replay it.
        journal.append('s', 'codex/item/completed', completedCommand('done', 'turn-done'))
      })

      const result = condense(journal)
      expect(result.commandOutputDeltasDeleted).toBe(1)
      expect(result.cursorCheckpointsWritten).toBe(1)
      const legacy = journal.db
        .prepare(
          `SELECT MAX(wseq) AS m FROM events
             WHERE session = ? AND wseq IS NOT NULL
               AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE session = ? AND kind = ?), 0)`
        )
        .get('s', 's', WSEQ_RESET_KIND) as { m: number | null }
      expect(legacy.m).toBe(7)
      expect(journal.lastJournaledWseq('s')).toBe(7)
      expect(journal.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').get(WSEQ_RESET_KIND)).toEqual({ n: 1 })
      expect(journal.db.prepare("SELECT wseq FROM events WHERE kind = 'session/wseq-checkpoint'").get()).toEqual({
        wseq: 7,
      })
    } finally {
      journal.db.close()
    }
  })
})
