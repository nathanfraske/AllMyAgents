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
  const profiles: Profile[] = [{ id: 'p1', provider: 'claude', dir: profileDir }]
  const steer = vi.fn(async () => {})
  const executor: Executor = {
    startThread: async () => 'unused',
    runTurn: async () => {},
    steer,
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
    bus,
    new MemoryStore(journal.db),
    new PracticeStore(journal.db),
    { busCanUseRiskyTools: false, autoApprovePractices: false },
    false,
    root,
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
  return { sessions, journal, approvals, seed, repo, steer }
}

function transition(sessions: SessionManager, id: string, status: SessionStatus): void {
  ;(sessions as unknown as { setStatusById(id: string, status: SessionStatus): void }).setStatusById(id, status)
}

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
    expect(result.summary).toContain('2 running, 1 idle, 1 stopped, 1 errored')
    expect(result.summary).toContain('(starting): starting')
    expect(result.summary).toContain('(active): active')
    expect(result.summary).not.toContain('grandchild')
    expect(result.summary).not.toContain('unrelated')
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
