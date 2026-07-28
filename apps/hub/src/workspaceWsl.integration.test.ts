import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceManager } from './workspace.js'
import { parseWslDistroList } from './wsl.js'
import { wslHostPath } from './workspaceLocation.js'

function installedTestDistro(): string | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const listed = execFileSync('wsl.exe', ['--list', '--verbose'])
    const requested = process.env.AMA_WSL_TEST_DISTRO
    return parseWslDistroList(listed).find(
      (candidate) =>
        candidate.version === 2 &&
        !/^docker-desktop(?:-data)?$/i.test(candidate.name) &&
        (!requested || candidate.name.toLowerCase() === requested.toLowerCase()),
    )?.name
  } catch {
    return undefined
  }
}

const distro = installedTestDistro()
const linuxRoots: string[] = []
const hostRoots: string[] = []

function wsl(cwd: string, program: string, ...args: string[]): string {
  return execFileSync(
    'wsl.exe',
    ['--distribution', distro!, '--cd', cwd, '--exec', program, ...args],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
}

afterEach(() => {
  for (const root of linuxRoots.splice(0)) {
    if (!root.startsWith('/tmp/ama-wsl-integration-')) continue
    try {
      wsl('/tmp', 'rm', '-rf', root)
    } catch {
      // A failed assertion should not hide the primary failure behind cleanup.
    }
  }
  for (const root of hostRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!distro)('WorkspaceManager real WSL 2 integration', () => {
  it('creates, inspects, and removes a worktree natively inside the project distro', () => {
    const linuxRoot = `/tmp/ama-wsl-integration-${crypto.randomUUID()}`
    const linuxRepo = path.posix.join(linuxRoot, 'repo')
    linuxRoots.push(linuxRoot)
    wsl('/tmp', 'mkdir', '-p', linuxRepo)
    wsl(linuxRepo, 'git', 'init')
    wsl(
      linuxRepo,
      'git',
      '-C',
      linuxRepo,
      '-c',
      'user.name=AllMyAgents Test',
      '-c',
      'user.email=wsl-test@allmyagents.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    )

    const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-wsl-manager-'))
    hostRoots.push(hostRoot)
    const workspace = new WorkspaceManager(path.join(hostRoot, 'worktrees'))
    const location = {
      kind: 'wsl' as const,
      distro: distro!,
      linuxPath: linuxRepo,
    }
    const repoHostPath = wslHostPath(distro!, linuxRepo)

    const created = workspace.create(repoHostPath, '12345678-wsl-test', location)

    expect(created.distro).toBe(distro)
    expect(created.executionPath).toBe(
      path.posix.join(linuxRoot, '.allmyagents-worktrees', '12345678'),
    )
    expect(fs.existsSync(created.worktree)).toBe(true)
    expect(
      wsl(created.executionPath!, 'git', '-C', created.executionPath!, 'rev-parse', '--show-toplevel'),
    ).toBe(created.executionPath)
    expect(
      workspace.inspect(repoHostPath, created.worktree, {
        distro: distro!,
        repoPath: linuxRepo,
        worktreePath: created.executionPath!,
      }),
    ).toEqual({ ok: true, dirty: false })

    expect(
      workspace.remove(repoHostPath, created.worktree, {
        distro: distro!,
        repoPath: linuxRepo,
        worktreePath: created.executionPath!,
      }),
    ).toEqual({ ok: true })
    expect(fs.existsSync(created.worktree)).toBe(false)
  }, 30_000)
})
