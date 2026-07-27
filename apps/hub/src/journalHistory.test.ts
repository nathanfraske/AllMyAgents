import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Journal, WSEQ_RESET_KIND } from './journal.js'

type HistoryCondenseResult = {
  commandOutputDeltasDeleted: number
  diffSnapshotsDeleted: number
  cursorCheckpointsWritten: number
  historyTurnsRolledUp: number
  historyTurnsDeferred: number
  historyTurnsExpired: number
  historyRowsDeleted: number
}

type HistoryCondensableJournal = Journal & {
  condenseCompletedCodex(options: {
    nowMs: number
    graceMs: number
    historyGraceMs: number
    historyRetentionMs: number
    maxHistoryTurns: number
    maxExpiredHistoryTurns: number
    maxHistorySourceRows?: number
    maxHistorySourceBytes?: number
  }): HistoryCondenseResult
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-07-26T12:00:00.000Z')
const OLD = new Date(NOW - 31 * DAY)

function at(when: Date, run: () => void): void {
  vi.setSystemTime(when)
  run()
}

function condense(
  journal: Journal,
  options: Partial<{
    historyGraceMs: number
    historyRetentionMs: number
    maxHistoryTurns: number
    maxExpiredHistoryTurns: number
    maxHistorySourceRows: number
    maxHistorySourceBytes: number
  }> = {}
): HistoryCondenseResult {
  return (journal as HistoryCondensableJournal).condenseCompletedCodex({
    nowMs: NOW,
    graceMs: 60 * 60 * 1000,
    historyGraceMs: 30 * DAY,
    historyRetentionMs: 5 * 365 * DAY,
    maxHistoryTurns: 10,
    maxExpiredHistoryTurns: 10,
    ...options,
  })
}

function codexCompleted(turnId: string, item: Record<string, unknown>): Record<string, unknown> {
  return { threadId: 'thread-1', turnId, item }
}

describe('long-run journal history rollup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-history-rollup-'))

  afterEach(() => vi.useRealTimers())
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('ships with unique history rewriting off while still removing superseded stream rows', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'default-is-nondestructive.db'))
    try {
      let reasoningSeq = 0
      at(OLD, () => {
        journal.append('s-default', 'session/input', { text: 'Keep the exact audit record.' })
        journal.append('s-default', 'codex/turn/started', {
          threadId: 'thread-1',
          turn: { id: 'turn-default' },
        })
        journal.append('s-default', 'codex/item/commandExecution/outputDelta', {
          threadId: 'thread-1',
          turnId: 'turn-default',
          itemId: 'cmd-default',
          delta: 'superseded stream fragment',
        })
        journal.append(
          's-default',
          'codex/item/completed',
          codexCompleted('turn-default', {
            id: 'cmd-default',
            type: 'commandExecution',
            command: 'inspect',
            aggregatedOutput: 'complete command output',
            status: 'completed',
          })
        )
        reasoningSeq = journal.append(
          's-default',
          'codex/item/completed',
          codexCompleted('turn-default', {
            id: 'reason-default',
            type: 'reasoning',
            text: 'unique reasoning detail with no second durable copy',
          })
        ).seq
        journal.append('s-default', 'codex/turn/completed', {
          threadId: 'thread-1',
          turn: { id: 'turn-default', status: 'completed', items: [] },
        })
      })

      // Deliberately use the shipped defaults for both history limits. This is the regression: changing
      // either default back above zero silently makes a 30-day-old chat lose unique audit detail.
      const result = journal.condenseCompletedCodex({ nowMs: NOW, graceMs: 60 * 60 * 1000 })
      expect(result.commandOutputDeltasDeleted).toBe(1)
      expect(result.historyTurnsRolledUp).toBe(0)
      expect(result.historyTurnsExpired).toBe(0)
      expect(journal.since(0).find((event) => event.seq === reasoningSeq)?.payload).toEqual(
        codexCompleted('turn-default', {
          id: 'reason-default',
          type: 'reasoning',
          text: 'unique reasoning detail with no second durable copy',
        })
      )
    } finally {
      journal.db.close()
    }
  })

  it('collapses an old completed Codex turn to prose plus one explicit tool rollup', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'codex.db'))
    try {
      at(OLD, () => {
        journal.append('s', 'session/input', { text: 'Please inspect the build.' })
        journal.append('s', 'codex/turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })
        journal.append('s', 'codex/item/started', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test' },
        })
        journal.append('s', 'codex/item/commandExecution/outputDelta', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'cmd-1',
          delta: 'streamed output that is superseded',
        })
        journal.append(
          's',
          'codex/item/completed',
          codexCompleted('turn-1', {
            id: 'cmd-1',
            type: 'commandExecution',
            command: 'npm test',
            aggregatedOutput: 'all tests passed',
            exitCode: 0,
            status: 'completed',
          })
        )
        journal.append(
          's',
          'codex/item/completed',
          codexCompleted('turn-1', { id: 'reason-1', type: 'reasoning', text: 'checked the failure modes' })
        )
        journal.append(
          's',
          'codex/item/completed',
          codexCompleted('turn-1', { id: 'answer-1', type: 'agentMessage', text: 'The build is healthy.' })
        )
        journal.append('s', 'codex/turn/completed', {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [] },
        })
      })

      const result = condense(journal)
      expect(result.historyTurnsRolledUp).toBe(1)
      const rows = [...journal.replay(0)]
      expect(rows.filter((event) => event.kind === 'session/input')).toHaveLength(1)
      expect(
        rows.some(
          (event) =>
            event.kind === 'codex/item/completed' &&
            (event.payload as { item?: { type?: string; text?: string } }).item?.type === 'agentMessage' &&
            (event.payload as { item?: { text?: string } }).item?.text === 'The build is healthy.'
        )
      ).toBe(true)
      const tools = rows.filter(
        (event) =>
          event.kind === 'codex/item/completed' &&
          (event.payload as { item?: { type?: string } }).item?.type === 'commandExecution'
      )
      expect(tools).toHaveLength(1)
      const rollup = (tools[0]?.payload as { item?: { command?: string; aggregatedOutput?: string } }).item
      expect(rollup?.command).toContain('history rollup')
      expect(rollup?.command).toContain('no command executed')
      expect(rollup?.aggregatedOutput).toContain('npm test')
      expect(rollup?.aggregatedOutput).toContain('all tests passed')
      expect(rows.some((event) => event.kind === 'codex/item/started')).toBe(false)
      expect(
        rows.some(
          (event) =>
            event.kind === 'codex/item/completed' &&
            (event.payload as { item?: { type?: string } }).item?.type === 'reasoning'
        )
      ).toBe(false)

      // A month-off machine may expose an enormous still-unswept turn. History maintenance must defer it
      // instead of defeating the bounded first-stage delta sweep with one giant synchronous delete.
      at(OLD, () => {
        journal.append('s', 'session/input', { text: 'second turn' })
        journal.append('s', 'codex/item/started', {
          threadId: 'thread-1',
          turnId: 'turn-2',
          item: { id: 'cmd-2', type: 'commandExecution', command: 'large turn' },
        })
        journal.append(
          's',
          'codex/item/completed',
          codexCompleted('turn-2', {
            id: 'answer-2',
            type: 'agentMessage',
            text: 'This turn should remain exact until a later batch.',
          })
        )
        journal.append('s', 'codex/turn/completed', {
          threadId: 'thread-1',
          turn: { id: 'turn-2', status: 'completed', items: [] },
        })
      })
      const deferred = condense(journal, { maxHistorySourceRows: 2 })
      expect(deferred.historyTurnsDeferred).toBe(1)
      expect(
        [...journal.replay(0)].some(
          (event) =>
            event.kind === 'session/input' &&
            (event.payload as { text?: string }).text === 'second turn'
        )
      ).toBe(true)
    } finally {
      journal.db.close()
    }
  })

  it('preserves Claude prose while pairing old tool calls and results into the explicit rollup', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'claude.db'))
    try {
      at(OLD, () => {
        journal.append('s', 'session/input', { text: 'Check disk usage.' })
        journal.append('s', 'claude/assistant', {
          message: {
            content: [
              { type: 'text', text: 'I will inspect it.' },
              { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'du -sh data' } },
            ],
          },
        })
        journal.append('s', 'claude/system', {
          subtype: 'task_progress',
          tool_use_id: 'tool-1',
          last_tool_name: 'Bash',
          usage: { tool_uses: 1 },
        })
        journal.append('s', 'claude/system', {
          subtype: 'future_semantic_event',
          detail: 'maintenance cannot prove this future subtype is telemetry',
        })
        journal.append('s', 'claude/user', {
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '390M data', is_error: false }],
          },
        })
        journal.append('s', 'claude/assistant', {
          message: { content: [{ type: 'text', text: 'The data directory is 390 MB.' }] },
        })
        journal.append('s', 'claude/result', { is_error: false, subtype: 'success', result: 'done' })
      })

      const result = condense(journal)
      expect(result.historyTurnsRolledUp).toBe(1)
      const rows = [...journal.replay(0)]
      const assistantText = rows
        .filter((event) => event.kind === 'claude/assistant')
        .flatMap(
          (event) =>
            (
              event.payload as {
                message?: { content?: Array<{ type?: string; text?: string; name?: string }> }
              }
            ).message?.content ?? []
        )
      expect(assistantText).toEqual([
        { type: 'text', text: 'I will inspect it.' },
        { type: 'text', text: 'The data directory is 390 MB.' },
      ])
      expect(rows.some((event) => event.kind === 'claude/user')).toBe(false)
      expect(
        rows.some(
          (event) =>
            event.kind === 'claude/system' &&
            (event.payload as { subtype?: string }).subtype === 'task_progress'
        )
      ).toBe(false)
      const rollup = rows.find(
        (event) =>
          event.kind === 'codex/item/completed' &&
          (event.payload as { item?: { command?: string } }).item?.command?.includes('history rollup')
      )
      const output = (rollup?.payload as { item?: { aggregatedOutput?: string } }).item?.aggregatedOutput
      expect(output).toContain('Bash')
      expect(output).toContain('du -sh data')
      expect(output).toContain('390M data')
      expect(
        rows.some(
          (event) =>
            event.kind === 'claude/system' &&
            (event.payload as { subtype?: string }).subtype === 'future_semantic_event'
        )
      ).toBe(true)
    } finally {
      journal.db.close()
    }
  })

  it('writes the rollback-compatible wseq checkpoint before a history rollup removes its cursor row', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'history-cursor.db'))
    try {
      at(OLD, () => {
        journal.append('s', WSEQ_RESET_KIND, { reason: 'worker respawn' })
        journal.appendWorker(
          's',
          'codex/item/completed',
          codexCompleted('turn-1', {
            id: 'cmd-1',
            type: 'commandExecution',
            command: 'echo hello',
            aggregatedOutput: 'hello',
            exitCode: 0,
          }),
          19
        )
        journal.append('s', 'codex/turn/completed', {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [] },
        })
      })

      const result = condense(journal)
      expect(result.historyTurnsRolledUp).toBe(1)
      expect(result.cursorCheckpointsWritten).toBe(1)
      expect(journal.lastJournaledWseq('s')).toBe(19)
      const legacy = journal.db
        .prepare(
          `SELECT MAX(wseq) AS m FROM events
             WHERE session = ? AND wseq IS NOT NULL
               AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE session = ? AND kind = ?), 0)`
        )
        .get('s', 's', WSEQ_RESET_KIND) as { m: number | null }
      expect(legacy.m).toBe(19)
    } finally {
      journal.db.close()
    }
  })

  it('expires transcript detail after the retention horizon into one visible boundary per session', () => {
    vi.useFakeTimers()
    const journal = new Journal(path.join(tmp, 'history-retention.db'))
    const ancient = new Date(NOW - 6 * 365 * DAY)
    try {
      at(ancient, () => {
        for (let turn = 1; turn <= 2; turn += 1) {
          journal.append('s', 'session/input', { text: `old prompt ${turn}` })
          journal.append(
            's',
            'codex/item/completed',
            codexCompleted(`turn-${turn}`, {
              id: `answer-${turn}`,
              type: 'agentMessage',
              text: `old answer ${turn}`,
            })
          )
          if (turn === 2) {
            journal.db
              .prepare("INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, 'claude/assistant', ?)")
              .run(ancient.toISOString(), 's', '{"message":{"content":[{"type":"text","text":"orphaned\\')
          }
          journal.append('s', 'codex/turn/completed', {
            threadId: 'thread-1',
            turn: { id: `turn-${turn}`, status: 'completed', items: [] },
          })
        }
      })

      const result = condense(journal)
      expect(result.historyTurnsRolledUp).toBe(2)
      expect(result.historyTurnsExpired).toBe(2)
      const rows = [...journal.replay(0)]
      expect(rows.some((event) => event.kind === 'session/input')).toBe(false)
      expect(
        rows.some(
          (event) =>
            event.kind === 'codex/item/completed' &&
            (event.payload as { item?: { text?: string } }).item?.text?.startsWith('old answer')
        )
      ).toBe(false)
      const boundaries = rows.filter(
        (event) =>
          event.kind === 'codex/item/completed' &&
          (event.payload as { __allmyagentsHistoryBoundary?: boolean }).__allmyagentsHistoryBoundary === true
      )
      expect(boundaries).toHaveLength(1)
      const boundary = boundaries[0]?.payload as {
        item?: { command?: string; aggregatedOutput?: string }
      }
      expect(boundary.item?.command).toContain('history boundary')
      expect(boundary.item?.command).toContain('no command executed')
      expect(boundary.item?.aggregatedOutput).toContain('2 completed turns')
      expect(boundary.item?.aggregatedOutput).toContain('exact transcript detail is no longer available')
      expect(
        rows.some(
          (event) =>
            event.kind === 'claude/assistant' &&
            (event.payload as { __unreadable?: boolean }).__unreadable === true
        )
      ).toBe(true)

      expect(condense(journal).historyTurnsExpired).toBe(0)
      expect(
        [...journal.replay(0)].filter(
          (event) =>
            event.kind === 'codex/item/completed' &&
            (event.payload as { __allmyagentsHistoryBoundary?: boolean }).__allmyagentsHistoryBoundary === true
        )
      ).toHaveLength(1)
    } finally {
      journal.db.close()
    }
  })

  it('holds one SQLite snapshot across replay pages while the maintenance connection rewrites old rows', () => {
    const file = path.join(tmp, 'replay-snapshot.db')
    const journal = new Journal(file)
    let maintenance: Database.Database | undefined
    try {
      journal.append('s', 'test/one', { value: 1 })
      journal.append('s', 'test/two', { value: 2 })
      journal.append('s', 'test/three', { value: 3 })
      journal.append('s', 'test/four', { value: 4 })
      const replay = journal.replay(0, 2)
      expect(replay.next().value?.seq).toBe(1)
      expect(replay.next().value?.seq).toBe(2)

      maintenance = new Database(file)
      maintenance.pragma('journal_mode = WAL')
      maintenance.transaction(() => {
        maintenance?.prepare('DELETE FROM events WHERE seq = 3').run()
        maintenance?.prepare("UPDATE events SET payload = '{\"value\":\"rewritten\"}' WHERE seq = 4").run()
      })()

      // One reconnect must see either the pre-rollup turn or the post-rollup turn. Without a read snapshot,
      // page two sees maintenance's commit and produces a hybrid (seq 3 vanishes; seq 4 changes shape).
      const tail = [...replay]
      expect(tail.map((event) => [event.seq, event.payload])).toEqual([
        [3, { value: 3 }],
        [4, { value: 4 }],
      ])
    } finally {
      maintenance?.close()
      journal.db.close()
    }
  })
})
