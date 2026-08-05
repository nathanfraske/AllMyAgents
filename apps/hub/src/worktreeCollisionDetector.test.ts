import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorktreeCollisionDetector,
  worktreeRepoKey,
} from './worktreeCollisionDetector.js'
import type { SessionRecord } from './types.js'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

function fixture(): {
  root: string
  repo: string
  knuth: SessionRecord
  hopper: SessionRecord
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-collision-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  const worktrees = path.join(root, 'worktrees')
  fs.mkdirSync(repo)
  fs.mkdirSync(worktrees)
  git(repo, 'init')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n')
  fs.writeFileSync(path.join(repo, 'shared.ts'), 'export const value = 1\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'base')
  const baseCommit = git(repo, 'rev-parse', 'HEAD')
  const baseRef = git(repo, 'symbolic-ref', 'HEAD')

  const knuthWorktree = path.join(worktrees, 'knuth')
  const hopperWorktree = path.join(worktrees, 'hopper')
  git(repo, 'worktree', 'add', '-b', 'agent/knuth', knuthWorktree)
  git(repo, 'worktree', 'add', '-b', 'agent/hopper', hopperWorktree)

  const record = (
    id: string,
    title: string,
    worktree: string,
    branch: string
  ): SessionRecord => ({
    id,
    title,
    titleSource: 'generated',
    profileId: `profile-${id}`,
    provider: 'claude',
    cwd: worktree,
    repo,
    worktree,
    branch,
    projectId: 'project-1',
    baseCommit,
    baseRef,
    status: 'active',
    createdAt: new Date().toISOString(),
  })

  return {
    root,
    repo,
    knuth: record('knuth', 'Knuth', knuthWorktree, 'agent/knuth'),
    hopper: record('hopper', 'Hopper', hopperWorktree, 'agent/hopper'),
  }
}

describe('WorktreeCollisionDetector', () => {
  it('does not spawn or log a failing Git inspection every poll for a vanished worktree', async () => {
    const { knuth } = fixture()
    fs.rmSync(knuth.worktree!, { recursive: true, force: true })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const detector = new WorktreeCollisionDetector({
      sessions: () => [knuth],
      steer: async () => true,
    })

    await detector.poll()
    await detector.poll()
    await detector.poll()

    expect(warning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/checkout is absent/i))
    expect(detector.projectActivity('project-1').agents).toEqual([])
    warning.mockRestore()
  })

  it('never groups identical Linux path tails from different distros', () => {
    const { knuth } = fixture()
    const ubuntu: SessionRecord = {
      ...knuth,
      repo: '\\\\wsl.localhost\\Ubuntu\\home\\me\\api',
      wslDistro: 'Ubuntu',
      executionRepo: '/home/me/api',
    }
    const debian: SessionRecord = {
      ...knuth,
      id: 'debian-agent',
      repo: '\\\\wsl.localhost\\Debian\\home\\me\\api',
      wslDistro: 'Debian',
      executionRepo: '/home/me/api',
    }

    expect(worktreeRepoKey(ubuntu)).not.toBe(worktreeRepoKey(debian))
  })

  it('exposes its existing inspection as a project activity snapshot without a second git scan', async () => {
    const { knuth, hopper } = fixture()
    knuth.parentSessionId = 'manager-1'
    knuth.managerTeamId = 'team-1'
    knuth.managerTeamName = 'Builders'
    const detector = new WorktreeCollisionDetector({
      sessions: () => [knuth, hopper],
      steer: async () => true,
    })

    fs.writeFileSync(path.join(knuth.worktree!, 'knuth-only.ts'), 'export const knuth = true\n')
    fs.writeFileSync(path.join(knuth.worktree!, 'committed.ts'), 'export const committed = true\n')
    git(knuth.worktree!, 'add', 'committed.ts')
    git(knuth.worktree!, 'commit', '-m', 'attribute this commit')
    fs.writeFileSync(path.join(knuth.worktree!, 'shared.ts'), 'export const value = 2\n')
    fs.writeFileSync(path.join(hopper.worktree!, 'shared.ts'), 'export const value = 3\n')

    await detector.poll()

    expect(detector.projectActivity('project-1')).toEqual(
      expect.objectContaining({
        projectId: 'project-1',
        agents: expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'hopper',
            files: [{ file: 'shared.ts', kind: 'uncommitted' }],
          }),
          expect.objectContaining({
            agentId: 'knuth',
            sessionId: 'knuth',
            managerSessionId: 'manager-1',
            teamId: 'team-1',
            teamName: 'Builders',
            commits: [expect.objectContaining({ subject: 'attribute this commit' })],
            files: expect.arrayContaining([
              { file: 'committed.ts', kind: 'committed' },
              { file: 'knuth-only.ts', kind: 'uncommitted' },
              { file: 'shared.ts', kind: 'uncommitted' },
            ]),
          }),
        ]),
        risks: [
          expect.objectContaining({
            risk: 'concurrent-write',
            file: 'shared.ts',
            sessionIds: ['hopper', 'knuth'],
          }),
        ],
      })
    )
  }, 20_000)

  it('keeps a stashed team worktree attributable without treating it as an active collision writer', async () => {
    const { knuth, hopper } = fixture()
    hopper.status = 'stopped'
    hopper.parentSessionId = 'manager-1'
    hopper.managerTeamId = 'team-stashed'
    hopper.managerTeamName = 'Reviewers'
    const steer = vi.fn(async () => true)
    const detector = new WorktreeCollisionDetector({ sessions: () => [knuth, hopper], steer })
    fs.writeFileSync(path.join(knuth.worktree!, 'shared.ts'), 'export const value = 2\n')
    fs.writeFileSync(path.join(hopper.worktree!, 'shared.ts'), 'export const value = 3\n')

    await detector.poll()

    expect(detector.projectActivity('project-1').agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'hopper',
          sessionId: 'hopper',
          managerSessionId: 'manager-1',
          teamId: 'team-stashed',
          teamName: 'Reviewers',
          files: [{ file: 'shared.ts', kind: 'uncommitted' }],
        }),
      ]),
    )
    expect(detector.projectActivity('project-1').risks).toEqual([])
    expect(steer).not.toHaveBeenCalled()

    // A stashed team keeps its last trustworthy attribution without re-running Git on every 2s poll.
    // Removing the disposable fixture checkout proves this second snapshot came from the bounded cache.
    fs.rmSync(hopper.worktree!, { recursive: true, force: true })
    await detector.poll()
    expect(detector.projectActivity('project-1').agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'hopper', teamId: 'team-stashed' }),
      ]),
    )
  }, 20_000)

  it('groups pair-wise dashboard collisions by file and ranks the most severe contention first', async () => {
    const { root, repo, knuth, hopper } = fixture()
    const makeAgent = (id: string, title: string): SessionRecord => {
      const worktree = path.join(root, 'worktrees', id)
      git(repo, 'worktree', 'add', '-b', `agent/${id}`, worktree)
      return {
        ...knuth,
        id,
        title,
        profileId: `profile-${id}`,
        cwd: worktree,
        worktree,
        branch: `agent/${id}`,
      }
    }
    const cori = makeAgent('cori', 'Cori')
    const simon = makeAgent('simon', 'Simon')
    const agents = [knuth, hopper, cori, simon]
    const write = (agent: SessionRecord, file: string): void => {
      const target = path.join(agent.worktree!, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, `// ${agent.id}\n`)
    }

    for (const agent of agents) write(agent, 'apps/hub/src/server.ts')
    for (const agent of [knuth, hopper, cori]) write(agent, 'apps/hub/src/projectManager.test.ts')
    for (const agent of [knuth, hopper]) {
      write(agent, 'apps/web/src/lib/api.ts')
      write(agent, 'apps/web/src/lib/api.test.ts')
    }

    const detector = new WorktreeCollisionDetector({
      sessions: () => agents,
      steer: async () => true,
    })
    await detector.poll()

    expect(detector.projectActivity('project-1').risks).toEqual([
      expect.objectContaining({
        risk: 'concurrent-write',
        file: 'apps/hub/src/server.ts',
        sessionIds: ['cori', 'hopper', 'knuth', 'simon'],
      }),
      expect.objectContaining({
        risk: 'concurrent-write',
        file: 'apps/hub/src/projectManager.test.ts',
        sessionIds: ['cori', 'hopper', 'knuth'],
      }),
      expect.objectContaining({
        risk: 'concurrent-write',
        file: 'apps/web/src/lib/api.ts',
        sessionIds: ['hopper', 'knuth'],
      }),
      expect.objectContaining({
        risk: 'concurrent-write',
        file: 'apps/web/src/lib/api.test.ts',
        sessionIds: ['hopper', 'knuth'],
      }),
    ])
  }, 30_000)

  it('steers exactly once when the base branch advances across a file this agent modified', async () => {
    const { repo, knuth } = fixture()
    const steer = vi.fn(async (_sessionId: string, _message: string) => true)
    const report = vi.fn(async () => {})
    const detector = new WorktreeCollisionDetector({
      sessions: () => [knuth],
      steer,
      report,
    })

    fs.writeFileSync(path.join(knuth.worktree!, 'shared.ts'), 'export const value = 2\n')
    fs.writeFileSync(path.join(repo, 'shared.ts'), 'export const value = 3\n')
    git(repo, 'add', 'shared.ts')
    git(repo, 'commit', '-m', 'main changes shared')
    const advancedHead = git(repo, 'rev-parse', 'HEAD')

    await detector.poll()
    await detector.poll()

    expect(steer).toHaveBeenCalledOnce()
    expect(steer).toHaveBeenCalledWith(
      'knuth',
      expect.stringMatching(
        new RegExp(`shared\\.ts.*${knuth.baseCommit!.slice(0, 8)}.*${advancedHead.slice(0, 8)}`, 's')
      )
    )
    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        risk: 'stale-base',
        file: 'shared.ts',
        baseCommit: knuth.baseCommit,
        mainCommit: advancedHead,
        commitsBehind: 1,
        sessions: [expect.objectContaining({ sessionId: 'knuth', role: 'stale-writer' })],
        mainAdvance: [
          expect.objectContaining({ commit: advancedHead, subject: 'main changes shared' }),
        ],
        steeredSessionIds: ['knuth'],
      })
    )
  }, 20_000)

  it('stays silent when the base branch advances without touching anything this agent modified', async () => {
    const { repo, knuth } = fixture()
    const steer = vi.fn(async (_sessionId: string, _message: string) => true)
    const detector = new WorktreeCollisionDetector({
      sessions: () => [knuth],
      steer,
    })

    fs.writeFileSync(path.join(knuth.worktree!, 'shared.ts'), 'export const value = 2\n')
    fs.writeFileSync(path.join(repo, 'main-only.ts'), 'export const main = true\n')
    git(repo, 'add', 'main-only.ts')
    git(repo, 'commit', '-m', 'main changes another file')

    await detector.poll()
    expect(steer).not.toHaveBeenCalled()
  }, 20_000)

  it('does not attribute commits replayed from main to an agent after a rebase', async () => {
    const { repo, knuth } = fixture()
    const steer = vi.fn(async (_sessionId: string, _message: string) => true)
    const detector = new WorktreeCollisionDetector({
      sessions: () => [knuth],
      steer,
    })

    fs.writeFileSync(path.join(knuth.worktree!, 'shared.ts'), 'export const value = 2\n')
    git(knuth.worktree!, 'add', 'shared.ts')
    git(knuth.worktree!, 'commit', '-m', 'agent changes shared')
    fs.writeFileSync(path.join(repo, 'main-only.ts'), 'export const main = true\n')
    git(repo, 'add', 'main-only.ts')
    git(repo, 'commit', '-m', 'main changes another file')
    git(knuth.worktree!, 'rebase', knuth.baseRef!)

    await detector.poll()
    expect(steer).not.toHaveBeenCalled()
  }, 20_000)

  it('steers exactly the later writer once per file/pair and names the other agent', async () => {
    const { knuth, hopper } = fixture()
    const sessions = [knuth, hopper]
    const steer = vi.fn(async (_sessionId: string, _message: string) => true)
    const report = vi.fn(async () => {})
    const detector = new WorktreeCollisionDetector({
      sessions: () => sessions,
      steer,
      report,
    })

    fs.writeFileSync(path.join(knuth.worktree!, 'shared.ts'), 'export const value = 2\n')
    await detector.poll()
    expect(steer).not.toHaveBeenCalled()

    fs.writeFileSync(path.join(hopper.worktree!, 'shared.ts'), 'export const value = 3\n')
    await detector.poll()
    await detector.poll()

    expect(steer).toHaveBeenCalledOnce()
    expect(steer).toHaveBeenCalledWith(
      'hopper',
      expect.stringMatching(/Heads up: Knuth is also editing shared\.ts right now\./)
    )
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        risk: 'concurrent-write',
        file: 'shared.ts',
        commitsBehind: 0,
        sessions: [
          expect.objectContaining({ sessionId: 'knuth', role: 'writer' }),
          expect.objectContaining({ sessionId: 'hopper', role: 'later-writer' }),
        ],
        steeredSessionIds: ['hopper'],
      })
    )
  }, 20_000)

  it('stays silent for one writer, read-only peers, and ignored files', async () => {
    const { knuth, hopper } = fixture()
    const sessions = [knuth, hopper]
    const steer = vi.fn(async (_sessionId: string, _message: string) => true)
    const detector = new WorktreeCollisionDetector({
      sessions: () => sessions,
      steer,
    })

    // One writer + one peer that merely reads the same tracked file.
    fs.writeFileSync(path.join(knuth.worktree!, 'shared.ts'), 'export const value = 2\n')
    fs.readFileSync(path.join(hopper.worktree!, 'shared.ts'), 'utf8')
    await detector.poll()

    // Git-ignored writes in both worktrees are not part of either agent's write set.
    fs.writeFileSync(path.join(knuth.worktree!, 'ignored.log'), 'knuth\n')
    fs.writeFileSync(path.join(hopper.worktree!, 'ignored.log'), 'hopper\n')
    await detector.poll()

    // The hub materializes these into every worktree. Identical hub-owned writes are not agent overlap.
    const managedInstructions = [
      '<!-- AllMyAgents operator instructions (managed by the hub — edit them in Settings, not here) -->',
      '',
      'Stay in your lane.',
      '',
      '<!-- /AllMyAgents operator instructions -->',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(knuth.worktree!, 'CLAUDE.md'), managedInstructions)
    fs.writeFileSync(path.join(hopper.worktree!, 'CLAUDE.md'), managedInstructions)
    await detector.poll()

    expect(steer).not.toHaveBeenCalled()
  }, 20_000)

  it('includes committed branch changes that are not merged into the base checkout', async () => {
    const { knuth, hopper } = fixture()
    const steer = vi.fn(async (_sessionId: string, _message: string) => true)
    const detector = new WorktreeCollisionDetector({
      sessions: () => [knuth, hopper],
      steer,
    })

    fs.writeFileSync(path.join(knuth.worktree!, 'shared.ts'), 'export const value = 2\n')
    git(knuth.worktree!, 'add', 'shared.ts')
    git(knuth.worktree!, 'commit', '-m', 'knuth edits shared')
    await detector.poll()

    fs.writeFileSync(path.join(hopper.worktree!, 'shared.ts'), 'export const value = 3\n')
    await detector.poll()

    expect(steer).toHaveBeenCalledOnce()
    expect(steer.mock.calls[0]?.[1]).toContain('Knuth')
    expect(steer.mock.calls[0]?.[1]).toContain('shared.ts')
  }, 20_000)
})
