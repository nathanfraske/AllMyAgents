import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AllMyStuffPlanes } from './allMyStuffPlanes.js'
import type { MyOwnMeshRpcBridge } from './myOwnMeshRpc.js'
import type { DeviceExecutorCapabilities, RemoteDeviceController } from './remoteDevices.js'
import {
  TestbedDeploymentService,
  verifyTestbedBundle,
  type TestbedDeploymentEvent,
} from './testbedDeployment.js'

const roots: string[] = []

function bundle(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-testbed-deploy-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'dist'))
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    version: 1,
    kind: 'allmyagents-lightweight-testbed',
    platform: 'win32',
    arch: 'x64',
    protocol: 1,
  }))
  fs.writeFileSync(path.join(root, 'node.exe'), 'runtime')
  fs.writeFileSync(path.join(root, 'README.txt'), 'headless node')
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(root, 'build.json'), '{"version":1,"appVersion":"0.1.27"}')
  const modules = ['testbedNode.js', 'deviceToken.js', 'remoteDevices.js', 'directHubProtocol.js', 'myOwnMeshRpc.js']
  for (const module of modules) fs.writeFileSync(path.join(root, 'dist', module), module)
  const files = [
    'manifest.json', 'node.exe', 'README.txt', 'package.json', 'build.json',
    ...modules.map((module) => `dist/${module}`),
  ]
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${files.map((relative) => {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')
    return `${digest}  ${relative}`
  }).join('\n')}\n`)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function lightweightCapabilities(profile: 'elevated-machine' | 'linux-sudo-machine' = 'elevated-machine'): DeviceExecutorCapabilities {
  return {
    enabled: true,
    platform: 'win32',
    arch: 'x64',
    hostname: 'testbed',
    roots: [],
    environments: [],
    nodeKind: 'lightweight-testbed',
    deploymentProfile: profile,
    elevated: true,
  }
}

function codePayloadId(root: string): string {
  const lines = fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').split(/\r?\n/u)
    .filter((line) => /  dist\//u.test(line))
    .sort((left, right) => left.slice(66).localeCompare(right.slice(66)))
  return crypto.createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex')
}

describe('lightweight testbed deployment orchestration', () => {
  it('verifies every file named by the release checksum manifest', () => {
    const root = bundle()
    expect(verifyTestbedBundle(root)).toMatchObject({ platform: 'win32', arch: 'x64' })
    fs.writeFileSync(path.join(root, 'dist', 'testbedNode.js'), 'tampered')
    expect(() => verifyTestbedBundle(root)).toThrow(/failed verification/u)

    const unexpected = bundle()
    fs.mkdirSync(path.join(unexpected, 'profiles'))
    fs.writeFileSync(path.join(unexpected, 'profiles', 'credentials.json'), '{}')
    expect(() => verifyTestbedBundle(unexpected)).toThrow(/credential-free file allowlist/u)
  })

  it('uploads through AllMyStuff, installs once, fleet-pairs, and verifies the requested elevated profile', async () => {
    const root = bundle()
    let installed = false
    const pairDirect = vi.fn(async () => {
      if (!installed) throw new Error('route unavailable')
      return { siteId: 'target', label: 'Target', token: 'token', paired: true }
    })
    const capabilities = vi.fn(async () => lightweightCapabilities())
    const remoteDevices = { pairDirect, capabilities, listConnections: () => [] } as unknown as RemoteDeviceController
    const commands: string[] = []
    const planes = {
      connectFiles: vi.fn(async () => 'files-route'),
      connectTerminal: vi.fn(async () => 'terminal-route'),
      disconnect: vi.fn(async () => undefined),
      remoteHome: vi.fn(async () => 'C:\\Users\\Test'),
      uploadTree: vi.fn(async (_route: string, _local: string, _remote: string, progress?: (value: object) => void) => {
        progress?.({ filesCompleted: 1, filesTotal: 3, bytesTransferred: 8, bytesTotal: 8, elapsedMs: 4, bytesPerSecond: 2_000 })
        return { files: 3, bytes: 8, elapsedMs: 4, bytesPerSecond: 2_000 }
      }),
      removeTree: vi.fn(async () => undefined),
      runCommand: vi.fn(async (_route: string, _platform: string, command: string) => {
        commands.push(command)
        if (commands.length === 1) return { ok: true, exitCode: 0, output: 'X64', elapsedMs: 2 }
        if (commands.length === 3) installed = true
        if (commands.length === 4) return { ok: true, exitCode: 0, output: 'ABCD-EFGH', elapsedMs: 3 }
        return { ok: true, exitCode: 0, output: 'ok', elapsedMs: 3 }
      }),
    } as unknown as AllMyStuffPlanes
    const events: TestbedDeploymentEvent[] = []
    const service = new TestbedDeploymentService({
      bundleDir: root,
      directMesh: {
        identity: vi.fn(async () => ({ siteId: 'source', label: 'Source' })),
        peers: vi.fn(async () => [{ siteId: 'target', label: 'Target', online: true, status: 'active' }]),
      } as unknown as MyOwnMeshRpcBridge,
      remoteDevices,
      ownedRoster: async () => [{ device: 'target' }],
      planes,
      emit: (event) => events.push(event),
    })

    await expect(service.deploy('target', 'elevated-machine')).resolves.toMatchObject({
      siteId: 'target',
      profile: 'elevated-machine',
      platform: 'win32',
      arch: 'x64',
      files: 3,
      bytes: 8,
      verified: true,
    })
    expect(commands).toHaveLength(4)
    expect(commands[2]).toMatch(/install-elevated --profile elevated-machine/u)
    expect(commands[3]).toMatch(/pair-code/u)
    expect(pairDirect).toHaveBeenCalledOnce()
    expect(pairDirect).toHaveBeenCalledWith('target', 'ABCD-EFGH')
    expect(events.map((event) => event.stage)).toEqual([
      'requested', 'preflight', 'transferring', 'installing', 'pairing', 'cleaning', 'verified',
    ])
    expect((planes.disconnect as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
  })

  it('refuses to displace an existing full hub', async () => {
    const root = bundle()
    const remoteDevices = {
      pairDirect: vi.fn(async () => ({ siteId: 'target', label: 'Target', token: 'token', paired: true })),
      capabilities: vi.fn(async () => ({ ...lightweightCapabilities(), nodeKind: 'hub' })),
      listConnections: () => [{ siteId: 'target', label: 'Target' }],
    } as unknown as RemoteDeviceController
    const service = new TestbedDeploymentService({
      bundleDir: root,
      directMesh: {
        identity: vi.fn(async () => ({ siteId: 'source', label: 'Source' })),
        peers: vi.fn(async () => [{ siteId: 'target', label: 'Target', online: true, status: 'active' }]),
      } as unknown as MyOwnMeshRpcBridge,
      remoteDevices,
      ownedRoster: async () => [{ device: 'target' }],
      planes: {} as AllMyStuffPlanes,
    })
    await expect(service.deploy('target', 'elevated-machine')).rejects.toThrow(/already runs a full AllMyAgents hub/u)
  })

  it('discovers only signed-fleet targets and inspects an unpaired device over its existing planes', async () => {
    const root = bundle()
    const disconnect = vi.fn(async () => undefined)
    const service = new TestbedDeploymentService({
      bundleDir: root,
      directMesh: {
        identity: vi.fn(async () => ({ siteId: 'source', label: 'Source' })),
        peers: vi.fn(async () => [
          { siteId: 'target', label: 'ARM lab', online: true, status: 'active', rttMs: 12 },
          { siteId: 'sighted', label: 'Not owned', online: true, status: 'active' },
        ]),
      } as unknown as MyOwnMeshRpcBridge,
      remoteDevices: { listConnections: () => [] } as unknown as RemoteDeviceController,
      ownedRoster: async () => [{ device: 'target' }],
      planes: {
        connectFiles: vi.fn(async () => 'files-route'),
        connectTerminal: vi.fn(async () => 'terminal-route'),
        remoteHome: vi.fn(async () => '/home/lab'),
        runCommand: vi.fn(async () => ({ ok: true, exitCode: 0, output: 'aarch64', elapsedMs: 2 })),
        disconnect,
      } as unknown as AllMyStuffPlanes,
    })

    await expect(service.targets()).resolves.toEqual([expect.objectContaining({
      siteId: 'target', label: 'ARM lab', signedFleet: true, paired: false, online: true,
    })])
    await expect(service.inspect('target')).resolves.toMatchObject({
      siteId: 'target', platform: 'linux', arch: 'arm64', home: '/home/lab', rttMs: 12,
    })
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it('reports degraded direct discovery instead of returning an indistinguishable empty target list', async () => {
    const service = new TestbedDeploymentService({
      bundleDir: bundle(),
      directMesh: {
        peers: vi.fn(async () => []),
        status: vi.fn(() => ({
          available: false,
          method: 'allmyagents.hub.v1',
          reason: 'permission-denied',
          error: 'control pipe access denied',
        })),
      } as unknown as MyOwnMeshRpcBridge,
      remoteDevices: { listConnections: () => [] } as unknown as RemoteDeviceController,
      ownedRoster: async () => [{ device: 'target' }],
    })

    await expect(service.targets()).rejects.toThrow(/degraded, not empty.*full-duplex/u)
  })

  it('syncs only changed portable files, treats a severed restart response as ambiguous, and verifies before success', async () => {
    const root = bundle()
    const desiredCode = codePayloadId(root)
    const modules = ['testbedNode.js', 'deviceToken.js', 'remoteDevices.js', 'directHubProtocol.js', 'myOwnMeshRpc.js']
    const firstModule = `dist/${modules[0]}`
    const firstHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, firstModule))).digest('hex')
    let committed = false
    const capabilities = vi.fn(async () => ({
      enabled: true,
      platform: 'linux' as const,
      arch: 'riscv64',
      hostname: 'Frask-Risk-Box',
      roots: [{ id: 'root-host', label: 'Host', path: '/', read: true, write: true, terminal: true }],
      environments: [],
      nodeKind: 'lightweight-testbed' as const,
      deploymentProfile: 'elevated-machine' as const,
      elevated: true,
      activeTransport: 'myownmesh-rpc' as const,
      ...(committed ? { testbedBuild: {
        payloadId: 'target-runtime-specific',
        codePayloadId: desiredCode,
        protocol: 1,
        files: [],
      } } : {}),
    }))
    const writes: string[] = []
    const execute = vi.fn(async (_siteId: string, action: { op: string; command?: string; path?: string; content?: string }) => {
      if (action.op === 'exec' && action.command?.startsWith('systemctl show')) {
        return { ok: true, stdout: 'path=/home/admini/amt/node ; argv[]=/home/admini/amt/node /home/admini/amt/dist/testbedNode.js run --data-dir /home/admini/amt/data ;' }
      }
      if (action.op === 'exec' && action.command?.startsWith('sha256sum --')) {
        return { ok: false, stdout: `${firstHash}  /home/admini/amt/${firstModule}\n`, exitCode: 1 }
      }
      if (action.op === 'mkdir') return { ok: true, created: true }
      if (action.op === 'write') {
        writes.push(action.path ?? '')
        return { ok: true, bytes: Buffer.from(action.content ?? '', action.path?.endsWith('apply.sh') ? 'utf8' : 'base64').length }
      }
      if (action.op === 'exec' && action.command?.includes('/apply.sh')) {
        committed = true
        return { ok: false, error: 'direct route disconnected during detached restart', failure: { stage: 'transport' as const } }
      }
      return { ok: false, error: 'unexpected test action' }
    })
    const remoteDevices = { capabilities, execute } as unknown as RemoteDeviceController
    const service = new TestbedDeploymentService({
      bundleDir: root,
      directMesh: {} as MyOwnMeshRpcBridge,
      remoteDevices,
      ownedRoster: async () => [],
    })

    await expect(service.sync('target', { sessionId: 'overseer', profileId: 'codex-b' })).resolves.toMatchObject({
      siteId: 'target',
      arch: 'riscv64',
      payloadId: desiredCode,
      verified: true,
      activeTransport: 'myownmesh-rpc',
      changedFiles: expect.arrayContaining(['build.json', 'dist/myOwnMeshRpc.js']),
      rollbackPath: '/home/admini/amt/.ama-rollback',
    })
    expect(writes.some((value) => value.includes(firstModule))).toBe(false)
    expect(writes.some((value) => /apply\.sh$/u.test(value))).toBe(true)
    expect(capabilities.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
