import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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

  create(repo: string, sessionId: string): string {
    if (!this.isRepo(repo)) throw new Error(`not a git repository: ${repo}`)
    const short = sessionId.slice(0, 8)
    const target = path.join(this.worktreesRoot, short)
    this.git(repo, ['worktree', 'add', '-b', `agent/${short}`, target])
    return target
  }

  remove(repo: string, worktree: string): void {
    try {
      this.git(repo, ['worktree', 'remove', '--force', worktree])
    } catch {
      // locked files on Windows are expected occasionally; prune below handles leftovers
    }
    try {
      this.git(repo, ['worktree', 'prune'])
    } catch {
      /* repo may be gone */
    }
  }
}
