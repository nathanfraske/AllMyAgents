import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceManager } from './workspace.js'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceManager', () => {
  it('creates name-only projects as committed Git repositories outside scratch workspaces', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-workspace-'))
    roots.push(root)
    const workspace = new WorkspaceManager(path.join(root, 'worktrees'))

    const created = workspace.createNamedProject('New research tool')

    expect(path.dirname(created)).toBe(path.join(root, 'projects'))
    expect(workspace.isRepo(created)).toBe(true)
    expect(git(created, 'rev-parse', '--verify', 'HEAD^{commit}')).toMatch(/^[a-f0-9]{40}$/)
  })

  it('recognises a registered worktree through a filesystem alias', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-workspace-'))
    roots.push(root)
    const repo = path.join(root, 'repo')
    const actual = path.join(root, 'actual')
    const alias = path.join(root, 'alias')
    fs.mkdirSync(repo)
    fs.mkdirSync(actual)
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    fs.writeFileSync(path.join(repo, 'README.md'), 'test\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'initial')
    fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')

    const workspace = new WorkspaceManager(path.join(alias, 'worktrees'))
    const created = workspace.create(repo, '12345678-test')

    expect(workspace.inspect(repo, created.worktree)).toEqual({ ok: true, dirty: false })
  })
})
