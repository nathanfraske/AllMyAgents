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
  testbedToolchainSearchPaths,
  type DeviceRootPolicy,
  type RemoteDeviceAction,
  type RemoteExecutionEnvironment,
  type TestbedBuildIdentity,
} from './remoteDevices.js'
import { defaultMyOwnMeshSocketPath, MyOwnMeshRpcBridge, myOwnMeshControlRequest } from './myOwnMeshRpc.js'

export type TestbedNodeProfile = 'scoped' | 'full-machine' | 'elevated-machine' | 'linux-sudo-machine'

export interface TestbedNodeConfig {
  version: 1
  profile: TestbedNodeProfile
  configuredAt: string
  /** Opt-in only: fleet roster membership must never silently become machine execution authority. */
  fleetTrustExchange?: boolean
  roots: Array<Pick<DeviceRootPolicy, 'label' | 'path' | 'environment' | 'read' | 'write' | 'terminal'>>
}

interface FleetRosterMember { device: string }

const SERVICE_NAME = 'AllMyAgentsTestbed'
const AUDIT_MAX_BYTES = 5 * 1024 * 1024
const AUDIT_GENERATIONS = 4
const PAIR_CODE_TTL_MS = 10 * 60 * 1000
const MESSAGE_REPLAY_TTL_MS = 10 * 60 * 1000
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const TESTBED_MODULES = ['testbedNode.js', 'deviceToken.js', 'remoteDevices.js', 'directHubProtocol.js', 'myOwnMeshRpc.js'] as const
const TESTBED_SERVICE = 'allmyagents-testbed.service'
const LINUX_SHARED_TOOLCHAIN_HOME = '/opt/allmyagents-toolchains'
const LINUX_TOOLCHAIN_PROFILE = '/etc/profile.d/allmyagents-toolchains.sh'

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

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function payloadRoot(): string {
  return path.dirname(currentDistDir())
}

/** Build identity is descriptive and checksum-backed. It carries no pairing or execution authority. */
export function readTestbedBuildIdentity(root = payloadRoot()): TestbedBuildIdentity {
  const sumsFile = path.join(root, 'SHA256SUMS')
  const files: TestbedBuildIdentity['files'] = []
  if (fs.existsSync(sumsFile)) {
    for (const line of fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/u).filter(Boolean)) {
      const match = /^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/u.exec(line)
      if (!match) continue
      const absolute = path.resolve(root, ...match[2]!.split('/'))
      const relation = path.relative(root, absolute)
      if (relation.startsWith('..') || path.isAbsolute(relation) || !fs.existsSync(absolute)) continue
      files.push({ path: match[2]!, sha256: sha256File(absolute), bytes: fs.statSync(absolute).size })
    }
  }
  // Pre-observability payloads did not install their manifest/checksum files. Still identify their
  // exact code so the first sync can compare rather than assuming that an old node is current.
  if (files.length === 0) {
    for (const name of TESTBED_MODULES) {
      const absolute = path.join(root, 'dist', name)
      if (fs.existsSync(absolute)) files.push({ path: `dist/${name}`, sha256: sha256File(absolute), bytes: fs.statSync(absolute).size })
    }
    const runtime = process.platform === 'win32' ? 'node.exe' : 'node'
    const runtimePath = path.join(root, runtime)
    if (fs.existsSync(runtimePath)) files.push({ path: runtime, sha256: sha256File(runtimePath), bytes: fs.statSync(runtimePath).size })
  }
  let manifest: { protocol?: unknown; appVersion?: unknown; sourceCommit?: unknown } = {}
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as typeof manifest } catch { /* legacy node */ }
  try {
    const build = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8')) as typeof manifest
    manifest = { ...manifest, ...build }
  } catch { /* legacy node */ }
  const normalized = files.sort((left, right) => left.path.localeCompare(right.path))
  const payloadId = crypto.createHash('sha256')
    .update(normalized.map((file) => `${file.sha256}  ${file.path}\n`).join(''))
    .digest('hex')
  const codePayloadId = crypto.createHash('sha256')
    .update(normalized.filter((file) => file.path.startsWith('dist/'))
      .map((file) => `${file.sha256}  ${file.path}\n`).join(''))
    .digest('hex')
  return {
    payloadId,
    codePayloadId,
    protocol: typeof manifest.protocol === 'number' ? manifest.protocol : 1,
    ...(typeof manifest.appVersion === 'string' ? { appVersion: manifest.appVersion } : {}),
    ...(typeof manifest.sourceCommit === 'string' ? { sourceCommit: manifest.sourceCommit } : {}),
    files: normalized,
  }
}

/** Public host keys are safe to expose through the already-authenticated mesh lane for SSH pinning. */
export function sshHostKeyFingerprints(directory = '/etc/ssh'): string[] {
  if (process.platform === 'win32' && directory === '/etc/ssh') return []
  let names: string[]
  try { names = fs.readdirSync(directory) } catch { return [] }
  return names
    .filter((name) => /^ssh_host_[A-Za-z0-9_-]+_key\.pub$/u.test(name))
    .sort()
    .flatMap((name) => {
      try {
        const fields = fs.readFileSync(path.join(directory, name), 'utf8').trim().split(/\s+/u)
        if (fields.length < 2 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(fields[1]!)) return []
        const bytes = Buffer.from(fields[1]!, 'base64')
        if (bytes.length === 0) return []
        const digest = crypto.createHash('sha256').update(bytes).digest('base64').replace(/=+$/u, '')
        return [`${fields[0]} SHA256:${digest}`]
      } catch { return [] }
    })
    .slice(0, 16)
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
  fleetTrustExchange?: boolean
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
    ...(input.fleetTrustExchange === true ? { fleetTrustExchange: true } : {}),
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
  return {
    version: 1,
    profile,
    configuredAt: boundedString(value.configuredAt, 'configuredAt', 100),
    ...(value.fleetTrustExchange === true ? { fleetTrustExchange: true } : {}),
    roots: value.roots,
  }
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
  const response = await myOwnMeshControlRequest<{ members?: unknown; roster?: unknown }>({
    op: 'roster_list',
  }, 5_000).catch(() => null)
  const members = response?.ok ? (response.data?.members ?? response.data?.roster) : undefined
  if (!Array.isArray(members)) return []
  return members.flatMap((raw) => {
    const candidate = raw as { device?: unknown; device_id?: unknown; id?: unknown }
    const device = candidate.device ?? candidate.device_id ?? candidate.id
    return typeof device === 'string' && device ? [{ device }] : []
  })
}

async function advertiseTestbedCapabilities(): Promise<void> {
  const listed = await myOwnMeshControlRequest<{
    networks?: Array<{ config_id?: unknown; phase?: unknown }>
  }>({ op: 'networks_list' }, 5_000)
  if (!listed.ok) throw new Error(listed.error || 'MyOwnMesh network discovery failed')
  const networks = (listed.data?.networks ?? []).flatMap((network) =>
    typeof network.config_id === 'string' && network.config_id
      ? [network.config_id]
      : [],
  )
  if (networks.length === 0) throw new Error('MyOwnMesh has no network on which to advertise the testbed')
  const outcomes = await Promise.all(networks.map((network) =>
    myOwnMeshControlRequest({
      op: 'capabilities_set',
      network,
      capabilities: {
        app_version: 'allmyagents-testbed/1',
        tags: ['allmyagents-testbed', 'terminal'],
      },
    }, 5_000).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })),
  ))
  if (!outcomes.some((outcome) => outcome.ok)) {
    throw new Error(outcomes.map((outcome) => outcome.error).find(Boolean) || 'MyOwnMesh refused testbed capability advertisement')
  }
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
  const executor = new DeviceExecutor(policyFile(dataDir), {
    isolateLinuxCommands: process.platform === 'linux' &&
      (config.profile === 'elevated-machine' || config.profile === 'linux-sudo-machine'),
  })
  const runningBuild = readTestbedBuildIdentity()
  const hostKeyFingerprints = sshHostKeyFingerprints()
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

  await advertiseTestbedCapabilities()
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
        ? config.fleetTrustExchange === true && rosterContains(await ownedRoster(), from)
        : redeemPairingCode(dataDir, boundedString(request.code, 'pairing code', 16))
      if (!trust) throw new Error(request.kind === 'fleet_trust_exchange'
        ? 'automatic fleet trust is disabled or the peer is not in the signed MyOwnMesh roster; use a one-use pairing code'
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
        testbedBuild: runningBuild,
        sshHostKeyFingerprints: hostKeyFingerprints,
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
    const actor = content.actor && typeof content.actor === 'object' && !Array.isArray(content.actor)
      ? content.actor as Record<string, unknown>
      : {}
    const durableRunId = typeof actor.durableRunId === 'string'
      ? actor.durableRunId.slice(0, 128)
      : undefined
    const result = await executor.execute(action, { durableRunId })
    appendTestbedAudit(dataDir, 'device/action', {
      sourceSiteId: envelope.sourceSiteId,
      messageId: envelope.messageId,
      profile: config.profile,
      op: action.op,
      durableRunId,
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
  }, { requireConnection: true })
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
  for (const name of TESTBED_MODULES) {
    const source = path.join(currentDistDir(), name)
    if (!fs.existsSync(source)) throw new Error(`testbed payload is missing ${name}; run the hub production build first`)
    fs.copyFileSync(source, path.join(dist, name))
  }
  fs.copyFileSync(process.execPath, path.join(installRoot, process.platform === 'win32' ? 'node.exe' : 'node'))
  if (process.platform !== 'win32') fs.chmodSync(path.join(installRoot, 'node'), 0o755)
  const sourceRoot = payloadRoot()
  for (const name of ['package.json', 'README.txt', 'manifest.json', 'build.json', 'SHA256SUMS']) {
    const source = path.join(sourceRoot, name)
    if (!fs.existsSync(source)) throw new Error(`testbed payload is missing ${name}; rebuild the portable payload`)
    fs.copyFileSync(source, path.join(installRoot, name))
  }
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

function isUnixSocket(candidate: string): boolean {
  try { return fs.statSync(candidate).isSocket() } catch { return false }
}

export function detectMyOwnMeshSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  probe: (candidate: string) => boolean = isUnixSocket,
): string {
  const configured = env.MYOWNMESH_CONTROL_SOCKET?.trim()
  const candidates = [
    configured,
    defaultMyOwnMeshSocketPath(env, 'linux', home),
    '/var/lib/myownmesh/daemon.sock',
    '/run/myownmesh/daemon.sock',
    '/run/myownmesh.sock',
    path.join(home, '.myownmesh', 'daemon.sock'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  return [...new Set(candidates)].find(probe) ?? candidates[0]!
}

function linuxServiceUser(profile: TestbedNodeProfile): string {
  return profile === 'linux-sudo-machine' ? 'allmyagents-testbed' : 'root'
}

function linuxServiceHome(profile: TestbedNodeProfile, dataDir: string): string {
  return profile === 'linux-sudo-machine' ? dataDir : '/root'
}

function populatedRustupHome(candidate: string): boolean {
  try { return fs.statSync(path.posix.join(candidate, 'toolchains')).isDirectory() } catch { return false }
}

function reconcilePrivateRustupHome(serviceHome: string, preferred: string): void {
  const privateHome = path.posix.join(serviceHome, '.rustup')
  if (!populatedRustupHome(privateHome) || fs.lstatSync(privateHome).isSymbolicLink()) return
  try {
    if (fs.existsSync(preferred) && fs.readdirSync(preferred).length === 0) fs.rmdirSync(preferred)
    fs.mkdirSync(path.posix.dirname(preferred), { recursive: true, mode: 0o755 })
    fs.renameSync(privateHome, preferred)
    try { fs.symlinkSync(preferred, privateHome, 'dir') } catch { /* Explicit service/profile state still points at the durable copy. */ }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    // A separately-mounted /opt cannot accept an atomic rename. Copy and verify the complete toolchain,
    // then leave the private original untouched as a rollback rather than deleting it speculatively.
    fs.cpSync(privateHome, preferred, { recursive: true, errorOnExist: true, preserveTimestamps: true })
    if (!populatedRustupHome(preferred)) throw new Error('shared Rust toolchain copy did not contain a toolchains directory')
  }
}

function detectLinuxRustupHome(serviceHome: string): string {
  const preferred = path.posix.join(LINUX_SHARED_TOOLCHAIN_HOME, 'rustup')
  if (populatedRustupHome(preferred)) return preferred
  // Compatibility with the first RISC-V testbed repair. Do not strand its verified compiler by
  // switching RUSTUP_HOME to a newly-created empty directory during a payload/service update.
  if (populatedRustupHome('/opt/rust')) return '/opt/rust'
  reconcilePrivateRustupHome(serviceHome, preferred)
  return preferred
}

export function renderLinuxToolchainProfile(input: { toolchainHome: string; rustupHome: string }): string {
  const shellValue = (value: string): string => {
    if (/\r|\n|\0/u.test(value)) throw new Error('toolchain path contains control characters')
    return `'${value.replaceAll("'", `'\"'\"'`)}'`
  }
  const toolchainHome = shellValue(input.toolchainHome)
  const rustupHome = shellValue(input.rustupHome)
  return [
    '# AllMyAgents testbed: shared compiler payload; writable package caches remain per user.',
    `export ALLMYAGENTS_TOOLCHAIN_HOME=${toolchainHome}`,
    `export RUSTUP_HOME=${rustupHome}`,
    'ama_toolchain_path="$ALLMYAGENTS_TOOLCHAIN_HOME/bin"',
    'for ama_toolchain_bin in "$RUSTUP_HOME"/toolchains/*/bin; do',
    '  [ -d "$ama_toolchain_bin" ] && ama_toolchain_path="$ama_toolchain_path:$ama_toolchain_bin"',
    'done',
    'PATH="$ama_toolchain_path:$PATH"',
    'export PATH',
    'unset ama_toolchain_path ama_toolchain_bin',
    '',
  ].join('\n')
}

function ensureLinuxToolchainEnvironment(profile: TestbedNodeProfile, dataDir: string): {
  toolchainHome: string
  rustupHome: string
  commandPath: string
} {
  const home = linuxServiceHome(profile, dataDir)
  const rustupHome = detectLinuxRustupHome(home)
  fs.mkdirSync(path.posix.join(LINUX_SHARED_TOOLCHAIN_HOME, 'bin'), { recursive: true, mode: 0o755 })
  fs.mkdirSync(rustupHome, { recursive: true, mode: 0o755 })
  fs.chmodSync(LINUX_SHARED_TOOLCHAIN_HOME, 0o755)
  fs.chmodSync(path.posix.join(LINUX_SHARED_TOOLCHAIN_HOME, 'bin'), 0o755)
  fs.chmodSync(rustupHome, 0o755)
  const readabilityMarker = path.posix.join(rustupHome, '.allmyagents-shared-readable-v1')
  if (!fs.existsSync(readabilityMarker)) {
    execFileSync('chmod', ['-R', 'a+rX', rustupHome], { stdio: 'pipe' })
    fs.writeFileSync(readabilityMarker, 'Shared compiler payload; writable package caches remain per user.\n', { mode: 0o644 })
  }
  fs.mkdirSync(path.posix.dirname(LINUX_TOOLCHAIN_PROFILE), { recursive: true })
  fs.writeFileSync(LINUX_TOOLCHAIN_PROFILE, renderLinuxToolchainProfile({
    toolchainHome: LINUX_SHARED_TOOLCHAIN_HOME,
    rustupHome,
  }), { mode: 0o644 })
  fs.chmodSync(LINUX_TOOLCHAIN_PROFILE, 0o644)
  const serviceUser = linuxServiceUser(profile)
  if (profile === 'linux-sudo-machine' && rustupHome.startsWith(`${LINUX_SHARED_TOOLCHAIN_HOME}/`)) {
    execFileSync('chown', [
      `${serviceUser}:${serviceUser}`,
      LINUX_SHARED_TOOLCHAIN_HOME,
      path.posix.join(LINUX_SHARED_TOOLCHAIN_HOME, 'bin'),
      rustupHome,
    ], { stdio: 'pipe' })
  }
  const search = testbedToolchainSearchPaths({
    ALLMYAGENTS_REMOTE_TESTBED: '1',
    ALLMYAGENTS_TOOLCHAIN_HOME: LINUX_SHARED_TOOLCHAIN_HOME,
    RUSTUP_HOME: rustupHome,
  }, home, 'linux')
  const standard = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']
  return {
    toolchainHome: LINUX_SHARED_TOOLCHAIN_HOME,
    rustupHome,
    commandPath: [...search, ...standard].filter((value, index, all) => all.indexOf(value) === index).join(':'),
  }
}

export function writeLinuxTestbedService(input: {
  installRoot: string
  dataDir: string
  profile: TestbedNodeProfile
  socketPath?: string
}): string {
  const socketPath = input.socketPath ?? detectMyOwnMeshSocketPath()
  const toolchains = ensureLinuxToolchainEnvironment(input.profile, input.dataDir)
  fs.mkdirSync('/etc/systemd/system', { recursive: true })
  const serviceFile = `/etc/systemd/system/${TESTBED_SERVICE}`
  fs.writeFileSync(serviceFile, renderLinuxTestbedService({ ...input, socketPath, ...toolchains }), { mode: 0o644 })
  return serviceFile
}

export function renderLinuxTestbedService(input: {
  installRoot: string
  dataDir: string
  profile: TestbedNodeProfile
  socketPath: string
  toolchainHome?: string
  rustupHome?: string
  commandPath?: string
}): string {
  const serviceUser = linuxServiceUser(input.profile)
  const toolchainHome = input.toolchainHome ?? LINUX_SHARED_TOOLCHAIN_HOME
  const rustupHome = input.rustupHome ?? path.posix.join(toolchainHome, 'rustup')
  const commandPath = input.commandPath ?? [
    path.posix.join(toolchainHome, 'bin'),
    path.posix.join(linuxServiceHome(input.profile, input.dataDir), '.cargo', 'bin'),
    '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin',
  ].join(':')
  return [
    '[Unit]',
    'Description=AllMyAgents lightweight remote testbed',
    'After=network-online.target myownmesh.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${serviceUser}`,
    `Environment=${systemdEscape(`MYOWNMESH_CONTROL_SOCKET=${input.socketPath}`)}`,
    `Environment=${systemdEscape(`ALLMYAGENTS_TOOLCHAIN_HOME=${toolchainHome}`)}`,
    `Environment=${systemdEscape(`RUSTUP_HOME=${rustupHome}`)}`,
    `Environment=${systemdEscape(`CARGO_INSTALL_ROOT=${toolchainHome}`)}`,
    `Environment=${systemdEscape(`PATH=${commandPath}`)}`,
    `ExecStart=${systemdEscape(path.join(input.installRoot, 'node'))} ${systemdEscape(path.join(input.installRoot, 'dist', 'testbedNode.js'))} run --data-dir ${systemdEscape(input.dataDir)}`,
    'UMask=0022',
    'Restart=on-failure',
    'RestartSec=3',
    'NoNewPrivileges=false',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')
}

export function repairLinuxTestbedService(dataDir: string, installRoot = payloadRoot()): { serviceFile: string; socketPath: string } {
  if (process.platform !== 'linux') throw new Error('service repair is available only on Linux')
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new Error('service repair must be run as root')
  const config = readTestbedNodeConfig(dataDir)
  const socketPath = detectMyOwnMeshSocketPath()
  const serviceFile = writeLinuxTestbedService({ installRoot, dataDir, profile: config.profile, socketPath })
  execFileSync('systemctl', ['daemon-reload'], { stdio: 'pipe' })
  appendTestbedAudit(dataDir, 'deployment/service-repaired', { serviceFile, socketPath })
  return { serviceFile, socketPath }
}

function installLinuxElevated(profile: TestbedNodeProfile): { installRoot: string; dataDir: string; launcher: string } {
  if (profile !== 'elevated-machine' && profile !== 'linux-sudo-machine') {
    throw new Error('Linux system installation requires elevated-machine or linux-sudo-machine')
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new Error('Linux system installation must be run as root')
  const installRoot = '/opt/allmyagents-testbed'
  const dataDir = '/var/lib/allmyagents-testbed'
  const serviceUser = linuxServiceUser(profile)
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
  writeLinuxTestbedService({ installRoot, dataDir, profile })
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
    const config = configureTestbedNode({
      dataDir,
      profile,
      roots: parseScopedRoots(args),
      fleetTrustExchange: args.includes('--trust-fleet'),
    })
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
  if (command === 'repair-service') {
    const repaired = repairLinuxTestbedService(dataDir)
    process.stdout.write(`${JSON.stringify({ ok: true, ...repaired })}\n`)
    return 0
  }
  if (command === 'run') {
    const runtime = await startTestbedNode(dataDir)
    process.stdout.write(`${JSON.stringify({ ok: true, status: 'running', dataDir, pid: process.pid })}\n`)
    return await new Promise<number>((resolve) => {
      // A pending Promise is not an event-loop resource. Keep an explicit referenced lease so a future
      // bridge regression cannot print "running" and then let the process exit cleanly underneath it.
      const lease = setInterval(() => {}, 60_000)
      let stopped = false
      const stop = (): void => {
        if (stopped) return
        stopped = true
        clearInterval(lease)
        runtime.stop()
        resolve(0)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
  }
  process.stderr.write('Usage: testbedNode <configure|pair-code|install-elevated|repair-service|run> [--data-dir PATH] [--profile PROFILE] [--root PATH] [--read] [--write] [--terminal]\n')
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runTestbedNodeCli().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
