import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { PROFILE_LOGIN_RESTART_SETTLEMENT_TIMEOUT_MS } from './profileRuntime.js'
import {
  ASK_RESTART_INTERRUPT_MARGIN_MS,
  ASK_RESTART_TURN_GRACE_MS,
  HUB_DRAIN_RELEASE_TIMEOUT_MS,
  HUB_PREFLIGHT_ABSOLUTE_TIMEOUT_MS,
  HUB_PREFLIGHT_STATUS_INTERVAL_MS,
  MalformedPreflightRefusalError,
  PreflightRefusalError,
  ProfilePublicEpochSequence,
  parseProfileGenerationEnvironment,
  profileGenerationEnvironment,
  waitForHubReady,
  waitForHubMsg,
} from './restartHandshake.js'

function child(): EventEmitter & ChildProcess {
  return new EventEmitter() as EventEmitter & ChildProcess
}

afterEach(() => {
  vi.useRealTimers()
})

describe('phase-aware preflight readiness', () => {
  const attemptId = '11111111-1111-4111-8111-111111111111'
  const deadlines = {
    startTimeoutMs: 100,
    livenessTimeoutMs: 100,
    absoluteTimeoutMs: 1_000,
  }

  it('keeps the absolute ceiling well above the measured 981MB integrity-check baseline', () => {
    const measured981MbMs = 1_700
    expect(HUB_PREFLIGHT_ABSOLUTE_TIMEOUT_MS).toBeGreaterThanOrEqual(measured981MbMs * 100)
    expect(HUB_PREFLIGHT_ABSOLUTE_TIMEOUT_MS).toBe(5 * 60_000)
  })

  it('allows a healthy long-running integrity check beyond the former ready deadline', async () => {
    vi.useFakeTimers()
    const peer = child()
    const statuses: Array<{ phase: string; elapsedMs: number }> = []
    const waiting = waitForHubReady(
      peer,
      attemptId,
      {
        startTimeoutMs: 20_000,
        livenessTimeoutMs: 5_000,
        absoluteTimeoutMs: 60_000,
      },
      (phase, elapsedMs) => statuses.push({ phase, elapsedMs })
    )
    peer.emit('message', {
      type: 'preflight-liveness',
      attemptId,
      phase: 'starting',
      sequence: 0,
    })
    for (let sequence = 1; sequence <= 6; sequence++) {
      await vi.advanceTimersByTimeAsync(4_000)
      peer.emit('message', {
        type: 'preflight-liveness',
        attemptId,
        phase: 'integrity-check',
        sequence,
      })
    }
    peer.emit('message', {
      type: 'preflight-liveness',
      attemptId,
      phase: 'booting',
      sequence: 7,
    })
    peer.emit('message', {
      type: 'ready',
      attemptId,
      port: 7777,
      restored: 2,
      schemaVersion: 1,
    })
    await expect(waiting).resolves.toMatchObject({ type: 'ready', restored: 2 })
    expect(statuses).toEqual([
      { phase: 'starting', elapsedMs: 0 },
      { phase: 'integrity-check', elapsedMs: 4_000 },
      { phase: 'integrity-check', elapsedMs: 16_000 },
      { phase: 'booting', elapsedMs: 24_000 },
    ])
    expect(HUB_PREFLIGHT_STATUS_INTERVAL_MS).toBe(10_000)
  })

  it('fails closed when preflight never starts or a started check stops reporting', async () => {
    vi.useFakeTimers()
    const missingStartPeer = child()
    const missingStart = waitForHubReady(missingStartPeer, attemptId, deadlines).catch(
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(101)
    await expect(missingStart).resolves.toMatchObject({ message: expect.stringMatching(/start/i) })

    const stalledPeer = child()
    const stalled = waitForHubReady(stalledPeer, attemptId, deadlines).catch(
      (error: unknown) => error
    )
    stalledPeer.emit('message', {
      type: 'preflight-liveness',
      attemptId,
      phase: 'starting',
      sequence: 0,
    })
    await vi.advanceTimersByTimeAsync(101)
    await expect(stalled).resolves.toMatchObject({ message: expect.stringMatching(/liveness/i) })
  })

  it('enforces an absolute ceiling despite valid ordered liveness renewals', async () => {
    vi.useFakeTimers()
    const peer = child()
    const waiting = waitForHubReady(peer, attemptId, deadlines).catch((error: unknown) => error)
    peer.emit('message', {
      type: 'preflight-liveness',
      attemptId,
      phase: 'starting',
      sequence: 0,
    })
    for (let sequence = 1; sequence <= 10; sequence++) {
      await vi.advanceTimersByTimeAsync(90)
      peer.emit('message', {
        type: 'preflight-liveness',
        attemptId,
        phase: 'integrity-check',
        sequence,
      })
    }
    await vi.advanceTimersByTimeAsync(101)
    await expect(waiting).resolves.toMatchObject({ message: expect.stringMatching(/absolute/i) })
  })

  it.each([
    {
      type: 'preflight-liveness',
      attemptId: '22222222-2222-4222-8222-222222222222',
      phase: 'starting',
      sequence: 0,
    },
    { type: 'preflight-liveness', attemptId, phase: 'starting', sequence: 1 },
    { type: 'preflight-liveness', attemptId, phase: 'unknown', sequence: 0 },
    { type: 'preflight-liveness', attemptId, phase: 'starting', sequence: 0, forged: true },
  ])('rejects forged, reordered, or malformed liveness: %j', async (liveness) => {
    const peer = child()
    const waiting = waitForHubReady(peer, attemptId, deadlines)
    peer.emit('message', liveness)
    await expect(waiting).rejects.toThrow(/preflight liveness/i)
  })

  it('rejects child exit and ready-before-start without extending authority', async () => {
    const exitedPeer = child()
    const exited = waitForHubReady(exitedPeer, attemptId, deadlines)
    exitedPeer.emit('exit')
    await expect(exited).rejects.toThrow(/exited/i)

    const prematurePeer = child()
    const premature = waitForHubReady(prematurePeer, attemptId, deadlines)
    prematurePeer.emit('message', {
      type: 'ready',
      attemptId,
      port: 7777,
      restored: 0,
      schemaVersion: 1,
    })
    await expect(premature).rejects.toThrow(/before validated preflight booting phase/i)
  })

  it.each([
    [
      'skips integrity',
      [
        { phase: 'starting', sequence: 0 },
        { phase: 'booting', sequence: 1 },
      ],
    ],
    [
      'regresses from booting',
      [
        { phase: 'starting', sequence: 0 },
        { phase: 'integrity-check', sequence: 1 },
        { phase: 'booting', sequence: 2 },
        { phase: 'integrity-check', sequence: 3 },
      ],
    ],
  ])('rejects a phase trace that %s', async (_label, trace) => {
    const peer = child()
    const waiting = waitForHubReady(peer, attemptId, deadlines)
    for (const item of trace) {
      peer.emit('message', {
        type: 'preflight-liveness',
        attemptId,
        ...item,
      })
    }
    await expect(waiting).rejects.toThrow(/preflight liveness ordering/i)
  })

  it('requires booting before ready even after valid integrity liveness', async () => {
    const peer = child()
    const waiting = waitForHubReady(peer, attemptId, deadlines)
    peer.emit('message', {
      type: 'preflight-liveness',
      attemptId,
      phase: 'starting',
      sequence: 0,
    })
    peer.emit('message', {
      type: 'preflight-liveness',
      attemptId,
      phase: 'integrity-check',
      sequence: 1,
    })
    peer.emit('message', {
      type: 'ready',
      attemptId,
      port: 7777,
      restored: 0,
      schemaVersion: 1,
    })
    await expect(waiting).rejects.toThrow(/before validated preflight booting phase/i)
  })

  it('rejects ready and refusal frames from another spawn attempt', async () => {
    const readyPeer = child()
    const readyWaiting = waitForHubReady(readyPeer, attemptId, deadlines)
    for (const [phase, sequence] of [
      ['starting', 0],
      ['integrity-check', 1],
      ['booting', 2],
    ] as const) {
      readyPeer.emit('message', {
        type: 'preflight-liveness',
        attemptId,
        phase,
        sequence,
      })
    }
    readyPeer.emit('message', {
      type: 'ready',
      attemptId: '22222222-2222-4222-8222-222222222222',
      port: 7777,
      restored: 0,
      schemaVersion: 1,
    })
    await expect(readyWaiting).rejects.toThrow(/malformed readiness/i)

    const refusalPeer = child()
    const refusalWaiting = waitForHubReady(refusalPeer, attemptId, deadlines)
    refusalPeer.emit('message', {
      type: 'preflight-failed',
      attemptId: '22222222-2222-4222-8222-222222222222',
      code: 'database-validation-unavailable',
      message: 'bounded failure',
      recovery: 'stay offline',
    })
    await expect(refusalWaiting).rejects.toBeInstanceOf(MalformedPreflightRefusalError)
  })
})

describe('restart handshake question-turn evidence', () => {
  it('round-trips bounded released counts', async () => {
    const peer = child()
    const waiting = waitForHubMsg(peer, 'released', 1_000)
    peer.emit('message', {
      type: 'released',
      questionTurns: { settled: 2, outcomeUnknown: 1 },
      loginAttempts: { settled: 3, outcomeUnknown: 1 },
    })

    await expect(waiting).resolves.toEqual({
      type: 'released',
      questionTurns: { settled: 2, outcomeUnknown: 1 },
      loginAttempts: { settled: 3, outcomeUnknown: 1 },
    })
  })

  it.each([
    undefined,
    { settled: -1, outcomeUnknown: 0 },
    { settled: 0.5, outcomeUnknown: 0 },
    { settled: 0, outcomeUnknown: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed released question evidence: %j', async (questionTurns) => {
    const peer = child()
    const waiting = waitForHubMsg(peer, 'released', 1_000)
    peer.emit('message', {
      type: 'released',
      questionTurns,
      loginAttempts: { settled: 0, outcomeUnknown: 0 },
    })
    await expect(waiting).rejects.toThrow(/invalid hub 'released'/)
  })

  it.each([
    undefined,
    { settled: -1, outcomeUnknown: 0 },
    { settled: 0.5, outcomeUnknown: 0 },
    { settled: 0, outcomeUnknown: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed released login evidence: %j', async (loginAttempts) => {
    const peer = child()
    const waiting = waitForHubMsg(peer, 'released', 1_000)
    peer.emit('message', {
      type: 'released',
      questionTurns: { settled: 0, outcomeUnknown: 0 },
      loginAttempts,
    })
    await expect(waiting).rejects.toThrow(/invalid hub 'released'/)
  })

  it('keeps the supervisor deadline above database waits, Ask grace, and interrupt margin', () => {
    const worstCaseDatabaseWaits = 3 * 5_000
    expect(HUB_DRAIN_RELEASE_TIMEOUT_MS).toBeGreaterThan(
      worstCaseDatabaseWaits +
        PROFILE_LOGIN_RESTART_SETTLEMENT_TIMEOUT_MS +
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
      attemptId: '11111111-1111-4111-8111-111111111111',
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
      attemptId: '11111111-1111-4111-8111-111111111111',
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
      attemptId: '11111111-1111-4111-8111-111111111111',
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
    peer.emit('message', {
      type: 'preflight-failed',
      attemptId: '11111111-1111-4111-8111-111111111111',
      ...fields,
    })
    await expect(waiting).rejects.toBeInstanceOf(MalformedPreflightRefusalError)
  })
})

describe('profile public-generation handshake', () => {
  it('round-trips a canonical generation environment and rejects spoofed values', () => {
    const authority = {
      generationId: '11111111-1111-4111-8111-111111111111',
      publicEpoch: 7,
      active: false,
    }
    expect(parseProfileGenerationEnvironment(profileGenerationEnvironment(authority))).toEqual(
      authority,
    )
    expect(() =>
      parseProfileGenerationEnvironment({
        ...profileGenerationEnvironment(authority),
        HUB_PROFILE_PUBLIC_EPOCH: '07',
      }),
    ).toThrow(/profile public epoch/i)
    expect(() =>
      parseProfileGenerationEnvironment({
        ...profileGenerationEnvironment(authority),
        HUB_PROFILE_PUBLIC_ACTIVE: 'true',
      }),
    ).toThrow(/profile public active/i)
  })

  it('allocates strictly monotonic safe epochs and never reuses a consumed promotion', () => {
    const epochs = new ProfilePublicEpochSequence()
    expect(epochs.next()).toBe(1)
    expect(epochs.next()).toBe(2)
    expect(epochs.next()).toBe(3)
    expect(epochs.current).toBe(3)
    expect(() => new ProfilePublicEpochSequence(Number.MAX_SAFE_INTEGER).next()).toThrow(
      /exhausted/i,
    )
  })
})
