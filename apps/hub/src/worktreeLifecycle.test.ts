import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentBus } from './bus.js'
import type { Executor } from './executor.js'
import { InstructionStore } from './instructions.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { ProjectStore } from './projects.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import type { Profile } from './types.js'
import { ApprovalService } from './approvals.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'

const cleanups: Array<() => void> = []

afterEach(async () => {
  // create()/reopen() schedule an idle→deliverBus check with setImmediate; let it drain while the
  // fixture database is still open so cleanup cannot manufacture an unrelated async error.
  await new Promise<void>((resolve) => setImmediate(resolve))
  while (cleanups.length) cleanups.pop()?.()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
}

function buildHub() {
  // macOS exposes os.tmpdir() through /var while git worktree list reports /private/var.
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ama-worktree-life-')))
  const repo = path.join(tmp, 'repo')
  const profileDir = path.join(tmp, 'profile')
  fs.mkdirSync(repo)
  fs.mkdirSync(profileDir)
  git(repo, 'init')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed\n')
  git(repo, 'add', 'tracked.txt')
  git(repo, '-c', 'user.name=AllMyAgents Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial')

  const journal = new Journal(path.join(tmp, 'hub.db'))
  const store = new SessionStore(journal.db)
  const projects = new ProjectStore(journal.db)
  const approvals = new ApprovalService(journal)
  const profiles: Profile[] = [{ id: 'claude-test', provider: 'claude', dir: profileDir }]
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
    store,
    new Map(profiles.map((p) => [p.id, p])),
    approvals,
    new UsageMonitor(journal, profiles, {}),
    new WorkspaceManager(path.join(tmp, 'worktrees')),
    projects,
    new InstructionStore(journal.db),
    new AgentBus(journal.db),
    new MemoryStore(journal.db),
    new PracticeStore(journal.db),
    { busCanUseRiskyTools: false, autoApprovePractices: false },
    false,
    tmp,
    executor
  )
  const projectId = projects.create('fixture', repo).id
  cleanups.push(() => {
    journal.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  return { repo, sessions, projectId }
}

async function createWorktreeSession() {
  const hub = buildHub()
  const record = await hub.sessions.create('claude-test', { projectId: hub.projectId })
  if (!record.worktree) throw new Error('fixture did not create a worktree')
  return { ...hub, record, worktree: record.worktree }
}

describe('worktree session lifecycle', () => {
  it('Stop preserves tracked and untracked work, and Reopen resumes the same checkout', async () => {
    const { sessions, record, worktree } = await createWorktreeSession()
    fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'operator work\n')
    fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'new work\n')

    await sessions.stop(record.id)

    expect(sessions.list().find((r) => r.id === record.id)?.status).toBe('stopped')
    expect(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8')).toBe('operator work\n')
    expect(fs.readFileSync(path.join(worktree, 'untracked.txt'), 'utf8')).toBe('new work\n')
    expect(sessions.reopen(record.id)).toEqual({ ok: true, status: 'idle' })
    expect(sessions.list().find((r) => r.id === record.id)?.cwd).toBe(worktree)
  })

  it('Reopen refuses a legacy stopped session whose recorded worktree is gone', async () => {
    const { repo, sessions, record, worktree } = await createWorktreeSession()
    await sessions.stop(record.id)
    if (fs.existsSync(worktree)) git(repo, 'worktree', 'remove', '--force', worktree)

    const result = sessions.reopen(record.id)

    expect(result.ok).toBe(false)
    expect(result.status).toBe('stopped')
    expect(result.error).toContain(worktree)
    expect(sessions.list().find((r) => r.id === record.id)?.status).toBe('stopped')
  })

  it('Delete refuses to discard a dirty worktree and tells the operator where it remains', async () => {
    const { sessions, record, worktree } = await createWorktreeSession()
    fs.writeFileSync(path.join(worktree, 'uncommitted.txt'), 'recover me\n')

    const result = await sessions.delete(record.id)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('dirty worktree deletion unexpectedly succeeded')
    expect(result.error).toContain('uncommitted')
    expect(result.error).toContain(worktree)
    expect(fs.readFileSync(path.join(worktree, 'uncommitted.txt'), 'utf8')).toBe('recover me\n')
    expect(sessions.list().find((r) => r.id === record.id)?.status).toBe('stopped')
  })

  it('Stop preserves worktree attachments and Delete treats them as recoverable uncommitted data', async () => {
    const { sessions, record, worktree } = await createWorktreeSession()
    const attachment = await sessions.storeAttachment(
      record.id,
      'evidence.png',
      'image/png',
      Buffer.from('recoverable attachment')
    )

    await sessions.stop(record.id)
    expect(fs.readFileSync(attachment.path, 'utf8')).toBe('recoverable attachment')

    const deleted = await sessions.delete(record.id)
    expect(deleted.ok).toBe(false)
    if (deleted.ok) throw new Error('attachment-bearing worktree deletion unexpectedly succeeded')
    expect(deleted.error).toContain('uncommitted')
    expect(fs.readFileSync(attachment.path, 'utf8')).toBe('recoverable attachment')
    expect(fs.existsSync(worktree)).toBe(true)
  })
})
