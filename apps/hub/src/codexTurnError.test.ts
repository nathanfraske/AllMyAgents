import { describe, expect, it } from 'vitest'
import { codexTurnErrorMessage, codexTurnOutcome } from './adapters/codex.js'

/**
 * REGRESSION — a FAILED Codex turn reported plain "ready".
 *
 * Every Codex turn ends with `turn/completed`; `turn.status` (completed | interrupted | failed) is what
 * distinguishes them. Both executors treated the event itself as success and never read the status, so a
 * genuine failure stopped the spinner, showed no reason, and looked finished. The same defect as the blank
 * Claude error card approached from the other side: there we rendered an error with no text, here we
 * rendered no error at all.
 */
describe('codexTurnOutcome', () => {
  it('reads a successful turn', () => {
    expect(codexTurnOutcome({ turn: { status: 'completed' } })).toEqual({ kind: 'completed' })
  })

  it('reads a failed turn and carries its reason', () => {
    expect(codexTurnOutcome({ turn: { status: 'failed', error: { message: 'boom' } } })).toEqual({
      kind: 'failed',
      message: 'boom',
    })
  })

  it('gives a failed turn a nonblank reason even with no error payload', () => {
    const out = codexTurnOutcome({ turn: { status: 'failed' } })
    expect(out.kind).toBe('failed')
    expect(out.kind === 'failed' && out.message.trim()).toBeTruthy()
  })

  it('treats an interruption as neither success nor failure', () => {
    expect(codexTurnOutcome({ turn: { status: 'interrupted' } })).toEqual({ kind: 'interrupted' })
  })

  /** "I do not recognise this" must never be success — that is how a failure gets a green tick. */
  it('never reports an unknown or missing status as completed', () => {
    for (const payload of [{}, null, { turn: {} }, { turn: { status: 'weird' } }, { turn: { status: 7 } }]) {
      expect(codexTurnOutcome(payload).kind).toBe('unknown')
    }
  })
})

/**
 * A terminal event that renders as an empty string is the failure this project keeps re-learning: the UI
 * shows that something went wrong with no way to find out what, or an empty error card. The Claude result
 * path had the same bug (reading `result`, a field the SDK's error shape does not have), so the Codex
 * equivalent gets the same guarantee: never blank, whatever the payload looks like.
 */
describe('codexTurnErrorMessage', () => {
  it('reads the nested error message', () => {
    expect(codexTurnErrorMessage({ threadId: 't', error: { message: 'boom' } })).toBe('boom')
  })

  it('accepts a plain string error', () => {
    expect(codexTurnErrorMessage({ error: 'rate limited' })).toBe('rate limited')
  })

  it('falls back to a top-level message', () => {
    expect(codexTurnErrorMessage({ message: 'stream closed' })).toBe('stream closed')
  })

  it('never returns blank, whatever the shape', () => {
    for (const payload of [null, undefined, {}, { error: {} }, { error: { message: '   ' } }, { message: '' }, 42]) {
      expect(codexTurnErrorMessage(payload).trim()).not.toBe('')
    }
  })
})
