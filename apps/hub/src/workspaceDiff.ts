import { spawn } from 'node:child_process'
import type { SessionRecord } from './types.js'

const MAX_DIFF_BYTES = 1024 * 1024
const MAX_META_BYTES = 128 * 1024
const GIT_TIMEOUT_MS = 10_000

export interface WorkspaceDiffResult {
  baseRef: string
  baseCommit: string
  headCommit: string
  branch?: string
  files: Array<{ status: string; path: string }>
  untracked: string[]
  patch: string
  truncated: boolean
  repositoryUrl?: string
  headUrl?: string
  baseUrl?: string
  compareUrl?: string
}

function githubRepositoryUrl(raw: string): string | undefined {
  const value = raw.trim().replace(/\.git$/iu, '')
  const match = /^(?:https?:\/\/(?:[^/@]+@)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/(?:git@)?github\.com\/)([^/]+)\/([^/]+)$/iu.exec(value)
  return match ? `https://github.com/${match[1]}/${match[2]}` : undefined
}

function validateRef(raw: string): string {
  const value = raw.trim()
  if (!value || value.length > 256 || value.startsWith('-') || /[\u0000-\u0020\u007f\\]/u.test(value)) {
    throw new Error('diff base is not a valid bounded Git revision')
  }
  return value
}

function processSpec(record: SessionRecord, args: string[]): { program: string; args: string[] } {
  if (record.wslDistro && record.executionCwd) {
    return {
      program: 'wsl.exe',
      args: [
        '--distribution', record.wslDistro,
        '--cd', record.executionCwd,
        '--exec', 'git', '-c', 'core.pager=cat', '-C', record.executionCwd,
        ...args,
      ],
    }
  }
  return {
    program: 'git',
    args: ['-c', 'core.pager=cat', '-C', record.worktree ?? record.cwd, ...args],
  }
}

async function git(
  record: SessionRecord,
  args: string[],
  maximum = MAX_META_BYTES,
): Promise<{ stdout: string; truncated: boolean }> {
  const spec = processSpec(record, args)
  return new Promise((resolve, reject) => {
    const child = spawn(spec.program, spec.args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = maximum - stdoutBytes
      if (remaining > 0) stdout.push(chunk.subarray(0, remaining))
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maximum) truncated = true
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = 32 * 1024 - stderrBytes
      if (remaining > 0) stderr.push(chunk.subarray(0, remaining))
      stderrBytes += chunk.byteLength
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 2_000)
        reject(new Error(detail || `git exited ${code ?? signal ?? 'without a status'}`))
        return
      }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), truncated })
    })
  })
}

function parseNameStatus(raw: string): Array<{ status: string; path: string }> {
  return raw.split(/\r?\n/u).flatMap((line) => {
    if (!line) return []
    const [status, ...paths] = line.split('\t')
    const file = paths.at(-1)
    return status && file ? [{ status, path: file }] : []
  })
}

function parseUntracked(raw: string): string[] {
  const entries = raw.split('\0')
  const files: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue
    const status = entry.slice(0, 2)
    if (status === '??') files.push(entry.slice(3))
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return files
}

export async function inspectWorkspaceDiff(
  record: SessionRecord,
  requestedBase?: string,
): Promise<WorkspaceDiffResult> {
  if (!record.repo && !record.worktree) throw new Error('this chat has no Git checkout')
  const baseRef = validateRef(requestedBase ?? record.baseRef ?? record.baseCommit ?? 'refs/heads/main')
  const [base, head, branch, origin] = await Promise.all([
    git(record, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]),
    git(record, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(record, ['branch', '--show-current']),
    git(record, ['remote', 'get-url', 'origin']).catch(() => ({ stdout: '', truncated: false })),
  ])
  const baseCommit = base.stdout.trim()
  const headCommit = head.stdout.trim()
  const [patch, names, status] = await Promise.all([
    git(record, ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--no-color', baseCommit, '--'], MAX_DIFF_BYTES),
    git(record, ['diff', '--name-status', '--no-ext-diff', '--no-textconv', '--find-renames', baseCommit, '--']),
    git(record, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ])
  const repositoryUrl = githubRepositoryUrl(origin.stdout)
  return {
    baseRef,
    baseCommit,
    headCommit,
    ...(branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
    files: parseNameStatus(names.stdout),
    untracked: parseUntracked(status.stdout),
    patch: patch.stdout,
    truncated: patch.truncated,
    ...(repositoryUrl ? {
      repositoryUrl,
      headUrl: `${repositoryUrl}/commit/${headCommit}`,
      baseUrl: `${repositoryUrl}/commit/${baseCommit}`,
      compareUrl: `${repositoryUrl}/compare/${baseCommit}...${headCommit}`,
    } : {}),
  }
}
