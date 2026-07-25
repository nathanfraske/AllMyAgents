import { describe, expect, it } from 'vitest'
import { ATTACH_GAP_KIND, DEFAULT_MAX_PER_SESSION, WseqBuffer } from './wseqBuffer.js'

/** A vendor-ish event; payload identity is asserted to prove no cloning surprises. */
function ev(kind: string, payload: unknown = {}) {
  return { kind, payload }
}

/** Drain a since() result down to bare (wseq, kind) tuples for order assertions. */
function shape(events: Array<{ wseq: number; kind: string }>) {
  return events.map((e) => [e.wseq, e.kind] as const)
}

describe('WseqBuffer.append — monotonic per-session wseq', () => {
  it('assigns 1,2,3,… starting at 1 for a session', () => {
    const buf = new WseqBuffer()
    expect(buf.append('s', ev('claude/text'))).toBe(1)
    expect(buf.append('s', ev('claude/text'))).toBe(2)
    expect(buf.append('s', ev('session/tokens'))).toBe(3)
    expect(buf.lastWseq('s')).toBe(3)
  })

  it('never repeats or reverses a wseq even across kinds', () => {
    const buf = new WseqBuffer()
    const seen: number[] = []
    for (let i = 0; i < 50; i++) seen.push(buf.append('s', ev(`k${i % 3}`)))
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1] + 1)
    expect(seen[0]).toBe(1)
    expect(seen.at(-1)).toBe(50)
  })
})

describe('WseqBuffer — independent sequences across sessions', () => {
  it('each session has its own counter starting at 1, unaffected by interleaving', () => {
    const buf = new WseqBuffer()
    expect(buf.append('a', ev('codex/text'))).toBe(1)
    expect(buf.append('b', ev('codex/text'))).toBe(1)
    expect(buf.append('a', ev('codex/text'))).toBe(2)
    expect(buf.append('b', ev('codex/text'))).toBe(2)
    expect(buf.append('b', ev('codex/text'))).toBe(3)

    expect(buf.lastWseq('a')).toBe(2)
    expect(buf.lastWseq('b')).toBe(3)
    // b's events never leak into a's replay and vice-versa.
    expect(shape(buf.since('a', 0))).toEqual([
      [1, 'codex/text'],
      [2, 'codex/text'],
    ])
    expect(buf.since('b', 0)).toHaveLength(3)
  })

  it('lastWseq is 0 and since() is [] for a never-seen session', () => {
    const buf = new WseqBuffer()
    expect(buf.lastWseq('ghost')).toBe(0)
    expect(buf.since('ghost', 0)).toEqual([])
    expect(buf.since('ghost', 999)).toEqual([])
  })
})

describe('WseqBuffer.since — exclusive cursor, ordered, newer-only', () => {
  it('returns strictly-newer events in ascending order (cursor is exclusive)', () => {
    const buf = new WseqBuffer()
    for (let i = 0; i < 5; i++) buf.append('s', ev(`k${i}`))
    // Full replay from a fresh attach.
    expect(shape(buf.since('s', 0))).toEqual([
      [1, 'k0'],
      [2, 'k1'],
      [3, 'k2'],
      [4, 'k3'],
      [5, 'k4'],
    ])
    // Exclusive: since(2) omits wseq 1 and 2.
    expect(shape(buf.since('s', 2))).toEqual([
      [3, 'k2'],
      [4, 'k3'],
      [5, 'k4'],
    ])
    // Caught up: nothing newer.
    expect(buf.since('s', 5)).toEqual([])
    // Cursor beyond the end (stale/corrupt) yields [] — never a false gap.
    expect(buf.since('s', 99)).toEqual([])
  })

  it('replay→live join: draining since(lastWseq) then appending is seamless and gap-free', () => {
    const buf = new WseqBuffer()
    buf.append('s', ev('a'))
    buf.append('s', ev('b'))
    const replay = buf.since('s', 0)
    const cursor = replay.at(-1)!.wseq // hub advances to the last replayed wseq
    expect(cursor).toBe(2)
    // A live event arrives after the hub attached; the next since() picks it up
    // with no overlap and no gap.
    buf.append('s', ev('c'))
    expect(shape(buf.since('s', cursor))).toEqual([[3, 'c']])
  })

  it('does not alias the internal buffer — mutating a result cannot corrupt bookkeeping', () => {
    const buf = new WseqBuffer()
    buf.append('s', ev('k'))
    const first = buf.since('s', 0)
    first[0].wseq = -999
    first[0].kind = 'tampered'
    // A fresh since() is unaffected by the caller's mutation.
    expect(shape(buf.since('s', 0))).toEqual([[1, 'k']])
  })

  it('passes payload through by reference (no expensive deep clone)', () => {
    const buf = new WseqBuffer()
    const payload = { nested: { tokens: 42 } }
    buf.append('s', ev('session/tokens', payload))
    expect(buf.since('s', 0)[0].payload).toBe(payload)
  })
})

describe('WseqBuffer — bounded drop-oldest + attach-gap sentinel', () => {
  it('retains only the last N events per session', () => {
    const buf = new WseqBuffer(3)
    for (let i = 1; i <= 5; i++) buf.append('s', ev(`k${i}`))
    // Only wseq 3,4,5 survive; the counter still reflects all 5.
    expect(buf.lastWseq('s')).toBe(5)
    const within = buf.since('s', 2) // cursor at the retained floor-1 → no gap
    expect(shape(within)).toEqual([
      [3, 'k3'],
      [4, 'k4'],
      [5, 'k5'],
    ])
  })

  it('emits the sentinel exactly when the cursor predates the retained window', () => {
    const buf = new WseqBuffer(3)
    for (let i = 1; i <= 5; i++) buf.append('s', ev(`k${i}`))
    // Retained window is wseq 3..5, so oldestRetained = 3, droppedThrough = 2.

    // A fresh attach (cursor 0) spans the dropped 1,2 → sentinel then survivors.
    const fromZero = buf.since('s', 0)
    expect(fromZero[0]).toEqual({
      wseq: 2,
      kind: ATTACH_GAP_KIND,
      payload: { droppedThrough: 2 },
    })
    expect(shape(fromZero)).toEqual([
      [2, ATTACH_GAP_KIND],
      [3, 'k3'],
      [4, 'k4'],
      [5, 'k5'],
    ])

    // cursor 1 still needs the dropped wseq 2 → still a gap.
    expect(buf.since('s', 1)[0].kind).toBe(ATTACH_GAP_KIND)
    expect(buf.since('s', 1)[0].payload).toEqual({ droppedThrough: 2 })
  })

  it('does NOT emit the sentinel when the cursor is within (or exactly at the edge of) the window', () => {
    const buf = new WseqBuffer(3)
    for (let i = 1; i <= 5; i++) buf.append('s', ev(`k${i}`))
    // Boundary: cursor 2 == oldestRetained - 1. Next-needed is wseq 3, which is
    // retained, so there is no gap.
    expect(buf.since('s', 2).some((e) => e.kind === ATTACH_GAP_KIND)).toBe(false)
    // Deeper inside the window: still no sentinel.
    expect(buf.since('s', 4).some((e) => e.kind === ATTACH_GAP_KIND)).toBe(false)
    expect(shape(buf.since('s', 4))).toEqual([[5, 'k5']])
  })

  it('a caught-up hub that keeps advancing its cursor never sees a gap despite constant trimming', () => {
    const buf = new WseqBuffer(3)
    let cursor = 0
    for (let i = 0; i < 100; i++) {
      buf.append('s', ev('tick'))
      const batch = buf.since('s', cursor)
      expect(batch.some((e) => e.kind === ATTACH_GAP_KIND)).toBe(false)
      if (batch.length > 0) cursor = batch.at(-1)!.wseq
    }
    expect(cursor).toBe(100)
  })

  it('the sentinel appears at most once: after the hub advances past the gap, the next since() is clean', () => {
    const buf = new WseqBuffer(3)
    for (let i = 1; i <= 5; i++) buf.append('s', ev(`k${i}`))
    const first = buf.since('s', 0)
    expect(first[0].kind).toBe(ATTACH_GAP_KIND)
    const cursor = first.at(-1)!.wseq // = 5
    // More events flow; the hub, now caught up, replays without a second sentinel.
    buf.append('s', ev('k6'))
    buf.append('s', ev('k7'))
    const second = buf.since('s', cursor)
    expect(second.some((e) => e.kind === ATTACH_GAP_KIND)).toBe(false)
    expect(shape(second)).toEqual([
      [6, 'k6'],
      [7, 'k7'],
    ])
  })

  it('reports droppedThrough as the highest lost wseq, so the hub can journal the exact gap span', () => {
    const buf = new WseqBuffer(2)
    for (let i = 1; i <= 10; i++) buf.append('s', ev('e')) // retains wseq 9,10
    const out = buf.since('s', 3)
    expect(out[0]).toMatchObject({ kind: ATTACH_GAP_KIND, payload: { droppedThrough: 8 } })
    // Survivors follow the sentinel, still strictly increasing in wseq.
    expect(shape(out)).toEqual([
      [8, ATTACH_GAP_KIND],
      [9, 'e'],
      [10, 'e'],
    ])
  })

  it('N=1 is a valid bound (keep only the latest); a lagging cursor gaps immediately', () => {
    const buf = new WseqBuffer(1)
    buf.append('s', ev('a'))
    buf.append('s', ev('b')) // retains only wseq 2
    const out = buf.since('s', 0)
    expect(shape(out)).toEqual([
      [1, ATTACH_GAP_KIND],
      [2, 'b'],
    ])
  })

  it('a negative or fractional cursor never fabricates a spurious gap on an un-trimmed buffer', () => {
    const buf = new WseqBuffer()
    buf.append('s', ev('a'))
    buf.append('s', ev('b'))
    // Nothing was trimmed (oldestRetained = 1), so no cursor value can gap.
    expect(buf.since('s', -5).some((e) => e.kind === ATTACH_GAP_KIND)).toBe(false)
    expect(buf.since('s', 0.9).some((e) => e.kind === ATTACH_GAP_KIND)).toBe(false)
    // 0.9 floors to 0 → full replay.
    expect(shape(buf.since('s', 0.9))).toEqual([
      [1, 'a'],
      [2, 'b'],
    ])
  })
})

describe('WseqBuffer.forget', () => {
  it('drops the buffer: lastWseq resets to 0 and since() empties', () => {
    const buf = new WseqBuffer()
    buf.append('s', ev('a'))
    buf.append('s', ev('b'))
    expect(buf.lastWseq('s')).toBe(2)

    buf.forget('s')
    expect(buf.lastWseq('s')).toBe(0)
    expect(buf.since('s', 0)).toEqual([])
  })

  it('a re-created session after forget starts a fresh sequence at wseq 1', () => {
    const buf = new WseqBuffer()
    buf.append('s', ev('a'))
    buf.forget('s')
    expect(buf.append('s', ev('a2'))).toBe(1)
    expect(shape(buf.since('s', 0))).toEqual([[1, 'a2']])
  })

  it('only forgets the named session — siblings are untouched', () => {
    const buf = new WseqBuffer()
    buf.append('a', ev('x'))
    buf.append('b', ev('y'))
    buf.forget('a')
    expect(buf.lastWseq('a')).toBe(0)
    expect(buf.lastWseq('b')).toBe(1)
  })
})

describe('WseqBuffer — construction', () => {
  it('defaults to DEFAULT_MAX_PER_SESSION and keeps a full window of that size gap-free', () => {
    const buf = new WseqBuffer()
    for (let i = 0; i < DEFAULT_MAX_PER_SESSION; i++) buf.append('s', ev('e'))
    // Exactly at capacity — nothing trimmed yet, so a fresh attach has no gap.
    expect(buf.since('s', 0).some((e) => e.kind === ATTACH_GAP_KIND)).toBe(false)
    expect(buf.since('s', 0)).toHaveLength(DEFAULT_MAX_PER_SESSION)
    // One more append trims the very first event → a fresh attach now gaps.
    buf.append('s', ev('e'))
    expect(buf.since('s', 0)[0]).toMatchObject({
      kind: ATTACH_GAP_KIND,
      payload: { droppedThrough: 1 },
    })
  })

  it('rejects a non-positive or non-integer bound', () => {
    expect(() => new WseqBuffer(0)).toThrow(RangeError)
    expect(() => new WseqBuffer(-1)).toThrow(RangeError)
    expect(() => new WseqBuffer(2.5)).toThrow(RangeError)
    expect(() => new WseqBuffer(Number.NaN)).toThrow(RangeError)
  })
})
