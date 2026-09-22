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
  it('excludes 612 inherited paths across four lanes without advancing protected main', async () => {
    const { root, repo, knuth, hopper } = fixture()
    const agents = [knuth, hopper]
    for (const id of ['cori', 'simon']) {
      const worktree = path.join(root, 'worktrees', id)
      git(repo, 'worktree', 'add', '-b', `agent/${id}`, worktree)
      agents.push({ ...knuth, id, title: id, worktree, cwd: worktree, branch: `agent/${id}` })
    }
    const protectedHead = git(repo, 'rev-parse', 'HEAD')
    for (let i = 0; i < 612; i++) fs.writeFileSync(path.join(knuth.worktree!, `inherited-${i}.ts`), '// accepted\n')
    git(knuth.worktree!, 'add', '.')
    git(knuth.worktree!, 'commit', '-m', 'shared accepted baseline not yet on protected main')
    const accepted = git(knuth.worktree!, 'rev-parse', 'HEAD')
    for (const agent of agents.slice(1)) git(agent.worktree!, 'merge', '--ff-only', accepted)
    git(knuth.worktree!, 'switch', '-c', 'agent/new-task')
    for (const agent of agents) fs.writeFileSync(path.join(agent.worktree!, `${agent.id}-only.ts`), '// lane\n')
    git(knuth.worktree!, 'add', 'knuth-only.ts')
    git(knuth.worktree!, 'commit', '-m', 'one task-owned commit')
    const steer = vi.fn(async () => true)
    const report = vi.fn(async () => {})
    const detector = new WorktreeCollisionDetector({ sessions: () => agents, steer, report })
    await detector.poll()
    await detector.poll()
    expect(steer).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
    expect(detector.projectActivity('project-1').risks).toEqual([])
    expect(detector.projectActivity('project-1').agents.find((a) => a.sessionId === 'knuth')?.branch).toBe('agent/new-task')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(protectedHead)

    // One dirty edit to a shared historical path is still just one writer.
    fs.writeFileSync(path.join(hopper.worktree!, 'inherited-0.ts'), '// hopper\n')
    await detector.poll()
    expect(steer).not.toHaveBeenCalled()
    fs.writeFileSync(path.join(knuth.worktree!, 'inherited-0.ts'), '// knuth\n')
    await detector.poll()
    expect(steer).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledOnce()
    expect(detector.projectActivity('project-1').risks).toMatchObject([{ file: 'inherited-0.ts' }])
  }, 90_000)

  it('coalesces real path fan-out and re-notifies only after observed resolution', async () => {
    const { knuth, hopper } = fixture()
    for (let i = 0; i < 60; i++) {
      for (const agent of [knuth, hopper]) fs.writeFileSync(path.join(agent.worktree!, `overlap-${i}.ts`), `// ${agent.id}\n`)
    }
    const steer = vi.fn(async (_id: string, _text: string) => true)
    const report = vi.fn(async (_event: unknown) => {})
    const detector = new WorktreeCollisionDetector({ sessions: () => [knuth, hopper], steer, report })
    await detector.poll()
    await detector.poll()
    expect(steer).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0]![0]).toMatchObject({ fileCount: 60, files: expect.any(Array) })
    expect((report.mock.calls[0]![0] as { files: string[] }).files).toHaveLength(8)
    expect(steer.mock.calls[0]![1].length).toBeLessThan(1_000)
    expect(detector.projectActivity('project-1').risks).toHaveLength(60)
    for (let i = 0; i < 60; i++) fs.unlinkSync(path.join(hopper.worktree!, `overlap-${i}.ts`))
    await detector.poll()
    expect(detector.projectActivity('project-1').risks).toEqual([])
    fs.writeFileSync(path.join(hopper.worktree!, 'overlap-0.ts'), '// resumed\n')
    await detector.poll()
    expect(steer).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledTimes(2)
  }, 30_000)

  it('retains independent same-path committed edits even when their final blobs match', async () => {
    const { knuth, hopper } = fixture()
    for (const agent of [knuth, hopper]) {
      fs.writeFileSync(path.join(agent.worktree!, 'shared.ts'), '// equal content, independent work\n')
      git(agent.worktree!, 'add', 'shared.ts')
      git(agent.worktree!, 'commit', '-m', `independent ${agent.id} change`)
    }
    const steer = vi.fn(async () => true)
    const detector = new WorktreeCollisionDetector({ sessions: () => [knuth, hopper], steer })
    await detector.poll()
    expect(steer).toHaveBeenCalledOnce()
    expect(detector.projectActivity('project-1').risks).toMatchObject([{ file: 'shared.ts' }])
  }, 20_000)

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
