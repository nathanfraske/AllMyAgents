import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Project } from './types.js'
import { wslHostPath } from './workspaceLocation.js'

type WslProjectLocation = NonNullable<Project['location']>

export interface WslWorktreeExecution {
  distro: string
  repoPath: string
  worktreePath: string
}

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
  private readonly namedProjectsRoot: string

  constructor(
    private readonly worktreesRoot: string,
    scratchRoot = path.join(path.dirname(worktreesRoot), 'workspaces')
  ) {
    this.scratchRoot = scratchRoot
    this.namedProjectsRoot = path.join(path.dirname(worktreesRoot), 'projects')
    fs.mkdirSync(worktreesRoot, { recursive: true })
    fs.mkdirSync(scratchRoot, { recursive: true })
  }

  private git(repo: string, args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  }

  private wslExec(distro: string, cwd: string, program: string, args: string[]): string {
    return execFileSync(
      'wsl.exe',
      ['--distribution', distro, '--cd', cwd, '--exec', program, ...args],
      { encoding: 'utf8', windowsHide: true },
    ).trim()
  }

  private projectGit(
    repo: string,
    args: string[],
    location?: WslProjectLocation,
  ): string {
    return location
      ? this.wslExec(location.distro, location.linuxPath, 'git', ['-C', location.linuxPath, ...args])
      : this.git(repo, args)
  }

  private samePath(left: string, right: string): boolean {
    const canonical = (value: string): string => {
      const resolved = path.resolve(value)
      try {
        return fs.realpathSync.native(resolved)
      } catch {
        return resolved
      }
    }
    const a = canonical(left)
    const b = canonical(right)
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

  /**
   * Materialize a name-only project under the app-data root. This is deliberately separate from
   * scratch chat workspaces: it is a real project repository and can therefore honor worktree isolation.
   * The root is lazy so merely opening/cancelling the project wizard writes nothing.
   */
  createNamedProject(name: string): string {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('project name is required')
    const slug = cleanName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project'
    const target = path.join(this.namedProjectsRoot, `${slug}-${crypto.randomUUID().slice(0, 8)}`)
    fs.mkdirSync(this.namedProjectsRoot, { recursive: true })
    fs.mkdirSync(target, { recursive: false })
    try {
      this.git(target, ['init'])
      const tree = this.git(target, ['write-tree'])
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
          tree,
          '-m',
          'Initialize project',
        ],
        { encoding: 'utf8', windowsHide: true }
      ).trim()
      this.git(target, ['update-ref', 'HEAD', commit])
      return target
    } catch (error) {
      fs.rmSync(target, { recursive: true, force: true })
      throw error
    }
  }

  removeNamedProject(target: string): void {
    const root = path.resolve(this.namedProjectsRoot)
    const resolved = path.resolve(target)
    if (path.dirname(resolved) !== root) throw new Error(`not an app-managed project path: ${target}`)
    fs.rmSync(resolved, { recursive: true, force: true })
  }

  /**
   * The destructive half of project deletion. Callers must obtain an explicit operator confirmation
   * before reaching this method. Worktrees are unregistered first while their repository still exists;
   * the project directory is removed last.
   */
  removeProjectFiles(
    projectPath: string,
    projectWorktrees: ReadonlyArray<{ repo?: string; worktree: string }>,
  ): void {
    const resolvedProject = path.resolve(projectPath)
    const filesystemRoot = path.parse(resolvedProject).root
    const forbidden = [
      filesystemRoot,
      path.resolve(os.homedir()),
      path.resolve(this.managedRoot()),
      path.resolve(this.worktreesRoot),
      path.resolve(this.scratchRoot),
      path.resolve(this.namedProjectsRoot),
    ]
    if (forbidden.some((candidate) => this.samePath(candidate, resolvedProject))) {
      throw new Error(`refusing to delete a broad application or filesystem root: ${resolvedProject}`)
    }

    for (const item of projectWorktrees) {
      const resolvedWorktree = path.resolve(item.worktree)
      if (!this.samePath(path.dirname(resolvedWorktree), this.worktreesRoot)) {
        throw new Error(`refusing to delete a worktree outside the managed worktree root: ${resolvedWorktree}`)
      }
      if (!fs.existsSync(resolvedWorktree)) continue
      if (item.repo && fs.existsSync(item.repo)) {
        try {
          this.git(item.repo, ['worktree', 'remove', '--force', resolvedWorktree])
          continue
        } catch {
          // The checkout may already be unregistered. Removing the exact recorded worktree remains
          // within the explicitly-confirmed project scope.
        }
      }
      fs.rmSync(resolvedWorktree, { recursive: true, force: true })
    }
    fs.rmSync(resolvedProject, { recursive: true, force: true })
  }

  isRepo(repo: string, location?: WslProjectLocation): boolean {
    try {
      return this.projectGit(repo, ['rev-parse', '--is-inside-work-tree'], location) === 'true'
    } catch {
      return false
    }
  }

  create(repo: string, sessionId: string, location?: WslProjectLocation): {
    worktree: string
    executionPath?: string
    distro?: string
    branch: string
    baseCommit: string
    baseRef?: string
  } {
    if (!this.isRepo(repo, location)) throw new Error(`not a git repository: ${repo}`)
    const baseCommit = this.projectGit(
      repo,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      location,
    )
    let baseRef: string | undefined
    try {
      baseRef = this.projectGit(repo, ['symbolic-ref', 'HEAD'], location)
    } catch {
      // Detached bases are valid. The immutable baseCommit remains authoritative; staleness monitoring
      // falls back to the primary checkout's HEAD when there is no branch ref to follow.
    }
    const short = sessionId.slice(0, 8)
    const branch = `agent/${short}`
    if (location) {
      // The checkout belongs to the same Linux filesystem as its repository. Keeping it beside the
      // primary checkout's parent avoids the severe Windows↔\\wsl$ traversal penalty and guarantees Git
      // and every agent tool see the same case-sensitive paths.
      const linuxRoot = path.posix.join(
        path.posix.dirname(location.linuxPath),
        '.allmyagents-worktrees',
      )
      const linuxTarget = path.posix.join(linuxRoot, short)
      this.wslExec(location.distro, location.linuxPath, 'mkdir', ['-p', linuxRoot])
      this.projectGit(
        repo,
        ['worktree', 'add', '-b', branch, linuxTarget],
        location,
      )
      return {
        worktree: wslHostPath(location.distro, linuxTarget),
        executionPath: linuxTarget,
        distro: location.distro,
        branch,
        baseCommit,
        baseRef,
      }
    }
    const target = path.join(this.worktreesRoot, short)
    this.git(repo, ['worktree', 'add', '-b', branch, target])
    return { worktree: target, branch, baseCommit, baseRef }
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
  inspect(
    repo: string,
    worktree: string,
    execution?: WslWorktreeExecution,
  ): WorktreeInspection {
    if (!fs.existsSync(worktree)) return { ok: false, error: `worktree is missing: ${worktree}` }
    try {
      if (execution) {
        const expected = path.posix.normalize(execution.worktreePath)
        const registered = this.wslExec(
          execution.distro,
          execution.repoPath,
          'git',
          ['-C', execution.repoPath, 'worktree', 'list', '--porcelain'],
        )
          .split(/\r?\n/)
          .filter((line) => line.startsWith('worktree '))
          .map((line) => path.posix.normalize(line.slice('worktree '.length)))
          .some((candidate) => candidate === expected)
        if (!registered) {
          return {
            ok: false,
            error: `path is not a registered worktree for ${execution.distro}:${execution.repoPath}: ${execution.worktreePath}`,
          }
        }
        const dirty =
          this.wslExec(execution.distro, execution.worktreePath, 'git', [
            '-C',
            execution.worktreePath,
            'status',
            '--porcelain',
            '--untracked-files=all',
          ]).length > 0
        return { ok: true, dirty }
      }
      // Git reports the physical path while records may legitimately contain a symlink/junction alias
      // (notably Windows' Roaming → Packages LocalCache projection). Compare filesystem identities so a
      // valid checkout is not rejected on Reopen merely because those spellings differ.
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
  remove(
    repo: string,
    worktree: string,
    execution?: WslWorktreeExecution,
  ): WorktreeRemoval {
    const state = this.inspect(repo, worktree, execution)
    if (!state.ok) return state
    if (state.dirty) {
      return {
        ok: false,
        error: `worktree has uncommitted changes and was preserved at ${worktree}`,
      }
    }
    try {
      if (execution) {
        this.wslExec(execution.distro, execution.repoPath, 'git', [
          '-C',
          execution.repoPath,
          'worktree',
          'remove',
          execution.worktreePath,
        ])
      } else {
        this.git(repo, ['worktree', 'remove', worktree])
      }
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
