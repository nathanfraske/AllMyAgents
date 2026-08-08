import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Project, SessionRecord } from './types.js'

const MAX_RENDERED_CHANGES = 500
const INSPECTION_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024

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
  /** Exact number discovered when inspection completed. `changes` is a bounded display sample. */
  changeCount: number
  changesTruncated: boolean
  localCommits: ProjectDeletionCommit[]
  worktrees: ProjectDeletionWorktree[]
  inspectionErrors: Array<{ path: string; message: string }>
}

interface Checkout {
  path: string
  sessionId?: string
  baseCommit?: string
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error(`inspection exceeded ${INSPECTION_TIMEOUT_MS / 1_000} seconds`)
  return remaining
}

function git(cwd: string, args: string[], deadline: number): Promise<string> {
  const timeout = remainingMs(deadline)
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout)
        return
      }
      const message = stderr.trim() || error.message
      reject(new Error(message))
    })
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

async function nulPaths(cwd: string, args: string[], deadline: number): Promise<string[]> {
  return (await git(cwd, args, deadline))
    .split('\0')
    .filter(Boolean)
    .map((relative) => path.resolve(cwd, relative))
}

async function plainFiles(
  root: string,
  deadline: number,
): Promise<{ files: string[]; count: number }> {
  const files: string[] = []
  let count = 0
  let visited = 0
  const pending = [root]
  while (pending.length) {
    remainingMs(deadline)
    const current = pending.pop()!
    const directory = await fs.promises.opendir(current)
    for await (const entry of directory) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else {
        count += 1
        if (files.length < MAX_RENDERED_CHANGES) files.push(target)
      }
      visited += 1
      if (visited % 256 === 0) {
        remainingMs(deadline)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }
  return { files: files.sort(), count }
}

async function localCommits(checkout: Checkout, deadline: number): Promise<ProjectDeletionCommit[]> {
  let range = 'HEAD'
  try {
    const upstream = (await git(checkout.path, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ], deadline)).trim()
    if (upstream) range = `${upstream}..HEAD`
  } catch {
    if (checkout.baseCommit) range = `${checkout.baseCommit}..HEAD`
  }

  const raw = await git(checkout.path, [
    'log',
    '--max-count=200',
    '--format=%H%x1f%s%x1e',
    range,
  ], deadline)
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
export async function inspectProjectDeletion(
  project: Project,
  projectSessions: readonly SessionRecord[],
): Promise<ProjectDeletionInspection> {
  const deadline = Date.now() + INSPECTION_TIMEOUT_MS
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
  let changeCount = 0
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
          (await git(checkout.path, ['rev-parse', '--is-inside-work-tree'], deadline)).trim() === 'true' &&
          pathKey((await git(checkout.path, ['rev-parse', '--show-toplevel'], deadline)).trim()) === pathKey(checkout.path)
      } catch {
        // A chosen local directory does not have to be a repository. Every file in it is still real
        // local-only work and must be named before a destructive delete.
      }
      if (!isGit) {
        if (checkout.sessionId) throw new Error('recorded worktree is not a Git working tree')
        const plain = await plainFiles(checkout.path, deadline)
        changeCount += plain.count
        for (const localPath of plain.files) {
          changes.push({
            kind: 'untracked',
            path: localPath,
            checkoutPath: checkout.path,
          })
        }
        continue
      }
      const modified = new Set([
        ...await nulPaths(checkout.path, ['diff', '--name-only', '-z'], deadline),
        ...await nulPaths(checkout.path, ['diff', '--cached', '--name-only', '-z'], deadline),
      ])
      for (const changedPath of modified) {
        changeCount += 1
        if (changes.length < MAX_RENDERED_CHANGES) {
          changes.push({
            kind: 'uncommitted',
            path: changedPath,
            checkoutPath: checkout.path,
            ...(checkout.sessionId ? { sessionId: checkout.sessionId } : {}),
          })
        }
      }
      for (const untrackedPath of await nulPaths(checkout.path, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ], deadline)) {
        changeCount += 1
        if (changes.length < MAX_RENDERED_CHANGES) {
          changes.push({
            kind: 'untracked',
            path: untrackedPath,
            checkoutPath: checkout.path,
            ...(checkout.sessionId ? { sessionId: checkout.sessionId } : {}),
          })
        }
      }
      commits.push(...await localCommits(checkout, deadline))
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
    changeCount,
    changesTruncated: changeCount > changes.length,
    localCommits: commits,
    worktrees,
    inspectionErrors,
  }
}
