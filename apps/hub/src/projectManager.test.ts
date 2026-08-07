import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalService } from './approvals.js'
import { AgentBus } from './bus.js'
import type { Executor } from './executor.js'
import { InstructionStore } from './instructions.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { ProjectStore } from './projects.js'
import { MANAGER_STALL_MS, SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import type { Profile, SessionRecord, SessionStatus } from './types.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { QuestionService } from './questions.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  vi.useRealTimers()
  while (cleanups.length) cleanups.pop()?.()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
}

function buildHub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-manager-'))
  const repo = path.join(root, 'repo')
  const profileDir = path.join(root, 'profile')
  fs.mkdirSync(repo)
  fs.mkdirSync(profileDir)
  git(repo, 'init')
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', 'base.txt')
  git(repo, '-c', 'user.name=AllMyAgents Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base')

  const journal = new Journal(path.join(root, 'hub.db'))
  const approvals = new ApprovalService(journal)
  const bus = new AgentBus(journal.db)
  const projects = new ProjectStore(journal.db)
  const profiles: Profile[] = [{ id: 'p1', provider: 'claude', dir: profileDir }]
  const steer = vi.fn(async () => {})
  const runTurn = vi.fn(async (
    _spec: Parameters<Executor['runTurn']>[0],
    _prompt: string,
    _origin: 'operator' | 'bus',
    _attachments?: Parameters<Executor['runTurn']>[3],
  ) => {})
  const executor: Executor = {
    startThread: async () => 'unused',
    runTurn,
    steer,
    interrupt: async () => {},
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => [],
    attach: async () => {},
    isBusy: () => false,
  }
  const usage = new UsageMonitor(journal, profiles, {})
  const sessions = new SessionManager(
    journal,
    new SessionStore(journal.db),
    new Map(profiles.map((profile) => [profile.id, profile])),
    approvals,
    usage,
    new WorkspaceManager(path.join(root, 'worktrees')),
    projects,
    new InstructionStore(journal.db),
    bus,
    new MemoryStore(journal.db),
    new PracticeStore(journal.db),
    { busCanUseRiskyTools: false, autoApprovePractices: false },
    false,
    root,
    new QuestionService(journal),
    executor
  )
  const seed = (record: Partial<SessionRecord> & Pick<SessionRecord, 'id'>): SessionRecord => {
    const full: SessionRecord = {
      profileId: 'p1',
      provider: 'claude',
      cwd: repo,
      status: 'idle',
      createdAt: new Date().toISOString(),
      ...record,
    }
    ;(sessions as unknown as { sessions: Map<string, SessionRecord> }).sessions.set(full.id, full)
    return full
  }
  cleanups.push(() => {
    journal.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { sessions, journal, approvals, usage, projects, bus, seed, repo, steer, runTurn }
}

function transition(sessions: SessionManager, id: string, status: SessionStatus): void {
  ;(sessions as unknown as { setStatusById(id: string, status: SessionStatus): void }).setStatusById(id, status)
}

describe('project manager permission ceiling', () => {
  it('keeps the operator-selected Safe mode when promoting a Full chat', () => {
    const { sessions, journal, seed } = buildHub()
    const manager = seed({ id: 'manager', permissionMode: 'full' })

    sessions.configureProjectManager(
      'manager',
      {
        enabled: true,
        maxLiveChildren: 2,
        allowedProfiles: ['p1'],
        permissionMode: 'safe',
      },
      'operator',
    )

    expect(manager.permissionMode).toBe('safe')
    expect(manager.managerPermissionModeCeiling).toBe('safe')
    expect(sessions.list().find((record) => record.id === 'manager')?.permissionMode).toBe('safe')
    const persisted = journal.db
      .prepare('SELECT record FROM sessions WHERE id = ?')
      .get('manager') as { record: string }
    expect(JSON.parse(persisted.record)).toMatchObject({
      permissionMode: 'safe',
      managerPermissionModeCeiling: 'safe',
    })
    expect(
      journal.recentEventsForSession('manager').filter((event) => event.kind === 'session/mode'),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ permissionMode: 'safe', source: 'manager/grant' }),
      }),
    ])
  })

  it('rejects the next raise above the grant and leaves parent and child modes unchanged', () => {
    const { sessions, seed } = buildHub()
    const manager = seed({ id: 'manager', permissionMode: 'full' })
    sessions.configureProjectManager(
      'manager',
      {
        enabled: true,
        allowedProfiles: ['p1'],
        permissionMode: 'safe',
        maxChildPermissionMode: 'safe',
      },
      'operator',
    )
    const child = seed({ id: 'child', parentSessionId: 'manager', permissionMode: 'safe' })

    expect(() => sessions.setMode('manager', 'full')).toThrow(/manager.*operator-granted ceiling/i)
    expect(() => sessions.setMode('child', 'full')).toThrow(/parent manager.*operator-granted ceiling/i)
    expect(manager.permissionMode).toBe('safe')
    expect(child.permissionMode).toBe('safe')
  })

  it('applies an explicit operator override to one child without rewriting the manager bound', () => {
    const { sessions, journal, seed } = buildHub()
    const manager = seed({
      id: 'manager',
      isProjectManager: true,
      managerMaxChildPermissionMode: 'safe',
    })
    const child = seed({ id: 'child', parentSessionId: 'manager', permissionMode: 'safe' })

    sessions.setMode('child', 'full', 'operator-override')

    expect(child.permissionMode).toBe('full')
    expect(child.permissionModeOperatorOverride).toBe(true)
    expect(child.permissionModeOperatorOverrideCeiling).toBe('full')
    expect(manager.managerMaxChildPermissionMode).toBe('safe')
    expect(
      (sessions as unknown as { effectivePermissionMode(record: SessionRecord): string })
        .effectivePermissionMode(child),
    ).toBe('full')
    expect(journal.recentEventsForSession('child')).toContainEqual(expect.objectContaining({
      kind: 'session/mode',
      payload: expect.objectContaining({ source: 'operator/override', operatorOverride: true }),
    }))

    ;(sessions as unknown as {
      setChildDelegation(
        manager: string,
        child: string,
        authorities: Array<'commit' | 'push'>,
        tools?: string[],
        permissionMode?: 'safe' | 'edits' | 'full',
      ): SessionRecord
    }).setChildDelegation('manager', 'child', [], undefined, 'edits')
    expect(child.permissionMode).toBe('edits')
    expect(child.permissionModeOperatorOverrideCeiling).toBe('full')

    ;(sessions as unknown as {
      setChildDelegation(
        manager: string,
        child: string,
        authorities: Array<'commit' | 'push'>,
        tools?: string[],
        permissionMode?: 'safe' | 'edits' | 'full',
      ): SessionRecord
    }).setChildDelegation('manager', 'child', [], undefined, 'full')
    expect(child.permissionMode).toBe('full')
  })

  it('rematerializes a child grant immediately when the manager changes authority and mode', () => {
    const { sessions, seed, repo } = buildHub()
    seed({
      id: 'manager',
      isProjectManager: true,
      managerDelegation: ['commit'],
      managerAllowedTools: ['WebFetch'],
      managerMaxChildPermissionMode: 'edits',
    })
    seed({ id: 'child', parentSessionId: 'manager', permissionMode: 'safe' })

    ;(sessions as unknown as {
      setChildDelegation(
        manager: string,
        child: string,
        authorities: Array<'commit' | 'push'>,
        tools?: string[],
        permissionMode?: 'safe' | 'edits' | 'full',
      ): SessionRecord
    }).setChildDelegation('manager', 'child', ['commit'], ['WebFetch'], 'edits')

    const instructions = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')
    expect(instructions).toContain('Permission mode: edits')
    expect(instructions).toContain('Delegated tools: WebFetch')
    expect(instructions).toContain('Delegated Git actions: commit')
  })
})

describe('project manager exhausted-account dispatch guard', () => {
  it('pauses direct-child messages at 100% but permits them when paid overage is active', () => {
    const { sessions, journal, usage, seed } = buildHub()
    const manager = seed({ id: 'manager', projectId: 'project-1' })
    seed({ id: 'child', projectId: 'project-1', parentSessionId: manager.id })
    sessions.configureProjectManager(
      manager.id,
      {
        enabled: true,
        allowedProfiles: ['p1'],
        pauseExhaustedAccounts: true,
      },
      'operator',
    )
    usage.noteClaude('p1', { status: 'allowed', overageStatus: 'rejected' })
    usage.list()[0]!.claudeUsage = [{
      label: 'week (all models)',
      percent: 100,
      resets: 'tomorrow',
      resetsAt: Date.now() / 1000 + 86_400,
    }]

    const blocked = sessions.busSend(
      manager.id,
      { kind: 'session', id: 'child' },
      'next task',
      'Start another review.',
    )
    expect(blocked).toMatchObject({ ok: false, delivered: 0 })
    expect(blocked.error).toMatch(/100%.*exhausted-account guard|exhausted.*100%/i)
    expect(sessions.busInbox('child')).toEqual([])
    expect(journal.recentEventsForSession(manager.id)).toContainEqual(expect.objectContaining({
      kind: 'manager/usage-dispatch-skipped',
      payload: expect.objectContaining({
        skipped: [expect.objectContaining({ sessionId: 'child', profileId: 'p1' })],
      }),
    }))

    usage.noteClaude('p1', { status: 'allowed', overageStatus: 'allowed', isUsingOverage: true })
    const credited = sessions.busSend(
      manager.id,
      { kind: 'session', id: 'child' },
      'credited task',
      'Continue using the enabled overage credits.',
    )
    expect(credited).toEqual({ ok: true, delivered: 1 })
    expect(sessions.busInbox('child')).toHaveLength(1)
  })

  it('leaves legacy managers unchanged until the operator enables the option', () => {
    const { sessions, usage, seed } = buildHub()
    seed({ id: 'manager', projectId: 'project-1', isProjectManager: true })
    seed({ id: 'child', projectId: 'project-1', parentSessionId: 'manager' })
    usage.list()[0]!.claudeUsage = [{ label: 'week', percent: 100, resets: 'later' }]

    expect(sessions.busSend(
      'manager',
      { kind: 'session', id: 'child' },
      undefined,
      'Legacy behavior remains opt-in.',
    )).toEqual({ ok: true, delivered: 1 })
  })
})

describe('high-context teammate wake guard', () => {
  it('queues an idle Claude message without launching another giant resumed turn', () => {
    const { sessions, journal, bus, seed, runTurn } = buildHub()
    seed({ id: 'manager', projectId: 'project-1', isProjectManager: true })
    seed({ id: 'child', projectId: 'project-1', parentSessionId: 'manager' })
    journal.append('child', 'session/tokens', {
      scope: 'request',
      contextUsed: 625_000,
      input: 1,
      cacheRead: 624_999,
    })

    expect(sessions.busSend(
      'manager',
      { kind: 'session', id: 'child' },
      'checkpoint',
      'Acknowledge the checkpoint.',
    )).toMatchObject({ ok: true, delivered: 1, deferred: 1 })
    expect(runTurn).not.toHaveBeenCalled()
    expect(bus.pending('child')).toMatchObject([{ wake: false, delivered: false }])
    expect(journal.recentEventsForSession('manager')).toContainEqual(expect.objectContaining({
      kind: 'bus/context-wake-deferred',
      payload: expect.objectContaining({
        recipients: [expect.objectContaining({ sessionId: 'child' })],
      }),
    }))
  })

  it('also holds hub-generated child reports that bypass the public send_message path', () => {
    const { sessions, journal, bus, seed, runTurn } = buildHub()
    const manager = seed({ id: 'manager', projectId: 'project-1', isProjectManager: true })
    const child = seed({ id: 'child', projectId: 'project-1', parentSessionId: 'manager' })
    journal.append('manager', 'session/tokens', { scope: 'request', contextUsed: 750_000 })
    bus.post({
      from: {
        sessionId: child.id,
        profileId: child.profileId,
        provider: child.provider,
        projectId: child.projectId,
        label: 'Child',
      },
      project: 'project-1',
      to: { kind: 'session', id: manager.id },
      subject: 'child idle',
      body: 'Hub-generated lifecycle report.',
      recipients: [manager.id],
    })

    ;(sessions as unknown as { deliverBus(sessionId: string): void }).deliverBus(manager.id)

    expect(runTurn).not.toHaveBeenCalled()
    expect(bus.pending(manager.id)).toMatchObject([{ wake: false }])
    expect(journal.recentEventsForSession(manager.id)).toContainEqual(expect.objectContaining({
      kind: 'bus/context-wake-held',
      payload: expect.objectContaining({ count: 1 }),
    }))
  })

  it('applies the same guard to Codex from its reported context-window occupancy', () => {
    const { sessions, journal, bus, seed, runTurn } = buildHub()
    seed({ id: 'manager', projectId: 'project-1', isProjectManager: true })
    seed({
      id: 'codex-child',
      provider: 'codex',
      projectId: 'project-1',
      parentSessionId: 'manager',
    })
    journal.append('codex-child', 'session/tokens', {
      scope: 'request',
      contextUsed: 220_000,
      contextWindow: 258_000,
    })

    expect(sessions.busSend(
      'manager',
      { kind: 'session', id: 'codex-child' },
      'review',
      'Please re-open the review.',
    )).toMatchObject({ ok: true, delivered: 1, deferred: 1 })
    expect(runTurn).not.toHaveBeenCalled()
    expect(bus.pending('codex-child')[0]).toMatchObject({ wake: false })
  })

  it('still steers a high-context agent when it is already running', async () => {
    const { sessions, journal, bus, seed, steer, runTurn } = buildHub()
    seed({ id: 'manager', projectId: 'project-1', isProjectManager: true })
    seed({
      id: 'child',
      projectId: 'project-1',
      parentSessionId: 'manager',
      status: 'active',
    })
    journal.append('child', 'session/tokens', { scope: 'request', contextUsed: 800_000 })

    expect(sessions.busSend(
      'manager',
      { kind: 'session', id: 'child' },
      'live correction',
      'Apply this while the current task is still in flight.',
    )).toEqual({ ok: true, delivered: 1 })
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce())
    expect(runTurn).not.toHaveBeenCalled()
    expect(bus.pending('child')).toEqual([])
  })

  it('never starts a turn for explicit wake=false mail and folds it into the next operator turn', async () => {
    const { sessions, bus, seed, runTurn } = buildHub()
    seed({ id: 'manager', projectId: 'project-1', isProjectManager: true })
    seed({ id: 'child', projectId: 'project-1', parentSessionId: 'manager' })

    expect(sessions.busSend(
      'manager',
      { kind: 'session', id: 'child' },
      'FYI',
      'No response needed.',
      false,
    )).toEqual({ ok: true, delivered: 1 })
    expect(runTurn).not.toHaveBeenCalled()
    expect(bus.pending('child')[0]).toMatchObject({ wake: false })

    await sessions.send('child', 'Start the operator-requested task.')

    expect(runTurn).toHaveBeenCalledOnce()
    expect(runTurn.mock.calls[0]?.[1]).toContain('Start the operator-requested task.')
    expect(runTurn.mock.calls[0]?.[1]).toContain('No response needed.')
    expect(bus.pending('child')).toEqual([])
  })

  it('warns a manager to cross a compaction/successor boundary before a new high-context task', () => {
    const { sessions, journal, seed } = buildHub()
    seed({ id: 'manager', projectId: 'project-1', isProjectManager: true })
    seed({ id: 'child', projectId: 'project-1', parentSessionId: 'manager' })
    journal.append('child', 'session/tokens', {
      scope: 'request',
      contextUsed: 700_000,
    })

    const result = sessions.managerAssignChildTask('manager', 'child', {
      title: 'Begin an unrelated audit',
      status: 'pending',
    })

    expect(result).toMatchObject({ ok: true, taskId: expect.any(String) })
    expect(result.warning).toMatch(/Context boundary required.*manage_child.*spawn_agent.*auto-compact/is)
  })
})

describe('project manager reversible child retirement', () => {
  type ChildInput = {
    operation: 'retire' | 'reactivate'
    childSessionId: string
    reason?: string
  }
  const manageChild = (
    sessions: SessionManager,
    managerSessionId: string,
    input: ChildInput,
  ): Promise<{ ok: boolean; summary?: string; error?: string }> =>
    (sessions as unknown as {
      managerManageChild(
        managerId: string,
        input: ChildInput,
      ): Promise<{ ok: boolean; summary?: string; error?: string }>
    }).managerManageChild(managerSessionId, input)

  it('preserves the old child, releases its bounded slot, and permits a successor spawn', async () => {
    const { sessions, journal, seed } = buildHub()
    const manager = seed({ id: 'manager' })
    const child = seed({ id: 'child', title: 'Corbato', parentSessionId: manager.id })
    sessions.configureProjectManager(
      manager.id,
      { enabled: true, maxLiveChildren: 1, allowedProfiles: ['p1'] },
      'operator',
    )
    const spawn = (input: { profileId: string; prompt: string; useWorktree: boolean }) =>
      (sessions as unknown as {
        managerSpawn(
          managerId: string,
          input: { profileId: string; prompt: string; useWorktree: boolean },
        ): Promise<{ ok: boolean; sessionId?: string; error?: string }>
      }).managerSpawn(manager.id, input)

    await expect(spawn({ profileId: 'p1', prompt: 'Replacement before retirement.', useWorktree: false }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/live child limit.*manage_child/i) })

    const retired = await manageChild(sessions, manager.id, {
      operation: 'retire',
      childSessionId: child.id,
      reason: 'context compaction unavailable',
    })

    expect(retired).toMatchObject({ ok: true, summary: expect.stringMatching(/released one live-child slot/i) })
    expect(child).toMatchObject({
      status: 'stopped',
      managerRetiredAt: expect.any(String),
      managerRetiredBySessionId: manager.id,
      managerRetiredReason: 'context compaction unavailable',
    })
    expect(sessions.list().find((record) => record.id === child.id)).toBe(child)
    expect(journal.recentEventsForSession(child.id)).toContainEqual(expect.objectContaining({
      kind: 'manager/child-retired',
      payload: expect.objectContaining({ managerSessionId: manager.id, reason: 'context compaction unavailable' }),
    }))
    expect(journal.recentEventsForSession(child.id).some((event) => event.kind === 'session/deleted')).toBe(false)
    expect(sessions.managerChildStatus(manager.id).summary).toMatch(/1 retired.*Corbato.*retired/is)

    await expect(spawn({ profileId: 'p1', prompt: 'Continue in a fresh bounded context.', useWorktree: false }))
      .resolves.toMatchObject({ ok: true, sessionId: expect.any(String) })
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('refuses to retire a running child and bounds reversible reactivation by live capacity', async () => {
    const { sessions, seed } = buildHub()
    const manager = seed({ id: 'manager' })
    const child = seed({ id: 'child', title: 'Worker', parentSessionId: manager.id, status: 'active' })
    sessions.configureProjectManager(
      manager.id,
      { enabled: true, maxLiveChildren: 1, allowedProfiles: ['p1'] },
      'operator',
    )

    await expect(manageChild(sessions, manager.id, {
      operation: 'retire',
      childSessionId: child.id,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/while it is running/i) })
    expect(child.status).toBe('active')

    transition(sessions, child.id, 'idle')
    await expect(manageChild(sessions, manager.id, {
      operation: 'retire',
      childSessionId: child.id,
    })).resolves.toMatchObject({ ok: true })
    const replacement = seed({ id: 'replacement', parentSessionId: manager.id, status: 'idle' })
    await expect(manageChild(sessions, manager.id, {
      operation: 'reactivate',
      childSessionId: child.id,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/live child limit/i) })

    replacement.status = 'stopped'
    await expect(manageChild(sessions, manager.id, {
      operation: 'reactivate',
      childSessionId: child.id,
      reason: 'operator wants the preserved context back',
    })).resolves.toMatchObject({ ok: true })
    expect(child.status).toBe('idle')
    expect(child.managerRetiredAt).toBeUndefined()
    expect(child.managerRetiredReason).toBeUndefined()
    await new Promise<void>((resolve) => setImmediate(resolve))
  })
})

describe('project manager lifecycle awareness', () => {
  it('pushes one report for each real start, idle, stop, and error transition', () => {
    const { sessions, seed } = buildHub()
    seed({ id: 'manager', isProjectManager: true, status: 'stopped' })
    seed({ id: 'child', parentSessionId: 'manager', status: 'starting', title: 'Worker' })

    // Driver initialization is not a completed-work event and must not tell the manager “ready for
    // review” immediately before the first real started transition.
    transition(sessions, 'child', 'idle')
    transition(sessions, 'child', 'active')
    transition(sessions, 'child', 'active')
    transition(sessions, 'child', 'idle')
    transition(sessions, 'child', 'stopped')
    seed({ id: 'error-child', parentSessionId: 'manager', status: 'active', title: 'Error worker' })
    transition(sessions, 'error-child', 'error')

    const reports = sessions.busInbox('manager').map((message) => message.subject).sort()
    expect(reports).toEqual(['child errored', 'child idle', 'child started', 'child stopped'])
  })

  it('pushes a single stalled transition after five minutes without activity', () => {
    vi.useFakeTimers()
    const { sessions, seed } = buildHub()
    seed({ id: 'manager', isProjectManager: true, status: 'stopped' })
    seed({ id: 'child', parentSessionId: 'manager', status: 'starting', title: 'Worker' })

    transition(sessions, 'child', 'active')
    vi.advanceTimersByTime(MANAGER_STALL_MS + 1)
    vi.advanceTimersByTime(MANAGER_STALL_MS + 1)

    expect(sessions.busInbox('manager').map((message) => message.subject).sort()).toEqual([
      'child started',
      'child stalled',
    ].sort())
  })

  it('returns an exact direct-child tally without reconstructing lifecycle messages', () => {
    const { sessions, seed } = buildHub()
    seed({ id: 'manager', isProjectManager: true })
    seed({ id: 'starting', parentSessionId: 'manager', status: 'starting' })
    seed({ id: 'active', parentSessionId: 'manager', status: 'active' })
    seed({ id: 'idle', parentSessionId: 'manager', status: 'idle' })
    seed({ id: 'stopped', parentSessionId: 'manager', status: 'stopped' })
    seed({ id: 'error', parentSessionId: 'manager', status: 'error' })
    seed({ id: 'grandchild', parentSessionId: 'active', status: 'active' })
    seed({ id: 'unrelated', status: 'active' })

    const result = sessions.managerChildStatus('manager')
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('2 running, 1 idle, 1 stopped, 0 retired, 1 errored')
    expect(result.summary).toContain('(starting): starting')
    expect(result.summary).toContain('(active): active')
    expect(result.summary).not.toContain('grandchild')
    expect(result.summary).not.toContain('unrelated')
  })
})

describe('project manager durable teams', () => {
  type TeamInput = {
    operation: 'list' | 'create' | 'activate' | 'rename'
    teamId?: string
    name?: string
    activate?: boolean
    interruptActive?: boolean
  }
  const manageTeam = (
    sessions: SessionManager,
    managerSessionId: string,
    input: TeamInput,
  ): Promise<{ ok: boolean; summary?: string; error?: string }> =>
    (sessions as unknown as {
      managerManageTeam(
        managerId: string,
        input: TeamInput,
      ): Promise<{ ok: boolean; summary?: string; error?: string }>
    }).managerManageTeam(managerSessionId, input)

  it('migrates legacy children into one stable initial team', () => {
    const { sessions, journal, seed } = buildHub()
    const manager = seed({ id: 'manager', projectId: 'project' })
    const legacy = seed({ id: 'legacy-child', parentSessionId: 'manager', projectId: 'project' })

    sessions.configureProjectManager(
      manager.id,
      { enabled: true, allowedProfiles: ['p1'] },
      'operator',
    )

    expect(manager.managerTeams).toHaveLength(1)
    expect(manager.managerTeams?.[0]?.name).toBe('Team 1')
    expect(manager.managerActiveTeamId).toBe(manager.managerTeams?.[0]?.id)
    expect(legacy.managerTeamId).toBe(manager.managerActiveTeamId)
    expect(legacy.managerTeamName).toBe('Team 1')
    expect(journal.recentEventsForSession(manager.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'manager/teams-updated' })]),
    )
  })

  it('refuses to shelve a running team without an explicit interrupt, then preserves and reopens exact sessions', async () => {
    const { sessions, journal, seed, repo } = buildHub()
    const manager = seed({ id: 'manager', projectId: 'project' })
    sessions.configureProjectManager(
      manager.id,
      { enabled: true, allowedProfiles: ['p1'] },
      'operator',
    )
    const firstTeam = manager.managerTeams![0]!
    const outgoing = seed({
      id: 'outgoing-child',
      title: 'Builder',
      parentSessionId: manager.id,
      managerTeamId: firstTeam.id,
      managerTeamName: firstTeam.name,
      projectId: 'project',
      status: 'active',
      cwd: repo,
      branch: 'agent/builder',
    })
    const created = await manageTeam(sessions, manager.id, {
      operation: 'create',
      name: 'Review team',
    })
    expect(created.ok).toBe(true)
    const secondTeam = manager.managerTeams!.find((team) => team.name === 'Review team')!
    const incoming = seed({
      id: 'incoming-child',
      title: 'Reviewer',
      parentSessionId: manager.id,
      managerTeamId: secondTeam.id,
      managerTeamName: secondTeam.name,
      projectId: 'project',
      status: 'stopped',
      cwd: repo,
      branch: 'agent/reviewer',
    })
    const originalReopen = sessions.reopen.bind(sessions)
    const activeTeamSeenByReopen: string[] = []
    vi.spyOn(sessions, 'reopen').mockImplementation((sessionId) => {
      activeTeamSeenByReopen.push(manager.managerActiveTeamId!)
      return originalReopen(sessionId)
    })

    const refused = await manageTeam(sessions, manager.id, {
      operation: 'activate',
      teamId: secondTeam.id,
    })
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/cannot stash.*running/i)
    expect(manager.managerActiveTeamId).toBe(firstTeam.id)
    expect(outgoing.status).toBe('active')

    const switched = await manageTeam(sessions, manager.id, {
      operation: 'activate',
      teamId: secondTeam.id,
      interruptActive: true,
    })
    expect(switched.ok).toBe(true)
    expect(manager.managerActiveTeamId).toBe(secondTeam.id)
    expect(outgoing.status).toBe('stopped')
    expect(outgoing.id).toBe('outgoing-child')
    expect(outgoing.cwd).toBe(repo)
    expect(outgoing.branch).toBe('agent/builder')
    expect(incoming.status).toBe('idle')
    expect(activeTeamSeenByReopen).toEqual([firstTeam.id])
    expect(incoming.id).toBe('incoming-child')
    expect(manager.managerTeams?.find((team) => team.id === firstTeam.id)?.stashedAt).toBeTruthy()
    expect(manager.managerTeams?.find((team) => team.id === secondTeam.id)?.stashedAt).toBeUndefined()
    expect(journal.recentEventsForSession(manager.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'manager/team-activated',
          payload: expect.objectContaining({
            fromTeamId: firstTeam.id,
            teamId: secondTeam.id,
            shelvedSessionIds: ['outgoing-child'],
            interruptedSessionIds: ['outgoing-child'],
          }),
        }),
      ]),
    )
    // reopen() schedules queued-bus delivery on the next immediate; let it settle before the fixture
    // closes the shared test database.
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('does not silently reactivate a retired child when its team becomes active', async () => {
    const { sessions, seed } = buildHub()
    const manager = seed({ id: 'manager', projectId: 'project' })
    sessions.configureProjectManager(manager.id, { enabled: true, allowedProfiles: ['p1'] }, 'operator')
    const firstTeam = manager.managerTeams![0]!
    await manageTeam(sessions, manager.id, { operation: 'create', name: 'Retired team' })
    const retiredTeam = manager.managerTeams!.find((team) => team.name === 'Retired team')!
    const retired = seed({
      id: 'retired-child',
      parentSessionId: manager.id,
      managerTeamId: retiredTeam.id,
      managerTeamName: retiredTeam.name,
      projectId: 'project',
      status: 'stopped',
      managerRetiredAt: new Date().toISOString(),
      managerRetiredBySessionId: manager.id,
      managerRetiredReason: 'replaced after context exhaustion',
    })

    const activated = await manageTeam(sessions, manager.id, {
      operation: 'activate',
      teamId: retiredTeam.id,
    })

    expect(activated.ok).toBe(true)
    expect(manager.managerActiveTeamId).toBe(retiredTeam.id)
    expect(manager.managerTeams?.find((team) => team.id === firstTeam.id)?.stashedAt).toBeTruthy()
    expect(retired.status).toBe('stopped')
    expect(retired.managerRetiredAt).toBeTruthy()
  })

  it('rejects a parallel mutation while an activation is awaiting the outgoing stop', async () => {
    const { sessions, seed } = buildHub()
    const manager = seed({ id: 'manager', projectId: 'project' })
    sessions.configureProjectManager(manager.id, { enabled: true, allowedProfiles: ['p1'] }, 'operator')
    const firstTeam = manager.managerTeams![0]!
    seed({
      id: 'outgoing-child',
      parentSessionId: manager.id,
      managerTeamId: firstTeam.id,
      managerTeamName: firstTeam.name,
      projectId: 'project',
      status: 'active',
    })
    await manageTeam(sessions, manager.id, { operation: 'create', name: 'Review team' })
    const secondTeam = manager.managerTeams!.find((team) => team.name === 'Review team')!
    const originalStop = sessions.stop.bind(sessions)
    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
    vi.spyOn(sessions, 'stop').mockImplementation(async (sessionId) => {
      await stopGate
      await originalStop(sessionId)
    })

    const activating = manageTeam(sessions, manager.id, {
      operation: 'activate',
      teamId: secondTeam.id,
      interruptActive: true,
    })
    await Promise.resolve()
    const parallel = await manageTeam(sessions, manager.id, { operation: 'create', name: 'Too soon' })

    expect(parallel).toEqual({
      ok: false,
      error: 'another team operation is still settling; retry after it completes',
    })
    releaseStop()
    expect((await activating).ok).toBe(true)
  })
})

describe('project manager durable live roster', () => {
  it('rebuilds the managed-agent roster and bounded operator provenance after compaction', async () => {
    const { sessions, journal, seed, repo } = buildHub()
    seed({ id: 'manager', projectId: 'project' })
    sessions.configureProjectManager(
      'manager',
      {
        enabled: true,
        maxLiveChildren: 4,
        allowedProfiles: ['p1'],
        standingInstructions: 'Your sole purpose is to coordinate the operator-granted project team.',
      },
      'operator',
    )
    const child = seed({
      id: 'reviewer-child',
      title: 'Hopper',
      parentSessionId: 'manager',
      projectId: 'project',
      status: 'active',
      role: 'Reviewer',
      model: 'claude-sonnet',
      worktree: repo,
      branch: 'agent/reviewer',
    })
    fs.writeFileSync(path.join(repo, 'owned-parser.ts'), 'export const owned = true\n')
    journal.append(child.id, 'session/steered', {
      source: 'operator',
      text: 'private operator steer body must not be copied into manager instructions',
    })
    journal.append(child.id, 'codex/item/started', {
      item: {
        type: 'commandExecution',
        command: 'pnpm --filter hub test',
        status: 'inProgress',
      },
    })
    // The opening manager prompt is gone. The next operator message must rebuild live state from hub
    // records and real activity rather than relying on the manager to remember to call child_status.
    journal.append('manager', 'claude/system', { subtype: 'compact_boundary' })

    await sessions.send('manager', 'What is the team doing now?')

    const instructions = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')
    expect(instructions).toContain('Your sole purpose is to coordinate')
    expect(instructions).toContain('LIVE MANAGED-AGENT ROSTER')
    expect(instructions).toMatch(/operator configured this manager’s team and permission bounds/i)
    expect(instructions).toContain('Hopper')
    expect(instructions).toContain('reviewer-child')
    expect(instructions).toContain('agent type: Reviewer')
    expect(instructions).toContain('p1 / claude-sonnet')
    expect(instructions).toContain(repo)
    expect(instructions).toContain('agent/reviewer')
    expect(instructions).toContain('owned-parser.ts')
    expect(instructions).toContain('pnpm --filter hub test')
    expect(instructions).toMatch(/operator steered the active turn/i)
    expect(instructions).not.toContain('private operator steer body')
    expect(instructions).toContain('use assign_child_task to mark that assignment')
  })

  it('does not add a manager roster to an ordinary chat turn', async () => {
    const { sessions, seed, repo } = buildHub()
    seed({ id: 'ordinary', projectId: 'project' })
    seed({ id: 'manager', projectId: 'project', isProjectManager: true })
    seed({ id: 'child', projectId: 'project', parentSessionId: 'manager', status: 'active' })

    await sessions.send('ordinary', 'Continue the ordinary chat.')

    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).not.toContain(
      'LIVE MANAGED-AGENT ROSTER',
    )
  })
})

describe('operator-enabled worker one-shot sub-agents', () => {
  it('creates a nested same-account descendant and keeps approvals, inspection, and ceilings under the root manager', async () => {
    const { sessions, journal, approvals, projects, seed, repo } = buildHub()
    const project = projects.create('Nested project', repo)
    const manager = seed({ id: 'manager', projectId: project.id, permissionMode: 'full' })
    sessions.configureProjectManager(
      manager.id,
      {
        enabled: true,
        allowedProfiles: ['p1'],
        allowedTools: ['Bash'],
        delegation: ['commit'],
        permissionMode: 'full',
        maxChildPermissionMode: 'full',
        canApproveChildren: true,
        allowWorkerSubagents: true,
        maxSubagentsPerWorker: 2,
      },
      'operator',
    )
    const worker = seed({
      id: 'worker',
      title: 'Allen',
      projectId: project.id,
      parentSessionId: manager.id,
      permissionMode: 'full',
      delegatedAuthorities: ['commit'],
      delegatedTools: ['Bash'],
    })

    const result = await (sessions as unknown as {
      managerSpawn(sessionId: string, input: {
        prompt: string
        useWorktree?: boolean
      }): Promise<{ ok: boolean; sessionId?: string; error?: string }>
    }).managerSpawn(worker.id, { prompt: 'Audit the parser boundary.', useWorktree: false })

    expect(result).toMatchObject({ ok: true })
    const child = sessions.list().find((record) => record.id === result.sessionId)!
    expect(child).toMatchObject({
      title: 'Allen II',
      parentSessionId: worker.id,
      managerRootSessionId: manager.id,
      isOneShotSubagent: true,
      oneShotOrdinal: 2,
      profileId: worker.profileId,
      model: worker.model,
      permissionMode: 'full',
      delegatedAuthorities: ['commit'],
      delegatedTools: ['Bash'],
    })
    expect((sessions as unknown as { effectivePermissionMode(record: SessionRecord): string })
      .effectivePermissionMode(child)).toBe('full')
    expect(sessions.busPeek(manager.id, child.id, { view: 'activity' }).found).toBe(true)
    expect(sessions.managerChildStatus(manager.id).summary).toContain('Allen II')

    const approvalPromise = approvals.request(child.id, 'claude/tool', {
      toolName: 'Bash',
      input: { command: 'git status' },
    })
    const pending = approvals.pending().find((approval) => approval.sessionId === child.id)!
    expect(journal.recentEventsForSession(child.id)).toContainEqual(expect.objectContaining({
      kind: 'manager/child-approval-reported',
      payload: expect.objectContaining({ managerSessionId: manager.id }),
    }))
    expect(sessions.decideChildApproval(manager.id, pending.id, true)).toEqual({ ok: true })
    await expect(approvalPromise).resolves.toBe(true)

    worker.permissionMode = 'safe'
    expect((sessions as unknown as { effectivePermissionMode(record: SessionRecord): string })
      .effectivePermissionMode(child)).toBe('safe')
    expect(() => sessions.setChildDelegation(manager.id, child.id, ['commit'], ['Bash'], 'full'))
      .toThrow(/parent worker/i)
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('refuses worker spawning unless the operator explicitly enables the manager grant', async () => {
    const { sessions, projects, seed, repo } = buildHub()
    const project = projects.create('Disabled nested project', repo)
    const manager = seed({ id: 'manager', projectId: project.id, isProjectManager: true })
    const worker = seed({ id: 'worker', projectId: project.id, parentSessionId: manager.id })

    const result = await (sessions as unknown as {
      managerSpawn(sessionId: string, input: { prompt: string }): Promise<{ ok: boolean; error?: string }>
    }).managerSpawn(worker.id, { prompt: 'This should not start.' })

    expect(result).toMatchObject({ ok: false })
    expect(result.error).toMatch(/operator has not enabled/i)
  })
})

describe('project manager visibility into its own workers', () => {
  it('fails closed when a manager requests deep data for another manager’s child', () => {
    const { sessions, seed } = buildHub()
    seed({ id: 'manager-a', isProjectManager: true, projectId: 'project' })
    seed({ id: 'manager-b', isProjectManager: true, projectId: 'project' })
    seed({ id: 'child-b', parentSessionId: 'manager-b', projectId: 'project' })

    expect(sessions.busPeek('manager-a', 'child-b', { view: 'transcript' })).toEqual({ found: false })
    expect(sessions.busPeek('manager-a', 'child-b', { view: 'changes' })).toEqual({ found: false })
  })

  it('shows its child’s exact transcript events, pending approval, model, mode, and checkout changes', async () => {
    const { sessions, journal, approvals, seed, repo } = buildHub()
    seed({ id: 'manager', isProjectManager: true, projectId: 'project' })
    const child = seed({
      id: 'child',
      parentSessionId: 'manager',
      projectId: 'project',
      model: 'claude-sonnet',
      permissionMode: 'edits',
      branch: 'agent/child',
      worktree: repo,
      status: 'active',
    })
    journal.append(child.id, 'session/input', { text: 'implement the parser' })
    journal.append(child.id, 'claude/assistant', { text: 'I am inspecting the grammar.' })
    void approvals.request(child.id, 'claude/tool', { toolName: 'Bash', input: { command: 'git status' } })
    fs.writeFileSync(path.join(repo, 'changed.txt'), 'manager-visible\n')

    const transcript = sessions.busPeek('manager', 'child', { view: 'transcript', afterSeq: 0 })
    expect(transcript.found).toBe(true)
    expect(transcript.summary).toContain('implement the parser')
    expect(transcript.summary).toContain('I am inspecting the grammar.')
    expect(transcript.summary).toContain('nextAfterSeq')

    const activity = sessions.busPeek('manager', 'child', { view: 'activity' })
    expect(activity.summary).toContain('claude-sonnet')
    expect(activity.summary).toContain('edits')
    expect(activity.summary).toContain('pending approval')
    expect(activity.summary).toContain('git status')

    const changes = sessions.busPeek('manager', 'child', { view: 'changes' })
    expect(changes.summary).toContain(repo)
    expect(changes.summary).toContain('agent/child')
    expect(changes.summary).toContain('changed.txt')
    expect(changes.summary).toContain('manager-visible')
    expect(changes.summary).toMatch(/stale/i)
  })

  it('derives one child board across both vendors and exposes it only to the direct manager', () => {
    const { sessions, journal, seed } = buildHub()
    seed({ id: 'manager', isProjectManager: true, projectId: 'project' })
    seed({ id: 'other-manager', isProjectManager: true, projectId: 'project' })
    const child = seed({ id: 'child', parentSessionId: 'manager', projectId: 'project' })
    journal.append(child.id, 'claude/assistant', {
      message: {
        content: [
          { type: 'tool_use', id: 'task-1', name: 'TaskCreate', input: { subject: 'Parse the grammar' } },
        ],
      },
    })
    journal.append(child.id, 'claude/user', {
      message: { content: [{ type: 'tool_result', tool_use_id: 'task-1', content: 'Created task #1' }] },
    })
    journal.append(child.id, 'codex/turn/plan/updated', {
      plan: [{ step: 'Verify parser fixtures', status: 'inProgress' }],
    })

    const own = sessions.busPeek('manager', 'child', { view: 'tasks' })
    expect(own.found).toBe(true)
    expect(own.summary).toContain('Verify parser fixtures')
    expect(own.summary).toContain('agent reported')
    expect(sessions.busPeek('other-manager', 'child', { view: 'tasks' })).toEqual({ found: false })
  })

  it('journals manager-assigned tasks onto the same board and rejects a non-child without journaling', () => {
    const { sessions, journal, seed } = buildHub()
    seed({ id: 'manager', isProjectManager: true, projectId: 'project', title: 'Curie' })
    seed({ id: 'child', parentSessionId: 'manager', projectId: 'project' })
    seed({ id: 'unrelated', projectId: 'project' })

    const assigned = sessions.managerAssignChildTask('manager', 'child', {
      title: 'Own the parser files',
      status: 'in_progress',
    })
    expect(assigned.ok).toBe(true)
    expect(assigned.taskId).toMatch(/^manager:/)
    const eventCountBeforeRejection = (
      journal.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }
    ).count
    expect(
      sessions.managerAssignChildTask('manager', 'unrelated', { title: 'This must fail' }),
    ).toEqual({ ok: false, error: 'target is not in this manager’s hierarchy' })
    expect(
      (journal.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
    ).toBe(eventCountBeforeRejection)

    const tasks = sessions.busPeek('manager', 'child', { view: 'tasks' })
    expect(tasks.summary).toContain('Own the parser files')
    expect(tasks.summary).toContain('manager assigned by Curie')
    expect(journal.recentEventsForSession('child')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'manager/task-assigned',
          payload: expect.objectContaining({ managerSessionId: 'manager', title: 'Own the parser files' }),
        }),
      ]),
    )
  })

  it('rejects a task update owned by another manager without journaling', () => {
    const { sessions, journal, seed } = buildHub()
    seed({ id: 'manager', isProjectManager: true, projectId: 'project', title: 'Curie' })
    seed({ id: 'child', parentSessionId: 'manager', projectId: 'project' })
    journal.append('child', 'manager/task-assigned', {
      version: 1,
      id: 'manager:prior-owner',
      title: 'Prior assignment',
      status: 'pending',
      managerSessionId: 'prior-manager',
      managerLabel: 'Noether',
      childSessionId: 'child',
      assignedAt: '2026-07-29T12:00:00.000Z',
    })
    const eventCountBeforeRejection = (
      journal.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }
    ).count

    expect(
      sessions.managerAssignChildTask('manager', 'child', {
        taskId: 'manager:prior-owner',
        title: 'Attempted takeover',
        status: 'in_progress',
      }),
    ).toEqual({ ok: false, error: 'task is not an assignment owned by this manager' })
    expect(
      (journal.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
    ).toBe(eventCountBeforeRejection)
  })

  it('rejects taking over an agent-origin task without journaling', () => {
    const { sessions, journal, seed } = buildHub()
    seed({ id: 'manager', isProjectManager: true, projectId: 'project', title: 'Curie' })
    seed({ id: 'child', parentSessionId: 'manager', projectId: 'project' })
    journal.append('child', 'claude/assistant', {
      message: {
        content: [
          { type: 'tool_use', id: 'task-create', name: 'TaskCreate', input: { subject: 'Agent-owned task' } },
        ],
      },
    })
    journal.append('child', 'claude/user', {
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'task-create', content: 'Created task #7' }],
      },
    })
    const eventCountBeforeRejection = (
      journal.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }
    ).count

    expect(
      sessions.managerAssignChildTask('manager', 'child', {
        taskId: '7',
        title: 'Attempted manager takeover',
        status: 'completed',
      }),
    ).toEqual({ ok: false, error: 'task is not an assignment owned by this manager' })
    expect(
      (journal.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
    ).toBe(eventCountBeforeRejection)
  })

  it('reports an empty child board honestly', () => {
    const { sessions, seed } = buildHub()
    seed({ id: 'manager', isProjectManager: true, projectId: 'project' })
    seed({ id: 'child', parentSessionId: 'manager', projectId: 'project' })
    expect(sessions.busPeek('manager', 'child', { view: 'tasks' }).summary).toContain(
      'No tasks reported',
    )
  })
})

describe('project manager worktree risk delivery', () => {
  const event = {
    version: 1,
    risk: 'concurrent-write',
    repo: 'C:/repo',
    projectId: 'project',
    file: 'apps/hub/src/sessions.ts',
    detectedAt: '2026-07-27T12:00:00.000Z',
    key: 'pair:file',
    sessions: [
      {
        sessionId: 'child-a',
        label: 'Ada',
        branch: 'agent/ada',
        worktree: 'C:/wt/ada',
        role: 'writer',
      },
      {
        sessionId: 'child-b',
        label: 'Grace',
        branch: 'agent/grace',
        worktree: 'C:/wt/grace',
        role: 'later-writer',
      },
    ],
    baseCommit: null,
    mainCommit: '0123456789abcdef',
    commitsBehind: 0,
    mainAdvance: [],
    steeredSessionIds: ['child-b'],
  } as const

  it('maps participant parentSessionId values and directly steers each active manager once', async () => {
    const { sessions, seed, steer } = buildHub()
    seed({ id: 'manager', isProjectManager: true, projectId: 'project', status: 'active' })
    seed({ id: 'child-a', parentSessionId: 'manager', projectId: 'project' })
    seed({ id: 'child-b', parentSessionId: 'manager', projectId: 'project' })

    await sessions.reportWorktreeRiskToManagers(event)

    expect(steer).toHaveBeenCalledOnce()
    expect(steer).toHaveBeenCalledWith(
      'manager',
      expect.stringMatching(/High-priority.*Ada, Grace.*sessions\.ts/s)
    )
  })

  it('queues one report for an inactive manager and rejects an unversioned payload closed', async () => {
    const { sessions, seed, steer } = buildHub()
    seed({ id: 'manager', isProjectManager: true, projectId: 'project', status: 'stopped' })
    seed({ id: 'child-a', parentSessionId: 'manager', projectId: 'project' })
    seed({ id: 'child-b', parentSessionId: 'manager', projectId: 'project' })

    await sessions.reportWorktreeRiskToManagers(event)
    await sessions.reportWorktreeRiskToManagers({ ...event, version: 2 })

    expect(steer).not.toHaveBeenCalled()
    const messages = sessions.busInbox('manager')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.subject).toBe('worktree concurrent-write')
  })
})
