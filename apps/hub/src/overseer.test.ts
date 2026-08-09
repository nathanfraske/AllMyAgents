import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalService } from './approvals.js'
import { AgentBus } from './bus.js'
import type { Executor } from './executor.js'
import type { ElevatedCommandResult } from './elevatedCommand.js'
import { InstructionStore } from './instructions.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { ProjectStore } from './projects.js'
import { QuestionService } from './questions.js'
import { applyOverseerModeUpdate } from './overseerMode.js'
import type { RemoteDeviceController } from './remoteDevices.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import type { OverseerConfig, Profile, SessionRecord } from './types.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'

const cleanups: Array<() => void> = []
afterEach(async () => {
  // Session creation intentionally queues initial bus delivery. Let lifecycle work scheduled by the
  // manager drain before closing its backing database, just as orderly hub shutdown does.
  await new Promise<void>((resolve) => setImmediate(resolve))
  while (cleanups.length) cleanups.pop()?.()
})

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-overseer-'))
  const profileDir = path.join(root, 'profile')
  const secondProfileDir = path.join(root, 'profile-2')
  fs.mkdirSync(profileDir)
  fs.mkdirSync(secondProfileDir)
  const journal = new Journal(path.join(root, 'hub.db'))
  const store = new SessionStore(journal.db)
  const approvals = new ApprovalService(journal)
  const profiles: Profile[] = [
    { id: 'p1', provider: 'claude', dir: profileDir },
    { id: 'p2', provider: 'codex', dir: secondProfileDir },
  ]
  const executor: Executor = {
    startThread: async () => 'unused',
    runTurn: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    interrupt: async () => {},
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => [],
    attach: async () => {},
    isBusy: () => false,
  }
  const bus = new AgentBus(journal.db)
  const projects = new ProjectStore(journal.db, journal)
  const sessions = new SessionManager(
    journal,
    store,
    new Map(profiles.map((profile) => [profile.id, profile])),
    approvals,
    new UsageMonitor(journal, profiles, {}),
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
    executor,
  )
  const seed = (record: Partial<SessionRecord> & Pick<SessionRecord, 'id'>): SessionRecord => {
    const full: SessionRecord = {
      profileId: 'p1', provider: 'claude', cwd: root, status: 'idle', createdAt: new Date().toISOString(), ...record,
    }
    ;(sessions as unknown as { sessions: Map<string, SessionRecord> }).sessions.set(full.id, full)
    return full
  }
  const markOperator = (id: string): void => {
    ;(sessions as unknown as { operatorTurnSessions: Set<string> }).operatorTurnSessions.add(id)
  }
  const markBus = (id: string): void => {
    ;(sessions as unknown as { busTurnSessions: Set<string> }).busTurnSessions.add(id)
  }
  cleanups.push(() => {
    journal.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, journal, store, approvals, sessions, executor, bus, projects, profiles, seed, markOperator, markBus }
}

describe('application Overseer authority', () => {
  it('upgrades an existing durable Overseer in place exactly once', () => {
    const h = harness()
    h.store.upsert({
      id: 'legacy-overseer',
      profileId: 'p1',
      provider: 'claude',
      cwd: h.root,
      status: 'idle',
      createdAt: '2026-07-01T00:00:00.000Z',
      isOverseer: true,
      overseerCapabilityVersion: 6,
      permissionMode: 'safe',
    })

    h.sessions.loadRecords()
    const loadedLegacy = h.store.all().find((record) => record.id === 'legacy-overseer')
    expect(loadedLegacy).toMatchObject({ permissionMode: 'safe' })
    expect(loadedLegacy?.overseerCapabilityVersion).toBe(6)
    expect(h.journal.recentEventsForSession('legacy-overseer', 20)).toEqual([])

    h.sessions.reconcileStale()

    expect(h.store.all().find((record) => record.id === 'legacy-overseer')).toMatchObject({
      isOverseer: true,
      overseerCapabilityVersion: 10,
      permissionMode: 'full',
      permissionModeOperatorOverride: true,
      role: 'Application Overseer',
    })
    expect(fs.readFileSync(path.join(h.root, 'CLAUDE.md'), 'utf8')).toContain(
      'Overseer capability manifest version 10',
    )
    expect(fs.readFileSync(path.join(h.root, 'CLAUDE.md'), 'utf8')).toContain(
      'mcp__allmyagents__overseer_control',
    )
    expect(fs.readFileSync(path.join(h.root, 'CLAUDE.md'), 'utf8')).toContain(
      'configure_github_automation',
    )
    expect(fs.readFileSync(path.join(h.root, 'CLAUDE.md'), 'utf8')).toContain(
      'explicitly ask whether the manager may decide descendant approvals',
    )
    expect(fs.readFileSync(path.join(h.root, 'CLAUDE.md'), 'utf8')).toContain(
      'reassign_manager_account',
    )
    expect(fs.readFileSync(path.join(h.root, 'CLAUDE.md'), 'utf8')).toContain(
      'Do not use the vendor-native list_agents or peek_agent',
    )
    const upgrades = () => h.journal.recentEventsForSession('legacy-overseer', 20)
      .filter((event) => event.kind === 'overseer/capabilities-upgraded')
    expect(upgrades()).toHaveLength(1)
    expect(upgrades()[0]?.payload).toMatchObject({
      fromVersion: 6,
      toVersion: 10,
      conversationPreserved: true,
      tools: expect.arrayContaining(['overseer_control', 'remote_exec', 'browser_navigate']),
    })

    h.sessions.reconcileStale()
    expect(upgrades()).toHaveLength(1)
  })

  it('requires the hub-minted role and direct operator provenance for mutations', async () => {
    const h = harness()
    h.seed({ id: 'ordinary' })
    h.markOperator('ordinary')
    await expect(h.sessions.overseerControl('ordinary', { operation: 'status' })).resolves.toMatchObject({ ok: false })

    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    await expect(h.sessions.overseerControl('overseer', { operation: 'status' })).resolves.toMatchObject({
      ok: true,
    })
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'set_mode', sessionId: 'ordinary', permissionMode: 'full',
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/direct operator turn/u) })
    h.markOperator('overseer')
    h.markBus('overseer')
    await expect(h.sessions.overseerControl('overseer', { operation: 'status' })).resolves.toMatchObject({ ok: true })
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'set_mode', sessionId: 'ordinary', permissionMode: 'full',
    })).resolves.toMatchObject({ ok: false })
  })

  it('gives the Overseer a complete read-only fleet view without widening ordinary agent ACLs', () => {
    const h = harness()
    h.seed({ id: 'overseer', title: 'Overseer', isOverseer: true, permissionMode: 'full' })
    h.seed({ id: 'project-a-agent', title: 'Ada', projectId: 'project-a', role: 'Reviewer' })
    h.seed({ id: 'project-b-agent', title: 'Turing', projectId: 'project-b', status: 'stopped' })
    h.seed({ id: 'project-a-peer', title: 'Hopper', projectId: 'project-a' })
    h.seed({
      id: 'retired-agent',
      title: 'Archived',
      projectId: 'project-a',
      status: 'stopped',
      parentSessionId: 'project-a-agent',
      managerRetiredAt: '2026-08-08T12:00:00.000Z',
    })

    expect(h.sessions.busRoster('overseer')).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'project-a-agent', label: 'Ada', projectId: 'project-a', role: 'Reviewer' }),
      expect.objectContaining({ sessionId: 'project-b-agent', label: 'Turing', projectId: 'project-b', status: 'stopped' }),
    ]))
    expect(h.sessions.busRoster('overseer').map((record) => record.sessionId)).not.toContain('retired-agent')
    expect(h.sessions.busRoster('project-a-agent').map((record) => record.sessionId)).toEqual(['project-a-peer'])

    expect(h.sessions.busPeek('overseer', 'project-b-agent', { view: 'activity' })).toMatchObject({
      found: true,
      summary: expect.stringContaining('project-b-agent'),
    })
    expect(h.sessions.busPeek('project-a-agent', 'project-b-agent', { view: 'summary' })).toEqual({ found: false })
    expect(h.journal.recentEventsForSession('overseer', 20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'overseer/agent-inspected',
        payload: expect.objectContaining({ targetSessionId: 'project-b-agent', view: 'activity' }),
      }),
    ]))
  })

  it('allows only a direct operator-origin Overseer turn to message across projects', () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    h.seed({ id: 'target', projectId: 'project-b', status: 'active' })

    expect(h.sessions.busSend('overseer', { kind: 'session', id: 'target' }, 'check', 'Before operator')).toMatchObject({
      ok: false,
      error: 'cross-project messaging is not allowed',
    })
    h.markOperator('overseer')
    expect(h.sessions.busSend('overseer', { kind: 'session', id: 'target' }, 'check', 'Operator request')).toEqual({
      ok: true,
      delivered: 1,
    })
    h.markBus('overseer')
    expect(h.sessions.busSend('overseer', { kind: 'session', id: 'target' }, 'check', 'Peer request')).toMatchObject({
      ok: false,
      error: 'cross-project messaging is not allowed',
    })
  })

  it('deduplicates authenticated peer messages and permits a bus turn to reply only to its source hub', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, overseerCapabilityVersion: 2, permissionMode: 'full' })
    const sendOverseerMessage = vi.fn(async () => ({ accepted: true }))
    h.sessions.setRemoteDeviceController({
      sendOverseerMessage,
    } as unknown as RemoteDeviceController)
    const input = {
      sourceSiteId: 'peerhub',
      sourceLabel: 'Peer Hub',
      messageId: 'cc8be0e3-f389-4be9-a140-8d102d67271e',
      subject: 'status',
      body: 'Please compare the release state.',
    }

    expect(h.sessions.receiveRemoteOverseerMessage(input)).toMatchObject({
      accepted: true, overseerSessionId: 'overseer',
    })
    expect(h.sessions.receiveRemoteOverseerMessage(input)).toMatchObject({
      accepted: true, duplicate: true, overseerSessionId: 'overseer',
    })
    expect(h.executor.runTurn).toHaveBeenCalledTimes(1)
    expect(h.bus.inbox('overseer')).toHaveLength(1)
    expect(h.bus.inbox('overseer')[0]?.body).toContain('semi-trusted peer message')

    await expect(h.sessions.overseerControl('overseer', {
      operation: 'send_overseer_message', siteId: 'different-peer', text: 'not allowed',
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/direct operator turn/u) })
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'send_overseer_message', siteId: 'peerhub', text: 'reply',
    })).resolves.toMatchObject({ ok: true })
    expect(sendOverseerMessage).toHaveBeenCalledOnce()
  })

  it('provides a provider-neutral app guide without requiring mutating authority', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    h.markBus('overseer')

    await expect(h.sessions.overseerControl('overseer', { operation: 'guide' })).resolves.toMatchObject({
      ok: true,
      data: {
        quickStart: expect.arrayContaining([expect.stringMatching(/set this up for me/u)]),
        concepts: expect.arrayContaining([
          expect.objectContaining({ name: 'Projects and scratchpads' }),
          expect.objectContaining({ name: 'Access and approvals' }),
          expect.objectContaining({ name: 'Mesh and remote testbeds' }),
        ]),
        responseRule: expect.stringMatching(/actual question first/u),
      },
    })
    await expect(h.sessions.overseerControl('overseer', { operation: 'ui_catalog' })).resolves.toMatchObject({
      ok: true,
      data: expect.arrayContaining([expect.objectContaining({ id: 'accounts' })]),
    })
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'highlight_ui', uiTarget: 'accounts', uiMessage: 'Accounts live here.',
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/direct operator turn/u) })
  })

  it('journals only allowlisted UI highlights on a direct operator turn', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    h.markOperator('overseer')

    await expect(h.sessions.overseerControl('overseer', {
      operation: 'highlight_ui', uiTarget: 'accounts', uiMessage: 'Sign in or re-authenticate here.',
    })).resolves.toMatchObject({ ok: true, data: { target: 'accounts', highlighted: true } })
    expect(h.journal.recentEventsForSession('overseer', 20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'overseer/ui-guide-requested',
        payload: expect.objectContaining({ target: 'accounts', message: 'Sign in or re-authenticate here.' }),
      }),
    ]))
  })

  it('can inspect, create, override, decide another chat approval, and request a supervised restart', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    h.seed({ id: 'target', permissionMode: 'safe' })
    h.markOperator('overseer')

    const status = await h.sessions.overseerControl('overseer', { operation: 'status' })
    expect(status).toMatchObject({ ok: true, data: { sessions: expect.any(Array), profiles: expect.any(Array) } })

    const project = await h.sessions.overseerControl('overseer', { operation: 'create_project', name: 'Lab' })
    expect(project).toMatchObject({ ok: true, data: { name: 'Lab' } })
    const projectId = (project.data as { id: string }).id
    expect(h.journal.since(0)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'project/created',
        sessionId: null,
        payload: { project: expect.objectContaining({ id: projectId, name: 'Lab' }) },
      }),
    ]))
    const chat = await h.sessions.overseerControl('overseer', {
      operation: 'create_chat', profileId: 'p1', projectId, permissionMode: 'edits', useWorktree: false,
    })
    expect(chat).toMatchObject({ ok: true, data: { profileId: 'p1', projectId, permissionMode: 'edits' } })

    await expect(h.sessions.overseerControl('overseer', {
      operation: 'set_mode', sessionId: 'target', permissionMode: 'full',
    })).resolves.toMatchObject({ ok: true })
    expect(h.sessions.list().find((record) => record.id === 'target')).toMatchObject({
      permissionMode: 'full', permissionModeOperatorOverride: true,
    })

    const pending = h.approvals.request('target', 'commandExecution', { command: 'git status' })
    const approvalId = h.approvals.pending()[0]!.id
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'approve', approvalId, approve: true,
    })).resolves.toMatchObject({ ok: true })
    await expect(pending).resolves.toBe(true)
    const afterInterventions = await h.sessions.overseerControl('overseer', { operation: 'status' })
    const targetStatus = (afterInterventions.data as {
      sessions: Array<{ id: string; operatorInterventions: string[] }>
    }).sessions.find((session) => session.id === 'target')
    expect(targetStatus?.operatorInterventions).toEqual(expect.arrayContaining([
      expect.stringMatching(/operator overrode permission mode to full/u),
      expect.stringMatching(/operator approved commandExecution/u),
    ]))

    const restart = vi.fn()
    h.sessions.setRestartSignal(restart)
    await expect(h.sessions.overseerControl('overseer', { operation: 'restart_hub' })).resolves.toMatchObject({ ok: true })
    expect(restart).toHaveBeenCalledWith('overseer', 'overseer')
  })

  it('forces an explicit manager approval choice and can hand the manager to another account', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    h.markOperator('overseer')
    const project = h.projects.create('Manager handoff', h.root)
    h.seed({ id: 'manager', title: 'Project manager', projectId: project.id })

    await expect(h.sessions.overseerControl('overseer', {
      operation: 'configure_manager',
      sessionId: 'manager',
      managerConfig: { enabled: true },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/ask whether the manager may decide descendant approvals/u),
    })
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'configure_manager',
      sessionId: 'manager',
      managerConfig: { enabled: true, canApproveChildren: false },
    })).resolves.toMatchObject({
      ok: true,
      data: expect.objectContaining({ isProjectManager: true, managerCanApproveChildren: false }),
    })

    const moved = await h.sessions.overseerControl('overseer', {
      operation: 'reassign_manager_account',
      sessionId: 'manager',
      profileId: 'p2',
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
    expect(moved).toMatchObject({
      ok: true,
      data: expect.objectContaining({
        profileId: 'p2',
        provider: 'codex',
        isProjectManager: true,
        managerReassignedFromSessionId: 'manager',
      }),
    })
    expect(h.sessions.list().find((record) => record.id === 'manager')).toMatchObject({
      isProjectManager: false,
      status: 'stopped',
      managerReassignedToSessionId: expect.any(String),
    })
  })

  it('saves and launches a real manager team with operator-origin startup messages', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    h.markOperator('overseer')
    const project = await h.sessions.overseerControl('overseer', { operation: 'create_project', name: 'Preset Lab' })
    const projectId = (project.data as { id: string }).id
    const saved = await h.sessions.overseerControl('overseer', {
      operation: 'save_team_preset',
      preset: {
        name: 'Review pair',
        description: 'One manager and one reviewer.',
        manager: {
          profileId: 'p1', permissionMode: 'full', maxChildPermissionMode: 'edits', maxLiveChildren: 2,
          canApproveChildren: true, delegation: ['commit'], allowedTools: ['Read', 'Edit'],
        },
        agents: [{
          id: 'reviewer', name: 'Reviewer', purpose: 'Review the project.', prompt: 'Inspect the project and report.',
          profileId: 'p1', permissionMode: 'edits', useWorktree: false, authorities: ['commit'], tools: ['Read'],
        }],
      },
    })
    const presetId = (saved.data as { id: string }).id
    const launched = await h.sessions.overseerControl('overseer', {
      operation: 'launch_team', projectId, presetId, text: 'Audit the current implementation.',
    })
    expect(launched).toMatchObject({ ok: true, data: { projectId, presetId, children: [{ name: 'Reviewer' }] } })
    const data = launched.data as { manager: { id: string }; children: Array<{ id: string }> }
    expect(h.sessions.list().find((record) => record.id === data.manager.id)).toMatchObject({
      isProjectManager: true,
      managerMaxChildPermissionMode: 'edits',
      permissionMode: 'full',
    })
    expect(h.sessions.list().find((record) => record.id === data.children[0]!.id)).toMatchObject({
      parentSessionId: data.manager.id,
      permissionMode: 'edits',
      delegatedAuthorities: ['commit'],
      delegatedTools: ['Read'],
    })
    expect(h.journal.lastTurnOrigin(data.manager.id)).toBe('operator')
    expect(h.journal.lastTurnOrigin(data.children[0]!.id)).toBe('operator')
  })

  it('allows diagnostic reads on failure-alert turns but keeps mutations operator-bound', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    h.seed({ id: 'failed', status: 'idle', title: 'Broken worker' })
    h.sessions.failTurn('failed', 'synthetic harness failure')
    expect(h.journal.recentEventsForSession('failed', 20).map((event) => event.kind)).toContain('overseer/failure-alerted')

    h.markBus('overseer')
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'failure_context', sessionId: 'failed',
    })).resolves.toMatchObject({ ok: true, data: { session: { id: 'failed', status: 'error' } } })
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'set_mode', sessionId: 'failed', permissionMode: 'full',
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/direct operator turn/u) })
  })

  it('turns Claude organization entitlement rejection into one actionable account re-authentication state', async () => {
    const h = harness()
    h.seed({ id: 'failed', status: 'active', title: 'Rejected Claude worker' })

    h.sessions.failTurn(
      'failed',
      'Claude Code returned an error result: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
    )

    expect(h.profiles[0]).toMatchObject({
      authStatus: 'signed_out',
      authError: expect.stringMatching(/organization that rejected Claude Code subscription access/u),
    })
    expect(h.journal.since(0)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'profile/auth',
        sessionId: null,
        payload: expect.objectContaining({
          profileId: 'p1',
          status: 'signed_out',
          message: expect.stringMatching(/Re-authenticate it from Settings/u),
        }),
      }),
    ]))

    const inputsBeforeRetry = h.journal.since(0).filter((event) => event.kind === 'session/input').length
    await expect(h.sessions.send('failed', 'retry with the same rejected credential')).rejects.toThrow(
      /organization that rejected Claude Code subscription access/u,
    )
    expect(h.executor.runTurn).not.toHaveBeenCalled()
    expect(h.journal.since(0).filter((event) => event.kind === 'session/input')).toHaveLength(inputsBeforeRetry)
  })

  it('queues failure alerts until a privileged operator turn ends', () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full', status: 'active' })
    h.markOperator('overseer')
    h.seed({ id: 'failed', status: 'idle', title: 'Broken worker' })

    h.sessions.failTurn('failed', 'synthetic harness failure')

    expect(h.executor.steer).not.toHaveBeenCalled()
    expect(h.bus.pending('overseer')).toHaveLength(1)
    expect(h.bus.pending('overseer')[0]?.subject).toBe('fleet failure')
  })

  it('reinjects role-specific Claude app tools after a compacted conversation resumes', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full', vendorSessionId: 'resume-overseer' })
    h.seed({ id: 'manager', isProjectManager: true, projectId: 'project-a' })
    h.seed({ id: 'child', parentSessionId: 'manager', projectId: 'project-a' })

    await h.sessions.send('overseer', 'inspect the fleet')
    h.journal.append('overseer', 'claude/system', { subtype: 'compact_boundary' })
    await h.sessions.send('overseer', 'continue after compaction')
    await h.sessions.send('manager', 'check the team')
    await h.sessions.send('child', 'report status')

    const calls = vi.mocked(h.executor.runTurn).mock.calls
    const overseerSpecs = calls
      .filter(([, prompt]) => prompt === 'inspect the fleet' || prompt === 'continue after compaction')
      .map(([spec]) => spec)
    expect(overseerSpecs).toHaveLength(2)
    for (const spec of overseerSpecs) {
      expect(spec.vendorSessionId).toBe('resume-overseer')
      expect(spec.claudeSystemPrompt).toMatch(/ToolSearch.*allmyagents/u)
      expect(spec.claudeSystemPrompt).toMatch(/mcp__allmyagents__overseer_control/u)
      expect(spec.claudeSystemPrompt).toMatch(/fleet-wide/u)
      expect(spec.claudeSystemPrompt).toMatch(/AskUserQuestion/u)
      expect(spec.claudeSystemPrompt).toMatch(/remote_list_devices.*remote_ping.*remote_inspect_environment.*remote_inspect_git.*remote_prepare_project_location/su)
      expect(spec.claudeSystemPrompt).toMatch(/Never blindly retry an ambiguous write, preparation, or terminal failure/u)
      expect(spec.claudeSystemPrompt).toMatch(/COMPACTION CONTINUITY CONTRACT/u)
      expect(spec.claudeSystemPrompt).toMatch(/active objective.*current project.*current slice/su)
      expect(spec.claudeSystemPrompt).toMatch(/exact next useful action/u)
    }
    const managerPrompt = calls.find(([, prompt]) => prompt === 'check the team')?.[0].claudeSystemPrompt
    const childPrompt = calls.find(([, prompt]) => prompt === 'report status')?.[0].claudeSystemPrompt
    expect(managerPrompt).toMatch(/decide_child_approval/u)
    expect(childPrompt).toMatch(/report a real scope or permission block upstream/u)
    for (const prompt of [managerPrompt, childPrompt]) {
      expect(prompt).toMatch(/remote_list_devices.*remote_ping.*remote_inspect_environment.*remote_inspect_git.*remote_prepare_project_location/su)
      expect(prompt).toMatch(/Report the returned timing, transfer, and failure-stage telemetry upstream/u)
    }
  })

  it('gives Codex live developer instructions with bounded fleet/team topology and provider discipline', async () => {
    const h = harness()
    const projectDir = path.join(h.root, 'project-alpha')
    const unrelatedDir = path.join(h.root, 'project-archive')
    fs.mkdirSync(projectDir)
    fs.mkdirSync(unrelatedDir)
    const project = h.projects.create('Project Alpha', projectDir)
    const unrelated = h.projects.create('Archive', unrelatedDir)
    const old = '2020-01-01T00:00:00.000Z'
    h.seed({ id: 'overseer', provider: 'codex', isOverseer: true, permissionMode: 'full' })
    h.seed({
      id: 'manager', provider: 'codex', title: 'Noether', isProjectManager: true,
      projectId: project.id, managerActiveTeamId: 'team-live',
      managerTeams: [
        { id: 'team-live', name: 'Current', createdAt: old, activatedAt: old },
        { id: 'team-old', name: 'Stashed', createdAt: old, activatedAt: old, stashedAt: old },
      ],
    })
    h.seed({
      id: 'child-active', provider: 'codex', title: 'Bose', status: 'active', projectId: project.id,
      parentSessionId: 'manager', managerTeamId: 'team-live', managerTeamName: 'Current',
    })
    h.seed({
      id: 'mentioned-old', provider: 'claude', title: 'Shannon', status: 'idle', projectId: project.id,
      lastActivity: old, createdAt: old,
    })
    h.seed({
      id: 'unrelated-old', provider: 'claude', title: 'Archived Agent', status: 'idle',
      projectId: unrelated.id, lastActivity: old, createdAt: old,
    })

    await h.sessions.send('manager', 'Coordinate the active team.')
    await h.sessions.send('overseer', 'Check Project Alpha and tell me its exact status.')

    const calls = vi.mocked(h.executor.runTurn).mock.calls
    const managerSpec = calls.find(([, prompt]) => prompt === 'Coordinate the active team.')?.[0]
    const overseerSpec = calls.find(([, prompt]) => prompt === 'Check Project Alpha and tell me its exact status.')?.[0]
    expect(managerSpec?.claudeSystemPrompt).toBeUndefined()
    expect(managerSpec?.codexDeveloperInstructions).toMatch(/Codex-manager discipline/u)
    expect(managerSpec?.codexDeveloperInstructions).toMatch(/remote_list_devices.*remote_prepare_project_location/su)
    expect(managerSpec?.codexDeveloperInstructions).toMatch(/COMPACTION CONTINUITY CONTRACT/u)
    expect(managerSpec?.codexDeveloperInstructions).toMatch(/"activeTeamId":"team-live"/u)
    expect(managerSpec?.codexDeveloperInstructions).toMatch(/"id":"team-old".*"state":"stashed"/u)
    expect(managerSpec?.codexDeveloperInstructions).toMatch(/"id":"child-active","name":"Bose","status":"active"/u)
    expect(overseerSpec?.codexDeveloperInstructions).toMatch(/Direct operator text mentioned: Project Alpha/u)
    expect(overseerSpec?.codexDeveloperInstructions).toContain('mentioned-old')
    expect(overseerSpec?.codexDeveloperInstructions).not.toContain('unrelated-old')
    expect(overseerSpec?.codexDeveloperInstructions).toMatch(/activityWindowDays":7/u)
  })

  it('routes a Codex child approval to its capable manager without duplicating it to the Overseer', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    h.seed({
      id: 'manager', title: 'Manager', isProjectManager: true, managerCanApproveChildren: true,
      managerAllowedTools: ['commandExecution'], projectId: 'project-a', status: 'idle',
    })
    h.seed({ id: 'child', title: 'Worker', parentSessionId: 'manager', projectId: 'project-a', status: 'active' })

    const decision = h.approvals.request('child', 'codex/item/commandExecution/requestApproval', {
      toolName: 'commandExecution', command: 'git status',
    })
    const pending = h.approvals.pending()[0]!

    expect(h.bus.inbox('manager')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: 'child approval pending',
        body: expect.stringMatching(new RegExp(`${pending.id}.*commandExecution: git status`, 'su')),
      }),
    ]))
    expect(h.bus.inbox('overseer')).toHaveLength(0)
    expect(h.journal.recentEventsForSession('child', 20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'manager/child-approval-reported' }),
    ]))
    h.approvals.resolve(pending.id, false)
    await expect(decision).resolves.toBe(false)
  })

  it('persists and reinjects operating modes only from a direct operator turn', async () => {
    const h = harness()
    let config: OverseerConfig = {}
    h.sessions.setOverseerRuntime({
      overseerConfig: () => structuredClone(config),
      configureOverseerMode: (update) => {
        config = applyOverseerModeUpdate(config, update)
        return structuredClone(config)
      },
    })
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full', overseerCapabilityVersion: 6 })

    await expect(h.sessions.overseerControl('overseer', {
      operation: 'get_operating_mode',
    })).resolves.toMatchObject({ ok: true, data: { operatingMode: 'standard' } })
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'set_operating_mode',
      operatingMode: 'eco',
      maxParallelAgents: 1,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/direct operator turn/u) })

    h.markOperator('overseer')
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'set_operating_mode',
      operatingMode: 'tokenmaxxing',
      modeGuidance: 'Prioritize the quota resetting first.',
      ideaPool: ['Audit recovery', 'Review permissions'],
      maxParallelAgents: 8,
      preferredEffort: 'high',
    })).resolves.toMatchObject({
      ok: true,
      data: {
        operatingMode: 'tokenmaxxing',
        policy: { maxParallelAgents: 8, ideaPool: ['Audit recovery', 'Review permissions'] },
      },
    })
    const instructions = fs.readFileSync(path.join(h.root, 'CLAUDE.md'), 'utf8')
    expect(instructions).toContain('OVERSEER OPERATING MODE: TOKENMAXXING (ACTIVE)')
    expect(instructions).toContain('Prioritize the quota resetting first.')
    expect(h.journal.recentEventsForSession('overseer')).toContainEqual(expect.objectContaining({
      kind: 'overseer/operating-mode-changed',
      payload: expect.objectContaining({ operatingMode: 'tokenmaxxing' }),
    }))
  })

  it('routes a child approval outside the manager exact-tool ceiling to the Overseer instead of wedging at the manager', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full', status: 'idle' })
    h.seed({
      id: 'manager', title: 'Manager', isProjectManager: true, managerCanApproveChildren: true,
      managerAllowedTools: ['browser'], projectId: 'project-a', status: 'idle',
    })
    h.seed({ id: 'child', title: 'Worker', parentSessionId: 'manager', projectId: 'project-a', status: 'active' })

    const decision = h.approvals.request('child', 'claude/tool', {
      toolName: 'PowerShell', input: { command: 'Get-Content README.md' },
    })
    const pending = h.approvals.pending()[0]!

    expect(h.bus.inbox('manager')).toHaveLength(0)
    expect(h.bus.inbox('overseer')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: 'approval awaiting operator',
        body: expect.stringMatching(
          new RegExp(`${pending.id}.*PowerShell.*Manager cannot approve this request: PowerShell is outside.*direct operator turn`, 'su'),
        ),
      }),
    ]))
    expect(h.journal.recentEventsForSession('child', 20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'manager/child-approval-outside-ceiling',
        payload: expect.objectContaining({
          managerSessionId: 'manager',
          approvalId: pending.id,
          reason: expect.stringMatching(/PowerShell.*tool ceiling/u),
        }),
      }),
      expect.objectContaining({ kind: 'overseer/approval-reported' }),
    ]))
    h.approvals.resolve(pending.id, false)
    await expect(decision).resolves.toBe(false)
  })

  it('falls back to the Overseer when a manager cannot receive or decide a permission prompt', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full', status: 'idle' })
    h.seed({
      id: 'manager', title: 'Manager', isProjectManager: true, managerCanApproveChildren: false,
      projectId: 'project-a', status: 'idle',
    })
    h.seed({ id: 'child', title: 'Worker', parentSessionId: 'manager', projectId: 'project-a', status: 'active' })

    const decision = h.approvals.request('child', 'claude/tool', {
      toolName: 'Write', input: { file_path: 'C:/work/file.ts' },
    })
    const pending = h.approvals.pending()[0]!

    expect(h.bus.inbox('manager')).toHaveLength(0)
    expect(h.bus.inbox('overseer')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: 'approval awaiting operator',
        body: expect.stringMatching(new RegExp(`${pending.id}.*Write: C:/work/file.ts.*direct operator turn`, 'su')),
      }),
    ]))
    expect(h.journal.recentEventsForSession('child', 20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'overseer/approval-reported' }),
    ]))
    h.approvals.resolve(pending.id, false)
    await expect(decision).resolves.toBe(false)
  })

  it('never steers a pending approval into an active privileged Overseer turn', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full', status: 'active' })
    h.markOperator('overseer')
    h.seed({ id: 'manager', title: 'Manager', isProjectManager: true, status: 'active' })

    const decision = h.approvals.request('manager', 'claude/tool', {
      toolName: 'Bash', input: { command: 'git status' },
    })
    const pending = h.approvals.pending()[0]!

    expect(h.executor.steer).not.toHaveBeenCalled()
    expect(h.bus.pending('overseer')).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'approval awaiting operator' }),
    ]))
    h.approvals.resolve(pending.id, false)
    await expect(decision).resolves.toBe(false)
  })

  it('lets a direct operator configure narrow project or exact-session GitHub automation', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    h.seed({ id: 'manager', isProjectManager: true, permissionMode: 'safe' })
    const projectId = h.projects.create('GitHub Policy Lab', h.root).id

    await expect(h.sessions.overseerControl('overseer', {
      operation: 'configure_github_automation',
      githubScope: 'project',
      projectId,
      githubCapabilities: ['pull_requests', 'workflow_runs'],
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/direct operator turn/u) })

    h.markOperator('overseer')
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'configure_github_automation',
      githubScope: 'project',
      projectId,
      githubCapabilities: ['pull_requests', 'workflow_runs'],
    })).resolves.toMatchObject({
      ok: true,
      data: { scope: 'project', targetId: projectId, capabilities: ['pull_requests', 'workflow_runs'] },
    })
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'configure_github_automation',
      githubScope: 'session',
      sessionId: 'manager',
      githubCapabilities: ['pull_request_merges'],
    })).resolves.toMatchObject({
      ok: true,
      data: { scope: 'session', targetId: 'manager', capabilities: ['pull_request_merges'] },
    })
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'get_github_automation_policy', githubScope: 'session', sessionId: 'manager',
    })).resolves.toMatchObject({
      ok: true,
      data: { capabilities: ['pull_request_merges'] },
    })
    expect(h.journal.recentEventsForSession('manager', 20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'github-automation/policy-configured',
        payload: expect.objectContaining({ actor: 'overseer:overseer' }),
      }),
    ]))
  })

  it('requires configured scope, a separate operator approval, and the elevation runner', async () => {
    const h = harness()
    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    h.markOperator('overseer')
    const project = await h.sessions.overseerControl('overseer', { operation: 'create_project', name: 'Elevated Lab' })
    const projectId = (project.data as { id: string }).id
    await expect(h.sessions.overseerControl('overseer', {
      operation: 'configure_elevation', projectId, elevationScope: 'project',
    })).resolves.toMatchObject({ ok: true, data: { scope: 'project' } })

    const executed: ElevatedCommandResult = {
      ok: true, exitCode: 0, stdout: 'done', stderr: '', timedOut: false, truncated: false,
      durationMs: 10, elevation: 'windows-uac',
    }
    const runner = { execute: vi.fn(async () => executed) }
    h.sessions.setOverseerRuntime({ elevatedRunner: runner })
    const pending = h.sessions.overseerControl('overseer', {
      operation: 'run_elevated_command', projectId, command: 'Get-ChildItem', reason: 'Test an admin-only path.',
      shell: 'powershell', timeoutMs: 5_000,
    })
    await vi.waitFor(() => expect(h.approvals.pending()).toHaveLength(1))
    const approval = h.approvals.pending()[0]!
    expect(approval.kind).toBe('overseer/elevated-command')
    h.approvals.resolve(approval.id, true)
    await expect(pending).resolves.toMatchObject({ ok: true, data: { result: { stdout: 'done' } } })
    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'Get-ChildItem' }))
    expect(h.journal.recentEventsForSession('overseer', 40).map((event) => event.kind)).toContain(
      'overseer/elevated-command-completed',
    )
  })
})
