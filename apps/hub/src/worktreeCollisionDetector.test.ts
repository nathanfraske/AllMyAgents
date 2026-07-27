import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCollisionDetector } from './worktreeCollisionDetector.js'
import type { SessionRecord } from './types.js'

const roots: string[] = []

afterEach(() => {
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
  it('steers exactly the later writer once per file/pair and names the other agent', async () => {
    const { knuth, hopper } = fixture()
    const sessions = [knuth, hopper]
    const steer = vi.fn(async (_sessionId: string, _message: string) => true)
    const detector = new WorktreeCollisionDetector({
      sessions: () => sessions,
      steer,
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
  })

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
  })

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
  })
})
