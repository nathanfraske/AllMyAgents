import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GitHubImportService,
  githubCloneArgs,
  type CommandResult,
  type GitHubCloneHandle,
  type GitHubCommands,
  type GitHubRepository,
} from './githubImport.js'
import type { Project } from './types.js'

const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-github-import-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const repo: GitHubRepository = {
  nameWithOwner: 'octo/example',
  name: 'example',
  description: 'A useful repository',
  private: true,
  archived: false,
  defaultBranch: 'main',
  updatedAt: '2026-07-27T12:00:00Z',
  supported: true,
}

class FakeCommands implements GitHubCommands {
  cloneExitCode = 0
  cloneError = ''
  cloneWasCancelled = false
  cloneTarget = ''

  async run(program: 'gh' | 'git', args: readonly string[]): Promise<CommandResult> {
    if (program === 'gh' && args[0] === '--version') return { exitCode: 0, stdout: 'gh version 2.95.0', stderr: '' }
    if (program === 'gh' && args[0] === 'auth') return { exitCode: 0, stdout: '', stderr: '' }
    if (program === 'gh' && args[0] === 'config') return { exitCode: 0, stdout: 'https\n', stderr: '' }
    if (program === 'git' && args[0] === '--version') return { exitCode: 0, stdout: 'git version 2.50.0', stderr: '' }
    if (program === 'gh' && args[0] === 'repo' && args[1] === 'list') {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            nameWithOwner: repo.nameWithOwner,
            name: repo.name,
            description: repo.description,
            isPrivate: repo.private,
            isArchived: repo.archived,
            defaultBranchRef: { name: repo.defaultBranch },
            updatedAt: repo.updatedAt,
          },
          {
            nameWithOwner: 'octo/empty',
            name: 'empty',
            description: '',
            isPrivate: false,
            isArchived: false,
            // Real `gh repo list` uses a blank name for some empty repositories, rather than null.
            defaultBranchRef: { name: '' },
            updatedAt: repo.updatedAt,
          },
        ]),
        stderr: '',
      }
    }
    if (program === 'git' && args.includes('--is-inside-work-tree')) {
      return { exitCode: 0, stdout: 'true\n', stderr: '' }
    }
    if (program === 'git' && args.includes('HEAD')) return { exitCode: 0, stdout: 'abc123\n', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
  }

  clone(_nameWithOwner: string, target: string, onProgress: (text: string) => void, onExit: (exitCode: number, error?: string) => void): GitHubCloneHandle {
    this.cloneTarget = target
    fs.mkdirSync(path.join(target, '.git'), { recursive: true })
    queueMicrotask(() => {
      onProgress('Receiving objects: 42% (42/100)')
      onExit(this.cloneExitCode, this.cloneError)
    })
    return {
      cancel: () => {
        this.cloneWasCancelled = true
        onExit(130, 'clone cancelled')
      },
    }
  }
}

async function waitForTerminal(service: GitHubImportService, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = service.job(id)
    if (job && (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled')) return job
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('clone job did not finish')
}

describe('GitHubImportService', () => {
  it('enables long Windows paths for this clone without changing global Git config', () => {
    expect(githubCloneArgs('octo/example', 'C:/long/sandbox/path')).toEqual([
      'repo',
      'clone',
      'octo/example',
      'C:/long/sandbox/path',
      '--',
      '--config',
      'core.longpaths=true',
      '--progress',
    ])
  })

  it('reports unavailable without GitHub CLI instead of assuming it exists', async () => {
    const commands = new FakeCommands()
    commands.run = async (program, args) =>
      program === 'gh' && args[0] === '--version'
        ? { exitCode: 127, stdout: '', stderr: 'not found' }
        : { exitCode: 0, stdout: '', stderr: '' }
    const service = new GitHubImportService(tempRoot(), () => {
      throw new Error('must not create a project')
    }, commands)

    await expect(service.capability()).resolves.toEqual({
      available: false,
      reason: 'GitHub import is not available because GitHub CLI is not installed.',
    })
  })

  it('lists authenticated personal repositories and clearly rejects one with no default branch', async () => {
    const service = new GitHubImportService(tempRoot(), () => {
      throw new Error('must not create a project')
    }, new FakeCommands())

    const listed = await service.repositories()

    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ nameWithOwner: 'octo/example', private: true, supported: true })
    expect(listed[1]).toMatchObject({
      nameWithOwner: 'octo/empty',
      supported: false,
      unsupportedReason: 'This repository has no default branch.',
    })
  })

  it('stages, validates, atomically moves, and only then creates the project', async () => {
    const root = tempRoot()
    const commands = new FakeCommands()
    let createdPath = ''
    const service = new GitHubImportService(
      root,
      (name, projectPath): Project => {
        createdPath = projectPath
        expect(fs.existsSync(path.join(projectPath, '.git'))).toBe(true)
        expect(projectPath).toBe(path.join(root, 'octo', 'example'))
        return { id: 'project-1', name, path: projectPath, createdAt: '2026-07-27T12:00:00Z' }
      },
      commands
    )
    await service.repositories()

    const started = service.start(repo.nameWithOwner)
    const done = await waitForTerminal(service, started.id)

    expect(done).toMatchObject({
      status: 'complete',
      progress: { stage: 'complete', percent: 100 },
      project: { id: 'project-1', name: 'example' },
    })
    expect(createdPath).toBe(path.join(root, 'octo', 'example'))
    expect(fs.existsSync(commands.cloneTarget)).toBe(false)
  })

  it('removes a failed partial clone and never creates a project record', async () => {
    const root = tempRoot()
    const commands = new FakeCommands()
    commands.cloneExitCode = 128
    commands.cloneError = 'network connection was interrupted'
    let created = false
    const service = new GitHubImportService(
      root,
      (): Project => {
        created = true
        throw new Error('must not create a project')
      },
      commands
    )
    await service.repositories()

    const started = service.start(repo.nameWithOwner)
    const done = await waitForTerminal(service, started.id)

    expect(done).toMatchObject({ status: 'failed', error: 'network connection was interrupted' })
    expect(created).toBe(false)
    expect(fs.existsSync(commands.cloneTarget)).toBe(false)
    expect(fs.existsSync(path.join(root, 'octo', 'example'))).toBe(false)
  })

  it('removes stale app-owned partial clones on startup without touching completed repositories', () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, '.ama-partials', 'stale', '.git'), { recursive: true })
    fs.mkdirSync(path.join(root, 'octo', 'kept', '.git'), { recursive: true })

    new GitHubImportService(root, () => {
      throw new Error('must not create a project')
    }, new FakeCommands())

    expect(fs.existsSync(path.join(root, '.ama-partials', 'stale'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'octo', 'kept', '.git'))).toBe(true)
  })
})
