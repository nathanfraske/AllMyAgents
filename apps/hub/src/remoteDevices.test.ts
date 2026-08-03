import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DeviceExecutor,
  FleetConnectionStore,
  RemoteDeviceController,
  parseRemoteWslEnvironments,
  wslUncPath,
  type DeviceExecutorCapabilities,
} from './remoteDevices.js'

const tempDirs: string[] = []

function tempDir(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-remote-device-'))
  tempDirs.push(value)
  return value
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('DeviceExecutor target policy', () => {
  it('is disabled with no roots until the operator explicitly configures it', async () => {
    const dir = tempDir()
    const executor = new DeviceExecutor(path.join(dir, 'policy.json'))
    expect(executor.capabilities()).toMatchObject({ enabled: false, roots: [] })
    await expect(executor.execute({ op: 'list', rootId: 'anything' })).resolves.toMatchObject({
      ok: false,
      error: 'Remote device execution is disabled on this machine.',
      failure: { stage: 'target' },
      telemetry: { targetMs: expect.any(Number) },
    })
  })

  it('contains file reads/writes to a real approved root and persists the policy', async () => {
    const dir = tempDir()
    const root = path.join(dir, 'root')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'hello.txt'), 'hello remote')
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'secret')
    const policyFile = path.join(dir, 'policy.json')
    const executor = new DeviceExecutor(policyFile)
    const policy = executor.update({
      enabled: true,
      roots: [{ id: '', label: 'fixture', path: root, read: true, write: true, terminal: false }],
    })
    const rootId = policy.roots[0]!.id

    await expect(executor.execute({ op: 'read', rootId, path: 'hello.txt' })).resolves.toMatchObject({
      ok: true,
      content: 'hello remote',
    })
    await expect(executor.execute({ op: 'read', rootId, path: '../outside.txt' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/escapes the approved root/u),
    })
    await expect(executor.execute({ op: 'write', rootId, path: 'created.txt', content: 'written' })).resolves.toMatchObject({
      ok: true,
      bytes: 7,
    })
    expect(fs.readFileSync(path.join(root, 'created.txt'), 'utf8')).toBe('written')
    await expect(executor.execute({ op: 'write', rootId, path: 'bad.bin', content: '**invalid**', encoding: 'base64' })).resolves.toMatchObject({
      ok: false,
      error: 'content is not valid base64',
    })
    expect(new DeviceExecutor(policyFile).capabilities()).toMatchObject({
      enabled: true,
      roots: [{ id: rootId, label: 'fixture', read: true, write: true, terminal: false }],
    })
  })

  it('runs a bounded non-interactive terminal command from an explicitly terminal-enabled root', async () => {
    const dir = tempDir()
    const root = path.join(dir, 'root')
    fs.mkdirSync(root)
    const executor = new DeviceExecutor(path.join(dir, 'policy.json'))
    const policy = executor.update({
      enabled: true,
      roots: [{ id: '', label: 'terminal', path: root, read: false, write: false, terminal: true }],
    })
    const command = process.platform === 'win32' ? 'Write-Output remote-ok' : 'printf remote-ok'
    const result = await executor.execute({ op: 'exec', rootId: policy.roots[0]!.id, command, timeoutMs: 10_000 })
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false })
    expect(result.stdout).toContain('remote-ok')
  }, 20_000)
})

describe('FleetConnectionStore', () => {
  it('persists credentials privately but never returns a token from its public view', () => {
    const dir = tempDir()
    const file = path.join(dir, 'fleet-connections.json')
    const store = new FleetConnectionStore(file)
    const publicValue = store.upsert({ siteId: 'site-a', label: 'Device A', token: 'a'.repeat(64) })
    expect(publicValue).not.toHaveProperty('token')
    expect(store.list()[0]).not.toHaveProperty('token')
    expect(new FleetConnectionStore(file).get('site-a')?.token).toBe('a'.repeat(64))
  })
})

describe('RemoteDeviceController', () => {
  it('authenticates target requests from the private store and intersects target roots with chat grants', async () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    connections.upsert({ siteId: 'site-a', label: 'Device A', token: 'b'.repeat(64) })
    const capabilities: DeviceExecutorCapabilities = {
      enabled: true,
      platform: process.platform,
      arch: 'test-arch',
      hostname: 'test-host',
      environments: [{ id: 'host', kind: 'host', label: 'test host', platform: process.platform, shell: 'test-shell' }],
      roots: [
        { id: 'root-one', label: 'One', path: '/not-shown-to-agent', read: true, write: true, terminal: false },
        { id: 'root-two', label: 'Two', path: '/not-granted', read: true, write: false, terminal: false },
      ],
    }
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'b'.repeat(64)}`)
      return new Response(JSON.stringify(capabilities), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new RemoteDeviceController(connections, async () => ({
      siteId: 'site-a', label: 'Device A', baseUrl: 'http://127.0.0.1:9999', online: true,
    }))
    const views = await controller.listForGrants([
      { siteId: 'site-a', rootIds: ['root-one'], capabilities: ['read'] },
    ])
    expect(views).toMatchObject([{
      siteId: 'site-a',
      connected: true,
      roots: [{ id: 'root-one', grantedCapabilities: ['read'] }],
    }])
    expect(views[0]!.roots).toHaveLength(1)
  })

  it('reports route, network, target, and transfer telemetry for remote file operations', async () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    connections.upsert({ siteId: 'site-a', label: 'Device A', token: 'c'.repeat(64) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      bytes: 4096,
      content: 'data',
      telemetry: { targetMs: 3 },
    }), { status: 200 })))
    const controller = new RemoteDeviceController(connections, async () => ({
      siteId: 'site-a', label: 'Device A', baseUrl: 'http://127.0.0.1:9999', online: true,
    }))
    const result = await controller.execute('site-a', {
      op: 'read', rootId: 'root-one', path: 'fixture.bin', encoding: 'base64',
    }, { sessionId: 's1', profileId: 'p1' })
    expect(result).toMatchObject({
      ok: true,
      telemetry: {
        targetMs: 3,
        transferBytes: 4096,
        bytesSent: expect.any(Number),
        bytesReceived: expect.any(Number),
        roundTripMs: expect.any(Number),
      },
    })
    expect(result.telemetry!.transferBytesPerSecond).toBeGreaterThan(0)
  })

  it('returns classified route failures with timing instead of throwing away diagnostics', async () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    connections.upsert({ siteId: 'site-a', label: 'Device A', token: 'd'.repeat(64) })
    const controller = new RemoteDeviceController(connections, async () => null)
    await expect(controller.execute('site-a', { op: 'probe', rootId: 'root-one' }, {
      sessionId: 's1', profileId: 'p1',
    })).resolves.toMatchObject({
      ok: false,
      failure: { stage: 'route' },
      telemetry: { routeMs: expect.any(Number), roundTripMs: expect.any(Number) },
    })
  })

  it('retains target timing when the remote action itself is rejected', async () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    connections.upsert({ siteId: 'site-a', label: 'Device A', token: 'e'.repeat(64) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: 'path is outside the approved root',
      failure: { stage: 'target' },
      telemetry: { targetMs: 7.5 },
    }), { status: 400 })))
    const controller = new RemoteDeviceController(connections, async () => ({
      siteId: 'site-a', label: 'Device A', baseUrl: 'http://127.0.0.1:9999', online: true,
    }))
    await expect(controller.execute('site-a', {
      op: 'read', rootId: 'root-one', path: '../escape',
    }, { sessionId: 's1', profileId: 'p1' })).resolves.toMatchObject({
      ok: false,
      error: 'path is outside the approved root',
      failure: { stage: 'target' },
      telemetry: { targetMs: 7.5, roundTripMs: expect.any(Number) },
    })
  })
})

describe('WSL remote environment identity', () => {
  it('parses distro state without including Docker-managed internals', () => {
    const parsed = parseRemoteWslEnvironments('  NAME              STATE           VERSION\n* Ubuntu-24.04      Running         2\n  Debian            Stopped         2\n  docker-desktop    Running         2\n')
    expect(parsed).toMatchObject([
      { id: 'wsl:Ubuntu-24.04', distro: 'Ubuntu-24.04', state: 'running', isDefault: true },
      { id: 'wsl:Debian', distro: 'Debian', state: 'stopped', isDefault: false },
    ])
  })

  it('projects only an absolute distro-native path into the WSL filesystem bridge', () => {
    expect(wslUncPath('Ubuntu-24.04', '/home/test/project')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\test\\project')
    expect(() => wslUncPath('bad/name', '/home/test')).toThrow(/path separators/u)
    expect(() => wslUncPath('Ubuntu', '../escape')).toThrow(/absolute Linux path/u)
  })
})
