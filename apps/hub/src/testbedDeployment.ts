import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AllMyStuffPlanes, allMyStuffRemotePathJoin, type AllMyStuffTransferProgress } from './allMyStuffPlanes.js'
import type { MyOwnMeshRpcBridge } from './myOwnMeshRpc.js'
import type { RemoteDeviceController } from './remoteDevices.js'
import type { TestbedNodeProfile } from './testbedNode.js'

interface TestbedBundleManifest {
  version: 1
  kind: 'allmyagents-lightweight-testbed'
  platform: NodeJS.Platform
  arch: string
  protocol: 1
}

export interface TestbedDeploymentResult {
  deploymentId: string
  siteId: string
  profile: TestbedNodeProfile
  platform: NodeJS.Platform
  arch: string
  files: number
  bytes: number
  transferMs: number
  bytesPerSecond: number
  installMs: number
  verified: true
  alreadyInstalled?: boolean
  cleanupPending?: boolean
}

export interface TestbedDeploymentEvent {
  deploymentId: string
  siteId: string
  profile: TestbedNodeProfile
  stage: 'requested' | 'preflight' | 'transferring' | 'installing' | 'pairing' | 'cleaning' | 'verified' | 'failed'
  detail?: Record<string, unknown>
}

export interface TestbedDeploymentDependencies {
  bundleDir: string
  directMesh: MyOwnMeshRpcBridge
  remoteDevices: RemoteDeviceController
  ownedRoster: () => Promise<Array<{ device: string }>>
  planes?: AllMyStuffPlanes
  emit?: (event: TestbedDeploymentEvent) => void
}

export interface TestbedTarget {
  siteId: string
  label: string
  online: boolean
  status: string
  rttMs?: number
  paired: boolean
  signedFleet: true
}

export interface TestbedTargetInspection extends TestbedTarget {
  platform: NodeJS.Platform
  arch: string
  home: string
}

function canonical(value: string): string {
  return value.split('-', 1)[0]!.trim().toLowerCase()
}

function platformFromHome(home: string): NodeJS.Platform {
  return /^[A-Za-z]:[\\/]/u.test(home) || /^\\\\/u.test(home) ? 'win32' : 'linux'
}

function normalizeArch(value: string): string {
  const lower = value.toLowerCase()
  if (/\b(?:x64|x86_64|amd64)\b/u.test(lower)) return 'x64'
  if (/\b(?:arm64|aarch64)\b/u.test(lower)) return 'arm64'
  if (/\b(?:arm|armv7|armv7l)\b/u.test(lower)) return 'arm'
  if (/\b(?:ia32|x86|i686)\b/u.test(lower)) return 'ia32'
  return lower.trim().slice(0, 50)
}

function powerShellLiteral(value: string): string {
  if (/\r|\n|\0/u.test(value)) throw new Error('remote Windows path contains a control character')
  return `'${value.replaceAll("'", "''")}'`
}

function shellLiteral(value: string): string {
  if (/\r|\n|\0/u.test(value)) throw new Error('remote Unix path contains a control character')
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

export function verifyTestbedBundle(bundleDir: string): TestbedBundleManifest {
  const root = fs.realpathSync.native(path.resolve(bundleDir))
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as Partial<TestbedBundleManifest>
  if (
    manifest.version !== 1 ||
    manifest.kind !== 'allmyagents-lightweight-testbed' ||
    manifest.protocol !== 1 ||
    typeof manifest.platform !== 'string' ||
    typeof manifest.arch !== 'string'
  ) {
    throw new Error('the bundled testbed manifest is invalid')
  }
  const runtime = manifest.platform === 'win32' ? 'node.exe' : 'node'
  const expectedFiles = new Set([
    'SHA256SUMS',
    'README.txt',
    'manifest.json',
    'package.json',
    runtime,
    'dist/testbedNode.js',
    'dist/deviceToken.js',
    'dist/remoteDevices.js',
    'dist/directHubProtocol.js',
    'dist/myOwnMeshRpc.js',
  ])
  const actualFiles = new Set<string>()
  const walk = (directory: string, relative = ''): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('the bundled testbed payload contains a symbolic link')
      if (entry.isDirectory()) walk(absolute, childRelative)
      else if (entry.isFile()) actualFiles.add(childRelative)
      else throw new Error('the bundled testbed payload contains an unsupported filesystem entry')
    }
  }
  walk(root)
  if (
    actualFiles.size !== expectedFiles.size ||
    [...actualFiles].some((file) => !expectedFiles.has(file))
  ) {
    throw new Error('the bundled testbed payload does not match the exact credential-free file allowlist')
  }
  const sums = fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').split(/\r?\n/u).filter(Boolean)
  const checksummed = new Set<string>()
  for (const line of sums) {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/u)
    if (!match) throw new Error('the bundled testbed checksum manifest is malformed')
    const relative = match[2]!
    if (relative === 'SHA256SUMS' || !expectedFiles.has(relative) || checksummed.has(relative)) {
      throw new Error('the bundled testbed checksum manifest contains an unexpected or duplicate path')
    }
    checksummed.add(relative)
    const absolute = path.resolve(root, ...relative.split('/'))
    const relation = path.relative(root, absolute)
    if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('the bundled testbed checksum path escaped its payload')
    const actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
    if (actual !== match[1]) throw new Error(`the bundled testbed payload failed verification: ${relative}`)
  }
  if (checksummed.size !== expectedFiles.size - 1) {
    throw new Error('the bundled testbed checksum manifest is incomplete')
  }
  return manifest as TestbedBundleManifest
}

function remoteVerifyCommand(platform: NodeJS.Platform, stage: string): string {
  if (platform === 'win32') {
    const root = powerShellLiteral(stage)
    return [
      `$amaRoot = ${root}`,
      '$amaOk = $true',
      'Get-Content -LiteralPath (Join-Path $amaRoot "SHA256SUMS") | ForEach-Object {',
      '  if ($_ -match "^([0-9a-f]{64})  (.+)$") {',
      '    $amaExpected = $Matches[1]',
      '    $amaPath = Join-Path $amaRoot ($Matches[2] -replace "/", "\\")',
      '    if (-not (Test-Path -LiteralPath $amaPath) -or (Get-FileHash -LiteralPath $amaPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $amaExpected) { $amaOk = $false }',
      '  } else { $amaOk = $false }',
      '}',
      'if ($amaOk) { $global:LASTEXITCODE = 0 } else { $global:LASTEXITCODE = 23 }',
    ].join('; ')
  }
  return `cd ${shellLiteral(stage)} && sha256sum -c SHA256SUMS`
}

function remoteInstallCommand(platform: NodeJS.Platform, stage: string, profile: TestbedNodeProfile): string {
  if (platform === 'win32') {
    if (profile !== 'elevated-machine') throw new Error('automatic Windows deployment currently requires elevated-machine')
    return `& ${powerShellLiteral(allMyStuffRemotePathJoin(stage, 'node.exe'))} ${powerShellLiteral(allMyStuffRemotePathJoin(stage, 'dist', 'testbedNode.js'))} install-elevated --profile elevated-machine`
  }
  if (profile !== 'elevated-machine' && profile !== 'linux-sudo-machine') {
    throw new Error('automatic Linux deployment currently requires elevated-machine or linux-sudo-machine')
  }
  return `sudo -n ${shellLiteral(allMyStuffRemotePathJoin(stage, 'node'))} ${shellLiteral(allMyStuffRemotePathJoin(stage, 'dist', 'testbedNode.js'))} install-elevated --profile ${profile}`
}

export class TestbedDeploymentService {
  private readonly planes: AllMyStuffPlanes

  constructor(private readonly deps: TestbedDeploymentDependencies) {
    this.planes = deps.planes ?? new AllMyStuffPlanes()
  }

  private event(event: TestbedDeploymentEvent): void {
    this.deps.emit?.(event)
  }

  async targets(): Promise<TestbedTarget[]> {
    const [roster, peers] = await Promise.all([
      this.deps.ownedRoster(),
      this.deps.directMesh.peers(true),
    ])
    const owned = new Set(roster.map((member) => canonical(member.device)).filter(Boolean))
    const paired = new Set(this.deps.remoteDevices.listConnections().map((connection) => canonical(connection.siteId)))
    return peers
      .filter((peer) => owned.has(canonical(peer.siteId)))
      .map((peer) => ({
        siteId: canonical(peer.siteId),
        label: peer.label,
        online: peer.online,
        status: peer.status,
        ...(peer.rttMs === undefined ? {} : { rttMs: peer.rttMs }),
        paired: paired.has(canonical(peer.siteId)),
        signedFleet: true as const,
      }))
  }

  async inspect(siteIdInput: string): Promise<TestbedTargetInspection> {
    const siteId = canonical(siteIdInput)
    if (!siteId) throw new Error('target device id is required')
    const target = (await this.targets()).find((candidate) => candidate.siteId === siteId)
    if (!target) throw new Error('testbed inspection requires the target in the signed AllMyStuff fleet roster')
    if (!target.online) throw new Error('the target AllMyStuff fleet device is not online')
    const identity = await this.deps.directMesh.identity()
    if (!identity) throw new Error('the source hub could not resolve its AllMyStuff device identity')
    let filesRoute: string | undefined
    let terminalRoute: string | undefined
    try {
      filesRoute = await this.planes.connectFiles(identity.siteId, siteId)
      const home = await this.planes.remoteHome(filesRoute)
      const platform = platformFromHome(home)
      terminalRoute = await this.planes.connectTerminal(identity.siteId, siteId)
      const probe = await this.planes.runCommand(
        terminalRoute,
        platform === 'win32' ? 'windows' : 'unix',
        platform === 'win32'
          ? '[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()'
          : 'uname -m',
        30_000,
      )
      if (!probe.ok) throw new Error(`target architecture probe failed with exit ${probe.exitCode}`)
      return { ...target, platform, arch: normalizeArch(probe.output), home }
    } finally {
      if (terminalRoute) await this.planes.disconnect(terminalRoute)
      if (filesRoute) await this.planes.disconnect(filesRoute)
    }
  }

  async deploy(siteIdInput: string, profile: TestbedNodeProfile): Promise<TestbedDeploymentResult> {
    const siteId = canonical(siteIdInput)
    if (!siteId) throw new Error('target device id is required')
    if (!['elevated-machine', 'linux-sudo-machine'].includes(profile)) {
      throw new Error('automatic remote deployment currently supports elevated-machine and linux-sudo-machine; scoped nodes use the portable bundle locally')
    }
    const deploymentId = `deploy_${crypto.randomUUID()}`
    const baseEvent = { deploymentId, siteId, profile }
    this.event({ ...baseEvent, stage: 'requested' })
    let terminalRoute: string | undefined
    let filesRoute: string | undefined
    try {
      const roster = await this.deps.ownedRoster()
      if (!roster.some((member) => canonical(member.device) === siteId)) {
        throw new Error('automatic testbed deployment requires the target in the signed AllMyStuff fleet roster')
      }
      const identity = await this.deps.directMesh.identity()
      if (!identity) throw new Error('the source hub could not resolve its AllMyStuff device identity')
      const peer = (await this.deps.directMesh.peers(true)).find((candidate) => candidate.siteId === siteId)
      if (!peer?.online) throw new Error('the target AllMyStuff fleet device is not online')
      const manifest = verifyTestbedBundle(this.deps.bundleDir)
      this.event({ ...baseEvent, stage: 'preflight', detail: { bundlePlatform: manifest.platform, bundleArch: manifest.arch } })

      // If an executor already owns the application RPC method, never displace it with a second node.
      let existingPaired = false
      try {
        await this.deps.remoteDevices.pairDirect(siteId)
        existingPaired = true
        const existing = await this.deps.remoteDevices.capabilities(siteId)
        if (existing.nodeKind === 'lightweight-testbed') {
          if (existing.deploymentProfile !== profile || existing.elevated !== true) {
            throw new Error(
              `the target already runs a lightweight node with profile ${existing.deploymentProfile ?? 'unknown'}; automatic in-place profile changes are refused`,
            )
          }
          const result: TestbedDeploymentResult = {
            deploymentId,
            siteId,
            profile: existing.deploymentProfile ?? profile,
            platform: existing.platform,
            arch: existing.arch,
            files: 0,
            bytes: 0,
            transferMs: 0,
            bytesPerSecond: 0,
            installMs: 0,
            verified: true,
            alreadyInstalled: true,
          }
          this.event({ ...baseEvent, stage: 'verified', detail: { ...result } })
          return result
        }
        throw new Error('the target already runs a full AllMyAgents hub; use its built-in executor instead of installing a competing lightweight node')
      } catch (error) {
        if (error instanceof Error && /already runs a full|use its built-in|lightweight/u.test(error.message)) throw error
        if (existingPaired) {
          throw new Error(
            `the target already answers the AllMyAgents route but its capabilities could not be inspected; refusing to replace it: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // No allmyagents.hub.v1 handler is the expected pre-bootstrap state.
      }

      filesRoute = await this.planes.connectFiles(identity.siteId, siteId)
      const home = await this.planes.remoteHome(filesRoute)
      const platform = platformFromHome(home)
      if (manifest.platform !== platform) {
        throw new Error(`this release carries a ${manifest.platform}/${manifest.arch} testbed payload, but the target is ${platform}; use a matching release artifact`)
      }
      terminalRoute = await this.planes.connectTerminal(identity.siteId, siteId)
      const archProbe = await this.planes.runCommand(
        terminalRoute,
        platform === 'win32' ? 'windows' : 'unix',
        platform === 'win32'
          ? '[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()'
          : 'uname -m',
        30_000,
      )
      const targetArch = normalizeArch(archProbe.output)
      if (!archProbe.ok || targetArch !== normalizeArch(manifest.arch)) {
        throw new Error(`testbed payload architecture ${manifest.arch} does not match the observed target architecture ${targetArch || 'unknown'}`)
      }
      if (profile === 'linux-sudo-machine' && platform !== 'linux') {
        throw new Error('linux-sudo-machine may be deployed only to Linux')
      }

      const stage = allMyStuffRemotePathJoin(home, '.allmyagents-testbed-bootstrap', deploymentId)
      let lastProgressAt = 0
      let lastProgressBucket = -1
      const progress = (value: AllMyStuffTransferProgress): void => {
        const bucket = value.bytesTotal > 0 ? Math.floor((value.bytesTransferred / value.bytesTotal) * 10) : 10
        if (bucket === lastProgressBucket && value.elapsedMs - lastProgressAt < 5_000) return
        lastProgressBucket = bucket
        lastProgressAt = value.elapsedMs
        this.event({ ...baseEvent, stage: 'transferring', detail: {
          filesCompleted: value.filesCompleted,
          filesTotal: value.filesTotal,
          bytesTransferred: value.bytesTransferred,
          bytesTotal: value.bytesTotal,
          bytesPerSecond: value.bytesPerSecond,
        } })
      }
      const transferred = await this.planes.uploadTree(filesRoute, this.deps.bundleDir, stage, progress)
      const verifiedTransfer = await this.planes.runCommand(
        terminalRoute,
        platform === 'win32' ? 'windows' : 'unix',
        remoteVerifyCommand(platform, stage),
        120_000,
      )
      if (!verifiedTransfer.ok) throw new Error(`the target rejected the transferred payload checksum (exit ${verifiedTransfer.exitCode})`)

      this.event({ ...baseEvent, stage: 'installing', detail: { platform, arch: targetArch } })
      const installed = await this.planes.runCommand(
        terminalRoute,
        platform === 'win32' ? 'windows' : 'unix',
        remoteInstallCommand(platform, stage, profile),
        5 * 60 * 1000,
      )
      if (!installed.ok) throw new Error(`the elevated target installer failed with exit ${installed.exitCode}`)

      this.event({ ...baseEvent, stage: 'pairing' })
      let capabilities: Awaited<ReturnType<RemoteDeviceController['capabilities']>> | undefined
      const pairingDeadline = Date.now() + 45_000
      let lastPairError: unknown
      while (Date.now() < pairingDeadline) {
        try {
          await this.deps.remoteDevices.pairDirect(siteId)
          capabilities = await this.deps.remoteDevices.capabilities(siteId)
          if (capabilities.nodeKind === 'lightweight-testbed') break
        } catch (error) {
          lastPairError = error
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (capabilities?.nodeKind !== 'lightweight-testbed') {
        throw new Error(`the testbed service was installed but did not become reachable${lastPairError instanceof Error ? `: ${lastPairError.message}` : ''}`)
      }
      if (capabilities.deploymentProfile !== profile || capabilities.elevated !== true) {
        throw new Error(
          `the testbed service registered with profile ${capabilities.deploymentProfile ?? 'unknown'} instead of the requested elevated profile ${profile}`,
        )
      }
      this.event({ ...baseEvent, stage: 'cleaning', detail: { stage } })
      let cleanupPending = false
      try {
        await this.planes.removeTree(filesRoute, stage)
      } catch {
        // Installation and pairing are already verified. Retain the exact unique staging path for an
        // operator cleanup rather than turning a housekeeping failure into a false deployment failure.
        cleanupPending = true
      }
      const result: TestbedDeploymentResult = {
        deploymentId,
        siteId,
        profile,
        platform: capabilities.platform,
        arch: capabilities.arch,
        files: transferred.files,
        bytes: transferred.bytes,
        transferMs: transferred.elapsedMs,
        bytesPerSecond: transferred.bytesPerSecond,
        installMs: installed.elapsedMs,
        verified: true,
        ...(cleanupPending ? { cleanupPending: true } : {}),
      }
      this.event({ ...baseEvent, stage: 'verified', detail: { ...result } })
      return result
    } catch (error) {
      this.event({
        ...baseEvent,
        stage: 'failed',
        detail: { error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) },
      })
      throw error
    } finally {
      if (terminalRoute) await this.planes.disconnect(terminalRoute)
      if (filesRoute) await this.planes.disconnect(filesRoute)
    }
  }
}
