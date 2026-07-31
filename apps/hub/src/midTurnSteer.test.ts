import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from './sessions.js'
import { ApprovalService } from './approvals.js'
import { Journal } from './journal.js'
import { SessionStore } from './store.js'
import { ProjectStore } from './projects.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { InstructionStore } from './instructions.js'
import { AgentBus } from './bus.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import type { Executor } from './executor.js'
import type { DangerFlags, Profile, SessionRecord } from './types.js'
import { QuestionService } from './questions.js'

const SAFE: DangerFlags = {
  busCanUseRiskyTools: false,
  autoApprovePractices: false,
  autoApproveRestart: false,
  fullAccessAnyOrigin: false,
}

const dirs: string[] = []
const journals: Journal[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const journal of journals.splice(0)) journal.db.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function build(
  opts: {
    steer?: (sessionId: string, text: string) => Promise<void>
    pref?: boolean
    provider?: 'claude' | 'codex'
    startThread?: () => Promise<string>
    runTurn?: Executor['runTurn']
    interrupt?: (sessionId: string) => Promise<void>
    isBusy?: (sessionId: string) => boolean
  } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-steer-'))
  dirs.push(dir)
  const journal = new Journal(path.join(dir, 'hub.db'))
  journals.push(journal)
  const store = new SessionStore(journal.db)
  const bus = new AgentBus(journal.db)
  const steer = vi.fn(opts.steer ?? (async () => {}))
  const startThread = vi.fn(opts.startThread ?? (async () => 'thread-1'))
  const runTurn = vi.fn(opts.runTurn ?? (async () => {}))
  const interrupt = vi.fn(opts.interrupt ?? (async () => {}))
  const executor: Executor = {
    startThread,
    runTurn,
    steer,
    interrupt,
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => [],
    attach: async () => {},
    isBusy: opts.isBusy ?? (() => true),
  }
  const profile: Profile = {
    id: 'p1',
    provider: opts.provider ?? 'claude',
    dir: path.join(dir, 'profile'),
  }
  const prefs = {
    chatNamePool: 'everyone',
    ...(opts.pref === undefined ? {} : { steerMessagesAtToolBoundary: opts.pref }),
  }
  const sessions = new SessionManager(
    journal,
    store,
    new Map([['p1', profile]]),
    new ApprovalService(journal),
    new UsageMonitor(journal, [], {}),
    new WorkspaceManager(path.join(dir, 'wt')),
    new ProjectStore(journal.db),
    new InstructionStore(journal.db),
    bus,
    new MemoryStore(journal.db),
    new PracticeStore(journal.db),
    SAFE,
    false,
    dir,
    new QuestionService(journal),
    executor,
    prefs as never
  )
  const record: SessionRecord = {
    id: 's1',
    profileId: 'p1',
    provider: 'claude',
    cwd: dir,
    projectId: 'proj1',
    status: 'active',
    createdAt: new Date().toISOString(),
    permissionMode: 'full',
  }
  ;(sessions as unknown as { sessions: Map<string, SessionRecord> }).sessions.set(record.id, record)
  store.upsert(record)
  return { sessions, journal, bus, record, steer, startThread, runTurn, interrupt }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await Promise.resolve()
}

describe('SessionManager mid-turn steering', () => {
  it('rechecks admission after async thread creation and never journals a phantom first prompt', async () => {
    let releaseThread!: () => void
    const threadReady = new Promise<string>((resolve) => {
      releaseThread = () => resolve('thread-after-freeze')
    })
    const { sessions, journal, startThread, runTurn } = build({
      provider: 'codex',
      startThread: () => threadReady,
    })

    const creating = sessions.create('p1', {
      prompt: 'must not dispatch after restart freeze',
    })
    await vi.waitFor(() => expect(startThread).toHaveBeenCalledOnce())
    sessions.setRestartTurnAdmissionFrozen(true)
    releaseThread()

    await expect(creating).rejects.toThrow(/temporarily unavailable/)
    expect(runTurn).not.toHaveBeenCalled()
    expect(
      journal
        .since(0)
        .filter(
          (event) =>
            event.kind === 'session/input' &&
            (event.payload as { text?: string }).text ===
              'must not dispatch after restart freeze'
        )
    ).toEqual([])
  })

  it('freezes operator and idle-bus turn admission until restart rollback releases it', async () => {
    const { sessions, bus, steer } = build()
    bus.post({
      from: {
        sessionId: 's2',
        profileId: 'p2',
        provider: 'claude',
        projectId: 'proj1',
        label: 'Teammate',
      },
      project: 'proj1',
      to: { kind: 'session', id: 's1' },
      body: 'stay queued during restart',
      recipients: ['s1'],
    })

    sessions.setRestartTurnAdmissionFrozen(true)
    await expect(sessions.send('s1', 'new operator input')).rejects.toThrow(
      /temporarily unavailable/
    )
    ;(sessions as unknown as { deliverBus(sessionId: string): void }).deliverBus('s1')
    await settle()
    expect(steer).not.toHaveBeenCalled()
    expect(bus.pending('s1')).toHaveLength(1)

    sessions.setRestartTurnAdmissionFrozen(false)
    await settle()
    expect(steer).toHaveBeenCalledOnce()
    expect(bus.pending('s1')).toHaveLength(0)
  })

  it('freezes only the selected profile before any new transcript or title mutation', async () => {
    const { sessions, journal, record } = build()
    sessions.freezeProfileTurnAdmission('p1', 5, 'blue-generation')

    await expect(sessions.send('s1', 'must remain absent')).rejects.toThrow(
      /credentials change/i,
    )
    expect(
      journal.since(0).filter(
        (event) =>
          event.kind === 'session/input' &&
          (event.payload as { text?: string }).text === 'must remain absent',
      ),
    ).toEqual([])
    expect(() => sessions.rename(record.id, 'must remain absent')).toThrow(/credentials change/i)
    expect(record.title).toBeUndefined()
  })

  it('finishes and journals an admitted Codex create after freeze races its thread acknowledgement', async () => {
    let releaseThread!: () => void
    const threadReady = new Promise<string>((resolve) => {
      releaseThread = () => resolve('thread-after-profile-freeze')
    })
    const { sessions, journal, startThread, runTurn } = build({
      provider: 'codex',
      startThread: () => threadReady,
      isBusy: () => false,
    })

    const creating = sessions.create('p1', {
      prompt: 'must not dispatch after profile freeze',
    })
    await vi.waitFor(() => expect(startThread).toHaveBeenCalledOnce())
    sessions.freezeProfileTurnAdmission('p1', 9, 'blue-generation')
    releaseThread()

    await expect(creating).resolves.toMatchObject({
      profileId: 'p1',
      vendorSessionId: 'thread-after-profile-freeze',
    })
    expect(runTurn).toHaveBeenCalledOnce()
    expect(
      journal.since(0).filter(
        (event) =>
          event.kind === 'session/input' &&
          (event.payload as { text?: string }).text ===
            'must not dispatch after profile freeze',
      ),
    ).toHaveLength(1)
  })

  it('keeps a Claude create admitted until the executor acknowledges turn start', async () => {
    let acceptTurn!: () => void
    const turnAccepted = new Promise<void>((resolve) => {
      acceptTurn = resolve
    })
    let busySessionId: string | undefined
    const { sessions, runTurn, interrupt, record } = build({
      isBusy: (sessionId) => sessionId === busySessionId,
      runTurn: async (spec) => {
        await turnAccepted
        busySessionId = spec.sessionId
      },
    })
    record.status = 'idle'

    const creating = sessions.create('p1', { prompt: 'create across credential freeze' })
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledOnce())
    const receipt = sessions.freezeProfileTurnAdmission('p1', 10, 'blue-generation')
    const settling = sessions.settleProfileTurns(receipt, 1_000)
    await Promise.resolve()
    expect(interrupt).not.toHaveBeenCalled()

    acceptTurn()
    const created = await creating
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith(created.id))
    busySessionId = undefined
    sessions.applyLifecycle({ t: 'turnCompleted', sessionId: created.id, wseq: 1 })
    await expect(settling).resolves.toEqual({
      settled: true,
      outcomeUnknownSessionIds: [],
      outcomeUnknownOperationIds: [],
    })
  })

  it('settles a frozen profile from explicit lifecycle notification without polling', async () => {
    let busy = true
    const { sessions, record, interrupt } = build({
      isBusy: () => busy,
    })
    const receipt = sessions.freezeProfileTurnAdmission('p1', 11, 'blue-generation')

    const settling = sessions.settleProfileTurns(receipt, 1_000)
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith(record.id))
    busy = false
    sessions.applyLifecycle({ t: 'turnCompleted', sessionId: record.id, wseq: 1 })

    await expect(settling).resolves.toEqual({
      settled: true,
      outcomeUnknownSessionIds: [],
      outcomeUnknownOperationIds: [],
    })
  })

  it('reports exact unknown sessions when profile settlement hits its bound', async () => {
    const { sessions, record } = build({ isBusy: () => true })
    const receipt = sessions.freezeProfileTurnAdmission('p1', 13, 'blue-generation')

    await expect(sessions.settleProfileTurns(receipt, 10)).resolves.toEqual({
      settled: false,
      outcomeUnknownSessionIds: [record.id],
      outcomeUnknownOperationIds: [],
    })
    await expect(sessions.send(record.id, 'still frozen')).rejects.toThrow(
      /credentials change/i,
    )

    expect(sessions.thawProfileTurnAdmission(receipt)).toBe(true)
    await expect(sessions.send(record.id, 'rollback reopened admission')).resolves.toBeUndefined()
    await settle()
  })

  it('waits an admitted steer ACK, journals accepted input, then snapshots and interrupts the exact turn', async () => {
    let acceptSteer!: () => void
    const steerAccepted = new Promise<void>((resolve) => {
      acceptSteer = resolve
    })
    let busy = true
    const { sessions, journal, steer, interrupt, record } = build({
      steer: () => steerAccepted,
      isBusy: () => busy,
    })

    const sending = sessions.send('s1', 'raced with credential freeze')
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce())
    const receipt = sessions.freezeProfileTurnAdmission('p1', 15, 'blue-generation')
    const settling = sessions.settleProfileTurns(receipt, 1_000)
    await Promise.resolve()
    expect(interrupt).not.toHaveBeenCalled()
    acceptSteer()

    await expect(sending).resolves.toBeUndefined()
    expect(
      journal.since(0).filter(
        (event) =>
          event.kind === 'session/input' &&
          (event.payload as { text?: string }).text === 'raced with credential freeze',
      ),
    ).toHaveLength(1)
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith(record.id))
    busy = false
    sessions.applyLifecycle({ t: 'turnCompleted', sessionId: record.id, wseq: 1 })
    await expect(settling).resolves.toEqual({
      settled: true,
      outcomeUnknownSessionIds: [],
      outcomeUnknownOperationIds: [],
    })
  })

  it('keeps a fresh Claude send admitted through a delayed runTurn-start acknowledgement', async () => {
    let acceptTurn!: () => void
    const turnAccepted = new Promise<void>((resolve) => {
      acceptTurn = resolve
    })
    let busy = false
    const { sessions, runTurn, interrupt, record } = build({
      isBusy: () => busy,
      runTurn: async () => {
        await turnAccepted
        busy = true
      },
    })
    record.status = 'idle'

    const sending = sessions.send(record.id, 'send across credential freeze')
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledOnce())
    const receipt = sessions.freezeProfileTurnAdmission('p1', 17, 'blue-generation')
    const settling = sessions.settleProfileTurns(receipt, 1_000)
    await Promise.resolve()
    expect(interrupt).not.toHaveBeenCalled()

    acceptTurn()
    await sending
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith(record.id))
    busy = false
    sessions.applyLifecycle({ t: 'turnCompleted', sessionId: record.id, wseq: 1 })
    await expect(settling).resolves.toEqual({
      settled: true,
      outcomeUnknownSessionIds: [],
      outcomeUnknownOperationIds: [],
    })
  })

  it('requires the exact freeze receipt to thaw and rejects equal-epoch generation aliases', async () => {
    const { sessions, record } = build()
    const first = sessions.freezeProfileTurnAdmission('p1', 21, 'blue-generation')
    expect(sessions.thawProfileTurnAdmission(first)).toBe(true)
    const second = sessions.freezeProfileTurnAdmission('p1', 21, 'blue-generation')

    expect(second.freezeId).not.toBe(first.freezeId)
    expect(sessions.thawProfileTurnAdmission(first)).toBe(false)
    expect(() =>
      sessions.freezeProfileTurnAdmission('p1', 21, 'green-generation'),
    ).toThrow(/belongs to generation/i)
    await expect(sessions.send(record.id, 'stale thaw must not open admission')).rejects.toThrow(
      /credentials change/i,
    )
    expect(sessions.thawProfileTurnAdmission(second)).toBe(true)
    await settle()
  })

  it('delivers a worktree collision as a direct live steer with distinct guardrail provenance', async () => {
    const { sessions, journal, record, steer } = build()
    record.worktree = record.cwd

    await expect(
      sessions.steerWorktreeCollision(
        's1',
        'Heads up: Knuth is also editing apps/hub/src/sessions.ts right now.'
      )
    ).resolves.toBe(true)

    expect(steer).toHaveBeenCalledOnce()
    expect(steer).toHaveBeenCalledWith(
      's1',
      'Heads up: Knuth is also editing apps/hub/src/sessions.ts right now.'
    )
    expect(
      journal.since(0).filter((event) => event.kind === 'session/worktree-collision-steered')
    ).toHaveLength(1)
    expect(journal.since(0).filter((event) => event.kind === 'session/turn-origin')).toHaveLength(0)
  })

  it('sends a second operator message into the live turn without changing its operator provenance', async () => {
    const { sessions, journal, steer } = build()
    ;(sessions as unknown as { operatorTurnSessions: Set<string> }).operatorTurnSessions.add('s1')
    const originCount = [...journal.replay(0)].filter((event) => event.kind === 'session/turn-origin').length

    await sessions.send('s1', 'correct the instruction')

    expect(steer).toHaveBeenCalledWith('s1', 'correct the instruction')
    expect([...journal.replay(0)].filter((event) => event.kind === 'session/turn-origin')).toHaveLength(originCount)
    expect(sessions.isAutoApproved('s1', 'claude/tool', { toolName: 'Bash' })).toBe(true)
    expect([...journal.replay(0)].some((event) => event.kind === 'session/input' && (event.payload as { text?: string }).text === 'correct the instruction')).toBe(true)
  })

  it('steers a framed bus message into a live turn without reclassifying that turn as bus-origin', async () => {
    const { sessions, journal, bus, steer } = build()
    ;(sessions as unknown as { operatorTurnSessions: Set<string> }).operatorTurnSessions.add('s1')
    bus.post({
      from: { sessionId: 's2', profileId: 'p2', provider: 'claude', projectId: 'proj1', label: 'Teammate' },
      project: 'proj1',
      to: { kind: 'session', id: 's1' },
      subject: 'Correction',
      body: 'Use the other API',
      recipients: ['s1'],
    })

    ;(sessions as unknown as { deliverBus(sessionId: string): void }).deliverBus('s1')
    await settle()

    expect(steer).toHaveBeenCalledOnce()
    expect(steer.mock.calls[0]![1]).toContain('<<ALLMYAGENTS-BUS')
    expect(steer.mock.calls[0]![1]).toContain('Use the other API')
    expect(steer.mock.calls[0]![1]).toContain('semi-trusted')
    expect(bus.pending('s1')).toHaveLength(0)
    expect(journal.since(0).filter((event) => event.kind === 'bus/pending-notice-attempted')).toHaveLength(0)
    expect((sessions as unknown as { busTurnSessions: Set<string> }).busTurnSessions.has('s1')).toBe(false)
    expect(sessions.isAutoApproved('s1', 'claude/tool', { toolName: 'Bash' })).toBe(true)
  })

  it('leaves a bus message queued when the live turn ends before the steer is accepted', async () => {
    const failure = new Error('no active Claude turn to steer')
    const { sessions, bus, steer } = build({ steer: async () => Promise.reject(failure) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bus.post({
      from: { sessionId: 's2', profileId: 'p2', provider: 'claude', projectId: 'proj1', label: 'Teammate' },
      project: 'proj1',
      to: { kind: 'session', id: 's1' },
      body: 'Do not lose me',
      recipients: ['s1'],
    })

    ;(sessions as unknown as { deliverBus(sessionId: string): void }).deliverBus('s1')
    await settle()

    expect(steer).toHaveBeenCalledOnce()
    expect(bus.pending('s1')).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('left queued'))
  })

  it('with full-message steering off, injects one durable notice per turn without delivering the mail', async () => {
    const { sessions, journal, bus, steer } = build({ pref: false })
    const post = (body: string) =>
      bus.post({
        from: { sessionId: 's2', profileId: 'p2', provider: 'claude', projectId: 'proj1', label: 'Teammate' },
        project: 'proj1',
        to: { kind: 'session', id: 's1' },
        body,
        recipients: ['s1'],
      })

    post('first message')
    ;(sessions as unknown as { deliverBus(sessionId: string): void }).deliverBus('s1')
    await settle()

    expect(steer).toHaveBeenCalledOnce()
    expect(steer.mock.calls[0]![1]).toMatch(/1 teammate message waiting.*read_messages/i)
    expect(bus.pending('s1')).toHaveLength(1)
    expect(journal.since(0).filter((event) => event.kind === 'bus/delivered')).toHaveLength(0)
    expect(journal.since(0).filter((event) => event.kind === 'bus/pending-notice-attempted')).toHaveLength(1)

    // More mail in the same turn neither repeats the notice nor marks either real message delivered.
    post('second message')
    ;(sessions as unknown as { deliverBus(sessionId: string): void }).deliverBus('s1')
    await settle()
    expect(steer).toHaveBeenCalledOnce()
    expect(bus.pending('s1')).toHaveLength(2)

    // The journal row is the cross-hub fence: losing only the process-local set during a restart must not
    // make a still-running turn receive the same notice again.
    ;(sessions as unknown as { busNoticeTurns: Set<string> }).busNoticeTurns.clear()
    ;(sessions as unknown as { deliverBus(sessionId: string): void }).deliverBus('s1')
    await settle()
    expect(steer).toHaveBeenCalledOnce()

    // A real turn boundary clears both fences, and the next turn-origin row makes the durable query
    // distinguish "notice in the prior turn" from "notice in this one."
    sessions.applyLifecycle({ t: 'turnCompleted', sessionId: 's1', wseq: 1 })
    await settle()
    journal.append('s1', 'session/turn-origin', { origin: 'operator' })
    sessions.applyLifecycle({ t: 'turnStarted', sessionId: 's1', wseq: 2 })
    post('third message, next turn')
    ;(sessions as unknown as { deliverBus(sessionId: string): void }).deliverBus('s1')
    await settle()
    expect(steer).toHaveBeenCalledTimes(2)
    expect(steer.mock.calls[1]![1]).toMatch(/3 teammate messages waiting.*read_messages/i)
  })

  it('builds API pending counts with one grouped query instead of pending() once per session', () => {
    const { sessions, journal, bus } = build()
    bus.post({
      from: { sessionId: 's2', profileId: 'p2', provider: 'claude', projectId: 'proj1', label: 'Teammate' },
      project: 'proj1',
      to: { kind: 'session', id: 's1' },
      body: 'one',
      recipients: ['s1'],
    })
    const second = bus.post({
      from: { sessionId: 's3', profileId: 'p3', provider: 'codex', projectId: 'proj1', label: 'Other' },
      project: 'proj1',
      to: { kind: 'session', id: 's1' },
      body: 'two',
      recipients: ['s1'],
    })
    const perSession = vi.spyOn(bus, 'pending')

    const rows = (
      sessions as unknown as {
        listForApi(): Array<SessionRecord & { unreadFromTeammates: number }>
      }
    ).listForApi()

    expect(rows).toEqual([expect.objectContaining({ id: 's1', unreadFromTeammates: 2 })])
    expect(perSession).not.toHaveBeenCalled()
    const plan = journal.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT toSession, COUNT(*) FROM bus_messages WHERE delivered = 0 GROUP BY toSession'
      )
      .all() as Array<{ detail: string }>
    expect(plan.some((step) => step.detail.includes('idx_bus_pending_to'))).toBe(true)

    bus.markDelivered(second.map((message) => message.id))
    expect(
      (
        sessions as unknown as {
          listForApi(): Array<SessionRecord & { unreadFromTeammates: number }>
        }
      )
        .listForApi()
        .find((row) => row.id === 's1')?.unreadFromTeammates
    ).toBe(1)
  })
})
