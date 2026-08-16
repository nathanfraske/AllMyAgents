import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AllMyStuffPlanes, allMyStuffRemotePathJoin, type AllMyStuffTransferProgress } from './allMyStuffPlanes.js'
import type { MyOwnMeshRpcBridge } from './myOwnMeshRpc.js'
import type { RemoteDeviceActor, RemoteDeviceController, RemoteDeviceActionResult } from './remoteDevices.js'
import type { TestbedNodeProfile } from './testbedNode.js'

interface TestbedBundleManifest {
  version: 1
  kind: 'allmyagents-lightweight-testbed'
  platform: NodeJS.Platform
  arch: string
  protocol: 1
  appVersion?: string
  sourceCommit?: string
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

export interface TestbedSyncResult {
  syncId: string
  siteId: string
  platform: NodeJS.Platform
  arch: string
  previousPayloadId?: string
  payloadId: string
  changedFiles: string[]
  bytesTransferred: number
  transferMs: number
  restartMs: number
  activeTransport?: 'myownmesh-rpc' | 'site'
  verified: true
  alreadyCurrent?: true
  rollbackPath?: string
}

export interface TestbedDeploymentEvent {
  deploymentId: string
  siteId: string
  profile: TestbedNodeProfile
  stage: 'requested' | 'preflight' | 'transferring' | 'installing' | 'pairing' | 'syncing' | 'restarting' | 'cleaning' | 'verified' | 'failed'
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
  if (/\b(?:riscv64|riscv64gc|rv64|rv64gc)\b/u.test(lower)) return 'riscv64'
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
    'build.json',
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

function remotePairCodeCommand(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const installRoot = 'C:\\ProgramData\\AllMyAgents\\TestbedNode'
    return `& ${powerShellLiteral(path.win32.join(installRoot, 'node.exe'))} ${powerShellLiteral(path.win32.join(installRoot, 'dist', 'testbedNode.js'))} pair-code --data-dir ${powerShellLiteral(path.win32.join(installRoot, 'data'))}`
  }
  return `sudo -n /opt/allmyagents-testbed/node /opt/allmyagents-testbed/dist/testbedNode.js pair-code --data-dir /var/lib/allmyagents-testbed`
}

function parsePairingCode(output: string): string {
  const matches = output.toUpperCase().match(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/gu)
  const code = matches?.at(-1)
  if (!code) throw new Error('the installed testbed did not return a valid one-use pairing code')
  return code
}

interface BundleFile {
  relative: string
  absolute: string
  sha256: string
  bytes: number
}

function bundleFiles(bundleDir: string): { manifest: TestbedBundleManifest; payloadId: string; codePayloadId: string; files: BundleFile[] } {
  const manifest = verifyTestbedBundle(bundleDir)
  const files: BundleFile[] = []
  for (const line of fs.readFileSync(path.join(bundleDir, 'SHA256SUMS'), 'utf8').split(/\r?\n/u).filter(Boolean)) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/u.exec(line)!
    const absolute = path.resolve(bundleDir, ...match[2]!.split('/'))
    files.push({ relative: match[2]!, absolute, sha256: match[1]!, bytes: fs.statSync(absolute).size })
  }
  const sums = path.join(bundleDir, 'SHA256SUMS')
  files.push({ relative: 'SHA256SUMS', absolute: sums, sha256: crypto.createHash('sha256').update(fs.readFileSync(sums)).digest('hex'), bytes: fs.statSync(sums).size })
  const payloadId = crypto.createHash('sha256')
    .update(files.filter((file) => file.relative !== 'SHA256SUMS').sort((a, b) => a.relative.localeCompare(b.relative))
      .map((file) => `${file.sha256}  ${file.relative}\n`).join(''))
    .digest('hex')
  const codePayloadId = crypto.createHash('sha256')
    .update(files.filter((file) => file.relative.startsWith('dist/')).sort((a, b) => a.relative.localeCompare(b.relative))
      .map((file) => `${file.sha256}  ${file.relative}\n`).join(''))
    .digest('hex')
  return { manifest, payloadId, codePayloadId, files }
}

function resultOutput(result: RemoteDeviceActionResult, operation: string): string {
  if (!result.ok) throw new Error(`${operation} failed (${result.failure?.stage ?? 'target'}): ${result.error ?? 'unknown error'}`)
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function parseLinuxServiceLayout(output: string): { installRoot: string; dataDir: string } {
  const script = /(?:^|[\s;])(?:"([^"]*\/dist\/testbedNode\.js)"|'([^']*\/dist\/testbedNode\.js)'|([^\s;]+\/dist\/testbedNode\.js))/u.exec(output)
  const data = /--data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;]+))/u.exec(output)
  const scriptPath = script?.slice(1).find(Boolean)
  const dataDir = data?.slice(1).find(Boolean)
  if (!scriptPath || !dataDir || !path.posix.isAbsolute(scriptPath) || !path.posix.isAbsolute(dataDir)) {
    throw new Error('the testbed systemd service did not expose a bounded absolute install/data layout')
  }
  const installRoot = path.posix.dirname(path.posix.dirname(scriptPath))
  if (installRoot === '/' || /[\r\n\0]/u.test(installRoot + dataDir)) throw new Error('the testbed service layout is unsafe')
  return { installRoot, dataDir }
}

function parseSha256Output(output: string): Map<string, string> {
  const hashes = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64})\s+(.+)$/u.exec(line.trim())
    if (match) hashes.set(match[2]!, match[1]!)
  }
  return hashes
}

function linuxApplyScript(input: {
  syncId: string
  installRoot: string
  dataDir: string
  stage: string
  files: BundleFile[]
}): string {
  const changed = input.files.map((file) => file.relative)
  const lines = [
    '#!/bin/sh',
    'set -eu',
    `ama_root=${shellLiteral(input.installRoot)}`,
    `ama_stage=${shellLiteral(input.stage)}`,
    'ama_backup="$ama_stage/rollback"',
    'mkdir -p "$ama_backup"',
    'ama_unit=/etc/systemd/system/allmyagents-testbed.service',
    'if [ -f "$ama_unit" ]; then cp -p "$ama_unit" "$ama_backup/allmyagents-testbed.service"; fi',
    'ama_rollback=1',
    'ama_restore() {',
    '  [ "$ama_rollback" = 1 ] || return 0',
    '  ama_rollback=0',
    ...changed.flatMap((relative) => [
      `  if [ -f "$ama_backup/${relative}" ]; then cp -p "$ama_backup/${relative}" "$ama_root/${relative}"; else rm -f "$ama_root/${relative}"; fi`,
    ]),
    '  if [ -f "$ama_backup/allmyagents-testbed.service" ]; then cp -p "$ama_backup/allmyagents-testbed.service" "$ama_unit"; systemctl daemon-reload || true; fi',
    '}',
    'trap ama_restore EXIT HUP INT TERM',
    ...input.files.map((file) => `printf '%s  %s\n' ${shellLiteral(file.sha256)} ${shellLiteral(`${input.stage}/${file.relative}`)} | sha256sum -c - >/dev/null`),
    ...changed.flatMap((relative) => [
      `mkdir -p "$(dirname "$ama_backup/${relative}")" "$(dirname "$ama_root/${relative}")"`,
      `if [ -f "$ama_root/${relative}" ]; then cp -p "$ama_root/${relative}" "$ama_backup/${relative}"; fi`,
      `ama_tmp="$ama_root/${relative}.ama-${input.syncId}.tmp"`,
      `cp "$ama_stage/${relative}" "$ama_tmp"`,
      `chmod ${relative === 'node' ? '0755' : '0644'} "$ama_tmp"`,
      `mv -f "$ama_tmp" "$ama_root/${relative}"`,
    ]),
    `${shellLiteral(`${input.installRoot}/node`)} ${shellLiteral(`${input.installRoot}/dist/testbedNode.js`)} repair-service --data-dir ${shellLiteral(input.dataDir)} >/dev/null`,
    `systemd-run --quiet --collect --unit=${shellLiteral(`allmyagents-testbed-restart-${input.syncId}`)} --on-active=2s /bin/systemctl restart allmyagents-testbed.service`,
    'ama_rollback=0',
    'trap - EXIT HUP INT TERM',
    'rm -rf "$ama_root/.ama-rollback"',
    'mv "$ama_backup" "$ama_root/.ama-rollback"',
    'rm -rf "$ama_stage"',
    `printf '%s\n' ${shellLiteral(`update ${input.syncId} applied; detached restart scheduled`)}`,
  ]
  return `${lines.join('\n')}\n`
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

  /**
   * Idempotently reconcile an already-paired Linux testbed to this release. This deliberately uses
   * the existing authenticated read/write/terminal protocol, so the first node that predates this
   * method can update itself too. The restart is scheduled by systemd after the action has replied;
   * an ambiguous commit response is never retried and is resolved only by read-only build probing.
   */
  async sync(siteIdInput: string, actor: RemoteDeviceActor): Promise<TestbedSyncResult> {
    const siteId = canonical(siteIdInput)
    if (!siteId) throw new Error('target device id is required')
    const syncId = crypto.randomBytes(8).toString('hex')
    const descriptor = bundleFiles(this.deps.bundleDir)
    const capabilities = await this.deps.remoteDevices.capabilities(siteId)
    if (capabilities.nodeKind !== 'lightweight-testbed') throw new Error('payload sync requires an already-paired lightweight testbed node')
    if (capabilities.platform !== 'linux') throw new Error('safe in-place payload sync is currently available for Linux systemd testbeds')
    // The five application modules are plain JavaScript and deliberately portable across x64, ARM,
    // and RISC-V. Runtime replacement remains a separate full-bootstrap concern.
    const root = capabilities.roots.find((candidate) =>
      candidate.environment === undefined && candidate.path === '/' && candidate.read && candidate.write && candidate.terminal)
    if (!root) throw new Error('payload sync requires an operator-configured whole-host read/write/terminal root on the testbed')
    const baseEvent = { deploymentId: `sync_${syncId}`, siteId, profile: capabilities.deploymentProfile ?? 'elevated-machine' as TestbedNodeProfile }
    this.event({ ...baseEvent, stage: 'requested', detail: { operation: 'payload-sync', codePayloadId: descriptor.codePayloadId } })
    const run = (action: Parameters<RemoteDeviceController['execute']>[1]) => this.deps.remoteDevices.execute(siteId, action, actor)
    try {
      const layoutResult = await run({
        op: 'exec', rootId: root.id,
        command: 'systemctl show allmyagents-testbed.service --property=ExecStart --value', timeoutMs: 20_000,
      })
      const layout = parseLinuxServiceLayout(resultOutput(layoutResult, 'testbed service inspection'))
      const portableFiles = descriptor.files
        .filter((file) => file.relative.startsWith('dist/') || file.relative === 'build.json')
        .sort((left, right) => {
          const rank = (file: BundleFile): number => file.relative === 'build.json' ? 2 : file.relative === 'dist/testbedNode.js' ? 1 : 0
          return rank(left) - rank(right) || left.relative.localeCompare(right.relative)
        })
      const targetPaths = portableFiles.map((file) => path.posix.join(layout.installRoot, file.relative))
      const hashResult = await run({
        op: 'exec', rootId: root.id,
        command: `sha256sum -- ${targetPaths.map(shellLiteral).join(' ')}`, timeoutMs: 120_000,
      })
      // sha256sum returns non-zero when a legacy payload lacks manifest metadata. Its valid lines are
      // still authoritative, so parse them and treat absent files as changes instead of failing here.
      const current = parseSha256Output(`${hashResult.stdout ?? ''}\n${hashResult.stderr ?? ''}`)
      const changed = portableFiles.filter((file, index) => current.get(targetPaths[index]!) !== file.sha256)
      if (changed.length === 0) {
        const result: TestbedSyncResult = {
          syncId, siteId, platform: capabilities.platform, arch: capabilities.arch,
          previousPayloadId: capabilities.testbedBuild?.codePayloadId,
          payloadId: descriptor.codePayloadId, changedFiles: [], bytesTransferred: 0,
          transferMs: 0, restartMs: 0, activeTransport: capabilities.activeTransport,
          verified: true, alreadyCurrent: true,
        }
        this.event({ ...baseEvent, stage: 'verified', detail: { ...result } })
        return result
      }
      if (changed.some((file) => file.bytes > 1024 * 1024)) throw new Error('a changed payload file exceeds the bounded remote write limit')
      const stage = path.posix.join(layout.installRoot, `.ama-sync-${syncId}`)
      const stageRelative = stage.replace(/^\/+/, '')
      const started = performance.now()
      resultOutput(await run({ op: 'mkdir', rootId: root.id, path: stageRelative, recursive: true }), 'update staging')
      let bytesTransferred = 0
      for (const file of changed) {
        const relative = path.posix.join(stageRelative, file.relative)
        const parent = path.posix.dirname(relative)
        if (parent !== stageRelative) resultOutput(await run({ op: 'mkdir', rootId: root.id, path: parent, recursive: true }), `staging ${file.relative}`)
        const content = fs.readFileSync(file.absolute).toString('base64')
        const written = await run({ op: 'write', rootId: root.id, path: relative, content, encoding: 'base64' })
        resultOutput(written, `transferring ${file.relative}`)
        if (written.bytes !== file.bytes) throw new Error(`target reported a short write for ${file.relative}`)
        bytesTransferred += file.bytes
      }
      const script = linuxApplyScript({ syncId, installRoot: layout.installRoot, dataDir: layout.dataDir, stage, files: changed })
      const scriptRelative = path.posix.join(stageRelative, 'apply.sh')
      resultOutput(await run({ op: 'write', rootId: root.id, path: scriptRelative, content: script }), 'transferring update transaction')
      bytesTransferred += Buffer.byteLength(script)
      const transferMs = Math.round((performance.now() - started) * 10) / 10
      this.event({ ...baseEvent, stage: 'syncing', detail: { changedFiles: changed.map((file) => file.relative), bytesTransferred, transferMs } })
      const applyCommand = capabilities.deploymentProfile === 'linux-sudo-machine'
        ? `sudo -n /bin/sh ${shellLiteral(stage + '/apply.sh')}`
        : `/bin/sh ${shellLiteral(stage + '/apply.sh')}`
      const commit = await run({ op: 'exec', rootId: root.id, command: applyCommand, timeoutMs: 120_000 })
      const restartStarted = performance.now()
      if (!commit.ok) {
        // The detached restart can sever an older executor before its response arrives. Never replay
        // the mutation: the read-only verification loop below is the only arbiter of success.
        this.event({ ...baseEvent, stage: 'restarting', detail: { outcome: 'commit-response-ambiguous', error: commit.error } })
      } else {
        this.event({ ...baseEvent, stage: 'restarting', detail: { outcome: 'detached-restart-scheduled' } })
      }
      const deadline = Date.now() + 60_000
      let observed: Awaited<ReturnType<RemoteDeviceController['capabilities']>> | undefined
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 750))
        try {
          const candidate = await this.deps.remoteDevices.capabilities(siteId)
          if (candidate.testbedBuild?.codePayloadId === descriptor.codePayloadId) { observed = candidate; break }
        } catch { /* Expected while the detached service restart is in flight. */ }
      }
      if (!observed) {
        throw new Error('the update was not replayed, but the restarted node did not confirm the requested payload before the verification deadline')
      }
      const restartMs = Math.round((performance.now() - restartStarted) * 10) / 10
      const result: TestbedSyncResult = {
        syncId, siteId, platform: observed.platform, arch: observed.arch,
        previousPayloadId: capabilities.testbedBuild?.codePayloadId,
        payloadId: descriptor.codePayloadId,
        changedFiles: changed.map((file) => file.relative), bytesTransferred, transferMs, restartMs,
        activeTransport: observed.activeTransport, verified: true,
        rollbackPath: path.posix.join(layout.installRoot, '.ama-rollback'),
      }
      this.event({ ...baseEvent, stage: 'verified', detail: { ...result } })
      return result
    } catch (error) {
      this.event({ ...baseEvent, stage: 'failed', detail: { error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) } })
      throw error
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

      // If this hub already holds a reciprocal connection, inspect it without issuing another pairing
      // mutation. Fleet membership alone is deliberately not execution authority.
      const existingConnection = this.deps.remoteDevices.listConnections()
        .find((connection) => canonical(connection.siteId) === siteId)
      if (existingConnection) {
        try {
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
        throw new Error(
          `the target is already paired but its capabilities could not be inspected; refusing to replace it: ${error instanceof Error ? error.message : String(error)}`,
        )
        }
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
      const pairingCodeResult = await this.planes.runCommand(
        terminalRoute,
        platform === 'win32' ? 'windows' : 'unix',
        remotePairCodeCommand(platform),
        30_000,
      )
      if (!pairingCodeResult.ok) {
        throw new Error(`the installed testbed could not issue a one-use pairing code (exit ${pairingCodeResult.exitCode})`)
      }
      const pairingCode = parsePairingCode(pairingCodeResult.output)
      let capabilities: Awaited<ReturnType<RemoteDeviceController['capabilities']>> | undefined
      const pairingDeadline = Date.now() + 45_000
      let advertised = false
      while (Date.now() < pairingDeadline) {
        const peerNow = (await this.deps.directMesh.peers(true)).find((candidate) => candidate.siteId === siteId)
        if (peerNow?.online) {
          advertised = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (!advertised) throw new Error('the installed testbed never advertised its authenticated MyOwnMesh route')
      // This is a one-use mutation. Call it exactly once: an ambiguous transport outcome may have paired
      // the device already, and blindly retrying would consume a second intent or misreport success.
      try {
        await this.deps.remoteDevices.pairDirect(siteId, pairingCode)
      } catch (error) {
        throw new Error(
          `the one-use pairing exchange did not return a confirmed result; inspect the connection before issuing another code: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      while (Date.now() < pairingDeadline) {
        try {
          capabilities = await this.deps.remoteDevices.capabilities(siteId)
          if (capabilities.nodeKind === 'lightweight-testbed') break
        } catch {
          // Read-only capability discovery is safe to retry after the single confirmed pairing mutation.
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (capabilities?.nodeKind !== 'lightweight-testbed') {
        throw new Error('the paired testbed service did not return its capabilities before the deadline')
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
