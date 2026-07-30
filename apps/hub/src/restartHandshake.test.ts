import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import {
  ASK_RESTART_INTERRUPT_MARGIN_MS,
  ASK_RESTART_TURN_GRACE_MS,
  HUB_DRAIN_RELEASE_TIMEOUT_MS,
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
})
