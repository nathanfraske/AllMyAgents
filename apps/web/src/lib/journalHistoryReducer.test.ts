import { describe, expect, it } from 'vitest'
import type { HubEvent } from './api'
import {
  JOURNAL_HISTORY_MAX_LOGICAL_ITEMS,
  reduceJournalHistory,
} from './journalHistoryReducer'

const ts = '2026-07-30T12:00:00.000Z'
const event = (seq: number, kind: string, payload: unknown): HubEvent => ({
  seq,
  ts,
  sessionId: 's',
  kind,
  payload,
})

describe('pure bounded journal history reducer', () => {
  it('reconstructs canonical assistant/tool output without touching live control-plane state', () => {
    const before = {
      setTimeout: globalThis.setTimeout,
      fetch: globalThis.fetch,
    }
    const items = reduceJournalHistory([
      event(1, 'session/input', { text: 'hello' }),
      event(2, 'codex/item/agentMessage/delta', {
        itemId: 'answer',
        delta: 'partial',
      }),
      event(3, 'codex/item/completed', {
        item: { id: 'answer', type: 'agentMessage', text: 'final answer' },
      }),
      event(4, 'codex/item/completed', {
        item: {
          id: 'command',
          type: 'commandExecution',
          command: 'echo ok',
          aggregatedOutput: 'ok\n',
        },
      }),
    ])

    expect(items.map((item) => [item.kind, item.text ?? item.toolResult])).toEqual([
      ['user', 'hello'],
      ['assistant', 'final answer'],
      ['tool', 'ok\n'],
    ])
    expect(items.every((item) => item.historical && item.replayed)).toBe(true)
    expect(globalThis.setTimeout).toBe(before.setTimeout)
    expect(globalThis.fetch).toBe(before.fetch)
  })

  it('renders the real provider compact boundary as completed and ignores DB maintenance events', () => {
    const items = reduceJournalHistory([
      event(1, 'claude/system', {
        subtype: 'compact_boundary',
        message: 'Context compaction completed.',
      }),
      event(2, 'journal/compaction-completed', {
        detail: 'Database cleanup completed.',
      }),
    ])

    expect(items.map((item) => [item.kind, item.status, item.text])).toEqual([
      ['compaction', 'completed', 'Context compaction completed.'],
    ])
  })

  it('keeps a pane within its logical-item bound', () => {
    const items = reduceJournalHistory(
      Array.from({ length: 200 }, (_, index) =>
        event(index + 1, 'session/input', { text: `message-${index + 1}` })
      )
    )

    expect(items).toHaveLength(JOURNAL_HISTORY_MAX_LOGICAL_ITEMS)
    expect(items[0]?.text).toBe('message-121')
    expect(items.at(-1)?.text).toBe('message-200')
  })
})
