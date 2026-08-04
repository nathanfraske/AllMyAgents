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
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import type { Profile, SessionRecord } from './types.js'
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
  fs.mkdirSync(profileDir)
  const journal = new Journal(path.join(root, 'hub.db'))
  const approvals = new ApprovalService(journal)
  const profiles: Profile[] = [{ id: 'p1', provider: 'claude', dir: profileDir }]
  const executor: Executor = {
    startThread: async () => 'unused',
    runTurn: async () => {},
    steer: vi.fn(async () => {}),
    interrupt: async () => {},
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => [],
    attach: async () => {},
    isBusy: () => false,
  }
  const bus = new AgentBus(journal.db)
  const sessions = new SessionManager(
    journal,
    new SessionStore(journal.db),
    new Map(profiles.map((profile) => [profile.id, profile])),
    approvals,
    new UsageMonitor(journal, profiles, {}),
    new WorkspaceManager(path.join(root, 'worktrees')),
    new ProjectStore(journal.db),
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
  return { root, journal, approvals, sessions, executor, bus, seed, markOperator, markBus }
}

describe('application Overseer authority', () => {
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

    const restart = vi.fn()
    h.sessions.setRestartSignal(restart)
    await expect(h.sessions.overseerControl('overseer', { operation: 'restart_hub' })).resolves.toMatchObject({ ok: true })
    expect(restart).toHaveBeenCalledWith('overseer', 'overseer')
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
