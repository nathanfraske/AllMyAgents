import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Journal, WSEQ_RESET_KIND } from './journal.js'

type CondenseResult = {
  commandOutputDeltasDeleted: number
  diffSnapshotsDeleted: number
  cursorCheckpointsWritten: number
}

type CondensableJournal = Journal & {
  condenseCompletedCodex(options: {
    nowMs: number
    graceMs: number
    maxCommandOutputDeltas?: number
    maxDiffSnapshots?: number
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

  it('keeps one authoritative diff for an old completed turn and leaves live or recent turns untouched', () => {
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
      expect(result.diffSnapshotsDeleted).toBe(2)
      const remaining = journal
        .since(0, 100)
        .filter((event) => event.kind === 'codex/turn/diff/updated')
        .map((event) => event.payload as { turnId: string; diff: string })
      expect(remaining).toEqual([
        { threadId: 'thread-1', turnId: 'done', diff: 'final' },
        { threadId: 'thread-1', turnId: 'live', diff: 'live-1' },
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
