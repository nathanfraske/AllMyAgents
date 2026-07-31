import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalService } from './approvals.js'
import { AgentBus } from './bus.js'
import type { Executor } from './executor.js'
import { InstructionStore } from './instructions.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { ProjectStore } from './projects.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import type { Profile, SessionRecord } from './types.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { QuestionService } from './questions.js'

const roots: string[] = []
const openJournals: Journal[] = []
afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  while (openJournals.length) {
    const journal = openJournals.pop()!
    if (journal.db.open) journal.db.close()
  }
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-manager-durability-'))
  roots.push(value)
  return value
}

function records(): SessionRecord[] {
  const createdAt = new Date().toISOString()
  const common = { profileId: 'p1', provider: 'claude' as const, cwd: 'C:/repo', status: 'idle' as const, createdAt }
  return [
    {
      ...common,
      id: 'manager',
      isProjectManager: true,
      managerMaxLiveChildren: 2,
      managerDelegation: ['commit'],
      managerAllowedProfiles: ['p1'],
    },
    { ...common, id: 'child-a', parentSessionId: 'manager', delegatedAuthorities: ['commit'] },
    { ...common, id: 'child-b', parentSessionId: 'manager', delegatedAuthorities: ['commit'] },
  ]
}

async function crashNarrowingAfter(write: number): Promise<{ records: SessionRecord[]; events: string[] }> {
  const dir = root()
  const dbFile = path.join(dir, 'hub.db')
  const seedJournal = new Journal(dbFile)
  const seedStore = new SessionStore(seedJournal.db)
  for (const record of records()) seedStore.upsert(record)
  seedJournal.db.close()

  const harness = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'test-fixtures',
    'managerCrashHarness.ts'
  )
  const child = fork(harness, [dbFile, String(write)], {
    cwd: path.resolve(path.dirname(harness), '..'),
    execArgv: ['--import', 'tsx/esm'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`crash harness did not reach write ${write}`))
    }, 30_000)
    child.once('error', reject)
    child.on('message', (message) => {
      if ((message as { type?: string }).type !== 'persistence-boundary') return
      clearTimeout(timer)
      resolve()
    })
  })
  child.kill('SIGKILL')
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))

  const reopened = new Journal(dbFile)
  const persisted = new SessionStore(reopened.db).all()
  const events = [...reopened.replay(0)]
    .filter((event) => event.kind.startsWith('manager/'))
    .map((event) => event.kind)
  reopened.db.close()
  return { records: persisted, events }
}

function buildHub() {
  const dir = root()
  const profileDir = path.join(dir, 'profile')
  fs.mkdirSync(profileDir)
  const journal = new Journal(path.join(dir, 'hub.db'))
  openJournals.push(journal)
  const store = new SessionStore(journal.db)
  const profiles: Profile[] = [{ id: 'p1', provider: 'codex', dir: profileDir }]
  const executor: Executor = {
    startThread: async () => 'thread',
    runTurn: async () => {},
    steer: async () => {},
    interrupt: async () => {},
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => [],
    attach: async () => {},
    isBusy: () => false,
  }
  const projects = new ProjectStore(journal.db)
  const sessions = new SessionManager(
    journal,
    store,
    new Map(profiles.map((profile) => [profile.id, profile])),
    new ApprovalService(journal),
    new UsageMonitor(journal, profiles, {}),
    new WorkspaceManager(path.join(dir, 'worktrees')),
    projects,
    new InstructionStore(journal.db),
    new AgentBus(journal.db),
    new MemoryStore(journal.db),
    new PracticeStore(journal.db),
    { busCanUseRiskyTools: false, autoApprovePractices: false },
    false,
    dir,
    new QuestionService(journal),
    executor
  )
  const seed = (record: Partial<SessionRecord> & Pick<SessionRecord, 'id'>): SessionRecord => {
    const full: SessionRecord = {
      profileId: 'p1',
      provider: 'codex',
      cwd: dir,
      status: 'idle',
      createdAt: new Date().toISOString(),
      ...record,
    }
    ;(sessions as unknown as { sessions: Map<string, SessionRecord> }).sessions.set(full.id, full)
    store.upsert(full)
    return full
  }
  return { dir, journal, projects, sessions, seed }
}

describe('project-manager durability and honest isolation', () => {
  it.each([1, 2, 3])(
    'a real crash after persistence write %i leaves either the old complete grant or the new complete revocation, never a partial unaudited state',
    async (write) => {
      const state = await crashNarrowingAfter(write)
      const byId = new Map(state.records.map((record) => [record.id, record]))
      const oldState =
        byId.get('manager')?.managerDelegation?.includes('commit') === true &&
        byId.get('child-a')?.delegatedAuthorities?.includes('commit') === true &&
        byId.get('child-b')?.delegatedAuthorities?.includes('commit') === true &&
        state.events.length === 0
      const newState =
        !byId.get('manager')?.managerDelegation?.includes('commit') &&
        !byId.get('child-a')?.delegatedAuthorities?.includes('commit') &&
        !byId.get('child-b')?.delegatedAuthorities?.includes('commit') &&
        state.events.filter((kind) => kind === 'manager/delegation-revoked').length === 2 &&
        state.events.includes('manager/granted')
      expect(oldState || newState).toBe(true)
    },
    30_000
  )

  it('commits the narrowed manager, every child revocation, and all audit rows together on success', () => {
    const { journal, sessions, seed } = buildHub()
    seed({
      id: 'manager',
      isProjectManager: true,
      managerMaxLiveChildren: 2,
      managerDelegation: ['commit'],
      managerAllowedProfiles: ['p1'],
    })
    seed({ id: 'child-a', parentSessionId: 'manager', delegatedAuthorities: ['commit'] })
    seed({ id: 'child-b', parentSessionId: 'manager', delegatedAuthorities: ['commit'] })

    sessions.configureProjectManager(
      'manager',
      { enabled: true, maxLiveChildren: 2, delegation: [], allowedProfiles: ['p1'] },
      'operator'
    )

    const byId = new Map(new SessionStore(journal.db).all().map((record) => [record.id, record]))
    expect(byId.get('manager')?.managerDelegation).toBeUndefined()
    expect(byId.get('child-a')?.delegatedAuthorities).toBeUndefined()
    expect(byId.get('child-b')?.delegatedAuthorities).toBeUndefined()
    const events = [...journal.replay(0)].filter((event) => event.kind.startsWith('manager/'))
    expect(events.filter((event) => event.kind === 'manager/delegation-revoked')).toHaveLength(2)
    expect(events.filter((event) => event.kind === 'manager/granted')).toHaveLength(1)
  })

  it('tells the manager in the spawn response when requested worktree isolation was not created', async () => {
    const { dir, projects, sessions, seed } = buildHub()
    const plain = path.join(dir, 'plain-project')
    fs.mkdirSync(plain)
    const project = projects.create('plain', plain)
    const manager = seed({
      id: 'manager',
      cwd: plain,
      projectId: project.id,
      isProjectManager: true,
      managerMaxLiveChildren: 2,
      managerAllowedProfiles: ['p1'],
    })

    const response = await sessions.execAgentTool('p1', manager.cwd, 'spawn_agent', {
      profile_id: 'p1',
      prompt: 'work on the plain project',
      use_worktree: true,
    })

    expect(String(response)).toMatch(/spawned child/i)
    expect(String(response)).toMatch(/without requested worktree isolation/i)
    expect(String(response)).toMatch(/not a git repository/i)
    expect(String(response)).toContain(plain)
  })

})
