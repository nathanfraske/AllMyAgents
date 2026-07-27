import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type WorktreeInspection =
  | { ok: true; dirty: boolean }
  | { ok: false; error: string }

export type WorktreeRemoval =
  | { ok: true }
  | { ok: false; error: string }

export type ScratchInspection =
  | { ok: true; dirty: boolean; hasCommits: boolean }
  | { ok: false; error: string }

export class WorkspaceManager {
  private readonly scratchRoot: string

  constructor(
    private readonly worktreesRoot: string,
    scratchRoot = path.join(path.dirname(worktreesRoot), 'workspaces')
  ) {
    this.scratchRoot = scratchRoot
    fs.mkdirSync(worktreesRoot, { recursive: true })
    fs.mkdirSync(scratchRoot, { recursive: true })
  }

  private git(repo: string, args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  }

  private samePath(left: string, right: string): boolean {
    const a = path.resolve(left)
    const b = path.resolve(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }

  private scratchPath(sessionId: string): string {
    if (!sessionId || path.basename(sessionId) !== sessionId || sessionId === '.' || sessionId === '..') {
      throw new Error(`invalid session id for workspace: ${sessionId}`)
    }
    return path.join(this.scratchRoot, sessionId)
  }

  /** The common app-data root containing both project worktrees and unfiled-chat workspaces. */
  managedRoot(): string {
    return path.dirname(this.worktreesRoot)
  }

  isRepo(repo: string): boolean {
    try {
      return this.git(repo, ['rev-parse', '--is-inside-work-tree']) === 'true'
    } catch {
      return false
    }
  }

  create(repo: string, sessionId: string): { worktree: string; branch: string } {
    if (!this.isRepo(repo)) throw new Error(`not a git repository: ${repo}`)
    const short = sessionId.slice(0, 8)
    const target = path.join(this.worktreesRoot, short)
    const branch = `agent/${short}`
    this.git(repo, ['worktree', 'add', '-b', branch, target])
    return { worktree: target, branch }
  }

  /**
   * Give an unfiled chat an independent Git-backed directory. The initial checkpoint is written
   * separately, after managed instructions have been materialized, so a brand-new chat starts clean.
   */
  createScratch(sessionId: string): string {
    const target = this.scratchPath(sessionId)
    if (fs.existsSync(target)) throw new Error(`session workspace already exists: ${target}`)
    fs.mkdirSync(target, { recursive: false })
    try {
      this.git(target, ['init'])
      return target
    } catch (err) {
      fs.rmSync(target, { recursive: true, force: true })
      throw err
    }
  }

  /** Record the hub-created baseline without relying on the operator's Git identity or commit hooks. */
  checkpointScratch(sessionId: string): void {
    const target = this.scratchPath(sessionId)
    this.git(target, ['add', '--all'])
    const stagedTree = this.git(target, ['write-tree'])
    const commit = execFileSync(
      'git',
      [
        '-C',
        target,
        '-c',
        'user.name=AllMyAgents',
        '-c',
        'user.email=workspace@allmyagents.invalid',
        'commit-tree',
        stagedTree,
        '-m',
        'Initialize chat workspace',
      ],
      { encoding: 'utf8', windowsHide: true }
    ).trim()
    this.git(target, ['update-ref', 'HEAD', commit])
    this.git(target, ['update-ref', 'refs/allmyagents/initial', commit])
  }

  isScratch(workspace: string, sessionId: string): boolean {
    try {
      return this.samePath(workspace, this.scratchPath(sessionId))
    } catch {
      return false
    }
  }

  inspectScratch(sessionId: string): ScratchInspection {
    let target: string
    try {
      target = this.scratchPath(sessionId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (!fs.existsSync(target)) return { ok: false, error: `workspace is missing: ${target}` }
    try {
      const repoRoot = this.git(target, ['rev-parse', '--show-toplevel'])
      if (!this.samePath(repoRoot, target)) {
        return { ok: false, error: `path is not an independent chat workspace: ${target}` }
      }
      const baseline = this.git(target, ['rev-parse', 'refs/allmyagents/initial'])
      const refs = this.git(target, ['for-each-ref', '--format=%(objectname)', 'refs'])
        .split(/\r?\n/)
        .filter(Boolean)
      const dirty = this.git(target, ['status', '--porcelain', '--untracked-files=all']).length > 0
      return { ok: true, dirty, hasCommits: refs.some((commit) => commit !== baseline) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `workspace is not usable: ${target} (${message})` }
    }
  }

  /**
   * Remove only a pristine chat workspace. Uncommitted files and commits are both operator work:
   * preserve either one, and include the recovery path in the error returned to Delete.
   */
  removeScratch(sessionId: string): WorktreeRemoval {
    const target = this.scratchPath(sessionId)
    const state = this.inspectScratch(sessionId)
    if (!state.ok) return state
    if (state.dirty) {
      return {
        ok: false,
        error: `workspace has uncommitted changes and was preserved at ${target}`,
      }
    }
    if (state.hasCommits) {
      return {
        ok: false,
        error: `workspace contains committed work and was preserved at ${target}`,
      }
    }
    try {
      fs.rmSync(target, { recursive: true })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error: `The workspace could not be removed; it was preserved at ${target} (${message})`,
      }
    }
  }

  /**
   * Verify that a recorded checkout still exists and belongs to this repository. Dirty is reported,
   * not rejected: reopening a stopped session with uncommitted work is the primary recovery path.
   */
  inspect(repo: string, worktree: string): WorktreeInspection {
    if (!fs.existsSync(worktree)) return { ok: false, error: `worktree is missing: ${worktree}` }
    try {
      const expected = path.resolve(worktree)
      const registered = this.git(repo, ['worktree', 'list', '--porcelain'])
        .split(/\r?\n/)
        .filter((line) => line.startsWith('worktree '))
        .map((line) => path.resolve(line.slice('worktree '.length)))
        .some((candidate) => this.samePath(candidate, expected))
      if (!registered) {
        return { ok: false, error: `path is not a registered worktree for ${repo}: ${worktree}` }
      }
      const dirty = this.git(worktree, ['status', '--porcelain', '--untracked-files=all']).length > 0
      return { ok: true, dirty }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `worktree is not usable: ${worktree} (${message})` }
    }
  }

  /**
   * Remove only a clean, registered worktree. Git's own non-force removal is the final race-safe guard:
   * if a file changes after inspect(), Git refuses instead of erasing it.
   */
  remove(repo: string, worktree: string): WorktreeRemoval {
    const state = this.inspect(repo, worktree)
    if (!state.ok) return state
    if (state.dirty) {
      return {
        ok: false,
        error: `worktree has uncommitted changes and was preserved at ${worktree}`,
      }
    }
    try {
      this.git(repo, ['worktree', 'remove', worktree])
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error: `Git refused to remove the worktree; it was preserved at ${worktree} (${message})`,
      }
    }
  }
}
