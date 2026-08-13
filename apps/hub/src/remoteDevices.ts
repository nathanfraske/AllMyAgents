import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { RemoteDeviceCapability, RemoteDeviceGrant } from './types.js'
import type { DirectHubEnvelope } from './directHubProtocol.js'
import { signDirectHubEnvelope, verifyDirectHubEnvelope } from './directHubProtocol.js'
import type { MyOwnMeshRpcBridge } from './myOwnMeshRpc.js'

const MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_READ_BYTES = 256 * 1024
const MAX_DIRECTORY_ENTRIES = 500
const MAX_COMMAND_CHARS = 16 * 1024
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024
const MAX_REMOTE_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_COMMAND_TIMEOUT_MS = 120_000
const MAX_DEVICE_ROOTS = 128
const MAX_FLEET_CONNECTIONS = 256
const MAX_CONCURRENT_COMMANDS = 8

export interface FleetConnection {
  siteId: string
  label: string
  token: string
  updatedAt: string
}

export interface FleetConnectionPublic extends Omit<FleetConnection, 'token'> {
  paired: true
}

export interface FleetConnectionSaveResult extends FleetConnectionPublic {
  /** False when a periodic fleet refresh merely re-presented the already stored credential. */
  changed: boolean
}

export interface DirectPairResult {
  siteId: string
  label: string
  token: string
  paired: true
}

export interface OverseerPeerStatus extends FleetConnectionPublic {
  online: boolean
  overseerAvailable?: boolean
  transport?: 'myownmesh-rpc' | 'site'
  error?: string
}

export interface DirectRemoteTransport {
  bridge: MyOwnMeshRpcBridge
  localDeviceToken: string
  enabled?: () => boolean
}

function boundedPlain(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const out = value.trim()
  if (!out || out.length > max || /[\u0000-\u001f\u007f]/u.test(out)) {
    throw new Error(`${field} must be a non-empty bounded plain string`)
  }
  return out
}

function atomicPrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temp, file)
    try { fs.chmodSync(file, 0o600) } catch { /* Windows ACLs are inherited from the data directory. */ }
  } finally {
    try { fs.unlinkSync(temp) } catch { /* rename already consumed it */ }
  }
}

/** Hub-owned remote credentials. Tokens never enter an agent prompt or tool result. */
export class FleetConnectionStore {
  private readonly values = new Map<string, FleetConnection>()

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { connections?: unknown }
      if (Array.isArray(parsed.connections)) {
        for (const raw of parsed.connections) {
          const item = raw as Partial<FleetConnection>
          if (
            typeof item.siteId === 'string' && item.siteId.length > 0 && item.siteId.length <= 256 &&
            typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 200 &&
            typeof item.token === 'string' && item.token.length >= 32 && item.token.length <= 512
          ) {
            this.values.set(item.siteId, {
              siteId: item.siteId,
              label: item.label,
              token: item.token,
              updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(),
            })
          }
        }
      }
    } catch {
      /* First run or malformed file: fail closed to no remote credentials. */
    }
  }

  list(): FleetConnectionPublic[] {
    return [...this.values.values()].map(({ token: _token, ...item }) => ({ ...item, paired: true }))
  }

  get(siteId: string): FleetConnection | undefined {
    return this.values.get(siteId)
  }

  upsert(input: { siteId: string; label: string; token: string }): FleetConnectionPublic {
    const siteId = boundedPlain(input.siteId, 'site id', 256)
    const label = boundedPlain(input.label, 'device label', 200)
    const token = boundedPlain(input.token, 'remote device token', 512)
    if (token.length < 32) throw new Error('remote device token is too short')
    const existing = this.values.get(siteId)
    if (existing?.label === label && existing.token === token) {
      const { token: _token, ...publicValue } = existing
      return { ...publicValue, paired: true }
    }
    if (!existing && this.values.size >= MAX_FLEET_CONNECTIONS) {
      throw new Error(`remote device connection limit (${MAX_FLEET_CONNECTIONS}) reached`)
    }
    const value: FleetConnection = { siteId, label, token, updatedAt: new Date().toISOString() }
    this.values.set(siteId, value)
    this.persist()
    const { token: _token, ...publicValue } = value
    return { ...publicValue, paired: true }
  }

  remove(siteId: string): boolean {
    const removed = this.values.delete(siteId)
    if (removed) this.persist()
    return removed
  }

  private persist(): void {
    atomicPrivateJson(this.file, { version: 1, connections: [...this.values.values()] })
  }
}

export interface DeviceRootPolicy {
  id: string
  label: string
  path: string
  /** Absent means the target's host OS. WSL roots use a distro-native absolute Linux path. */
  environment?: { kind: 'wsl'; distro: string }
  read: boolean
  write: boolean
  terminal: boolean
}

export interface DeviceExecutorPolicy {
  enabled: boolean
  roots: DeviceRootPolicy[]
}

export interface DeviceExecutorCapabilities {
  enabled: boolean
  platform: NodeJS.Platform
  arch: string
  hostname: string
  /** Bounded inventory facts for the operator's device overview. Optional on older paired nodes. */
  cpuCount?: number
  totalMemoryBytes?: number
  /** Present when the executor is the vendor-free service rather than a full AllMyAgents hub. */
  nodeKind?: 'hub' | 'lightweight-testbed'
  /** Operator-selected install profile; descriptive only and never an authority token. */
  deploymentProfile?: 'scoped' | 'full-machine' | 'elevated-machine' | 'linux-sudo-machine'
  elevated?: boolean
  environments: RemoteExecutionEnvironment[]
  roots: DeviceRootPolicy[]
}

export interface RemoteExecutionEnvironment {
  id: string
  kind: 'host' | 'wsl'
  label: string
  platform: string
  arch?: string
  shell: string
  distro?: string
  state?: 'running' | 'stopped'
  version?: 1 | 2
  isDefault?: boolean
}

export interface RemoteEnvironmentInspection {
  environmentId: string
  kind: 'host' | 'wsl'
  label: string
  platform: string
  arch: string
  hostname: string
  release: string
  shell: string
  cpuCount: number
  totalMemoryBytes: number
  tools: Record<string, boolean>
}

export interface RemoteDeviceTelemetry {
  /** Time spent locating/refreshing the AllMyStuff route on the source hub. */
  routeMs?: number
  /** HTTP request/response time after the route was resolved. */
  networkMs?: number
  /** End-to-end source-side time. */
  roundTripMs?: number
  /** Time spent executing the operation on the target hub. */
  targetMs?: number
  bytesSent?: number
  bytesReceived?: number
  transferBytes?: number
  transferBytesPerSecond?: number
}

export interface RemoteDeviceFailure {
  stage: 'admission' | 'pairing' | 'route' | 'transport' | 'timeout' | 'protocol' | 'target'
  code?: string
}

export interface RemoteGitInspection {
  status: 'unknown' | 'ready' | 'dirty' | 'not-repository' | 'unavailable'
  gitAvailable: boolean
  isRepository: boolean
  complete: boolean
  clean?: boolean
  detached?: boolean
  headCommit?: string
  headRef?: string
  /** Credential-free host/path identity derived from origin; never the raw remote URL. */
  repository?: string
  trackedChanges?: number
  untrackedFiles?: number
  observedAt: string
  error?: string
}

export type RemoteDeviceAction =
  | { op: 'probe'; rootId: string }
  | { op: 'inspect'; rootId: string }
  | { op: 'git_inspect'; rootId: string }
  | { op: 'git_sync'; rootId: string; repository: string; headRef: string; headCommit: string }
  | { op: 'list'; rootId: string; path?: string }
  | { op: 'read'; rootId: string; path: string; encoding?: 'utf8' | 'base64'; maxBytes?: number }
  | { op: 'mkdir'; rootId: string; path: string; recursive?: boolean }
  | { op: 'write'; rootId: string; path: string; content: string; encoding?: 'utf8' | 'base64' }
  | { op: 'exec'; rootId: string; command: string; cwd?: string; timeoutMs?: number }

export interface RemoteDeviceActionResult {
  ok: boolean
  /** Source-hub durable run identity when this action targeted an attached project replica. */
  runId?: string
  error?: string
  failure?: RemoteDeviceFailure
  telemetry?: RemoteDeviceTelemetry
  environment?: RemoteEnvironmentInspection
  git?: RemoteGitInspection
  entries?: Array<{ name: string; kind: 'file' | 'directory' | 'other'; size?: number }>
  content?: string
  encoding?: 'utf8' | 'base64'
  bytes?: number
  created?: boolean
  truncated?: boolean
  stdout?: string
  stderr?: string
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
}

export interface RemoteDeviceActor {
  sessionId: string
  profileId: string
  runId?: string
  projectId?: string
  replicaId?: string
  agentId?: string
  baseCommit?: string
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

function relativePath(value: unknown, field: string, allowEmpty = false): string {
  if (value === undefined && allowEmpty) return ''
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 4096 || value.includes('\0')) {
    throw new Error(`${field} must be a bounded relative path`)
  }
  if (path.isAbsolute(value)) throw new Error(`${field} must be relative to an approved root`)
  const normalized = path.normalize(value || '.')
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${field} escapes the approved root`)
  }
  return normalized === '.' ? '' : normalized
}

function rootId(realPath: string): string {
  const identity = process.platform === 'win32' || process.platform === 'darwin'
    ? realPath.toLocaleLowerCase('en-US')
    : realPath
  return `root_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20)}`
}

function wslEnvironmentId(distro: string): string {
  return `wsl:${distro}`
}

function environmentValue(name: string): string | undefined {
  const entry = Object.entries(process.env).find(([key]) => key.toUpperCase() === name)
  return entry?.[1]
}

function windowsPowerShell(): { program: string; label: string } {
  const programFiles = environmentValue('PROGRAMFILES')
  const modern = programFiles ? path.join(programFiles, 'PowerShell', '7', 'pwsh.exe') : undefined
  if (modern && fs.existsSync(modern)) return { program: modern, label: 'PowerShell 7' }
  return { program: 'powershell.exe', label: 'Windows PowerShell' }
}

function hostEnvironment(): RemoteExecutionEnvironment {
  return {
    id: 'host',
    kind: 'host',
    label: `${os.hostname()} host`,
    platform: process.platform,
    arch: process.arch,
    shell: process.platform === 'win32' ? windowsPowerShell().label : '/bin/sh',
  }
}

function decodeProcessOutput(value: Buffer | string | null | undefined): string {
  if (typeof value === 'string') return value.replaceAll('\0', '').replace(/^\uFEFF/u, '')
  if (!value) return ''
  let zeroes = 0
  for (let index = 1; index < value.length; index += 2) if (value[index] === 0) zeroes += 1
  return value.toString(value.length > 1 && zeroes > value.length / 8 ? 'utf16le' : 'utf8')
    .replaceAll('\0', '')
    .replace(/^\uFEFF/u, '')
}

/** Parse redirected `wsl.exe --list --verbose` output without starting a stopped distro. */
export function parseRemoteWslEnvironments(output: Buffer | string): RemoteExecutionEnvironment[] {
  const environments: RemoteExecutionEnvironment[] = []
  for (const raw of decodeProcessOutput(output).split(/\r?\n/u)) {
    const line = raw.trimEnd()
    if (!line.trim() || /^\s*NAME\s+STATE\s+VERSION\s*$/iu.test(line)) continue
    const match = /^\s*(\*)?\s*(.+?)\s+(Running|Stopped)\s+([12])\s*$/iu.exec(line)
    if (!match || /^docker-desktop(?:-data)?$/iu.test(match[2]!.trim())) continue
    const distro = match[2]!.trim()
    environments.push({
      id: wslEnvironmentId(distro),
      kind: 'wsl',
      label: `${distro} (WSL)`,
      platform: 'linux',
      shell: '/bin/sh',
      distro,
      state: match[3]!.toLowerCase() === 'running' ? 'running' : 'stopped',
      version: Number(match[4]) as 1 | 2,
      isDefault: match[1] === '*',
    })
  }
  return environments
}

function discoverExecutionEnvironments(): RemoteExecutionEnvironment[] {
  const host = hostEnvironment()
  if (process.platform !== 'win32') return [host]
  const listed = spawnSync('wsl.exe', ['--list', '--verbose'], {
    windowsHide: true,
    encoding: 'buffer',
    timeout: 5_000,
    maxBuffer: 256 * 1024,
  })
  return listed.status === 0 ? [host, ...parseRemoteWslEnvironments(listed.stdout)] : [host]
}

function validateLinuxAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || value.includes('\0')) {
    throw new Error(`${field} must be a bounded absolute Linux path`)
  }
  const normalized = path.posix.normalize(value)
  if (!normalized.startsWith('/')) throw new Error(`${field} must be an absolute Linux path`)
  return normalized
}

/** Project one canonical distro-native path through WSL's local filesystem bridge. */
export function wslUncPath(distro: string, linuxPath: string): string {
  const name = boundedPlain(distro, 'WSL distro', 200)
  if (/[\\/]/u.test(name)) throw new Error('WSL distro must not contain path separators')
  const normalized = validateLinuxAbsolutePath(linuxPath, 'WSL path')
  const suffix = normalized === '/' ? '' : normalized.slice(1).replaceAll('/', '\\')
  return `\\\\wsl.localhost\\${name}${suffix ? `\\${suffix}` : ''}`
}

export function remoteCapabilityForAction(action: RemoteDeviceAction): RemoteDeviceCapability {
  if (action.op === 'write' || action.op === 'mkdir') return 'write'
  // A checkout can invoke configured credential helpers or content filters. Keep it behind the same
  // OS-account authority as a terminal even though callers can supply only bounded Git identities.
  if (action.op === 'exec' || action.op === 'git_sync') return 'terminal'
  return 'read'
}

interface BoundedProcessResult {
  status: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  error?: string
}

function runBoundedProcess(program: string, args: string[], timeoutMs = 5_000): Promise<BoundedProcessResult> {
  return new Promise((resolve) => {
    let settled = false
    let child: ChildProcess
    try {
      child = spawn(program, args, {
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
          ),
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', timedOut: false, truncated: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let truncated = false
    let timedOut = false
    const collect = (target: Buffer[], chunk: Buffer): void => {
      const remaining = 256 * 1024 - bytes
      if (remaining <= 0) { truncated = true; return }
      target.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      bytes += Math.min(chunk.length, remaining)
      if (chunk.length > remaining) truncated = true
    }
    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk))
    const finish = (result: BoundedProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    child.once('error', (error) => finish({
      status: null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      truncated,
      error: error.message,
    }))
    child.once('close', (status) => finish({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      truncated,
    }))
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, stdio: 'ignore', timeout: 5_000,
          })
        } else if (child.pid) {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch { /* already gone */ }
    }, timeoutMs)
    timer.unref?.()
  })
}

function gitCheckoutInvocation(
  input: { path: string; environment?: { kind: 'wsl'; distro: string } },
  args: string[],
  timeoutMs = 5_000,
): Promise<BoundedProcessResult> {
  return input.environment?.kind === 'wsl'
    ? runBoundedProcess('wsl.exe', [
        '--distribution', input.environment.distro, '--cd', input.path, '--exec',
        '/usr/bin/env', 'GIT_OPTIONAL_LOCKS=0', 'GIT_TERMINAL_PROMPT=0', 'LC_ALL=C', 'git', ...args,
      ], timeoutMs)
    : runBoundedProcess('git', ['-C', input.path, ...args], timeoutMs)
}

function repositoryPath(raw: string): string | undefined {
  const value = raw.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '')
  if (!value || value.length > 450 || value.includes('//')) return undefined
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._~+%=-]+$/u.test(part))) {
    return undefined
  }
  return parts.join('/')
}

/** Reduce a Git remote to a credential-free comparison identity. Local/file remotes are unsupported. */
export function normalizeGitRemoteIdentity(raw: string): string | undefined {
  const value = raw.trim()
  if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  // Parse URL syntax first. Without this guard, `https://host/repo` looks like an scp remote whose
  // host is literally `https`, which both corrupts identity and can hide embedded credentials.
  const scp = value.includes('://') ? null : /^(?:[^@\s/:]+@)?([A-Za-z0-9.-]+):(.+)$/u.exec(value)
  if (scp) {
    const repository = repositoryPath(scp[2]!)
    return repository ? `${scp[1]!.toLowerCase()}/${repository}` : undefined
  }
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol) || !parsed.hostname) return undefined
    const repository = repositoryPath(parsed.pathname)
    if (!repository) return undefined
    const port = parsed.port ? `:${parsed.port}` : ''
    return `${parsed.hostname.toLowerCase()}${port}/${repository}`
  } catch {
    return undefined
  }
}

function boundedRepositoryIdentity(value: unknown): string {
  const identity = boundedPlain(value, 'repository identity', 500)
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._~+%=/\-]+$/u.test(identity)) {
    throw new Error('repository identity is invalid')
  }
  const [host, ...segments] = identity.split('/')
  if (!host || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('repository identity is invalid')
  }
  return identity
}

function boundedGitHeadRef(value: unknown): string {
  const ref = boundedPlain(value, 'Git head ref', 240)
  if (
    ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock') ||
    ref.includes('..') || ref.includes('//') || ref.includes('@{') || ref.includes('[') || ref.includes(']') ||
    /[\s~^:?*\\]/u.test(ref)
  ) throw new Error('Git head ref is invalid')
  return ref
}

function boundedGitCommit(value: unknown): string {
  const commit = boundedPlain(value, 'Git commit', 64).toLowerCase()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) throw new Error('Git commit must be a full object id')
  return commit
}

/** Fixed-argv, read-only repository probe used by both local and remote project locations. */
export async function inspectGitCheckout(input: {
  path: string
  environment?: { kind: 'wsl'; distro: string }
}): Promise<RemoteGitInspection> {
  const observedAt = new Date().toISOString()
  const invoke = (args: string[]): Promise<BoundedProcessResult> => gitCheckoutInvocation(input, args)
  const repositoryProbe = await invoke(['rev-parse', '--is-inside-work-tree'])
  if (repositoryProbe.timedOut) {
    return { status: 'unknown', gitAvailable: true, isRepository: false, complete: false, observedAt, error: 'Git repository probe timed out.' }
  }
  if (repositoryProbe.error || repositoryProbe.status === 127) {
    return { status: 'unavailable', gitAvailable: false, isRepository: false, complete: true, observedAt, error: 'Git is unavailable in this environment.' }
  }
  if (repositoryProbe.status !== 0 || repositoryProbe.stdout.trim() !== 'true') {
    return { status: 'not-repository', gitAvailable: true, isRepository: false, complete: true, observedAt }
  }

  const [head, ref, status, origin] = await Promise.all([
    invoke(['rev-parse', '--verify', 'HEAD']),
    invoke(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    invoke(['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    invoke(['remote', 'get-url', 'origin']),
  ])
  const headCommit = head.status === 0 && /^[0-9a-f]{40,64}$/iu.test(head.stdout.trim())
    ? head.stdout.trim().toLowerCase()
    : undefined
  const headRef = ref.status === 0 ? ref.stdout.trim().slice(0, 500) : undefined
  const repository = origin.status === 0 ? normalizeGitRemoteIdentity(origin.stdout) : undefined
  if (status.timedOut || status.error || status.status !== 0) {
    return {
      status: 'unknown', gitAvailable: true, isRepository: true, complete: false,
      ...(headCommit ? { headCommit } : {}),
      ...(headRef ? { headRef } : {}),
      ...(repository ? { repository } : {}),
      detached: !headRef,
      observedAt,
      error: status.timedOut ? 'Git status timed out.' : 'Git status could not be read completely.',
    }
  }
  const entries = status.stdout.split('\0').filter(Boolean)
  let trackedChanges = 0
  let untrackedFiles = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.startsWith('??')) untrackedFiles += 1
    else {
      trackedChanges += 1
      // Porcelain -z emits a second path field for a rename/copy. It is evidence for the same change.
      if (/[RC]/u.test(entry.slice(0, 2))) index += 1
    }
  }
  const dirty = trackedChanges + untrackedFiles > 0 || status.truncated
  return {
    status: dirty ? 'dirty' : 'ready',
    gitAvailable: true,
    isRepository: true,
    complete: !status.truncated,
    clean: !dirty,
    detached: !headRef,
    ...(headCommit ? { headCommit } : {}),
    ...(headRef ? { headRef } : {}),
    ...(repository ? { repository } : {}),
    trackedChanges,
    untrackedFiles,
    observedAt,
    ...(status.truncated ? { error: 'Git status exceeded the bounded output window; the checkout is dirty.' } : {}),
  }
}

/**
 * Prepare an existing clean checkout at one exact revision using only fixed Git argv.
 * The named branch must advertise that exact commit; local-only/unpublished commits are refused.
 */
export async function syncGitCheckout(input: {
  path: string
  environment?: { kind: 'wsl'; distro: string }
  repository: string
  headRef: string
  headCommit: string
}): Promise<RemoteDeviceActionResult> {
  const repository = boundedRepositoryIdentity(input.repository)
  const headRef = boundedGitHeadRef(input.headRef)
  const headCommit = boundedGitCommit(input.headCommit)
  const checkout = {
    path: input.path,
    ...(input.environment?.kind === 'wsl' ? { environment: input.environment } : {}),
  }
  const fail = (error: string, code: string, git?: RemoteGitInspection): RemoteDeviceActionResult => ({
    ok: false,
    error,
    failure: { stage: 'target', code },
    ...(git ? { git } : {}),
  })
  let before = await inspectGitCheckout(checkout)
  if (!before.gitAvailable || !before.isRepository) {
    return fail('The target location is not an existing Git checkout.', 'NOT_REPOSITORY', before)
  }
  if (!before.complete || before.clean !== true) {
    return fail('The target checkout is dirty or could not be inspected completely.', 'DIRTY_CHECKOUT', before)
  }
  if (!before.repository || before.repository !== repository) {
    return fail('The target checkout does not have the same safe origin identity as the primary location.', 'REPOSITORY_MISMATCH', before)
  }
  const invoke = (args: string[], timeoutMs = 5_000): Promise<BoundedProcessResult> =>
    gitCheckoutInvocation(checkout, [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.http.allow=always',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always',
      '-c', 'protocol.git.allow=always',
      '-c', 'protocol.ext.allow=never',
      ...args,
    ], timeoutMs)
  const trackingRef = `refs/remotes/origin/${headRef}`
  const fetched = await invoke([
    'fetch', '--no-tags', 'origin', `+refs/heads/${headRef}:${trackingRef}`,
  ], MAX_COMMAND_TIMEOUT_MS)
  if (fetched.timedOut) return fail('Git fetch timed out; the checkout was not switched.', 'FETCH_TIMEOUT', before)
  if (fetched.error || fetched.status !== 0 || fetched.truncated) {
    return fail('Git could not fetch the requested branch non-interactively.', 'FETCH_FAILED', before)
  }
  const advertised = await invoke(['rev-parse', '--verify', trackingRef])
  if (advertised.status !== 0 || advertised.stdout.trim().toLowerCase() !== headCommit) {
    return fail('The primary revision is not the exact commit currently advertised by that remote branch.', 'SOURCE_REVISION_NOT_PUBLISHED', before)
  }
  if (before.headCommit === headCommit) return { ok: true, git: before }

  // Fetch can take long enough for a local process to edit the checkout. Re-check immediately before mutation.
  before = await inspectGitCheckout(checkout)
  if (!before.complete || before.clean !== true || before.repository !== repository) {
    return fail('The target checkout changed while its revision was being fetched.', 'CHECKOUT_CHANGED', before)
  }
  const switched = await invoke(['checkout', '--detach', headCommit], 30_000)
  if (switched.timedOut || switched.error || switched.status !== 0 || switched.truncated) {
    return fail('Git could not switch the target checkout to the requested revision.', 'CHECKOUT_FAILED', await inspectGitCheckout(checkout))
  }
  const after = await inspectGitCheckout(checkout)
  if (!after.complete || after.clean !== true || after.headCommit !== headCommit || after.repository !== repository) {
    return fail('The target checkout could not be verified at the requested revision.', 'VERIFY_FAILED', after)
  }
  return { ok: true, git: after }
}

/** Target-side execution boundary. Disabled with zero roots until the operator configures it. */
export class DeviceExecutor {
  private policy: DeviceExecutorPolicy = { enabled: false, roots: [] }
  private activeCommands = 0
  /** Target-authoritative fence across every paired source hub for this physical root. */
  private readonly activeCommandRoots = new Set<string>()

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as DeviceExecutorPolicy
      this.policy = this.normalizePolicy(parsed)
    } catch {
      /* Safe default. */
    }
  }

  capabilities(): DeviceExecutorCapabilities {
    return {
      enabled: this.policy.enabled,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      environments: discoverExecutionEnvironments(),
      roots: this.policy.roots.map((root) => ({ ...root })),
    }
  }

  update(input: { enabled?: unknown; roots?: unknown }): DeviceExecutorCapabilities {
    const roots = Array.isArray(input.roots) ? input.roots : this.policy.roots
    this.policy = this.normalizePolicy({ enabled: input.enabled === true, roots: roots as DeviceRootPolicy[] })
    atomicPrivateJson(this.file, { version: 1, ...this.policy })
    return this.capabilities()
  }

  async execute(action: RemoteDeviceAction): Promise<RemoteDeviceActionResult> {
    const started = performance.now()
    const finish = (result: RemoteDeviceActionResult): RemoteDeviceActionResult => ({
      ...result,
      failure: result.ok ? undefined : (result.failure ?? { stage: 'target' }),
      telemetry: { ...result.telemetry, targetMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10) },
    })
    if (!this.policy.enabled) return finish({ ok: false, error: 'Remote device execution is disabled on this machine.' })
    const root = this.policy.roots.find((item) => item.id === action.rootId)
    if (!root) return finish({ ok: false, error: 'Unknown or revoked device root.' })
    const needed = remoteCapabilityForAction(action)
    if (!root[needed]) return finish({ ok: false, error: `${needed} access is not enabled for this root.` })
    try {
      if (this.activeCommandRoots.has(root.id) && ['mkdir', 'write', 'git_sync', 'exec'].includes(action.op)) {
        return finish({
          ok: false,
          error: 'This testbed root already has an active terminal command.',
          failure: { stage: 'admission', code: 'ROOT_BUSY' },
        })
      }
      if (action.op === 'probe') return finish({ ok: true })
      if (action.op === 'inspect') return finish(await this.inspect(root))
      if (action.op === 'git_inspect') {
        return finish({ ok: true, git: await inspectGitCheckout({ path: root.path, environment: root.environment }) })
      }
      if (action.op === 'git_sync') {
        if (this.activeCommands >= MAX_CONCURRENT_COMMANDS) {
          return finish({ ok: false, error: `remote operation concurrency limit (${MAX_CONCURRENT_COMMANDS}) reached` })
        }
        this.activeCommands += 1
        this.activeCommandRoots.add(root.id)
        try {
          return finish(await syncGitCheckout({
            path: root.path,
            ...(root.environment ? { environment: root.environment } : {}),
            repository: action.repository,
            headRef: action.headRef,
            headCommit: action.headCommit,
          }))
        } finally {
          this.activeCommands -= 1
          this.activeCommandRoots.delete(root.id)
        }
      }
      if (action.op === 'list') return finish(this.list(root, action.path))
      if (action.op === 'read') return finish(this.read(root, action))
      if (action.op === 'mkdir') return finish(this.mkdir(root, action))
      if (action.op === 'write') return finish(this.write(root, action))
      if (this.activeCommands >= MAX_CONCURRENT_COMMANDS) {
        return finish({ ok: false, error: `remote terminal concurrency limit (${MAX_CONCURRENT_COMMANDS}) reached` })
      }
      this.activeCommands += 1
      this.activeCommandRoots.add(root.id)
      try {
        return finish(await this.exec(root, action))
      } finally {
        this.activeCommands -= 1
        this.activeCommandRoots.delete(root.id)
      }
    } catch (error) {
      return finish({ ok: false, error: this.safeError(error, root.path) })
    }
  }

  private normalizePolicy(input: DeviceExecutorPolicy): DeviceExecutorPolicy {
    const roots: DeviceRootPolicy[] = []
    const seen = new Set<string>()
    for (const raw of (Array.isArray(input?.roots) ? input.roots : []).slice(0, MAX_DEVICE_ROOTS)) {
      try {
        const environment = raw.environment?.kind === 'wsl'
          ? { kind: 'wsl' as const, distro: boundedPlain(raw.environment.distro, 'WSL distro', 200) }
          : undefined
        let real: string
        let publicPath: string
        if (environment) {
          if (process.platform !== 'win32' || /[\\/]/u.test(environment.distro)) continue
          const requested = validateLinuxAbsolutePath(raw.path, 'WSL root path')
          const canonical = spawnSync('wsl.exe', [
            '--distribution', environment.distro, '--exec', 'realpath', '--', requested,
          ], { windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 })
          if (canonical.status !== 0) continue
          publicPath = validateLinuxAbsolutePath(decodeProcessOutput(canonical.stdout).trim(), 'canonical WSL root path')
          real = fs.realpathSync.native(wslUncPath(environment.distro, publicPath))
        } else {
          const requested = boundedPlain(raw.path, 'root path', 4096)
          real = fs.realpathSync.native(path.resolve(requested))
          publicPath = real
        }
        if (!fs.statSync(real).isDirectory()) continue
        // Keep host IDs byte-for-byte compatible with the original host-only executor so enabling
        // WSL support never silently revokes an existing grant. WSL roots need the environment in
        // their identity because the same Linux path may exist in several distributions.
        const id = environment
          ? rootId(`${wslEnvironmentId(environment.distro)}:${publicPath}`)
          : rootId(real)
        if (seen.has(id)) continue
        seen.add(id)
        roots.push({
          id,
          label: typeof raw.label === 'string' && raw.label.trim()
            ? boundedPlain(raw.label, 'root label', 100)
            : environment
              ? path.posix.basename(publicPath) || `${environment.distro} /`
              : path.basename(real) || real,
          path: publicPath,
          ...(environment ? { environment } : {}),
          read: raw.read === true,
          write: raw.write === true,
          terminal: raw.terminal === true,
        })
      } catch {
        /* A missing/invalid root is revoked rather than broadening to an ancestor. */
      }
    }
    return { enabled: input?.enabled === true, roots }
  }

  private filesystemRoot(root: DeviceRootPolicy): string {
    return root.environment?.kind === 'wsl'
      ? wslUncPath(root.environment.distro, root.path)
      : root.path
  }

  private resolveExisting(root: DeviceRootPolicy, requested: unknown, field: string, directory = false): string {
    const rel = relativePath(requested, field, true)
    const base = this.filesystemRoot(root)
    const lexical = path.resolve(base, rel)
    if (!inside(base, lexical)) throw new Error(`${field} escapes the approved root`)
    const real = fs.realpathSync.native(lexical)
    if (!inside(base, real)) throw new Error(`${field} resolves outside the approved root`)
    if (directory && !fs.statSync(real).isDirectory()) throw new Error(`${field} is not a directory`)
    return real
  }

  private list(root: DeviceRootPolicy, requested: unknown): RemoteDeviceActionResult {
    const dir = this.resolveExisting(root, requested, 'path', true)
    const entries: fs.Dirent[] = []
    const handle = fs.opendirSync(dir)
    try {
      while (entries.length <= MAX_DIRECTORY_ENTRIES) {
        const entry = handle.readSync()
        if (!entry) break
        entries.push(entry)
      }
    } finally {
      handle.closeSync()
    }
    const truncated = entries.length > MAX_DIRECTORY_ENTRIES
    if (truncated) entries.length = MAX_DIRECTORY_ENTRIES
    const out = entries.map((entry) => {
      const kind = entry.isFile() ? 'file' as const : entry.isDirectory() ? 'directory' as const : 'other' as const
      let size: number | undefined
      if (kind === 'file') {
        try { size = fs.statSync(path.join(dir, entry.name)).size } catch { /* raced with removal */ }
      }
      return { name: entry.name, kind, ...(size === undefined ? {} : { size }) }
    })
    return { ok: true, entries: out, truncated }
  }

  private read(root: DeviceRootPolicy, action: Extract<RemoteDeviceAction, { op: 'read' }>): RemoteDeviceActionResult {
    const file = this.resolveExisting(root, action.path, 'path')
    const stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error('path is not a regular file')
    const max = Math.max(1, Math.min(Number(action.maxBytes) || DEFAULT_READ_BYTES, MAX_FILE_BYTES))
    const handle = fs.openSync(file, 'r')
    try {
      const bytes = Math.min(stat.size, max)
      const buffer = Buffer.alloc(bytes)
      const read = fs.readSync(handle, buffer, 0, bytes, 0)
      const value = buffer.subarray(0, read)
      const encoding = action.encoding === 'base64' ? 'base64' : 'utf8'
      return {
        ok: true,
        content: value.toString(encoding),
        encoding,
        bytes: read,
        truncated: stat.size > read,
      }
    } finally {
      fs.closeSync(handle)
    }
  }

  private write(root: DeviceRootPolicy, action: Extract<RemoteDeviceAction, { op: 'write' }>): RemoteDeviceActionResult {
    const rel = relativePath(action.path, 'path')
    const base = this.filesystemRoot(root)
    const target = path.resolve(base, rel)
    if (!inside(base, target)) throw new Error('path escapes the approved root')
    const parent = fs.realpathSync.native(path.dirname(target))
    if (!inside(base, parent)) throw new Error('path resolves outside the approved root')
    try {
      const current = fs.lstatSync(target)
      if (current.isSymbolicLink()) throw new Error('refusing to overwrite a symbolic link')
      const real = fs.realpathSync.native(target)
      if (!inside(base, real) || !current.isFile()) throw new Error('target is not a regular file inside the root')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const encoding = action.encoding === 'base64' ? 'base64' : 'utf8'
    if (typeof action.content !== 'string') throw new Error('content must be a string')
    if (encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(action.content)) {
      throw new Error('content is not valid base64')
    }
    const content = Buffer.from(action.content, encoding)
    if (content.length > MAX_FILE_BYTES) throw new Error(`write exceeds ${MAX_FILE_BYTES} bytes`)
    const temp = path.join(parent, `.${path.basename(target)}.ama-${crypto.randomBytes(6).toString('hex')}.tmp`)
    try {
      fs.writeFileSync(temp, content, { flag: 'wx' })
      fs.renameSync(temp, target)
    } finally {
      try { fs.unlinkSync(temp) } catch { /* renamed or never created */ }
    }
    return { ok: true, bytes: content.length, encoding }
  }

  /**
   * Create a directory tree without ever following an existing link or junction out of the granted
   * root. Remote file transfer previously exposed list/read/write but no directory mutation, so a
   * folder containing `src/a.ts` failed as soon as `src` did not already exist on the target.
   */
  private mkdir(root: DeviceRootPolicy, action: Extract<RemoteDeviceAction, { op: 'mkdir' }>): RemoteDeviceActionResult {
    const rel = relativePath(action.path, 'path')
    const base = this.filesystemRoot(root)
    const target = path.resolve(base, rel)
    if (!inside(base, target)) throw new Error('path escapes the approved root')
    const parts = path.relative(base, target).split(path.sep).filter(Boolean)
    let cursor = base
    let created = false
    for (const part of parts) {
      cursor = path.join(cursor, part)
      try {
        const stat = fs.lstatSync(cursor)
        if (stat.isSymbolicLink()) throw new Error('refusing to traverse a symbolic link')
        if (!stat.isDirectory()) throw new Error('a path component is not a directory')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (action.recursive !== true && cursor !== target) {
          throw new Error('parent directory does not exist')
        }
        fs.mkdirSync(cursor)
        created = true
      }
      const real = fs.realpathSync.native(cursor)
      if (!inside(base, real)) throw new Error('path resolves outside the approved root')
    }
    return { ok: true, created }
  }

  private exec(
    root: DeviceRootPolicy,
    action: Extract<RemoteDeviceAction, { op: 'exec' }>,
  ): Promise<RemoteDeviceActionResult> {
    if (typeof action.command !== 'string' || action.command.length === 0 || action.command.length > MAX_COMMAND_CHARS || action.command.includes('\0')) {
      throw new Error('command must be a non-empty bounded string')
    }
    const cwd = this.resolveExisting(root, action.cwd, 'cwd', true)
    const timeoutMs = Math.max(1000, Math.min(Number(action.timeoutMs) || 30_000, MAX_COMMAND_TIMEOUT_MS))
    const allowedEnvironment = new Set([
      'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
      'LANG', 'LC_ALL', 'TERM',
    ])
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (allowedEnvironment.has(key.toUpperCase())) env[key] = value
    }
    env.ALLMYAGENTS_REMOTE_TESTBED = '1'
    const wsl = root.environment?.kind === 'wsl' ? root.environment : undefined
    const relativeCwd = path.relative(this.filesystemRoot(root), cwd).split(path.sep).filter(Boolean)
    const linuxCwd = wsl ? path.posix.join(root.path, ...relativeCwd) : undefined
    // Prefer the maintained PowerShell runtime when present. Windows PowerShell 5.1 can spend
    // an unbounded-looking amount of time in cold CLR/AMSI initialization on a loaded host;
    // PowerShell 7 is also the shell GitHub's current Windows runners execute reliably.
    const program = wsl ? 'wsl.exe' : process.platform === 'win32' ? windowsPowerShell().program : '/bin/sh'
    const args = wsl
      ? ['--distribution', wsl.distro, '--cd', linuxCwd!, '--exec', '/usr/bin/env', 'ALLMYAGENTS_REMOTE_TESTBED=1', '/bin/sh', '-lc', action.command]
      : process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', action.command]
        : ['-lc', action.command]
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(program, args, {
          cwd: wsl ? undefined : cwd,
          env,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let truncated = false
      let timedOut = false
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        const remaining = MAX_COMMAND_OUTPUT_BYTES - outputBytes
        if (remaining <= 0) { truncated = true; return }
        if (chunk.length > remaining) {
          chunks.push(chunk.subarray(0, remaining))
          outputBytes = MAX_COMMAND_OUTPUT_BYTES
          truncated = true
          return
        }
        chunks.push(chunk)
        outputBytes += chunk.length
      }
      child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk))
      child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk))
      const killTree = (): void => {
        if (!child.pid) return
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
          } else {
            process.kill(-child.pid, 'SIGKILL')
          }
        } catch {
          try { child.kill('SIGKILL') } catch { /* already exited */ }
        }
      }
      const timer = setTimeout(() => { timedOut = true; killTree() }, timeoutMs)
      timer.unref?.()
      child.once('error', (error) => {
        clearTimeout(timer)
        resolve({ ok: false, error: error.message })
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        resolve({
          ok: !timedOut && code === 0,
          ...(timedOut ? { error: `command timed out after ${timeoutMs}ms` } : {}),
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code,
          signal,
          timedOut,
          truncated,
        })
      })
    })
  }

  private async inspect(root: DeviceRootPolicy): Promise<RemoteDeviceActionResult> {
    const toolNames = ['git', 'node', 'npm', 'python3', 'docker', 'gcc', 'make'] as const
    if (root.environment?.kind !== 'wsl') {
      const program = process.platform === 'win32' ? 'where.exe' : '/bin/sh'
      const tools = Object.fromEntries(toolNames.map((tool) => {
        const checked = process.platform === 'win32'
          ? spawnSync(program, [tool], { windowsHide: true, stdio: 'ignore', timeout: 2_000 })
          : spawnSync(program, ['-lc', `command -v ${tool}`], { windowsHide: true, stdio: 'ignore', timeout: 2_000 })
        return [tool, checked.status === 0]
      }))
      return {
        ok: true,
        environment: {
          environmentId: 'host',
          kind: 'host',
          label: `${os.hostname()} host`,
          platform: process.platform,
          arch: process.arch,
          hostname: os.hostname(),
          release: os.release(),
          shell: process.platform === 'win32' ? 'PowerShell' : '/bin/sh',
          cpuCount: os.cpus().length,
          totalMemoryBytes: os.totalmem(),
          tools,
        },
      }
    }
    const distro = root.environment.distro
    const script = [
      'printf "HOST\\t%s\\n" "$(hostname)"',
      'printf "ARCH\\t%s\\n" "$(uname -m)"',
      'printf "RELEASE\\t%s\\n" "$(uname -sr)"',
      'printf "CPU\\t%s\\n" "$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || printf 0)"',
      'printf "MEM\\t%s\\n" "$(awk \'/MemTotal/{print $2 * 1024}\' /proc/meminfo 2>/dev/null || printf 0)"',
      ...toolNames.map((tool) => `command -v ${tool} >/dev/null 2>&1 && printf "TOOL\\t${tool}\\t1\\n" || printf "TOOL\\t${tool}\\t0\\n"`),
    ].join('; ')
    const result = spawnSync('wsl.exe', ['--distribution', distro, '--exec', '/bin/sh', '-lc', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    })
    if (result.status !== 0) {
      return { ok: false, error: `WSL environment inspection failed${result.error ? `: ${result.error.message}` : ''}` }
    }
    const values = new Map<string, string>()
    const tools: Record<string, boolean> = {}
    for (const line of decodeProcessOutput(result.stdout).split(/\r?\n/u)) {
      const [key, name, value] = line.split('\t')
      if (key === 'TOOL' && name) tools[name] = value === '1'
      else if (key && name !== undefined) values.set(key, name)
    }
    return {
      ok: true,
      environment: {
        environmentId: wslEnvironmentId(distro),
        kind: 'wsl',
        label: `${distro} (WSL)`,
        platform: 'linux',
        arch: values.get('ARCH') || 'unknown',
        hostname: values.get('HOST') || distro,
        release: values.get('RELEASE') || 'unknown',
        shell: '/bin/sh',
        cpuCount: Number(values.get('CPU')) || 0,
        totalMemoryBytes: Number(values.get('MEM')) || 0,
        tools,
      },
    }
  }

  private safeError(error: unknown, approvedRoot: string): string {
    const message = error instanceof Error ? error.message : String(error)
    const escaped = approvedRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return escaped ? message.replace(new RegExp(escaped, 'giu'), '[approved root]') : message
  }
}

export interface RemoteDeviceView {
  siteId: string
  label: string
  connected: boolean
  error?: string
  platform?: NodeJS.Platform
  arch?: string
  hostname?: string
  environments?: RemoteExecutionEnvironment[]
  roots: Array<DeviceRootPolicy & { grantedCapabilities: RemoteDeviceCapability[] }>
}

export interface RemoteDeviceCatalogEntry extends FleetConnectionPublic {
  connected: boolean
  error?: string
  capabilities?: DeviceExecutorCapabilities
}

export interface RemoteDeviceRoute {
  siteId: string
  label: string
  baseUrl: string
  online: boolean
}

async function boundedJson(response: Response, onBytes?: (bytes: number) => void): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_REMOTE_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('remote device response exceeded its size bound')
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
  onBytes?.(total)
  return text ? JSON.parse(text) : undefined
}

class RemoteRequestError extends Error {
  constructor(
    message: string,
    readonly failure: RemoteDeviceFailure,
    readonly telemetry: RemoteDeviceTelemetry,
  ) {
    super(message)
  }
}

/** Source-side client. It intersects target policy with one session's durable operator grant. */
export class RemoteDeviceController {
  constructor(
    private readonly connections: FleetConnectionStore,
    private readonly resolveRoute: (siteId: string) => Promise<RemoteDeviceRoute | null>,
    private readonly direct?: DirectRemoteTransport,
  ) {}

  listConnections(): FleetConnectionPublic[] {
    return this.connections.list()
  }

  saveConnection(input: { siteId: string; label: string; token: string }): FleetConnectionSaveResult {
    const previous = this.connections.get(input.siteId)
    const changed = previous?.label !== input.label || previous.token !== input.token
    return { ...this.connections.upsert(input), changed }
  }

  removeConnection(siteId: string): boolean {
    return this.connections.remove(siteId)
  }

  async listForGrants(grants: RemoteDeviceGrant[]): Promise<RemoteDeviceView[]> {
    const bySite = new Map<string, RemoteDeviceGrant[]>()
    for (const grant of grants) bySite.set(grant.siteId, [...(bySite.get(grant.siteId) ?? []), grant])
    return Promise.all([...bySite].map(async ([siteId, siteGrants]) => {
      const connection = this.connections.get(siteId)
      if (!connection) return { siteId, label: siteId, connected: false, error: 'Device is not paired with this hub.', roots: [] }
      try {
        const capabilities = await this.capabilities(siteId)
        return {
          siteId,
          label: connection.label,
          connected: capabilities.enabled,
          ...capabilities,
          roots: capabilities.roots
            .filter((root) => siteGrants.some((grant) => grant.rootIds.includes(root.id)))
            .map((root) => ({
              ...root,
              grantedCapabilities: [...new Set(siteGrants
                .filter((grant) => grant.rootIds.includes(root.id))
                .flatMap((grant) => grant.capabilities)
                .filter((capability) => root[capability]))],
            })),
        }
      } catch (error) {
        return { siteId, label: connection.label, connected: false, error: error instanceof Error ? error.message : String(error), roots: [] }
      }
    }))
  }

  async catalog(): Promise<RemoteDeviceCatalogEntry[]> {
    return Promise.all(this.connections.list().map(async (connection) => {
      try {
        const capabilities = await this.capabilities(connection.siteId)
        return {
          ...connection,
          connected: capabilities.enabled,
          ...(!capabilities.enabled ? { error: 'Testbed access is disabled on this device.' } : {}),
          capabilities,
        }
      } catch (error) {
        return {
          ...connection,
          connected: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }))
  }

  async capabilities(siteId: string): Promise<DeviceExecutorCapabilities> {
    const direct = await this.directCall<DeviceExecutorCapabilities>(siteId, 'device_capabilities', {}).catch(() => null)
    if (direct) return direct
    return this.request<DeviceExecutorCapabilities>(siteId, '/api/device-executor', 'GET')
  }

  async execute(siteId: string, action: RemoteDeviceAction, actor: RemoteDeviceActor): Promise<RemoteDeviceActionResult> {
    const timeout = action.op === 'exec'
      ? Math.min(Number(action.timeoutMs) || 30_000, MAX_COMMAND_TIMEOUT_MS) + 10_000
      : action.op === 'git_sync'
        ? MAX_COMMAND_TIMEOUT_MS + 30_000
      : action.op === 'git_inspect'
        ? 25_000
      : 15_000
    const body = { action, actor }
    const directStarted = performance.now()
    let directResult: RemoteDeviceActionResult | null
    try {
      directResult = await this.directCall<RemoteDeviceActionResult>(siteId, 'device_action', body, timeout)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: `Direct MyOwnMesh action failed: ${message}`,
        failure: { stage: /tim(?:ed?\s*out|eout)/iu.test(message) ? 'timeout' : 'transport' },
        telemetry: { routeMs: 0, roundTripMs: Math.round((performance.now() - directStarted) * 10) / 10 },
      }
    }
    if (directResult) {
      const roundTripMs = Math.round((performance.now() - directStarted) * 10) / 10
      const targetMs = directResult.telemetry?.targetMs
      const transferBytes = action.op === 'read' || action.op === 'write' ? directResult.bytes : undefined
      return {
        ...directResult,
        failure: directResult.ok ? undefined : (directResult.failure ?? { stage: 'target' }),
        telemetry: {
          ...directResult.telemetry,
          routeMs: 0,
          ...(targetMs === undefined ? {} : { networkMs: Math.max(0, Math.round((roundTripMs - targetMs) * 10) / 10) }),
          roundTripMs,
          ...(transferBytes === undefined ? {} : {
            transferBytes,
            transferBytesPerSecond: Math.round(transferBytes / Math.max(roundTripMs / 1000, 0.001)),
          }),
        },
      }
    }
    try {
      const result = await this.request<RemoteDeviceActionResult>(siteId, '/api/device-executor/action', 'POST', body, timeout, true)
      const telemetry = result.telemetry ?? {}
      const transferBytes = action.op === 'read' || action.op === 'write' ? result.bytes : undefined
      return {
        ...result,
        failure: result.ok ? undefined : (result.failure ?? { stage: 'target' }),
        telemetry: {
          ...telemetry,
          ...(transferBytes === undefined ? {} : {
            transferBytes,
            transferBytesPerSecond: Math.round(transferBytes / Math.max((telemetry.roundTripMs ?? 1) / 1000, 0.001)),
          }),
        },
      }
    } catch (error) {
      if (error instanceof RemoteRequestError) {
        return { ok: false, error: error.message, failure: error.failure, telemetry: error.telemetry }
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        failure: { stage: 'transport' },
      }
    }
  }

  /**
   * Reciprocal capability exchange over the Site-free RPC lane. A supplied code is the compatibility
   * path; an omitted code asks the target to authorize the authenticated peer from its signed fleet
   * roster. The target, not this caller, decides whether that stronger pre-existing trust exists.
   */
  async pairDirect(siteId: string, code?: string): Promise<DirectPairResult> {
    if (!this.direct || this.direct.enabled?.() === false) {
      throw new Error('The direct MyOwnMesh hub channel is unavailable or disabled.')
    }
    const identity = await this.direct.bridge.identity()
    if (!identity) throw new Error('Could not resolve this device identity from MyOwnMesh.')
    const response = await this.direct.bridge.call(siteId, {
      kind: code ? 'pair_exchange' : 'fleet_trust_exchange',
      version: 1,
      ...(code ? { code } : {}),
      source: {
        siteId: identity.siteId,
        label: identity.label,
        token: this.direct.localDeviceToken,
      },
    }, 15_000) as { siteId?: unknown; label?: unknown; token?: unknown }
    if (
      typeof response?.siteId !== 'string' ||
      typeof response?.label !== 'string' ||
      typeof response?.token !== 'string'
    ) {
      throw new Error('The remote hub returned an invalid pairing response.')
    }
    if (response.siteId.toLowerCase() !== siteId.split('-', 1)[0]!.toLowerCase()) {
      throw new Error('The pairing response identity did not match the requested mesh peer.')
    }
    const saved = this.connections.upsert({ siteId: response.siteId, label: response.label, token: response.token })
    return { siteId: saved.siteId, label: saved.label, token: response.token, paired: true }
  }

  async overseerPeers(): Promise<OverseerPeerStatus[]> {
    const directPeers = new Map(
      (this.direct?.enabled?.() === false ? [] : await this.direct?.bridge.peers(true).catch(() => []) ?? [])
        .map((peer) => [peer.siteId.toLowerCase(), peer] as const),
    )
    return Promise.all(this.connections.list().map(async (connection) => {
      const peer = directPeers.get(connection.siteId.split('-', 1)[0]!.toLowerCase())
      if (peer?.online) {
        try {
          const result = await this.directCall<{ overseerAvailable?: boolean }>(
            connection.siteId,
            'overseer_message',
            { probe: true },
          )
          return {
            ...connection,
            online: true,
            overseerAvailable: result?.overseerAvailable === true,
            transport: 'myownmesh-rpc' as const,
          }
        } catch (error) {
          return {
            ...connection,
            online: false,
            transport: 'myownmesh-rpc' as const,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }
      const route = await this.resolveRoute(connection.siteId).catch(() => null)
      return {
        ...connection,
        online: route?.online === true,
        transport: 'site' as const,
        ...(!route?.online ? { error: 'No live direct RPC peer or Site route.' } : {}),
      }
    }))
  }

  async sendOverseerMessage(
    siteId: string,
    input: { subject?: string; body: string },
  ): Promise<{ accepted: boolean; duplicate?: boolean; overseerSessionId?: string }> {
    const result = await this.directCall<{ accepted?: boolean; duplicate?: boolean; overseerSessionId?: string }>(
      siteId,
      'overseer_message',
      { subject: input.subject, body: input.body },
    )
    if (!result || result.accepted !== true) throw new Error('The remote Overseer did not accept the message.')
    return { accepted: true, duplicate: result.duplicate, overseerSessionId: result.overseerSessionId }
  }

  verifyDirectEnvelope(value: unknown, fromPeer: string): DirectHubEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('direct hub request is malformed')
    const sourceSiteId = (value as { sourceSiteId?: unknown }).sourceSiteId
    if (typeof sourceSiteId !== 'string') throw new Error('direct hub source id is missing')
    const connection = this.connections.get(sourceSiteId)
    if (!connection) throw new Error('The source hub is not reciprocally paired with this hub.')
    return verifyDirectHubEnvelope(value, { fromPeer, token: connection.token })
  }

  private async directCall<T>(
    siteId: string,
    operation: DirectHubEnvelope['operation'],
    payload: unknown,
    timeoutMs = 10_000,
  ): Promise<T | null> {
    if (!this.direct || this.direct.enabled?.() === false) return null
    const connection = this.connections.get(siteId)
    if (!connection) return null
    const canonicalSiteId = siteId.split('-', 1)[0]!.toLowerCase()
    const peer = (await this.direct.bridge.peers().catch(() => []))
      .find((candidate) => candidate.siteId.toLowerCase() === canonicalSiteId)
    if (!peer?.online) return null
    const identity = await this.direct.bridge.identity()
    if (!identity) throw new Error('Could not resolve this hub identity from MyOwnMesh.')
    const envelope = signDirectHubEnvelope(this.direct.localDeviceToken, identity, operation, payload)
    return await this.direct.bridge.call(siteId, { kind: 'authenticated', envelope }, timeoutMs) as T
  }

  private async request<T>(
    siteId: string,
    pathname: string,
    method: 'GET' | 'POST',
    body?: unknown,
    timeoutMs = 10_000,
    instrument = false,
  ): Promise<T> {
    const started = performance.now()
    const telemetry: RemoteDeviceTelemetry = {}
    const connection = this.connections.get(siteId)
    if (!connection) throw new RemoteRequestError('Device is not paired with this hub.', { stage: 'pairing' }, telemetry)
    const routeStarted = performance.now()
    let route: RemoteDeviceRoute | null
    try {
      route = await this.resolveRoute(siteId)
    } catch (error) {
      telemetry.routeMs = Math.round((performance.now() - routeStarted) * 10) / 10
      telemetry.roundTripMs = Math.round((performance.now() - started) * 10) / 10
      throw new RemoteRequestError(
        error instanceof Error ? error.message : String(error),
        { stage: 'route' },
        telemetry,
      )
    }
    telemetry.routeMs = Math.round((performance.now() - routeStarted) * 10) / 10
    if (!route?.online) {
      telemetry.roundTripMs = Math.round((performance.now() - started) * 10) / 10
      throw new RemoteRequestError('The remote device route is offline.', { stage: 'route' }, telemetry)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    const encodedBody = body === undefined ? undefined : JSON.stringify(body)
    if (instrument) telemetry.bytesSent = encodedBody ? Buffer.byteLength(encodedBody) : 0
    const networkStarted = performance.now()
    try {
      const response = await fetch(new URL(pathname, route.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${connection.token}`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
        signal: controller.signal,
      })
      let parsed: T & { error?: string }
      try {
        parsed = await boundedJson(response, (bytes) => { if (instrument) telemetry.bytesReceived = bytes }) as T & { error?: string }
      } catch (error) {
        telemetry.networkMs = Math.round((performance.now() - networkStarted) * 10) / 10
        telemetry.roundTripMs = Math.round((performance.now() - started) * 10) / 10
        throw new RemoteRequestError(
          `Remote device returned an invalid response: ${error instanceof Error ? error.message : String(error)}`,
          { stage: 'protocol' },
          telemetry,
        )
      }
      telemetry.networkMs = Math.round((performance.now() - networkStarted) * 10) / 10
      telemetry.roundTripMs = Math.round((performance.now() - started) * 10) / 10
      if (!response.ok) {
        const targetTelemetry = parsed && typeof parsed === 'object'
          ? (parsed as T & { telemetry?: RemoteDeviceTelemetry }).telemetry
          : undefined
        throw new RemoteRequestError(
          parsed?.error || `remote device returned HTTP ${response.status}`,
          { stage: 'target', code: `HTTP_${response.status}` },
          { ...targetTelemetry, ...telemetry },
        )
      }
      if (instrument && parsed && typeof parsed === 'object') {
        const value = parsed as T & { telemetry?: RemoteDeviceTelemetry }
        value.telemetry = { ...value.telemetry, ...telemetry }
      }
      return parsed as T
    } catch (error) {
      if (error instanceof RemoteRequestError) throw error
      telemetry.networkMs = Math.round((performance.now() - networkStarted) * 10) / 10
      telemetry.roundTripMs = Math.round((performance.now() - started) * 10) / 10
      if (controller.signal.aborted) {
        throw new RemoteRequestError(
          `remote device request timed out after ${timeoutMs}ms`,
          { stage: 'timeout', code: 'TIMEOUT' },
          telemetry,
        )
      }
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined
      throw new RemoteRequestError(
        error instanceof Error ? error.message : String(error),
        { stage: 'transport', ...(code ? { code } : {}) },
        telemetry,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
