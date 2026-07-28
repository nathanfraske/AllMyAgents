import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Project, SessionRecord } from './types.js'

export interface ProjectDeletionChange {
  kind: 'uncommitted' | 'untracked'
  path: string
  checkoutPath: string
  sessionId?: string
}

export interface ProjectDeletionCommit {
  hash: string
  subject: string
  checkoutPath: string
  sessionId?: string
}

export interface ProjectDeletionWorktree {
  sessionId: string
  title: string
  path: string
  branch?: string
  status: SessionRecord['status']
}

export interface ProjectDeletionInspection {
  projectId: string
  projectPath: string
  sessions: Array<{
    id: string
    title: string
    status: SessionRecord['status']
    cwd: string
  }>
  changes: ProjectDeletionChange[]
  localCommits: ProjectDeletionCommit[]
  worktrees: ProjectDeletionWorktree[]
  inspectionErrors: Array<{ path: string; message: string }>
}

interface Checkout {
  path: string
  sessionId?: string
  baseCommit?: string
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function canonical(value: string): string {
  const resolved = path.resolve(value)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function pathKey(value: string): string {
  const resolved = canonical(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function nulPaths(cwd: string, args: string[]): string[] {
  return git(cwd, args)
    .split('\0')
    .filter(Boolean)
    .map((relative) => path.resolve(cwd, relative))
}

function plainFiles(root: string): string[] {
  const files: string[] = []
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else files.push(target)
    }
  }
  return files.sort()
}

function localCommits(checkout: Checkout): ProjectDeletionCommit[] {
  let range = 'HEAD'
  try {
    const upstream = git(checkout.path, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]).trim()
    if (upstream) range = `${upstream}..HEAD`
  } catch {
    if (checkout.baseCommit) range = `${checkout.baseCommit}..HEAD`
  }

  const raw = git(checkout.path, [
    'log',
    '--max-count=200',
    '--format=%H%x1f%s%x1e',
    range,
  ])
  return raw
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash = '', ...subject] = entry.split('\x1f')
      return {
        hash,
        subject: subject.join('\x1f'),
        checkoutPath: checkout.path,
        ...(checkout.sessionId ? { sessionId: checkout.sessionId } : {}),
      }
    })
}

/**
 * Read-only preflight for project deletion. Every path returned is absolute so the confirmation surface
 * can point at recoverable work rather than hiding it behind counts.
 */
export function inspectProjectDeletion(
  project: Project,
  projectSessions: readonly SessionRecord[],
): ProjectDeletionInspection {
  const sessions = projectSessions.filter((session) => session.projectId === project.id)
  const worktrees: ProjectDeletionWorktree[] = sessions
    .filter((session): session is SessionRecord & { worktree: string } => Boolean(session.worktree))
    .map((session) => ({
      sessionId: session.id,
      title: session.title?.trim() || session.role?.trim() || session.id.slice(0, 8),
      path: canonical(session.worktree),
      ...(session.branch ? { branch: session.branch } : {}),
      status: session.status,
    }))

  const checkouts = new Map<string, Checkout>()
  const projectPath = canonical(project.path)
  checkouts.set(pathKey(projectPath), { path: projectPath })
  for (const session of sessions) {
    if (!session.worktree) continue
    const checkoutPath = canonical(session.worktree)
    checkouts.set(pathKey(checkoutPath), {
      path: checkoutPath,
      sessionId: session.id,
      baseCommit: session.baseCommit,
    })
  }

  const changes: ProjectDeletionChange[] = []
  const commits: ProjectDeletionCommit[] = []
  const inspectionErrors: Array<{ path: string; message: string }> = []
  for (const checkout of checkouts.values()) {
    try {
      if (!fs.existsSync(checkout.path)) {
        throw new Error('path does not exist')
      }
      let isGit = false
      try {
        isGit =
          git(checkout.path, ['rev-parse', '--is-inside-work-tree']).trim() === 'true' &&
          pathKey(git(checkout.path, ['rev-parse', '--show-toplevel']).trim()) === pathKey(checkout.path)
      } catch {
        // A chosen local directory does not have to be a repository. Every file in it is still real
        // local-only work and must be named before a destructive delete.
      }
      if (!isGit) {
        if (checkout.sessionId) throw new Error('recorded worktree is not a Git working tree')
        for (const localPath of plainFiles(checkout.path)) {
          changes.push({
            kind: 'untracked',
            path: localPath,
            checkoutPath: checkout.path,
          })
        }
        continue
      }
      const modified = new Set([
        ...nulPaths(checkout.path, ['diff', '--name-only', '-z']),
        ...nulPaths(checkout.path, ['diff', '--cached', '--name-only', '-z']),
      ])
      for (const changedPath of modified) {
        changes.push({
          kind: 'uncommitted',
          path: changedPath,
          checkoutPath: checkout.path,
          ...(checkout.sessionId ? { sessionId: checkout.sessionId } : {}),
        })
      }
      for (const untrackedPath of nulPaths(checkout.path, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ])) {
        changes.push({
          kind: 'untracked',
          path: untrackedPath,
          checkoutPath: checkout.path,
          ...(checkout.sessionId ? { sessionId: checkout.sessionId } : {}),
        })
      }
      commits.push(...localCommits(checkout))
    } catch (error) {
      inspectionErrors.push({
        path: checkout.path,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    projectId: project.id,
    projectPath,
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title?.trim() || session.role?.trim() || session.id.slice(0, 8),
      status: session.status,
      cwd: canonical(session.cwd),
    })),
    changes,
    localCommits: commits,
    worktrees,
    inspectionErrors,
  }
}
