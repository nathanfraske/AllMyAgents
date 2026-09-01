import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { inspectWorkspaceDiff } from './workspaceDiff.js'
import type { SessionRecord } from './types.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

describe('workspace diff inspection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-workspace-diff-'))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it('compares the live checkout to a verified base and reports GitHub links without running diff helpers', async () => {
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'remote', 'add', 'origin', 'git@github.com:nathanfraske/AllMyAgents.git')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'after\n')
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n')

    const record = {
      id: 'session',
      profileId: 'codex-a',
      provider: 'codex',
      cwd: repo,
      repo,
      worktree: repo,
      status: 'idle',
      baseRef: 'refs/heads/main',
    } as SessionRecord
    const result = await inspectWorkspaceDiff(record)

    expect(result.baseCommit).toBe(base)
    expect(result.files).toContainEqual({ status: 'M', path: 'tracked.txt' })
    expect(result.untracked).toContain('untracked.txt')
    expect(result.patch).toContain('-before')
    expect(result.patch).toContain('+after')
    expect(result.headUrl).toBe(`https://github.com/nathanfraske/AllMyAgents/commit/${base}`)
  })

  it('rejects an option-shaped or whitespace-bearing base', async () => {
    const record = {
      id: 'session', profileId: 'codex-a', provider: 'codex', cwd: root, repo: root, status: 'idle',
    } as SessionRecord
    await expect(inspectWorkspaceDiff(record, '--output=/tmp/nope')).rejects.toThrow(/valid bounded Git revision/i)
    await expect(inspectWorkspaceDiff(record, 'main bad')).rejects.toThrow(/valid bounded Git revision/i)
  })
})
