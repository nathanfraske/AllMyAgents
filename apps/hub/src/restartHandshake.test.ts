import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import {
  ASK_RESTART_INTERRUPT_MARGIN_MS,
  ASK_RESTART_TURN_GRACE_MS,
  HUB_DRAIN_RELEASE_TIMEOUT_MS,
  MalformedPreflightRefusalError,
  PreflightRefusalError,
  waitForHubMsg,
} from './restartHandshake.js'

function child(): EventEmitter & ChildProcess {
  return new EventEmitter() as EventEmitter & ChildProcess
}

describe('restart handshake question-turn evidence', () => {
  it('round-trips bounded released counts', async () => {
    const peer = child()
    const waiting = waitForHubMsg(peer, 'released', 1_000)
    peer.emit('message', {
      type: 'released',
      questionTurns: { settled: 2, outcomeUnknown: 1 },
    })

    await expect(waiting).resolves.toEqual({
      type: 'released',
      questionTurns: { settled: 2, outcomeUnknown: 1 },
    })
  })

  it.each([
    undefined,
    { settled: -1, outcomeUnknown: 0 },
    { settled: 0.5, outcomeUnknown: 0 },
    { settled: 0, outcomeUnknown: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed released evidence: %j', async (questionTurns) => {
    const peer = child()
    const waiting = waitForHubMsg(peer, 'released', 1_000)
    peer.emit('message', { type: 'released', questionTurns })
    await expect(waiting).rejects.toThrow(/invalid hub 'released'/)
  })

  it('keeps the supervisor deadline above database waits, Ask grace, and interrupt margin', () => {
    const worstCaseDatabaseWaits = 3 * 5_000
    expect(HUB_DRAIN_RELEASE_TIMEOUT_MS).toBeGreaterThan(
      worstCaseDatabaseWaits +
        ASK_RESTART_TURN_GRACE_MS +
        ASK_RESTART_INTERRUPT_MARGIN_MS
    )
  })

  it.each([
    ['database-corrupt', 'sqlite-corruption'],
    ['database-orphan-family', 'orphan-family'],
  ] as const)('preserves the closed typed recovery pair %s/%s', async (code, recoveryCause) => {
    const peer = child()
    const waiting = waitForHubMsg(peer, 'ready', 1_000)
    peer.emit('message', {
      type: 'preflight-failed',
      code,
      message: 'bounded failure',
      recovery: 'stay offline',
      recoveryCause,
    })
    const error = await waiting.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PreflightRefusalError)
    expect((error as PreflightRefusalError).automaticRecoveryCause).toBe(recoveryCause)
  })

  it('does not authorize a mismatched structured recovery pair', async () => {
    const peer = child()
    const waiting = waitForHubMsg(peer, 'ready', 1_000)
    peer.emit('message', {
      type: 'preflight-failed',
      code: 'database-corrupt',
      message: 'bounded failure',
      recovery: 'stay offline',
      recoveryCause: 'orphan-family',
    })
    const error = await waiting.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PreflightRefusalError)
    expect((error as PreflightRefusalError).automaticRecoveryCause).toBeUndefined()
  })

  it('keeps same-journal lineage rollback typed but offline-only', async () => {
    const peer = child()
    const waiting = waitForHubMsg(peer, 'ready', 1_000)
    peer.emit('message', {
      type: 'preflight-failed',
      code: 'database-lineage-invalid',
      message: 'same journal high-water regressed',
      recovery: 'stay offline for operator reconciliation',
      recoveryCause: 'lineage-rollback',
    })
    const error = await waiting.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PreflightRefusalError)
    expect((error as PreflightRefusalError).automaticRecoveryCause).toBeUndefined()
  })

  it.each([
    { code: 'x'.repeat(129), message: 'bounded', recovery: 'offline' },
    { code: 'database-corrupt', message: 'bad\u0000message', recovery: 'offline' },
    { code: 'database-corrupt', message: 'bounded', recovery: 'x'.repeat(4097) },
  ])('rejects malformed or oversized preflight refusal fields', async (fields) => {
    const peer = child()
    const waiting = waitForHubMsg(peer, 'ready', 1_000)
    peer.emit('message', { type: 'preflight-failed', ...fields })
    await expect(waiting).rejects.toBeInstanceOf(MalformedPreflightRefusalError)
  })
})
