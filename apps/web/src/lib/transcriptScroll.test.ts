import { describe, expect, it } from 'vitest'
import { distanceFromBottom, newItemsBelow, shouldShowJumpToBottom } from './transcriptScroll'

// New module → old-vs-new is hollow; each assertion was confirmed to fail under a deliberate mutation
// of the function it covers (documented in the report), so it discriminates behaviour.

describe('distanceFromBottom', () => {
  it('is 0 at the bottom and never negative (overscroll clamps)', () => {
    expect(distanceFromBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(0)
    expect(distanceFromBottom({ scrollTop: 950, scrollHeight: 1000, clientHeight: 100 })).toBe(0) // clamp
  })
  it('measures the content left below the viewport', () => {
    expect(distanceFromBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 100 })).toBe(700)
  })
})

describe('shouldShowJumpToBottom', () => {
  it('stays hidden near the bottom — not a two-line nudge', () => {
    // 60px away in an 800px pane: not pinned maybe, but nowhere near "useful".
    expect(shouldShowJumpToBottom({ scrollTop: 9140, scrollHeight: 10000, clientHeight: 800 })).toBe(false)
  })
  it('shows once you are past half a viewport of content', () => {
    // 500px away in an 800px pane → threshold 400 → show.
    expect(shouldShowJumpToBottom({ scrollTop: 8700, scrollHeight: 10000, clientHeight: 800 })).toBe(true)
    // exactly at half a viewport is NOT yet past it
    expect(shouldShowJumpToBottom({ scrollTop: 8800, scrollHeight: 10000, clientHeight: 800 })).toBe(false)
  })
  it('applies the 200px floor on a short pane', () => {
    // 300px pane → half is 150, floored to 200. 180 away → still hidden; 220 away → shown.
    expect(shouldShowJumpToBottom({ scrollTop: 520, scrollHeight: 1000, clientHeight: 300 })).toBe(false) // 180 away
    expect(shouldShowJumpToBottom({ scrollTop: 480, scrollHeight: 1000, clientHeight: 300 })).toBe(true) // 220 away
  })
})

describe('newItemsBelow', () => {
  const keys = ['a', 'b', 'c', 'd', 'e']
  it('counts items after the anchor', () => {
    expect(newItemsBelow(keys, 'c')).toBe(2) // d, e
    expect(newItemsBelow(keys, 'a')).toBe(4)
  })
  it('is 0 when the anchor is the last item or unset', () => {
    expect(newItemsBelow(keys, 'e')).toBe(0)
    expect(newItemsBelow(keys, null)).toBe(0)
  })
  it('is 0 (does not guess) when the anchor is gone — rollback / chat switch', () => {
    expect(newItemsBelow(keys, 'zzz')).toBe(0)
  })
  it('does not count OLDER history prepended above the anchor', () => {
    // Anchor 'c' had 2 below. Prepend two older items at the top: count below 'c' is unchanged.
    expect(newItemsBelow(['x', 'y', 'a', 'b', 'c', 'd', 'e'], 'c')).toBe(2)
  })
})
