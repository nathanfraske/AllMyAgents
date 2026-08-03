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
    steer: async () => {},
    interrupt: async () => {},
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => [],
    attach: async () => {},
    isBusy: () => false,
  }
  const sessions = new SessionManager(
    journal,
    new SessionStore(journal.db),
    new Map(profiles.map((profile) => [profile.id, profile])),
    approvals,
    new UsageMonitor(journal, profiles, {}),
    new WorkspaceManager(path.join(root, 'worktrees')),
    new ProjectStore(journal.db),
    new InstructionStore(journal.db),
    new AgentBus(journal.db),
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
  return { root, journal, approvals, sessions, seed, markOperator, markBus }
}

describe('application Overseer authority', () => {
  it('requires both the hub-minted role and a direct operator turn', async () => {
    const h = harness()
    h.seed({ id: 'ordinary' })
    h.markOperator('ordinary')
    await expect(h.sessions.overseerControl('ordinary', { operation: 'status' })).resolves.toMatchObject({ ok: false })

    h.seed({ id: 'overseer', isOverseer: true, permissionMode: 'full' })
    await expect(h.sessions.overseerControl('overseer', { operation: 'status' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/direct operator turn/u),
    })
    h.markOperator('overseer')
    h.markBus('overseer')
    await expect(h.sessions.overseerControl('overseer', { operation: 'status' })).resolves.toMatchObject({ ok: false })
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
})
