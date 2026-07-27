import { describe, expect, it } from 'vitest'
import { classifyDecideOutcome } from './approvals'

// New module → "passes against old code too" is hollow (there is no old code). Each assertion below was
// confirmed to FAIL under a deliberate mutation of classifyDecideOutcome (documented in the report), so
// it discriminates the three outcomes rather than merely exercising the happy path.

describe('classifyDecideOutcome', () => {
  it('is resolved when the write succeeded (no error), regardless of pending state', () => {
    expect(classifyDecideOutcome({ ok: true }, false)).toEqual({ kind: 'resolved' })
    // A race where the roster has not caught up yet must NOT turn a real success into a failure.
    expect(classifyDecideOutcome({ ok: true }, true)).toEqual({ kind: 'resolved' })
    expect(classifyDecideOutcome(undefined, true)).toEqual({ kind: 'resolved' })
  })

  it('is a real failure when the write errored AND the approval is still pending', () => {
    // The click did not take (401 / 500 / network): the request is still there to decide.
    expect(classifyDecideOutcome({ error: 'HTTP 401' }, true)).toEqual({ kind: 'failed', error: 'HTTP 401' })
    expect(classifyDecideOutcome({ error: 'network error' }, true)).toEqual({ kind: 'failed', error: 'network error' })
  })

  it('is gone when the write errored but the approval is no longer pending', () => {
    // The hub answers a missing approval with 404; the refreshed roster no longer lists it → already
    // resolved elsewhere or timed out. Not the same as "your click failed".
    expect(classifyDecideOutcome({ error: 'HTTP 404' }, false)).toEqual({ kind: 'gone' })
  })

  it('distinguishes gone from failed purely by pending state, not by the error string', () => {
    // Same error text, opposite outcomes — the roster is the authority, not the message.
    const err = { error: 'HTTP 404' }
    expect(classifyDecideOutcome(err, true).kind).toBe('failed')
    expect(classifyDecideOutcome(err, false).kind).toBe('gone')
  })
})
