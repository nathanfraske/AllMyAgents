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
  const hubRoot = path.join(tmp, 'installed-hub')
  const dataDir = path.join(tmp, 'app-data')
  const repo = path.join(tmp, 'repo')
  const profileDir = path.join(tmp, 'profile')
  fs.mkdirSync(hubRoot)
  fs.mkdirSync(dataDir)
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
    new WorkspaceManager(path.join(dataDir, 'worktrees')),
    projects,
    new InstructionStore(journal.db),
    new AgentBus(journal.db),
    new MemoryStore(journal.db),
    new PracticeStore(journal.db),
    { busCanUseRiskyTools: false, autoApprovePractices: false },
    false,
    hubRoot,
    executor
  )
  const projectId = projects.create('fixture', repo).id
  cleanups.push(() => {
    journal.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  return { hubRoot, dataDir, repo, sessions, projects, projectId }
}

async function createWorktreeSession() {
  const hub = buildHub()
  const record = await hub.sessions.create('claude-test', { projectId: hub.projectId })
  if (!record.worktree) throw new Error('fixture did not create a worktree')
  return { ...hub, record, worktree: record.worktree }
}

describe('unfiled chat workspace lifecycle', () => {
  it('recognizes Git canonicalizing a filesystem alias before removing a pristine workspace', () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ama-workspace-alias-')))
    const realData = path.join(tmp, 'real-data')
    const aliasedData = path.join(tmp, 'aliased-data')
    fs.mkdirSync(realData)
    fs.symlinkSync(realData, aliasedData, process.platform === 'win32' ? 'junction' : 'dir')
    const workspace = new WorkspaceManager(
      path.join(aliasedData, 'worktrees'),
      path.join(aliasedData, 'workspaces')
    )
    const sessionId = 'canonical-path-fixture'
    const cwd = workspace.createScratch(sessionId)
    workspace.checkpointScratch(sessionId)
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }))

    expect(fs.realpathSync.native(cwd)).not.toBe(path.resolve(cwd))
    expect(workspace.removeScratch(sessionId)).toEqual({ ok: true })
    expect(fs.existsSync(cwd)).toBe(false)
  })

  it('gives an unfiled chat its own workspace instead of the hub directory', async () => {
    const { hubRoot, dataDir, sessions } = buildHub()

    const record = await sessions.create('claude-test', {})

    expect(record.cwd).not.toBe(hubRoot)
    expect(path.dirname(record.cwd)).toBe(path.join(dataDir, 'workspaces'))
    expect(path.basename(record.cwd)).toBe(record.id)
    expect(fs.statSync(record.cwd).isDirectory()).toBe(true)
    expect(git(record.cwd, 'status', '--porcelain')).toBe('')
  })

  it('deletes a pristine unfiled workspace with its chat', async () => {
    const { sessions } = buildHub()
    const record = await sessions.create('claude-test', {})

    const result = await sessions.delete(record.id)

    expect(result).toEqual({ ok: true })
    expect(fs.existsSync(record.cwd)).toBe(false)
    expect(sessions.list().some((candidate) => candidate.id === record.id)).toBe(false)
  })

  it('refuses to delete an unfiled workspace with uncommitted work and reports its path', async () => {
    const { sessions } = buildHub()
    const record = await sessions.create('claude-test', {})
    fs.writeFileSync(path.join(record.cwd, 'recover-me.txt'), 'operator work\n')

    const result = await sessions.delete(record.id)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('dirty workspace deletion unexpectedly succeeded')
    expect(result.error).toContain('uncommitted')
    expect(result.error).toContain(record.cwd)
    expect(fs.readFileSync(path.join(record.cwd, 'recover-me.txt'), 'utf8')).toBe('operator work\n')
    expect(sessions.list().find((candidate) => candidate.id === record.id)?.status).toBe('stopped')
  })

  it('preserves committed work instead of deleting the only copy with the chat', async () => {
    const { sessions } = buildHub()
    const record = await sessions.create('claude-test', {})
    fs.writeFileSync(path.join(record.cwd, 'committed-work.txt'), 'keep me\n')
    git(record.cwd, 'add', 'committed-work.txt')
    git(
      record.cwd,
      '-c',
      'user.name=AllMyAgents Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'operator work'
    )

    const result = await sessions.delete(record.id)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('committed workspace deletion unexpectedly succeeded')
    expect(result.error).toContain('committed work')
    expect(result.error).toContain(record.cwd)
    expect(fs.readFileSync(path.join(record.cwd, 'committed-work.txt'), 'utf8')).toBe('keep me\n')
  })
})

describe('worktree session lifecycle', () => {
  it('records requested isolation separately from the created checkout', async () => {
    const { record, worktree } = await createWorktreeSession()

    expect(record.worktreeRequested).toBe(true)
    expect(record.worktree).toBe(worktree)
    expect(record.worktreeFallbackReason).toBeUndefined()
    expect(git(worktree, 'branch', '--show-current')).toBe(record.branch)
  })

  it('records an explicit Project choice without claiming a worktree failure', async () => {
    const hub = buildHub()
    const record = await hub.sessions.create('claude-test', {
      projectId: hub.projectId,
      useWorktree: false,
    })

    expect(record.worktreeRequested).toBe(false)
    expect(record.worktree).toBeUndefined()
    expect(record.cwd).toBe(hub.repo)
    expect(record.worktreeFallbackReason).toBeUndefined()
  })

  it('records why an explicit cwd overrode a requested project worktree', async () => {
    const hub = buildHub()
    const record = await hub.sessions.create('claude-test', {
      projectId: hub.projectId,
      cwd: hub.repo,
      useWorktree: true,
    })

    expect(record.worktreeRequested).toBe(true)
    expect(record.worktree).toBeUndefined()
    expect(record.cwd).toBe(hub.repo)
    expect(record.worktreeFallbackReason).toContain('explicit working directory')
    expect(record.worktreeFallbackReason).toContain(hub.repo)
  })

  it('records why a non-Git project could not satisfy requested isolation', async () => {
    const hub = buildHub()
    const plain = path.join(path.dirname(hub.repo), 'plain-folder')
    fs.mkdirSync(plain)
    const projectId = hub.projects.create('plain', plain).id
    const record = await hub.sessions.create('claude-test', {
      projectId,
      useWorktree: true,
    })

    expect(record.worktreeRequested).toBe(true)
    expect(record.worktree).toBeUndefined()
    expect(record.cwd).toBe(plain)
    expect(record.worktreeFallbackReason).toContain('not a Git repository')
    expect(record.worktreeFallbackReason).toContain(plain)
  })

  it('Stop preserves tracked and untracked work, and Reopen resumes the same checkout', async () => {
    const { sessions, record, worktree } = await createWorktreeSession()
    fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'operator work\n')
    fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'new work\n')

    await sessions.stop(record.id)

    const stopped = sessions.list().find((r) => r.id === record.id)
    expect(stopped?.status).toBe('stopped')
    expect(stopped?.worktree).toBe(worktree)
    expect(stopped?.branch).toBe(record.branch)
    expect(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8')).toBe('operator work\n')
    expect(fs.readFileSync(path.join(worktree, 'untracked.txt'), 'utf8')).toBe('new work\n')
    expect(sessions.reopen(record.id)).toEqual({ ok: true, status: 'idle' })
    const reopened = sessions.list().find((r) => r.id === record.id)
    expect(reopened?.cwd).toBe(worktree)
    expect(reopened?.worktree).toBe(worktree)
    expect(reopened?.branch).toBe(record.branch)
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
