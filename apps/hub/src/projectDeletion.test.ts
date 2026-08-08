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
import { inspectProjectDeletion } from './projectDeletion.js'
import { ProjectStore } from './projects.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import type { Profile, Project, SessionRecord } from './types.js'
import { ApprovalService } from './approvals.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { QuestionService } from './questions.js'

const cleanups: Array<() => void> = []

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  while (cleanups.length) cleanups.pop()?.()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

function commit(cwd: string, message: string): void {
  git(cwd, 'add', '--all')
  git(
    cwd,
    '-c',
    'user.name=AllMyAgents Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    message,
  )
}

function buildHub() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ama-project-delete-hub-')))
  const repo = path.join(root, 'project')
  const data = path.join(root, 'data')
  const profileDir = path.join(root, 'profile')
  fs.mkdirSync(repo)
  fs.mkdirSync(data)
  fs.mkdirSync(profileDir)
  git(repo, 'init')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n')
  commit(repo, 'baseline')

  const journal = new Journal(path.join(root, 'hub.db'))
  const projects = new ProjectStore(journal.db)
  const project = projects.create('Deletion fixture', repo)
  const profiles: Profile[] = [{ id: 'codex-a', provider: 'codex', dir: profileDir }]
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
    new ApprovalService(journal),
    new UsageMonitor(journal, profiles, {}),
    new WorkspaceManager(path.join(data, 'worktrees')),
    projects,
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
  cleanups.push(() => {
    journal.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, repo, project, projects, sessions }
}

describe('project deletion preflight', () => {
  it('reports the actual local-only files, commits, and live worktree paths', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ama-project-delete-')))
    const repo = path.join(root, 'project')
    const worktree = path.join(root, 'worktree')
    fs.mkdirSync(repo)
    git(repo, 'init')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n')
    commit(repo, 'baseline')
    const baseCommit = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'worktree', 'add', '-b', 'agent/worker', worktree)

    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed in project\n')
    const committedPath = path.join(worktree, 'agent-result.txt')
    fs.writeFileSync(committedPath, 'committed locally\n')
    commit(worktree, 'agent result')
    const untrackedPath = path.join(worktree, 'local-only.txt')
    fs.writeFileSync(untrackedPath, 'not committed\n')

    const project: Project = {
      id: 'project-1',
      name: 'Deletion fixture',
      path: repo,
      createdAt: new Date().toISOString(),
    }
    const session: SessionRecord = {
      id: 'session-1',
      profileId: 'codex-a',
      provider: 'codex',
      projectId: project.id,
      cwd: worktree,
      repo,
      worktree,
      branch: 'agent/worker',
      baseCommit,
      status: 'idle',
      title: 'Worker',
      createdAt: new Date().toISOString(),
    }

    const result = await inspectProjectDeletion(project, [session])

    expect(result.projectPath).toBe(repo)
    expect(result.changes).toEqual(expect.arrayContaining([
      {
        kind: 'uncommitted',
        path: path.join(repo, 'tracked.txt'),
        checkoutPath: repo,
      },
      {
        kind: 'untracked',
        path: untrackedPath,
        checkoutPath: worktree,
        sessionId: session.id,
      },
    ]))
    expect(result.localCommits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: 'agent result',
        checkoutPath: worktree,
        sessionId: session.id,
      }),
    ]))
    expect(result.worktrees).toEqual([
      {
        sessionId: session.id,
        title: 'Worker',
        path: worktree,
        branch: 'agent/worker',
        status: 'idle',
      },
    ])
    expect(result.inspectionErrors).toEqual([])
    expect(result.changeCount).toBe(2)
    expect(result.changesTruncated).toBe(false)

    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  }, 20_000)

  it('removes only the project association by default and preserves dirty work', async () => {
    const hub = buildHub()
    const record = await hub.sessions.create('codex-a', { projectId: hub.project.id })
    if (!record.worktree) throw new Error('fixture did not create a worktree')
    const localFile = path.join(record.worktree, 'recover-me.txt')
    fs.writeFileSync(localFile, 'operator work\n')

    const result = await hub.sessions.deleteProject(hub.project.id)

    expect(result).toEqual({
      ok: true,
      detachedSessionIds: [record.id],
      deletedSessionIds: [],
    })
    expect(hub.projects.get(hub.project.id)).toBeUndefined()
    expect(hub.sessions.list().find((candidate) => candidate.id === record.id)?.projectId).toBeUndefined()
    expect(fs.readFileSync(localFile, 'utf8')).toBe('operator work\n')
    expect(fs.existsSync(hub.repo)).toBe(true)
  })

  it('removes an explicitly confirmed project directory and its records', async () => {
    const hub = buildHub()
    fs.writeFileSync(path.join(hub.repo, 'CLAUDE.md'), 'operator-confirmed disposable project\n')

    const result = await hub.sessions.deleteProject(hub.project.id, { deleteFiles: true })

    expect(result).toEqual({
      ok: true,
      detachedSessionIds: [],
      deletedSessionIds: [],
    })
    expect(hub.projects.get(hub.project.id)).toBeUndefined()
    expect(fs.existsSync(hub.repo)).toBe(false)
  })

  it('lists files in a plain project even when a parent directory is a Git repository', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ama-project-delete-plain-')))
    git(root, 'init')
    const projectRoot = path.join(root, 'plain-project')
    const nested = path.join(projectRoot, 'src')
    fs.mkdirSync(nested, { recursive: true })
    const localFile = path.join(nested, 'only-copy.txt')
    fs.writeFileSync(localFile, 'local work\n')
    const project: Project = {
      id: 'plain-project',
      name: 'Plain folder',
      path: projectRoot,
      createdAt: new Date().toISOString(),
    }

    const result = await inspectProjectDeletion(project, [])

    expect(result.changes).toEqual([
      {
        kind: 'untracked',
        path: localFile,
        checkoutPath: projectRoot,
      },
    ])
    expect(result.inspectionErrors).toEqual([])
    expect(result.changeCount).toBe(1)
    expect(result.changesTruncated).toBe(false)
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  })

  it('keeps a large plain-directory inspection responsive and bounds the renderer payload', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ama-project-delete-large-')))
    const projectRoot = path.join(root, 'plain-project')
    fs.mkdirSync(projectRoot)
    for (let index = 0; index < 525; index += 1) {
      fs.writeFileSync(path.join(projectRoot, `artifact-${String(index).padStart(4, '0')}.bin`), 'x')
    }
    const project: Project = {
      id: 'large-project',
      name: 'Large plain folder',
      path: projectRoot,
      createdAt: new Date().toISOString(),
    }
    let eventLoopAdvanced = false
    const inspecting = inspectProjectDeletion(project, [])
    setImmediate(() => { eventLoopAdvanced = true })

    const result = await inspecting

    expect(eventLoopAdvanced).toBe(true)
    expect(result.changeCount).toBe(525)
    expect(result.changes).toHaveLength(500)
    expect(result.changesTruncated).toBe(true)
    expect(result.inspectionErrors).toEqual([])
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  })
})
