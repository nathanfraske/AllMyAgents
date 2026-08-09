import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getOrCreateDeviceToken } from './deviceToken.js'
import {
  DeviceExecutor,
  FleetConnectionStore,
  RemoteDeviceController,
  type DeviceRootPolicy,
  type RemoteDeviceAction,
  type RemoteExecutionEnvironment,
} from './remoteDevices.js'
import { MyOwnMeshRpcBridge, myOwnMeshControlRequest } from './myOwnMeshRpc.js'

export type TestbedNodeProfile = 'scoped' | 'full-machine' | 'elevated-machine' | 'linux-sudo-machine'

export interface TestbedNodeConfig {
  version: 1
  profile: TestbedNodeProfile
  configuredAt: string
  roots: Array<Pick<DeviceRootPolicy, 'label' | 'path' | 'environment' | 'read' | 'write' | 'terminal'>>
}

interface FleetRosterMember {
  device: string
}

const SERVICE_NAME = 'AllMyAgentsTestbed'
const AUDIT_MAX_BYTES = 5 * 1024 * 1024
const AUDIT_GENERATIONS = 4
const PAIR_CODE_TTL_MS = 10 * 60 * 1000
const MESSAGE_REPLAY_TTL_MS = 10 * 60 * 1000
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temp, file)
    try { fs.chmodSync(file, 0o600) } catch { /* Windows inherits the containing directory ACL. */ }
  } finally {
    try { fs.unlinkSync(temp) } catch { /* Atomic rename consumed it. */ }
  }
}

function canonicalDevice(value: string): string {
  return value.split('-', 1)[0]!.trim().toLowerCase()
}

function boundedString(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const out = value.trim()
  if (!out || out.length > max || /[\u0000-\u001f\u007f]/u.test(out)) throw new Error(`${label} is malformed`)
  return out
}

function defaultDataDir(): string {
  if (process.env.ALLMYAGENTS_TESTBED_DATA_DIR?.trim()) return path.resolve(process.env.ALLMYAGENTS_TESTBED_DATA_DIR.trim())
  return path.join(os.homedir(), '.allmyagents-testbed')
}

function configFile(dataDir: string): string {
  return path.join(dataDir, 'node-config.json')
}

function policyFile(dataDir: string): string {
  return path.join(dataDir, 'device-executor.json')
}

function connectionsFile(dataDir: string): string {
  return path.join(dataDir, 'fleet-connections.json')
}

function auditFile(dataDir: string): string {
  return path.join(dataDir, 'audit.jsonl')
}

function rotateAudit(file: string): void {
  try {
    if (fs.statSync(file).size < AUDIT_MAX_BYTES) return
  } catch {
    return
  }
  try { fs.unlinkSync(`${file}.${AUDIT_GENERATIONS}`) } catch { /* Oldest generation may not exist. */ }
  for (let generation = AUDIT_GENERATIONS - 1; generation >= 1; generation -= 1) {
    const from = `${file}.${generation}`
    const to = `${file}.${generation + 1}`
    if (!fs.existsSync(from)) continue
    try { fs.renameSync(from, to) } catch { /* Keep the current audit writable even if rotation is blocked. */ }
  }
  try { fs.renameSync(file, `${file}.1`) } catch { /* Append below remains the fail-soft fallback. */ }
}

export function appendTestbedAudit(dataDir: string, kind: string, payload: Record<string, unknown>): void {
  const file = auditFile(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  rotateAudit(file)
  const handle = fs.openSync(file, 'a', 0o600)
  try {
    fs.writeSync(handle, `${JSON.stringify({ at: new Date().toISOString(), kind, ...payload })}\n`)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
}

function admittedMessageIds(dataDir: string, now = Date.now()): Map<string, number> {
  const recent = new Map<string, number>()
  const base = auditFile(dataDir)
  for (const file of [base, ...Array.from({ length: AUDIT_GENERATIONS }, (_, index) => `${base}.${index + 1}`)]) {
    if (!fs.existsSync(file)) continue
    let lines: string[]
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u) } catch { continue }
    for (const line of lines) {
      if (!line) continue
      try {
        const event = JSON.parse(line) as { at?: unknown; kind?: unknown; messageId?: unknown }
        const seenAt = typeof event.at === 'string' ? Date.parse(event.at) : Number.NaN
        if (
          event.kind === 'device/admitted' &&
          typeof event.messageId === 'string' &&
          Number.isFinite(seenAt) &&
          now - seenAt <= MESSAGE_REPLAY_TTL_MS
        ) {
          recent.set(event.messageId, seenAt)
        }
      } catch { /* One malformed audit line cannot erase other durable replay evidence. */ }
    }
  }
  return recent
}

function hostMachineRoots(platform: NodeJS.Platform): DeviceRootPolicy[] {
  if (platform !== 'win32') {
    return [{ id: '', label: 'Host filesystem', path: '/', read: true, write: true, terminal: true }]
  }
  const roots: DeviceRootPolicy[] = []
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`
    try {
      if (fs.statSync(drive).isDirectory()) {
        roots.push({ id: '', label: `${drive.slice(0, 2)} drive`, path: drive, read: true, write: true, terminal: true })
      }
    } catch { /* Drive is absent or not ready. */ }
  }
  return roots
}

export function machineRoots(
  platform: NodeJS.Platform,
  environments: readonly RemoteExecutionEnvironment[] = [],
): DeviceRootPolicy[] {
  const roots = hostMachineRoots(platform)
  if (platform === 'win32') {
    for (const environment of environments) {
      if (environment.kind !== 'wsl' || !environment.distro) continue
      roots.push({
        id: '',
        label: `${environment.distro} filesystem`,
        path: '/',
        environment: { kind: 'wsl', distro: environment.distro },
        read: true,
        write: true,
        terminal: true,
      })
    }
  }
  return roots
}

function normalizeProfile(value: unknown): TestbedNodeProfile {
  if (value === 'scoped' || value === 'full-machine' || value === 'elevated-machine' || value === 'linux-sudo-machine') {
    if (value === 'linux-sudo-machine' && process.platform !== 'linux') {
      throw new Error('linux-sudo-machine is available only on Linux')
    }
    return value
  }
  throw new Error('profile must be scoped, full-machine, elevated-machine, or linux-sudo-machine')
}

export function configureTestbedNode(input: {
  dataDir: string
  profile: TestbedNodeProfile
  roots?: Array<Pick<DeviceRootPolicy, 'label' | 'path' | 'environment' | 'read' | 'write' | 'terminal'>>
}): TestbedNodeConfig {
  const dataDir = path.resolve(input.dataDir)
  const profile = normalizeProfile(input.profile)
  const executor = new DeviceExecutor(policyFile(dataDir))
  const requested = profile === 'scoped'
    ? (input.roots ?? [])
    : machineRoots(process.platform, executor.capabilities().environments)
  if (profile === 'scoped' && requested.length === 0) throw new Error('scoped testbed nodes require at least one explicit root')
  const capabilities = executor.update({ enabled: true, roots: requested })
  if (capabilities.roots.length === 0) throw new Error('no requested testbed roots could be resolved safely')
  const config: TestbedNodeConfig = {
    version: 1,
    profile,
    configuredAt: new Date().toISOString(),
    roots: capabilities.roots.map(({ id: _id, ...root }) => root),
  }
  atomicJson(configFile(dataDir), config)
  appendTestbedAudit(dataDir, 'node/configured', {
    profile,
    roots: capabilities.roots.map((root) => ({ id: root.id, label: root.label, environment: root.environment?.kind ?? 'host' })),
  })
  return config
}

export function readTestbedNodeConfig(dataDir: string): TestbedNodeConfig {
  const value = JSON.parse(fs.readFileSync(configFile(path.resolve(dataDir)), 'utf8')) as Partial<TestbedNodeConfig>
  const profile = normalizeProfile(value.profile)
  if (value.version !== 1 || !Array.isArray(value.roots)) throw new Error('testbed node configuration is invalid')
  return { version: 1, profile, configuredAt: boundedString(value.configuredAt, 'configuredAt', 100), roots: value.roots }
}

function pairingClaimFile(dataDir: string): string {
  return path.join(dataDir, 'pairing-code.json')
}

export function issueTestbedPairingCode(dataDir: string, now = new Date()): string {
  let raw = ''
  while (raw.length < 8) raw += PAIR_ALPHABET[crypto.randomInt(0, PAIR_ALPHABET.length)]
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
  atomicJson(pairingClaimFile(dataDir), {
    version: 1,
    digest: crypto.createHash('sha256').update(raw).digest('hex'),
    expiresAt: new Date(now.getTime() + PAIR_CODE_TTL_MS).toISOString(),
  })
  appendTestbedAudit(dataDir, 'pairing/code-issued', { expiresAt: new Date(now.getTime() + PAIR_CODE_TTL_MS).toISOString() })
  return code
}

function redeemPairingCode(dataDir: string, supplied: string, now = new Date()): boolean {
  const file = pairingClaimFile(dataDir)
  const claim = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.claim`
  try {
    fs.renameSync(file, claim)
  } catch {
    return false
  }
  try {
    const stored = JSON.parse(fs.readFileSync(claim, 'utf8')) as { digest?: unknown; expiresAt?: unknown }
    const raw = supplied.toUpperCase().replace(/[^A-Z0-9]/gu, '')
    const digest = crypto.createHash('sha256').update(raw).digest('hex')
    return raw.length === 8 && stored.digest === digest && typeof stored.expiresAt === 'string' && Date.parse(stored.expiresAt) >= now.getTime()
  } catch {
    return false
  } finally {
    try { fs.unlinkSync(claim) } catch { /* One-use claim is consumed even when invalid. */ }
  }
}

async function ownedRoster(): Promise<FleetRosterMember[]> {
  const response = await myOwnMeshControlRequest<{ members?: unknown }>({ op: 'owned_roster' }, 5_000).catch(() => null)
  const members = response?.ok ? response.data?.members : undefined
  if (!Array.isArray(members)) return []
  return members.flatMap((raw) => {
    const device = (raw as { device?: unknown }).device
    return typeof device === 'string' && device ? [{ device }] : []
  })
}

function rosterContains(roster: readonly FleetRosterMember[], device: string): boolean {
  const wanted = canonicalDevice(device)
  return wanted.length > 0 && roster.some((member) => canonicalDevice(member.device) === wanted)
}

export async function startTestbedNode(dataDirInput: string): Promise<{ stop: () => void }> {
  const dataDir = path.resolve(dataDirInput)
  const config = readTestbedNodeConfig(dataDir)
  const token = getOrCreateDeviceToken(dataDir)
  const bridge = new MyOwnMeshRpcBridge()
  const controller = new RemoteDeviceController(
    new FleetConnectionStore(connectionsFile(dataDir)),
    async () => null,
    { bridge, localDeviceToken: token },
  )
  const executor = new DeviceExecutor(policyFile(dataDir))
  const recentMessageIds = admittedMessageIds(dataDir)
  const admitMessage = (id: string, sourceSiteId: string, operation: string): void => {
    const now = Date.now()
    for (const [candidate, seenAt] of recentMessageIds) if (now - seenAt > MESSAGE_REPLAY_TTL_MS) recentMessageIds.delete(candidate)
    if (recentMessageIds.has(id)) throw new Error('direct testbed message was already processed')
    // Admit durably before an elevated action can begin. A crash after this point may conservatively
    // reject an action that never started, but it cannot replay one whose outcome the source did not see.
    appendTestbedAudit(dataDir, 'device/admitted', { sourceSiteId, messageId: id, operation })
    recentMessageIds.set(id, now)
  }

  await bridge.start(async ({ from, payload }) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('direct testbed request is malformed')
    const request = payload as Record<string, unknown>
    if (request.kind === 'pair_exchange' || request.kind === 'fleet_trust_exchange') {
      const source = request.source && typeof request.source === 'object' && !Array.isArray(request.source)
        ? request.source as Record<string, unknown>
        : {}
      const sourceSiteId = boundedString(source.siteId, 'source site id')
      const sourceLabel = boundedString(source.label, 'source label', 200)
      const sourceToken = boundedString(source.token, 'source token', 512)
      if (sourceToken.length < 32 || canonicalDevice(sourceSiteId) !== canonicalDevice(from)) {
        throw new Error('pair exchange identity does not match the authenticated mesh peer')
      }
      const trust = request.kind === 'fleet_trust_exchange'
        ? rosterContains(await ownedRoster(), from)
        : redeemPairingCode(dataDir, boundedString(request.code, 'pairing code', 16))
      if (!trust) throw new Error(request.kind === 'fleet_trust_exchange'
        ? 'automatic testbed trust requires membership in the signed AllMyStuff fleet roster'
        : 'pairing code is invalid, expired, or already used')
      const identity = await bridge.identity()
      if (!identity) throw new Error('testbed node could not resolve its MyOwnMesh identity')
      const saved = controller.saveConnection({ siteId: sourceSiteId, label: sourceLabel, token: sourceToken })
      appendTestbedAudit(dataDir, 'pairing/accepted', {
        sourceSiteId,
        sourceLabel,
        trust: request.kind === 'fleet_trust_exchange' ? 'signed-fleet-roster' : 'one-use-code',
        changed: saved.changed,
      })
      return { siteId: identity.siteId, label: identity.label, token }
    }
    if (request.kind !== 'authenticated') throw new Error('direct testbed request is unsupported')
    const envelope = controller.verifyDirectEnvelope(request.envelope, from)
    admitMessage(envelope.messageId, envelope.sourceSiteId, envelope.operation)
    if (envelope.operation === 'device_capabilities') {
      return {
        ...executor.capabilities(),
        nodeKind: 'lightweight-testbed' as const,
        deploymentProfile: config.profile,
        elevated: config.profile === 'elevated-machine' || config.profile === 'linux-sudo-machine',
      }
    }
    if (envelope.operation !== 'device_action') throw new Error('lightweight nodes accept only testbed operations')
    const content = envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
      ? envelope.payload as Record<string, unknown>
      : {}
    if (!content.action || typeof content.action !== 'object' || Array.isArray(content.action)) throw new Error('action must be an object')
    const action = content.action as RemoteDeviceAction
    if (!['probe', 'inspect', 'git_inspect', 'git_sync', 'list', 'read', 'mkdir', 'write', 'exec'].includes(action.op)) {
      throw new Error('unknown remote device operation')
    }
    const result = await executor.execute(action)
    appendTestbedAudit(dataDir, 'device/action', {
      sourceSiteId: envelope.sourceSiteId,
      messageId: envelope.messageId,
      profile: config.profile,
      op: action.op,
      rootId: typeof action.rootId === 'string' ? action.rootId.slice(0, 128) : '',
      ok: result.ok,
      failure: result.failure?.stage,
      code: result.failure?.code,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      targetMs: result.telemetry?.targetMs,
      bytes: result.bytes,
    })
    return result
  })
  appendTestbedAudit(dataDir, 'node/started', { profile: config.profile, pid: process.pid })
  return {
    stop: () => {
      bridge.stop()
      appendTestbedAudit(dataDir, 'node/stopped', { profile: config.profile, pid: process.pid })
    },
  }
}

function currentDistDir(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

function installFiles(installRoot: string): void {
  const dist = path.join(installRoot, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  for (const name of ['testbedNode.js', 'deviceToken.js', 'remoteDevices.js', 'directHubProtocol.js', 'myOwnMeshRpc.js']) {
    const source = path.join(currentDistDir(), name)
    if (!fs.existsSync(source)) throw new Error(`testbed payload is missing ${name}; run the hub production build first`)
    fs.copyFileSync(source, path.join(dist, name))
  }
  fs.copyFileSync(process.execPath, path.join(installRoot, process.platform === 'win32' ? 'node.exe' : 'node'))
  if (process.platform !== 'win32') fs.chmodSync(path.join(installRoot, 'node'), 0o755)
  fs.writeFileSync(path.join(installRoot, 'package.json'), '{\n  "private": true,\n  "type": "module"\n}\n', { mode: 0o644 })
}

function installWindowsElevated(profile: TestbedNodeProfile): { installRoot: string; dataDir: string; launcher: string } {
  if (profile !== 'elevated-machine') throw new Error('Windows elevated startup requires the elevated-machine profile')
  const programData = process.env.ProgramData?.trim() || 'C:\\ProgramData'
  const installRoot = path.join(programData, 'AllMyAgents', 'TestbedNode')
  const dataDir = path.join(installRoot, 'data')
  installFiles(installRoot)
  configureTestbedNode({ dataDir, profile })
  execFileSync('icacls.exe', [
    installRoot,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-18:(OI)(CI)(F)',
    '*S-1-5-32-544:(OI)(CI)(F)',
    '/T',
    '/C',
  ], { windowsHide: true, stdio: 'pipe' })
  const launcher = `\"${path.join(installRoot, 'node.exe')}\" \"${path.join(installRoot, 'dist', 'testbedNode.js')}\" run --data-dir \"${dataDir}\"`
  execFileSync('schtasks.exe', [
    '/Create', '/F', '/TN', SERVICE_NAME, '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/TR', launcher,
  ], { windowsHide: true, stdio: 'pipe' })
  execFileSync('schtasks.exe', ['/Run', '/TN', SERVICE_NAME], { windowsHide: true, stdio: 'pipe' })
  appendTestbedAudit(dataDir, 'deployment/installed', { profile, platform: 'win32', account: 'LocalSystem', launcher: 'scheduled-task' })
  return { installRoot, dataDir, launcher: 'Windows startup task (LocalSystem, highest privileges)' }
}

function systemdEscape(value: string): string {
  if (/\r|\n|\0/u.test(value)) throw new Error('systemd path contains control characters')
  return `\"${value.replaceAll('\\', '\\\\').replaceAll('\"', '\\\"')}\"`
}

function installLinuxElevated(profile: TestbedNodeProfile): { installRoot: string; dataDir: string; launcher: string } {
  if (profile !== 'elevated-machine' && profile !== 'linux-sudo-machine') {
    throw new Error('Linux system installation requires elevated-machine or linux-sudo-machine')
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new Error('Linux system installation must be run as root')
  const installRoot = '/opt/allmyagents-testbed'
  const dataDir = '/var/lib/allmyagents-testbed'
  const serviceUser = profile === 'linux-sudo-machine' ? 'allmyagents-testbed' : 'root'
  if (profile === 'linux-sudo-machine') {
    try {
      execFileSync('id', ['-u', serviceUser], { stdio: 'ignore' })
    } catch {
      execFileSync('useradd', ['--system', '--home-dir', dataDir, '--create-home', '--shell', '/usr/sbin/nologin', serviceUser], { stdio: 'pipe' })
    }
  }
  installFiles(installRoot)
  configureTestbedNode({ dataDir, profile })
  if (profile === 'linux-sudo-machine') {
    const sudoers = `/etc/sudoers.d/${SERVICE_NAME}`
    const temporary = `${sudoers}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${serviceUser} ALL=(ALL:ALL) NOPASSWD: ALL\n`, { mode: 0o440 })
    try {
      execFileSync('visudo', ['-cf', temporary], { stdio: 'pipe' })
      fs.renameSync(temporary, sudoers)
      fs.chmodSync(sudoers, 0o440)
    } finally {
      try { fs.unlinkSync(temporary) } catch { /* Rename consumed the validated file. */ }
    }
  }
  fs.mkdirSync('/etc/systemd/system', { recursive: true })
  fs.writeFileSync('/etc/systemd/system/allmyagents-testbed.service', [
    '[Unit]',
    'Description=AllMyAgents lightweight remote testbed',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${serviceUser}`,
    `ExecStart=${systemdEscape(path.join(installRoot, 'node'))} ${systemdEscape(path.join(installRoot, 'dist', 'testbedNode.js'))} run --data-dir ${systemdEscape(dataDir)}`,
    'Restart=on-failure',
    'RestartSec=3',
    'NoNewPrivileges=false',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n'), { mode: 0o644 })
  if (profile === 'linux-sudo-machine') {
    execFileSync('chown', ['-R', `${serviceUser}:${serviceUser}`, dataDir], { stdio: 'pipe' })
  }
  execFileSync('systemctl', ['daemon-reload'], { stdio: 'pipe' })
  execFileSync('systemctl', ['enable', '--now', 'allmyagents-testbed.service'], { stdio: 'pipe' })
  appendTestbedAudit(dataDir, 'deployment/installed', { profile, platform: 'linux', account: serviceUser, launcher: 'systemd' })
  return { installRoot, dataDir, launcher: `systemd (${serviceUser})` }
}

export function installElevatedTestbedNode(profile: TestbedNodeProfile): { installRoot: string; dataDir: string; launcher: string } {
  if (process.platform === 'win32') return installWindowsElevated(profile)
  if (process.platform === 'linux') return installLinuxElevated(profile)
  throw new Error('elevated testbed installation is currently implemented for Windows and Linux')
}

function cliValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function parseScopedRoots(args: string[]): DeviceRootPolicy[] {
  const roots: DeviceRootPolicy[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--root') continue
    const rootPath = args[index + 1]
    if (!rootPath) throw new Error('--root requires a path')
    roots.push({
      id: '',
      label: path.basename(path.resolve(rootPath)) || path.resolve(rootPath),
      path: rootPath,
      read: args.includes('--read') || (!args.includes('--write') && !args.includes('--terminal')),
      write: args.includes('--write'),
      terminal: args.includes('--terminal'),
    })
  }
  return roots
}

export async function runTestbedNodeCli(args = process.argv.slice(2)): Promise<number> {
  const command = args[0]
  const dataDir = path.resolve(cliValue(args, '--data-dir') ?? defaultDataDir())
  if (command === 'configure') {
    const profile = normalizeProfile(cliValue(args, '--profile') ?? 'scoped')
    const config = configureTestbedNode({ dataDir, profile, roots: parseScopedRoots(args) })
    process.stdout.write(`${JSON.stringify({ ok: true, dataDir, profile: config.profile, roots: config.roots.length })}\n`)
    return 0
  }
  if (command === 'pair-code') {
    process.stdout.write(`${issueTestbedPairingCode(dataDir)}\n`)
    return 0
  }
  if (command === 'install-elevated') {
    const profile = normalizeProfile(cliValue(args, '--profile') ?? 'elevated-machine')
    const installed = installElevatedTestbedNode(profile)
    process.stdout.write(`${JSON.stringify({ ok: true, profile, ...installed })}\n`)
    return 0
  }
  if (command === 'run') {
    const runtime = await startTestbedNode(dataDir)
    const stop = (): void => { runtime.stop(); process.exitCode = 0 }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    process.stdout.write(`${JSON.stringify({ ok: true, status: 'running', dataDir, pid: process.pid })}\n`)
    return await new Promise<number>(() => { /* Kept alive by the MyOwnMesh event socket. */ })
  }
  process.stderr.write('Usage: testbedNode <configure|pair-code|install-elevated|run> [--data-dir PATH] [--profile PROFILE] [--root PATH] [--read] [--write] [--terminal]\n')
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runTestbedNodeCli().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
