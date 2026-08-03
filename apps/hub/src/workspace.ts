import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSolelyHubManagedInstructions } from './instructions.js'
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

  createNamedWslProject(
    name: string,
    distro: string,
  ): { hostPath: string; location: WslProjectLocation } {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('project name is required')
    const slug = cleanName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project'
    const home = this.wslExec(distro, '/', 'sh', ['-lc', 'printf %s "$HOME"'])
    if (!home.startsWith('/')) throw new Error(`could not resolve the home directory inside ${distro}`)
    const linuxRoot = path.posix.join(home, '.local', 'share', 'allmyagents', 'projects')
    const linuxPath = path.posix.join(linuxRoot, `${slug}-${crypto.randomUUID().slice(0, 8)}`)
    this.wslExec(distro, '/', 'mkdir', ['-p', linuxRoot])
    this.wslExec(distro, '/', 'mkdir', [linuxPath])
    const location: WslProjectLocation = { kind: 'wsl', distro, linuxPath }
    const hostPath = wslHostPath(distro, linuxPath)
    try {
      this.projectGit(hostPath, ['init'], location)
      const tree = this.projectGit(hostPath, ['write-tree'], location)
      const commit = this.wslExec(distro, linuxPath, 'git', [
        '-C',
        linuxPath,
        '-c',
        'user.name=AllMyAgents',
        '-c',
        'user.email=workspace@allmyagents.invalid',
        'commit-tree',
        tree,
        '-m',
        'Initialize project',
      ])
      this.projectGit(hostPath, ['update-ref', 'HEAD', commit], location)
      return { hostPath, location }
    } catch (error) {
      this.wslExec(distro, '/', 'rm', ['-rf', linuxPath])
      throw error
    }
  }

  removeNamedProject(target: string): void {
    const root = path.resolve(this.namedProjectsRoot)
    const resolved = path.resolve(target)
    if (path.dirname(resolved) !== root) throw new Error(`not an app-managed project path: ${target}`)
    fs.rmSync(resolved, { recursive: true, force: true })
  }

  removeNamedWslProject(location: WslProjectLocation): void {
    const expectedSegment = '/.local/share/allmyagents/projects/'
    if (!location.linuxPath.includes(expectedSegment)) {
      throw new Error(`not an app-managed WSL project path: ${location.linuxPath}`)
    }
    this.wslExec(location.distro, '/', 'rm', ['-rf', location.linuxPath])
  }

  /**
   * The destructive half of project deletion. Callers must obtain an explicit operator confirmation
   * before reaching this method. Worktrees are unregistered first while their repository still exists;
   * the project directory is removed last.
   */
  removeProjectFiles(
    projectPath: string,
    projectWorktrees: ReadonlyArray<{
      repo?: string
      worktree: string
      execution?: WslWorktreeExecution
    }>,
    projectLocation?: WslProjectLocation,
  ): void {
    if (projectLocation) {
      const home = this.wslExec(projectLocation.distro, '/', 'sh', [
        '-lc',
        'printf %s "$HOME"',
      ])
      const resolvedProject = path.posix.normalize(projectLocation.linuxPath)
      if (resolvedProject === '/' || resolvedProject === home) {
        throw new Error(`refusing to delete a broad WSL filesystem root: ${resolvedProject}`)
      }
      for (const item of projectWorktrees) {
        const execution = item.execution
        if (!execution || execution.distro.toLowerCase() !== projectLocation.distro.toLowerCase()) {
          throw new Error(`missing or mismatched WSL worktree identity for ${item.worktree}`)
        }
        if (path.posix.basename(path.posix.dirname(execution.worktreePath)) !== '.allmyagents-worktrees') {
          throw new Error(
            `refusing to delete a WSL worktree outside its managed root: ${execution.worktreePath}`,
          )
        }
        try {
          this.wslExec(execution.distro, execution.repoPath, 'git', [
            '-C',
            execution.repoPath,
            'worktree',
            'remove',
            '--force',
            execution.worktreePath,
          ])
        } catch {
          this.wslExec(execution.distro, '/', 'rm', ['-rf', execution.worktreePath])
        }
      }
      this.wslExec(projectLocation.distro, '/', 'rm', ['-rf', resolvedProject])
      return
    }
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

  /**
   * Reclaim worktrees whose owning session no longer exists.
   *
   * Until this existed, a worktree was removed ONLY as part of `removeProjectFiles` — i.e. deleting the
   * whole project behind an explicit operator confirmation. Nothing reclaimed the per-agent checkout when
   * its session was deleted or never persisted, so the directory grew without bound: one operator reached
   * 36 worktrees / 92 GB, of which 85 GB was regenerable `target/` and `node_modules/` and only ~7 GB was
   * actual work. Nine of those had no owning session at all.
   *
   * SAFETY: an orphan is deleted only when git proves it holds nothing. Uncommitted changes or commits not
   * reachable from its base leave it on disk and reported, because unmerged agent work is exactly what a
   * disk-space sweep must never eat. Build artifacts are ignored when judging dirtiness — a stale `target/`
   * is not a reason to keep a worktree forever.
   *
   * @param liveWorktrees absolute paths still claimed by a session; anything else under the root is orphaned.
   * @returns what was removed and what was deliberately kept, for the caller to log.
   */
  reapOrphanWorktrees(liveWorktrees: Iterable<string>): {
    removed: string[]
    keptWithWork: Array<{ worktree: string; reason: string }>
  } {
    const live = new Set(
      Array.from(liveWorktrees, (candidate) => this.normalizeForCompare(path.resolve(candidate)))
    )
    const removed: string[] = []
    const keptWithWork: Array<{ worktree: string; reason: string }> = []

    let entries: string[]
    try {
      entries = fs.readdirSync(this.worktreesRoot)
    } catch {
      return { removed, keptWithWork }
    }

    for (const entry of entries) {
      const worktree = path.join(this.worktreesRoot, entry)
      if (live.has(this.normalizeForCompare(worktree))) continue
      try {
        if (!fs.statSync(worktree).isDirectory()) continue
      } catch {
        continue
      }
      // Belt-and-braces containment: only ever a direct child of the managed root.
      if (!this.samePath(path.dirname(path.resolve(worktree)), this.worktreesRoot)) continue

      const retention = this.worktreeRetentionReason(worktree)
      if (retention) {
        keptWithWork.push({ worktree, reason: retention })
        continue
      }
      try {
        fs.rmSync(worktree, { recursive: true, force: true })
        removed.push(worktree)
      } catch (error) {
        keptWithWork.push({
          worktree,
          reason: `could not be removed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    return { removed, keptWithWork }
  }

  /**
   * Why an orphaned worktree must be kept, or undefined when git proves it holds nothing worth keeping.
   *
   * Fails CLOSED: if git cannot answer (not a checkout, binary missing, corrupt index), the worktree is
   * retained. Deleting on "I could not tell" is how a sweep destroys work.
   */
  private worktreeRetentionReason(worktree: string): string | undefined {
    let status: string
    try {
      status = this.git(worktree, ['status', '--porcelain'])
    } catch (error) {
      return `git status unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
    const dirty = status
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        // Porcelain v1 is `XY <path>`, and a rename reads `XY old -> new`. The status field must be
        // stripped BEFORE matching, or a path test sees "?? target/" and never matches "target". The
        // leading-space form (" M file") can arrive already trimmed, so accept one or two status chars.
        const withoutStatus = line.replace(/^[ MADRCU?!]{1,2}\s+/, '')
        const rename = withoutStatus.lastIndexOf(' -> ')
        const candidate = rename >= 0 ? withoutStatus.slice(rename + 4) : withoutStatus
        return candidate.replace(/^"(.*)"$/, '$1')
      })
      // Regenerable build output is not work. Everything else counts.
      .filter((file) => !/(^|[/\\])(node_modules|target|dist|build)([/\\]|$)/.test(file))
      // Neither is the instruction file the hub materializes into every worktree itself. Without this the
      // sweep is inert in practice: each worktree carries an untracked CLAUDE.md/AGENTS.md the hub wrote,
      // so every orphan looks dirty forever. Reuses the collision detector's own predicate, which returns
      // false the moment the file holds any content a person wrote — so real edits still protect it.
      .filter((file) => !this.isHubWrittenInstructionFile(worktree, file))
    if (dirty.length > 0) return `${dirty.length} uncommitted change(s)`

    // Commits the agent made that are reachable from NO other ref are unmerged work.
    //
    // The refs are enumerated explicitly rather than with `--exclude=... --branches`: that flag matches
    // relative to the ref namespace it filters, so the obvious-looking `refs/heads/agent/*` silently
    // matches nothing and every agent commit reads as already merged — which would delete exactly the
    // work this check exists to protect. Agent branches are dropped from the "merged elsewhere" set so a
    // commit that lives only on its own agent branch still counts as unmerged.
    try {
      const otherRefs = this.git(worktree, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ])
        .split('\n')
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0 && !ref.startsWith('refs/heads/agent/'))
      const unreachable = this.git(worktree, ['log', '--oneline', 'HEAD', '--not', ...otherRefs])
      if (unreachable.length > 0) {
        return `${unreachable.split('\n').filter(Boolean).length} unmerged commit(s)`
      }
    } catch (error) {
      return `git log unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
    return undefined
  }

  /**
   * True for a worktree-root CLAUDE.md/AGENTS.md whose entire contents this hub materialized.
   *
   * Fails CLOSED in both directions: a file it cannot read, or one carrying any authored content, is
   * reported as real work so the worktree survives the sweep.
   */
  private isHubWrittenInstructionFile(worktree: string, file: string): boolean {
    if (file !== 'CLAUDE.md' && file !== 'AGENTS.md') return false
    try {
      return isSolelyHubManagedInstructions(fs.readFileSync(path.join(worktree, file), 'utf8'))
    } catch {
      return false
    }
  }

  private normalizeForCompare(candidate: string): string {
    return process.platform === 'win32' ? candidate.toLowerCase() : candidate
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
