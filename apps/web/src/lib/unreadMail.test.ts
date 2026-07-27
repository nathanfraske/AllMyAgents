import { describe, expect, it } from 'vitest'
import { unreadMailCount, unreadMailTitle } from './unreadMail'

describe('unreadMailCount — defensive against the optional/absent API field', () => {
  it('returns the count for a small positive number', () => {
    expect(unreadMailCount(3)).toBe(3)
    expect(unreadMailCount(1)).toBe(1)
  })
  it('is 0 (⇒ no badge) at zero — never a zero placeholder', () => {
    expect(unreadMailCount(0)).toBe(0)
  })
  it('is 0 when the field is ABSENT (older hub / not deployed) — never NaN', () => {
    expect(unreadMailCount(undefined)).toBe(0)
    expect(unreadMailCount(null)).toBe(0)
  })
  it('is 0 for a non-number (wrong API shape) rather than coercing to NaN', () => {
    expect(unreadMailCount('3')).toBe(0)
    expect(unreadMailCount(NaN)).toBe(0)
    expect(unreadMailCount({})).toBe(0)
  })
  it('is 0 for a negative value', () => {
    expect(unreadMailCount(-2)).toBe(0)
  })
  it('floors a fractional count to an integer', () => {
    expect(unreadMailCount(2.9)).toBe(2)
  })
})

describe('unreadMailTitle — names the marker, singular/plural', () => {
  it('is singular for 1', () => {
    expect(unreadMailTitle(1)).toBe('1 unread message from teammates')
  })
  it('is plural otherwise', () => {
    expect(unreadMailTitle(2)).toBe('2 unread messages from teammates')
  })
})
