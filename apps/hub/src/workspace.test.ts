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

  describe('reapOrphanWorktrees', () => {
    // Builds a repo plus three worktrees so each test can choose which are "live".
    function scenario() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-reap-'))
      roots.push(root)
      const repo = path.join(root, 'repo')
      fs.mkdirSync(repo)
      git(repo, 'init')
      git(repo, 'config', 'user.email', 'test@example.com')
      git(repo, 'config', 'user.name', 'Test')
      fs.writeFileSync(path.join(repo, 'README.md'), 'test\n')
      git(repo, 'add', 'README.md')
      git(repo, 'commit', '-m', 'initial')
      const workspace = new WorkspaceManager(path.join(root, 'worktrees'))
      return { root, repo, workspace }
    }

    it('removes an orphan with no work and never touches a live worktree', () => {
      const { repo, workspace } = scenario()
      const live = workspace.create(repo, '11111111-live')
      const orphan = workspace.create(repo, '22222222-orphan')

      const result = workspace.reapOrphanWorktrees([live.worktree])

      expect(result.removed).toEqual([orphan.worktree])
      expect(fs.existsSync(orphan.worktree)).toBe(false)
      expect(fs.existsSync(live.worktree)).toBe(true)
    })

    it('KEEPS an orphan holding uncommitted changes', () => {
      const { repo, workspace } = scenario()
      const orphan = workspace.create(repo, '33333333-dirty')
      fs.writeFileSync(path.join(orphan.worktree, 'unsaved.txt'), 'agent work\n')

      const result = workspace.reapOrphanWorktrees([])

      expect(result.removed).toEqual([])
      expect(fs.existsSync(orphan.worktree)).toBe(true)
      expect(result.keptWithWork[0]?.reason).toMatch(/uncommitted/)
    })

    it('KEEPS an orphan holding commits that are not merged anywhere', () => {
      const { repo, workspace } = scenario()
      const orphan = workspace.create(repo, '44444444-unmerged')
      fs.writeFileSync(path.join(orphan.worktree, 'feature.txt'), 'agent work\n')
      git(orphan.worktree, 'add', 'feature.txt')
      git(orphan.worktree, 'commit', '-m', 'unmerged agent work')

      const result = workspace.reapOrphanWorktrees([])

      expect(result.removed).toEqual([])
      expect(fs.existsSync(orphan.worktree)).toBe(true)
      expect(result.keptWithWork[0]?.reason).toMatch(/unmerged commit/)
    })

    it('treats regenerable build output as reclaimable, not as work', () => {
      const { repo, workspace } = scenario()
      const orphan = workspace.create(repo, '55555555-artifacts')
      fs.mkdirSync(path.join(orphan.worktree, 'target'), { recursive: true })
      fs.writeFileSync(path.join(orphan.worktree, 'target', 'huge.bin'), 'x'.repeat(1024))
      fs.mkdirSync(path.join(orphan.worktree, 'node_modules', 'left-pad'), { recursive: true })
      fs.writeFileSync(path.join(orphan.worktree, 'node_modules', 'left-pad', 'index.js'), 'x\n')

      const result = workspace.reapOrphanWorktrees([])

      expect(result.removed).toEqual([orphan.worktree])
      expect(fs.existsSync(orphan.worktree)).toBe(false)
    })

    it('ignores an instruction file the hub materialized, but KEEPS one a person edited', () => {
      const { repo, workspace } = scenario()
      const hubOnly = workspace.create(repo, '66666666-hubonly')
      const authored = workspace.create(repo, '77777777-authored')
      // The exact markers instructions.ts wraps its managed block in.
      const managed =
        '<!-- AllMyAgents operator instructions (managed by the hub — edit them in Settings, not here) -->\n' +
        'standing rules\n' +
        '<!-- /AllMyAgents operator instructions -->\n'
      fs.writeFileSync(path.join(hubOnly.worktree, 'AGENTS.md'), managed)
      fs.writeFileSync(
        path.join(authored.worktree, 'AGENTS.md'),
        `${managed}\nNotes I wrote by hand and do not want deleted.\n`
      )

      const result = workspace.reapOrphanWorktrees([])

      expect(result.removed).toEqual([hubOnly.worktree])
      expect(fs.existsSync(authored.worktree)).toBe(true)
      expect(result.keptWithWork.map((kept) => kept.worktree)).toEqual([authored.worktree])
    })

    it('fails closed and keeps a directory git cannot vouch for', () => {
      const { root, workspace } = scenario()
      const notACheckout = path.join(root, 'worktrees', 'deadbeef')
      fs.mkdirSync(notACheckout, { recursive: true })
      fs.writeFileSync(path.join(notACheckout, 'mystery.txt'), 'unknown provenance\n')

      const result = workspace.reapOrphanWorktrees([])

      expect(result.removed).toEqual([])
      expect(fs.existsSync(notACheckout)).toBe(true)
    })
  })
})
