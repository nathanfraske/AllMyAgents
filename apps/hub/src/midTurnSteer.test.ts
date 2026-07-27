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

function build(opts: { steer?: (sessionId: string, text: string) => Promise<void>; pref?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-steer-'))
  dirs.push(dir)
  const journal = new Journal(path.join(dir, 'hub.db'))
  journals.push(journal)
  const store = new SessionStore(journal.db)
  const bus = new AgentBus(journal.db)
  const steer = vi.fn(opts.steer ?? (async () => {}))
  const executor: Executor = {
    startThread: async () => 'thread-1',
    runTurn: async () => {},
    steer,
    interrupt: async () => {},
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => [],
    attach: async () => {},
    isBusy: () => true,
  }
  const profile: Profile = { id: 'p1', provider: 'claude', dir: path.join(dir, 'profile') }
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
  return { sessions, journal, bus, record, steer }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await Promise.resolve()
}

describe('SessionManager mid-turn steering', () => {
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
    const { sessions, bus, steer } = build()
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
})
