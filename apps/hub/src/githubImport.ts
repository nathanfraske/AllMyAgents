import crypto from 'node:crypto'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Project } from './types.js'
import { wslHostPath } from './workspaceLocation.js'
import { nativeWslExecutable, spawnInWsl } from './wslProcess.js'

export interface GitHubCapability {
  available: boolean
  reason?: string
}

export interface GitHubRepository {
  nameWithOwner: string
  name: string
  description: string
  private: boolean
  archived: boolean
  defaultBranch: string | null
  updatedAt: string
  supported: boolean
  unsupportedReason?: string
}

export interface GitHubCloneProgress {
  stage: 'queued' | 'cloning' | 'validating' | 'complete'
  percent?: number
  message: string
}

export interface GitHubCloneJob {
  id: string
  repository: Pick<GitHubRepository, 'nameWithOwner' | 'name' | 'private'>
  status: 'queued' | 'cloning' | 'validating' | 'complete' | 'failed' | 'cancelled'
  progress: GitHubCloneProgress
  createdAt: string
  updatedAt: string
  project?: Project
  error?: string
  destination?: GitHubCloneDestination
}

export type GitHubCloneDestination =
  | { kind: 'local' }
  | { kind: 'wsl'; distro: string }

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface GitHubCloneHandle {
  cancel(): void
}

export interface GitHubCommands {
  run(program: 'gh' | 'git', args: readonly string[]): Promise<CommandResult>
  clone(
    nameWithOwner: string,
    target: string,
    onProgress: (text: string) => void,
    onExit: (exitCode: number, error?: string) => void
  ): GitHubCloneHandle
}

type CreateProject = (
  name: string,
  projectPath: string,
  location?: NonNullable<Project['location']>,
) => Project

const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024
const MAX_ERROR_LENGTH = 500
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const TOKEN_SHAPES = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
]

function safeMessage(raw: string, fallback: string): string {
  let message = raw
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
  for (const shape of TOKEN_SHAPES) message = message.replace(shape, '[credential redacted]')
  return (message || fallback).slice(0, MAX_ERROR_LENGTH)
}

function defaultRun(program: 'gh' | 'git', args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(program, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      resolve({ exitCode, stdout, stderr })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.slice(0, MAX_COMMAND_OUTPUT - stdout.length)
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_COMMAND_OUTPUT) stderr += chunk.slice(0, MAX_COMMAND_OUTPUT - stderr.length)
    })
    child.once('error', (error) => {
      stderr = error.message
      finish(127)
    })
    child.once('close', (code) => finish(code ?? 1))
  })
}

function progressFrom(line: string): GitHubCloneProgress | null {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim()
  if (!clean) return null
  const match = /(Enumerating|Counting|Compressing|Receiving|Resolving|Updating) (?:objects|deltas|files)?:?\s*(\d+)%/i.exec(clean)
  if (match) {
    return {
      stage: 'cloning',
      percent: Math.min(99, Math.max(0, Number(match[2]))),
      message: `${match[1]} ${match[2]}%`,
    }
  }
  if (/cloning into/i.test(clean)) return { stage: 'cloning', percent: 0, message: 'Preparing repository…' }
  return null
}

export function githubCloneArgs(nameWithOwner: string, target: string): string[] {
  return [
    'repo',
    'clone',
    nameWithOwner,
    target,
    '--',
    // Applied to THIS clone/repository only (never the user's global Git config). The installed app and
    // sandbox both live under long per-user Windows paths; without this, a tiny private repo reached 100%
    // and then failed writing `.git/objects/pack/*.keep` with "Filename too long".
    '--config',
    'core.longpaths=true',
    '--progress',
  ]
}

class NodeGitHubCommands implements GitHubCommands {
  run(program: 'gh' | 'git', args: readonly string[]): Promise<CommandResult> {
    return defaultRun(program, args)
  }

  clone(
    nameWithOwner: string,
    target: string,
    onProgress: (text: string) => void,
    onExit: (exitCode: number, error?: string) => void
  ): GitHubCloneHandle {
    const running = spawn('gh', githubCloneArgs(nameWithOwner, target), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let child: ChildProcess | null = running
    let settled = false
    let errorTail = ''
    const finish = (exitCode: number, error?: string): void => {
      if (settled) return
      settled = true
      child = null
      onExit(exitCode, error)
    }
    running.stderr.setEncoding('utf8')
    running.stderr.on('data', (chunk: string) => {
      errorTail = (errorTail + chunk).slice(-MAX_ERROR_LENGTH)
      for (const line of chunk.split(/[\r\n]+/)) onProgress(line)
    })
    running.stdout.resume()
    running.once('error', (error) => finish(127, error.message))
    running.once('close', (code) => finish(code ?? 1, code === 0 ? undefined : safeMessage(errorTail, 'GitHub clone failed.')))
    return {
      cancel: () => {
        if (child && !settled) child.kill()
      },
    }
  }
}

interface RepoListRow {
  nameWithOwner?: unknown
  name?: unknown
  description?: unknown
  isPrivate?: unknown
  isArchived?: unknown
  defaultBranchRef?: { name?: unknown } | null
  updatedAt?: unknown
}

/**
 * Optional GitHub import using an EXISTING `gh` login.
 *
 * Authentication deliberately stays inside GitHub CLI's own credential store. The hub never asks for,
 * receives, logs, persists, or forwards a GitHub token. Clones stage under the app-owned `.ama-partials`
 * directory, are validated as a checked-out repository with a real HEAD, then move atomically to their
 * final path. ProjectStore is called only after that move, so a slow, failed, or interrupted clone cannot
 * leave a project record pointing at an empty/partial directory.
 */
export class GitHubImportService {
  private readonly repositoriesRoot: string
  private readonly partialsRoot: string
  private readonly commands: GitHubCommands
  private readonly knownRepositories = new Map<string, GitHubRepository>()
  private readonly jobs = new Map<string, GitHubCloneJob>()

  constructor(
    repositoriesRoot: string,
    private readonly createProject: CreateProject,
    commands: GitHubCommands = new NodeGitHubCommands()
  ) {
    this.repositoriesRoot = path.resolve(repositoriesRoot)
    this.partialsRoot = path.join(this.repositoriesRoot, '.ama-partials')
    this.commands = commands
    fs.mkdirSync(this.repositoriesRoot, { recursive: true })
    // This directory is exclusively clone staging owned by this service. Clearing it on startup recovers
    // from a killed hub/desktop without ever touching a completed repository or a user-chosen folder.
    fs.rmSync(this.partialsRoot, { recursive: true, force: true })
    fs.mkdirSync(this.partialsRoot, { recursive: true })
  }

  async capability(): Promise<GitHubCapability> {
    const gh = await this.commands.run('gh', ['--version'])
    if (gh.exitCode !== 0) {
      return { available: false, reason: 'GitHub import is not available because GitHub CLI is not installed.' }
    }
    const git = await this.commands.run('git', ['--version'])
    if (git.exitCode !== 0) {
      return { available: false, reason: 'GitHub import is not available because Git is not installed.' }
    }
    const auth = await this.commands.run('gh', ['auth', 'status', '--hostname', 'github.com'])
    if (auth.exitCode !== 0) {
      return {
        available: false,
        reason: 'No signed-in GitHub CLI session is available. This version does not collect GitHub credentials.',
      }
    }
    const protocol = await this.commands.run('gh', ['config', 'get', 'git_protocol', '--host', 'github.com'])
    if (protocol.exitCode !== 0 || protocol.stdout.trim().toLowerCase() !== 'https') {
      return {
        available: false,
        reason: 'GitHub import currently supports HTTPS GitHub CLI sessions only; this session is configured for SSH.',
      }
    }
    return { available: true }
  }

  async repositories(): Promise<GitHubRepository[]> {
    const capability = await this.capability()
    if (!capability.available) throw new Error(capability.reason)
    const result = await this.commands.run('gh', [
      'repo',
      'list',
      '--limit',
      '100',
      '--json',
      'nameWithOwner,name,description,isPrivate,isArchived,defaultBranchRef,updatedAt',
    ])
    if (result.exitCode !== 0) throw new Error(safeMessage(result.stderr, 'Could not load GitHub repositories.'))
    let rows: RepoListRow[]
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (!Array.isArray(parsed)) throw new Error('expected an array')
      rows = parsed as RepoListRow[]
    } catch {
      throw new Error('GitHub CLI returned an unreadable repository list.')
    }
    const repositories = rows.flatMap((row): GitHubRepository[] => {
      const nameWithOwner = typeof row.nameWithOwner === 'string' ? row.nameWithOwner : ''
      const name = typeof row.name === 'string' ? row.name : ''
      if (!REPOSITORY_NAME.test(nameWithOwner) || !name) return []
      const branchName =
        row.defaultBranchRef && typeof row.defaultBranchRef.name === 'string' ? row.defaultBranchRef.name.trim() : ''
      // GitHub CLI returns `{ name: "" }` (not null) for some empty repositories.
      const defaultBranch = branchName || null
      return [
        {
          nameWithOwner,
          name,
          description: typeof row.description === 'string' ? row.description : '',
          private: row.isPrivate === true,
          archived: row.isArchived === true,
          defaultBranch,
          updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
          supported: defaultBranch !== null,
          ...(defaultBranch === null ? { unsupportedReason: 'This repository has no default branch.' } : {}),
        },
      ]
    })
    this.knownRepositories.clear()
    for (const repository of repositories) this.knownRepositories.set(repository.nameWithOwner, repository)
    return repositories
  }

  start(
    nameWithOwner: string,
    destination: GitHubCloneDestination = { kind: 'local' },
  ): GitHubCloneJob {
    const repository = this.knownRepositories.get(nameWithOwner)
    if (!repository) throw new Error('Refresh the GitHub repository list before cloning.')
    if (!repository.supported) throw new Error(repository.unsupportedReason ?? 'This repository is not supported.')
    const wslDestination =
      destination.kind === 'wsl'
        ? this.resolveWslDestination(destination.distro, repository)
        : undefined
    const finalPath = wslDestination?.hostPath ?? this.finalPath(repository)
    if (fs.existsSync(finalPath)) {
      throw new Error(`A repository folder already exists for ${repository.nameWithOwner}. Add that local folder instead.`)
    }
    const now = new Date().toISOString()
    const job: GitHubCloneJob = {
      id: crypto.randomUUID(),
      repository: {
        nameWithOwner: repository.nameWithOwner,
        name: repository.name,
        private: repository.private,
      },
      status: 'queued',
      progress: { stage: 'queued', percent: 0, message: 'Waiting to clone…' },
      createdAt: now,
      updatedAt: now,
      destination,
    }
    this.jobs.set(job.id, job)
    this.pruneJobs()
    void (wslDestination
      ? this.performWslClone(job, repository, wslDestination)
      : this.performClone(job, repository, finalPath))
    return { ...job, progress: { ...job.progress } }
  }

  job(id: string): GitHubCloneJob | undefined {
    const job = this.jobs.get(id)
    return job ? { ...job, progress: { ...job.progress } } : undefined
  }

  private finalPath(repository: GitHubRepository): string {
    const [owner] = repository.nameWithOwner.split('/')
    return path.join(this.repositoriesRoot, owner!, repository.name)
  }

  private resolveWslDestination(
    distro: string,
    repository: GitHubRepository,
  ): { distro: string; linuxPath: string; hostPath: string; gh: string; git: string } {
    const gh = nativeWslExecutable(distro, 'gh')
    const git = nativeWslExecutable(distro, 'git')
    const home = execFileSync(
      'wsl.exe',
      [
        '--distribution',
        distro,
        '--exec',
        'sh',
        '-lc',
        'printf %s "$HOME"',
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim()
    if (!home.startsWith('/')) throw new Error(`Could not resolve the home directory inside ${distro}.`)
    const [owner] = repository.nameWithOwner.split('/')
    const linuxPath = path.posix.join(
      home,
      '.local',
      'share',
      'allmyagents',
      'repositories',
      owner!,
      repository.name,
    )
    return { distro, linuxPath, hostPath: wslHostPath(distro, linuxPath), gh, git }
  }

  private setProgress(job: GitHubCloneJob, progress: GitHubCloneProgress): void {
    job.progress = progress
    job.updatedAt = new Date().toISOString()
  }

  private async performClone(job: GitHubCloneJob, repository: GitHubRepository, finalPath: string): Promise<void> {
    const partialPath = path.join(this.partialsRoot, job.id)
    fs.mkdirSync(partialPath, { recursive: true })
    job.status = 'cloning'
    this.setProgress(job, { stage: 'cloning', percent: 0, message: 'Starting clone…' })
    try {
      const result = await new Promise<{ exitCode: number; error?: string }>((resolve) => {
        this.commands.clone(
          repository.nameWithOwner,
          partialPath,
          (line) => {
            const progress = progressFrom(line)
            if (progress) this.setProgress(job, progress)
          },
          (exitCode, error) => resolve({ exitCode, error })
        )
      })
      if (result.exitCode !== 0) throw new Error(safeMessage(result.error ?? '', 'GitHub clone failed.'))

      job.status = 'validating'
      this.setProgress(job, { stage: 'validating', percent: 99, message: 'Validating repository…' })
      const workTree = await this.commands.run('git', ['-C', partialPath, 'rev-parse', '--is-inside-work-tree'])
      const head = await this.commands.run('git', ['-C', partialPath, 'rev-parse', '--verify', 'HEAD'])
      if (workTree.exitCode !== 0 || workTree.stdout.trim() !== 'true' || head.exitCode !== 0 || !head.stdout.trim()) {
        throw new Error('Clone finished without a checked-out default branch; no project was created.')
      }
      if (!fs.existsSync(path.join(partialPath, '.git'))) {
        throw new Error('Clone validation failed because Git metadata is missing; no project was created.')
      }
      fs.mkdirSync(path.dirname(finalPath), { recursive: true })
      if (fs.existsSync(finalPath)) throw new Error('The destination folder appeared while cloning; no project was created.')
      fs.renameSync(partialPath, finalPath)

      try {
        job.project = this.createProject(repository.name, finalPath)
      } catch (error) {
        throw new Error(
          `The repository was cloned successfully but could not be added as a project: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      job.status = 'complete'
      this.setProgress(job, { stage: 'complete', percent: 100, message: 'Repository ready.' })
    } catch (error) {
      job.status = 'failed'
      job.error = safeMessage(error instanceof Error ? error.message : String(error), 'GitHub clone failed.')
      job.updatedAt = new Date().toISOString()
    } finally {
      fs.rmSync(partialPath, { recursive: true, force: true })
    }
  }

  private wslRun(
    distro: string,
    cwd: string,
    program: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        'wsl.exe',
        ['--distribution', distro, '--cd', cwd, '--exec', program, ...args],
        { encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) =>
          resolve({
            exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
              ? Number((error as NodeJS.ErrnoException).code)
              : error
                ? 1
                : 0,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
          }),
      )
    })
  }

  private async performWslClone(
    job: GitHubCloneJob,
    repository: GitHubRepository,
    destination: { distro: string; linuxPath: string; hostPath: string; gh: string; git: string },
  ): Promise<void> {
    const partialPath = path.posix.join(
      path.posix.dirname(destination.linuxPath),
      '.ama-partials',
      job.id,
    )
    const partialParent = path.posix.dirname(partialPath)
    job.status = 'cloning'
    this.setProgress(job, { stage: 'cloning', percent: 0, message: `Starting clone in ${destination.distro}…` })
    try {
      const made = await this.wslRun(destination.distro, '/', 'mkdir', ['-p', partialParent])
      if (made.exitCode !== 0) throw new Error(safeMessage(made.stderr, 'Could not create the WSL clone staging directory.'))
      const result = await new Promise<{ exitCode: number; error?: string }>((resolve) => {
        const running = spawnInWsl(
          destination.distro,
          '/',
          destination.gh,
          ['repo', 'clone', repository.nameWithOwner, partialPath, '--', '--progress'],
          {},
        )
        let settled = false
        let errorTail = ''
        const finish = (exitCode: number, error?: string): void => {
          if (settled) return
          settled = true
          resolve({ exitCode, error })
        }
        running.stderr?.setEncoding('utf8')
        running.stderr?.on('data', (chunk: string) => {
          errorTail = (errorTail + chunk).slice(-MAX_ERROR_LENGTH)
          for (const line of chunk.split(/[\r\n]+/)) {
            const progress = progressFrom(line)
            if (progress) this.setProgress(job, progress)
          }
        })
        running.stdout?.resume()
        running.once('error', (error) => finish(127, error.message))
        running.once('close', (code) =>
          finish(code ?? 1, code === 0 ? undefined : safeMessage(errorTail, 'GitHub clone failed.')),
        )
      })
      if (result.exitCode !== 0) throw new Error(safeMessage(result.error ?? '', 'GitHub clone failed.'))

      job.status = 'validating'
      this.setProgress(job, { stage: 'validating', percent: 99, message: 'Validating repository inside WSL…' })
      const workTree = await this.wslRun(destination.distro, partialPath, destination.git, [
        '-C',
        partialPath,
        'rev-parse',
        '--is-inside-work-tree',
      ])
      const head = await this.wslRun(destination.distro, partialPath, destination.git, [
        '-C',
        partialPath,
        'rev-parse',
        '--verify',
        'HEAD',
      ])
      if (workTree.exitCode !== 0 || workTree.stdout.trim() !== 'true' || head.exitCode !== 0) {
        throw new Error('Clone finished without a checked-out default branch; no project was created.')
      }
      const finalParent = path.posix.dirname(destination.linuxPath)
      const madeFinal = await this.wslRun(destination.distro, '/', 'mkdir', ['-p', finalParent])
      if (madeFinal.exitCode !== 0) throw new Error('Could not create the final WSL repository directory.')
      const moved = await this.wslRun(destination.distro, '/', 'mv', [partialPath, destination.linuxPath])
      if (moved.exitCode !== 0) {
        throw new Error(safeMessage(moved.stderr, 'Could not move the WSL clone into its final directory.'))
      }
      job.project = this.createProject(repository.name, destination.hostPath, {
        kind: 'wsl',
        distro: destination.distro,
        linuxPath: destination.linuxPath,
      })
      job.status = 'complete'
      this.setProgress(job, { stage: 'complete', percent: 100, message: 'Repository ready in WSL.' })
    } catch (error) {
      job.status = 'failed'
      job.error = safeMessage(error instanceof Error ? error.message : String(error), 'GitHub clone failed.')
      job.updatedAt = new Date().toISOString()
    } finally {
      await this.wslRun(destination.distro, '/', 'rm', ['-rf', partialPath]).catch(() => undefined)
    }
  }

  private pruneJobs(): void {
    if (this.jobs.size <= 100) return
    for (const [id, job] of this.jobs) {
      if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') this.jobs.delete(id)
      if (this.jobs.size <= 100) return
    }
  }
}
