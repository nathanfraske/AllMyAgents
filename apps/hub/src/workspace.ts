import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type WorktreeInspection =
  | { ok: true; dirty: boolean }
  | { ok: false; error: string }

export type WorktreeRemoval =
  | { ok: true }
  | { ok: false; error: string }

export class WorkspaceManager {
  constructor(private readonly worktreesRoot: string) {
    fs.mkdirSync(worktreesRoot, { recursive: true })
  }

  private git(repo: string, args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim()
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
        .some((candidate) =>
          process.platform === 'win32'
            ? candidate.toLowerCase() === expected.toLowerCase()
            : candidate === expected
        )
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
