import { describe, expect, it } from 'vitest'
import { chatOrderKey, isChatBusy, nextOrderKey, orderChats, type ChatOrderFacts } from './chatOrder'

// Sidebar.ordering.test.ts proves the sidebar stops jumping. This proves the comparator underneath it
// is a sound total order, which is the part that cannot be observed from the rendered list: a
// comparator can be inconsistent and still look fine until the day the array arrives in another order.

function chat(id: string, over: Partial<ChatOrderFacts> = {}): ChatOrderFacts {
  return { id, createdAt: '2026-01-01T00:00:00.000Z', lastActivity: '2026-01-01T00:00:00.000Z', ...over }
}

const ids = (rows: ChatOrderFacts[]): string[] => rows.map((r) => r.id)
const order = (rows: ChatOrderFacts[], manual: string[] = []): string[] =>
  ids(orderChats(rows, manual, (c) => c))

/** Every arrangement of `xs` — the only way to prove a comparator does not depend on input order. */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs]
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]))
}

describe('isChatBusy', () => {
  it('is true while a local turn clock is running', () => {
    expect(isChatBusy({ turnStartedAt: 1_700_000_000_000, status: 'idle' })).toBe(true)
  })

  it('is true for a hub-reported running turn, which is all a remote fleet row has', () => {
    expect(isChatBusy({ status: 'active' })).toBe(true)
    expect(isChatBusy({ status: 'starting' })).toBe(true)
  })

  it('is false once the turn has ended, however it ended', () => {
    for (const status of ['idle', 'error', 'stopped']) {
      expect(isChatBusy({ status })).toBe(false)
    }
  })
})

describe('nextOrderKey', () => {
  it('holds the key for the whole turn, however many events arrive', () => {
    let key = '2026-01-01T10:00:00.000Z'
    for (let i = 0; i < 500; i++) key = nextOrderKey(key, `2026-01-01T10:05:${String(i % 60).padStart(2, '0')}.000Z`, true)
    expect(key).toBe('2026-01-01T10:00:00.000Z')
  })

  it('advances to the event time once the chat is idle — this is what a settle does', () => {
    expect(nextOrderKey('2026-01-01T10:00:00.000Z', '2026-01-01T10:09:00.000Z', false)).toBe('2026-01-01T10:09:00.000Z')
  })

  it('never runs backwards, so a replayed journal cannot sink a row and float it again', () => {
    expect(nextOrderKey('2026-01-01T10:00:00.000Z', '2026-01-01T09:00:00.000Z', false)).toBe('2026-01-01T10:00:00.000Z')
  })
})

describe('chatOrderKey', () => {
  it('falls back to live recency for a view that carries no settled key yet', () => {
    expect(chatOrderKey(chat('a', { lastActivity: '2026-01-02T00:00:00.000Z' }))).toBe('2026-01-02T00:00:00.000Z')
  })

  it('prefers the settled key wherever one exists', () => {
    const c = chat('a', { lastActivity: '2026-01-09T00:00:00.000Z', orderKey: '2026-01-02T00:00:00.000Z' })
    expect(chatOrderKey(c)).toBe('2026-01-02T00:00:00.000Z')
  })
})

describe('orderChats', () => {
  it('sorts unarranged chats by settled recency, newest first', () => {
    const rows = [
      chat('a', { orderKey: '2026-01-01T00:00:00.000Z' }),
      chat('b', { orderKey: '2026-01-03T00:00:00.000Z' }),
      chat('c', { orderKey: '2026-01-02T00:00:00.000Z' }),
    ]
    expect(order(rows)).toEqual(['b', 'c', 'a'])
  })

  it('ignores live recency entirely when a settled key is present', () => {
    // 'a' has streamed for hours; 'b' has not moved. The stream must not buy 'a' the top slot.
    const rows = [
      chat('a', { lastActivity: '2026-01-09T00:00:00.000Z', orderKey: '2026-01-01T00:00:00.000Z' }),
      chat('b', { lastActivity: '2026-01-02T00:00:00.000Z', orderKey: '2026-01-02T00:00:00.000Z' }),
    ]
    expect(order(rows)).toEqual(['b', 'a'])
  })

  it('puts the operator\'s arrangement first, in the saved order, ahead of everything else', () => {
    const rows = [
      chat('new', { orderKey: '2026-01-09T00:00:00.000Z' }), // by far the most recent
      chat('a', { orderKey: '2026-01-01T00:00:00.000Z' }),
      chat('b', { orderKey: '2026-01-02T00:00:00.000Z' }),
    ]
    // Recency would say new, b, a. The drag said b then a, and the drag wins for the chats it names.
    expect(order(rows, ['b', 'a'])).toEqual(['b', 'a', 'new'])
  })

  it('appends a chat the arrangement never mentioned rather than dropping it', () => {
    const rows = [chat('a'), chat('ghost'), chat('b')]
    expect(order(rows, ['b', 'a'])).toEqual(['b', 'a', 'ghost'])
  })

  it('ignores ids in the saved order that are not in this group', () => {
    const rows = [chat('a'), chat('b')]
    expect(order(rows, ['gone', 'b', 'alsogone', 'a'])).toEqual(['b', 'a'])
  })

  it('gives a duplicated id in the saved order its first slot, not two', () => {
    const rows = [chat('a'), chat('b')]
    expect(order(rows, ['a', 'b', 'a'])).toEqual(['a', 'b'])
  })

  it('breaks a recency tie by creation time, newest first', () => {
    // Ids chosen so the id tie-break would give the OPPOSITE answer: without the creation-time rule
    // this returns ['a', 'b'] and looks perfectly stable while being wrong.
    const rows = [
      chat('a', { createdAt: '2026-01-01T00:00:00.000Z' }),
      chat('b', { createdAt: '2026-01-05T00:00:00.000Z' }),
    ]
    expect(order(rows)).toEqual(['b', 'a'])
  })

  it('breaks a total tie by id, so equal rows can never swap between renders', () => {
    const rows = [chat('zeta'), chat('alpha'), chat('mid')]
    expect(order(rows)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('returns the same order for every arrangement of the same chats', () => {
    // Chats the comparator genuinely cannot separate until the last tie-break, mixed with ones it can,
    // and one pair that is identical apart from its id — the case an input-order fallback gets wrong.
    const rows = [
      chat('a', { orderKey: '2026-01-02T00:00:00.000Z' }),
      chat('b', { orderKey: '2026-01-02T00:00:00.000Z' }),
      chat('c', { orderKey: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }),
      chat('d', { orderKey: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-04T00:00:00.000Z' }),
    ]
    const expected = order(rows)
    for (const p of permutations(rows)) expect(order(p)).toEqual(expected)
    expect(expected).toEqual(['a', 'b', 'd', 'c'])
  })

  it('stays deterministic when NOTHING is arranged — no two unranked rows may compare as equal', () => {
    // Both ranks are Infinity here. Subtracting them yields NaN, which sort() coerces to +0 — every
    // pair compares equal and the list keeps whatever order it arrived in. This is the case that
    // catches it, and it only bites when NOTHING in the group has been arranged: the common case.
    const rows = [chat('c'), chat('a'), chat('b')]
    for (const p of permutations(rows)) expect(order(p)).toEqual(['a', 'b', 'c'])
  })

  it('leaves the caller\'s array alone', () => {
    const rows = [chat('b'), chat('a')]
    orderChats(rows, [], (c) => c)
    expect(ids(rows)).toEqual(['b', 'a'])
  })
})
