import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyDirectHubEnvelope } from './directHubProtocol.js'
import type { MyOwnMeshRpcBridge } from './myOwnMeshRpc.js'
import {
  DeviceExecutor,
  MAX_DURABLE_COMMAND_TIMEOUT_MS,
  MAX_INTERACTIVE_COMMAND_TIMEOUT_MS,
  FleetConnectionStore,
  RemoteDeviceController,
  normalizeGitRemoteIdentity,
  effectiveRemoteCommandTimeout,
  parseRemoteWslEnvironments,
  remoteCapabilityForAction,
  wslUncPath,
  type DeviceExecutorCapabilities,
} from './remoteDevices.js'

describe('remote command timeout policy', () => {
  it('keeps ad-hoc shells bounded while honoring the durable run ceiling', () => {
    expect(effectiveRemoteCommandTimeout(3_600_000)).toBe(MAX_INTERACTIVE_COMMAND_TIMEOUT_MS)
    expect(effectiveRemoteCommandTimeout(3_600_000, { durableRunId: 'run-1' })).toBe(3_600_000)
    expect(effectiveRemoteCommandTimeout(24 * 60 * 60_000, { durableRunId: 'run-1' }))
      .toBe(MAX_DURABLE_COMMAND_TIMEOUT_MS)
  })
})

const tempDirs: string[] = []
const children: ChildProcess[] = []

function tempDir(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-remote-device-'))
  tempDirs.push(value)
  return value
}

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      try {
        if (process.platform === 'win32' && child.pid) {
          // Git for Windows starts git-daemon.exe beneath the git.exe wrapper. `child.kill()` only
          // terminates that wrapper, leaving the daemon alive with the test runner's inherited pipe.
          // Vitest then prints a green summary but never exits, so release preflight hangs forever and
          // each run leaks another listener. Kill the exact spawned tree while its parent relationship
          // is still intact; this command never targets a discovered or name-matched process.
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          child.kill()
        }
      } catch {
        /* already exited */
      }
      await Promise.race([
        new Promise<void>((resolve) => child.once('close', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ])
    }
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function unusedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function waitForGitRemote(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      execFileSync('git', ['ls-remote', url], { stdio: 'ignore', timeout: 2_000 })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error('git daemon did not become ready')
}

describe('DeviceExecutor target policy', () => {
  it('classifies directory creation as a write at every grant boundary', () => {
    expect(remoteCapabilityForAction({ op: 'mkdir', rootId: 'root', path: 'nested' })).toBe('write')
    expect(remoteCapabilityForAction({ op: 'write', rootId: 'root', path: 'file', content: '' })).toBe('write')
    expect(remoteCapabilityForAction({ op: 'list', rootId: 'root' })).toBe('read')
    expect(remoteCapabilityForAction({ op: 'git_inspect', rootId: 'root' })).toBe('read')
    expect(remoteCapabilityForAction({
      op: 'git_sync', rootId: 'root', repository: 'example.test/acme/repo', headRef: 'main', headCommit: 'a'.repeat(40),
    })).toBe('terminal')
    expect(remoteCapabilityForAction({ op: 'exec', rootId: 'root', command: 'true' })).toBe('terminal')
  })

  it('is disabled with no roots until the operator explicitly configures it', async () => {
    const dir = tempDir()
    const executor = new DeviceExecutor(path.join(dir, 'policy.json'))
    expect(executor.capabilities()).toMatchObject({
      enabled: false,
      hostname: expect.any(String),
      platform: process.platform,
      arch: process.arch,
      cpuCount: expect.any(Number),
      totalMemoryBytes: expect.any(Number),
      roots: [],
    })
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
    await expect(executor.execute({
      op: 'mkdir', rootId, path: path.join('nested', 'empty'), recursive: true,
    })).resolves.toMatchObject({ ok: true, created: true })
    expect(fs.statSync(path.join(root, 'nested', 'empty')).isDirectory()).toBe(true)
    await expect(executor.execute({
      op: 'write', rootId, path: path.join('nested', 'copied.txt'), content: 'folder payload',
    })).resolves.toMatchObject({ ok: true, bytes: 14 })
    expect(fs.readFileSync(path.join(root, 'nested', 'copied.txt'), 'utf8')).toBe('folder payload')
    await expect(executor.execute({
      op: 'mkdir', rootId, path: path.join('missing-parent', 'leaf'), recursive: false,
    })).resolves.toMatchObject({ ok: false, error: 'parent directory does not exist' })
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
    // A cold PowerShell process can take more than ten seconds to initialize on
    // a saturated Windows CI runner. Keep the command bounded while testing the
    // executor contract rather than the runner's process-start latency.
    const result = await executor.execute({ op: 'exec', rootId: policy.roots[0]!.id, command, timeoutMs: 60_000 })
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false })
    expect(result.stdout).toContain('remote-ok')
  }, 75_000)

  it('classifies a command deadline as a timeout rather than a target failure', async () => {
    const dir = tempDir()
    const root = path.join(dir, 'root')
    fs.mkdirSync(root)
    const executor = new DeviceExecutor(path.join(dir, 'policy.json'))
    const policy = executor.update({
      enabled: true,
      roots: [{ id: '', label: 'terminal', path: root, read: false, write: false, terminal: true }],
    })
    const command = process.platform === 'win32'
      ? 'Start-Sleep -Seconds 3'
      : 'sleep 3'
    await expect(executor.execute({
      op: 'exec', rootId: policy.roots[0]!.id, command, timeoutMs: 1_000,
    })).resolves.toMatchObject({
      ok: false,
      timedOut: true,
      failure: { stage: 'timeout', code: 'COMMAND_TIMEOUT' },
      error: 'command timed out after 1000ms',
    })
  }, 15_000)

  it('admits only one terminal command per physical root across source hubs', async () => {
    const dir = tempDir()
    const root = path.join(dir, 'root')
    fs.mkdirSync(root)
    const executor = new DeviceExecutor(path.join(dir, 'policy.json'))
    const policy = executor.update({
      enabled: true,
      roots: [{ id: '', label: 'shared testbed', path: root, read: false, write: true, terminal: true }],
    })
    const rootId = policy.roots[0]!.id
    const command = process.platform === 'win32'
      ? 'Start-Sleep -Milliseconds 750; Write-Output first'
      : 'sleep 0.75; printf first'
    const first = executor.execute({ op: 'exec', rootId, command, timeoutMs: 30_000 })
    await expect(executor.execute({ op: 'exec', rootId, command: 'echo second' })).resolves.toMatchObject({
      ok: false,
      failure: { stage: 'admission', code: 'ROOT_BUSY' },
    })
    await expect(executor.execute({ op: 'write', rootId, path: 'raced.txt', content: 'unsafe' })).resolves.toMatchObject({
      ok: false,
      failure: { stage: 'admission', code: 'ROOT_BUSY' },
    })
    expect(fs.existsSync(path.join(root, 'raced.txt'))).toBe(false)
    await expect(first).resolves.toMatchObject({ ok: true, exitCode: 0 })
  }, 45_000)

  it('reports bounded Git readiness without granting arbitrary terminal execution', async () => {
    const dir = tempDir()
    const root = path.join(dir, 'root')
    fs.mkdirSync(root)
    execFileSync('git', ['-C', root, 'init'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'clean')
    execFileSync('git', ['-C', root, 'add', 'tracked.txt'])
    execFileSync('git', ['-C', root, 'commit', '-m', 'fixture'])
    const executor = new DeviceExecutor(path.join(dir, 'policy.json'))
    const policy = executor.update({
      enabled: true,
      roots: [{ id: '', label: 'repository', path: root, read: true, write: false, terminal: false }],
    })
    const rootId = policy.roots[0]!.id

    await expect(executor.execute({ op: 'git_inspect', rootId })).resolves.toMatchObject({
      ok: true,
      git: {
        status: 'ready',
        gitAvailable: true,
        isRepository: true,
        clean: true,
        complete: true,
        headCommit: expect.stringMatching(/^[0-9a-f]{40}$/u),
      },
    })
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'dirty')
    await expect(executor.execute({ op: 'git_inspect', rootId })).resolves.toMatchObject({
      ok: true,
      git: { status: 'dirty', clean: false, untrackedFiles: 1 },
    })
    await expect(executor.execute({ op: 'exec', rootId, command: 'git status' })).resolves.toMatchObject({
      ok: false,
      error: 'terminal access is not enabled for this root.',
    })
  })

  it('prepares a clean matching checkout at the exact commit advertised by the primary branch', async () => {
    const dir = tempDir()
    const origin = path.join(dir, 'origin.git')
    const source = path.join(dir, 'source')
    const target = path.join(dir, 'target')
    execFileSync('git', ['init', '--bare', origin])
    execFileSync('git', ['clone', origin, source])
    execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.invalid'])
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Test'])
    execFileSync('git', ['-C', source, 'checkout', '-b', 'main'])
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'one')
    execFileSync('git', ['-C', source, 'add', 'tracked.txt'])
    execFileSync('git', ['-C', source, 'commit', '-m', 'first'])
    execFileSync('git', ['-C', source, 'push', '-u', 'origin', 'main'])
    execFileSync('git', ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])

    const port = await unusedPort()
    const daemon = spawn('git', [
      'daemon', '--reuseaddr', '--export-all', '--listen=127.0.0.1', `--port=${port}`,
      `--base-path=${dir}`, dir,
    ], { windowsHide: true, stdio: 'ignore' })
    children.push(daemon)
    const remoteUrl = `git://127.0.0.1:${port}/origin.git`
    await waitForGitRemote(remoteUrl)
    execFileSync('git', ['clone', remoteUrl, target])
    const oldHead = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

    fs.writeFileSync(path.join(source, 'tracked.txt'), 'two')
    execFileSync('git', ['-C', source, 'add', 'tracked.txt'])
    execFileSync('git', ['-C', source, 'commit', '-m', 'second'])
    execFileSync('git', ['-C', source, 'push', 'origin', 'main'])
    execFileSync('git', ['-C', source, 'remote', 'set-url', 'origin', remoteUrl])
    const headCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const repository = normalizeGitRemoteIdentity(remoteUrl)!

    const executor = new DeviceExecutor(path.join(dir, 'policy.json'))
    const policy = executor.update({
      enabled: true,
      roots: [{ id: '', label: 'repository', path: target, read: false, write: false, terminal: true }],
    })
    const rootId = policy.roots[0]!.id
    await expect(executor.execute({
      op: 'git_sync', rootId, repository: 'github.com/other/repository', headRef: 'main', headCommit,
    })).resolves.toMatchObject({ ok: false, failure: { code: 'REPOSITORY_MISMATCH' } })
    fs.writeFileSync(path.join(target, 'untracked.txt'), 'keep me')
    await expect(executor.execute({
      op: 'git_sync', rootId, repository, headRef: 'main', headCommit,
    })).resolves.toMatchObject({ ok: false, failure: { code: 'DIRTY_CHECKOUT' } })
    fs.unlinkSync(path.join(target, 'untracked.txt'))
    await expect(executor.execute({
      op: 'git_sync', rootId, repository, headRef: 'main', headCommit: oldHead,
    })).resolves.toMatchObject({ ok: false, failure: { code: 'SOURCE_REVISION_NOT_PUBLISHED' } })
    await expect(executor.execute({
      op: 'git_sync', rootId, repository, headRef: 'main', headCommit: 'b'.repeat(40),
    })).resolves.toMatchObject({ ok: false, failure: { code: 'SOURCE_REVISION_NOT_PUBLISHED' } })
    const result = await executor.execute({
      op: 'git_sync', rootId, repository, headRef: 'main', headCommit,
    })
    expect(result).toMatchObject({
      ok: true,
      git: { status: 'ready', clean: true, detached: true, headCommit, repository },
    })
    expect(fs.readFileSync(path.join(target, 'tracked.txt'), 'utf8')).toBe('two')
  }, 45_000)

  it('never exposes credentials while comparing remote repository identities', () => {
    expect(normalizeGitRemoteIdentity('https://secret-user:secret-pass@GitHub.com/Acme/Repo.git'))
      .toBe('github.com/Acme/Repo')
    expect(normalizeGitRemoteIdentity('git@github.com:Acme/Repo.git')).toBe('github.com/Acme/Repo')
    expect(normalizeGitRemoteIdentity('file:///tmp/repo.git')).toBeUndefined()
  })
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
  it('reports unchanged credentials so periodic fleet reconciliation stays audit-idempotent', () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    const controller = new RemoteDeviceController(connections, async () => null)
    const token = 'r'.repeat(64)

    expect(controller.saveConnection({ siteId: 'peer', label: 'Peer', token }).changed).toBe(true)
    expect(controller.saveConnection({ siteId: 'peer', label: 'Peer', token }).changed).toBe(false)
    expect(controller.saveConnection({ siteId: 'peer', label: 'Renamed', token }).changed).toBe(true)
  })

  it('uses the authenticated Site-free RPC lane for granted capabilities and actions', async () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    const remoteToken = 'r'.repeat(64)
    const localToken = 'l'.repeat(64)
    connections.upsert({ siteId: 'peerhub', label: 'Peer Hub', token: remoteToken })
    const capabilities: DeviceExecutorCapabilities = {
      enabled: true,
      platform: process.platform,
      arch: 'remote-arch',
      hostname: 'remote-host',
      environments: [{ id: 'host', kind: 'host', label: 'remote host', platform: process.platform, shell: 'shell' }],
      roots: [{ id: 'root-one', label: 'One', path: '/private-target-path', read: true, write: true, terminal: true }],
    }
    const call = vi.fn(async (_peer: string, value: unknown) => {
      const request = value as { kind?: unknown; envelope?: unknown }
      expect(request.kind).toBe('authenticated')
      const envelope = verifyDirectHubEnvelope(request.envelope, {
        fromPeer: 'localhub-session',
        token: localToken,
      })
      if (envelope.operation === 'device_capabilities') return capabilities
      if (envelope.operation === 'device_action') {
        expect(envelope.payload).toMatchObject({
          actor: {
            sessionId: 'session-a',
            profileId: 'profile-a',
            runId: 'run-a',
            projectId: 'project-a',
            replicaId: 'replica-a',
            agentId: 'agent-a',
            baseCommit: 'abc123',
          },
        })
        return { ok: true, bytes: 512, content: 'remote data' }
      }
      throw new Error(`unexpected operation ${envelope.operation}`)
    })
    const bridge = {
      identity: vi.fn(async () => ({ siteId: 'localhub', label: 'Local Hub' })),
      peers: vi.fn(async () => [{ siteId: 'peerhub', label: 'Peer Hub', online: true, status: 'active', rttMs: 12 }]),
      call,
    } as unknown as MyOwnMeshRpcBridge
    const resolveRoute = vi.fn(async () => null)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Site HTTP must not be used') }))
    const controller = new RemoteDeviceController(connections, resolveRoute, { bridge, localDeviceToken: localToken })

    await expect(controller.listForGrants([{
      siteId: 'peerhub', rootIds: ['root-one'], capabilities: ['read', 'write'],
    }])).resolves.toMatchObject([{
      siteId: 'peerhub',
      connected: true,
      roots: [{ id: 'root-one', grantedCapabilities: ['read', 'write'] }],
    }])
    await expect(controller.execute('peerhub', {
      op: 'read', rootId: 'root-one', path: 'fixture.txt',
    }, {
      sessionId: 'session-a',
      profileId: 'profile-a',
      runId: 'run-a',
      projectId: 'project-a',
      replicaId: 'replica-a',
      agentId: 'agent-a',
      baseCommit: 'abc123',
    })).resolves.toMatchObject({
      ok: true,
      content: 'remote data',
      telemetry: { routeMs: 0, roundTripMs: expect.any(Number), transferBytes: 512 },
    })
    expect(resolveRoute).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('carries the durable identity and full timeout through the direct transport', async () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    const remoteToken = 'r'.repeat(64)
    const localToken = 'l'.repeat(64)
    connections.upsert({ siteId: 'peerhub', label: 'Peer Hub', token: remoteToken })
    const call = vi.fn(async (_peer: string, value: unknown, timeoutMs?: number) => {
      const request = value as { envelope?: unknown }
      const envelope = verifyDirectHubEnvelope(request.envelope, {
        fromPeer: 'localhub-session',
        token: localToken,
      })
      expect(envelope.payload).toMatchObject({
        action: { op: 'exec', timeoutMs: 3_600_000 },
        actor: { durableRunId: 'durable-1' },
      })
      expect(timeoutMs).toBe(3_610_000)
      return { ok: true, stdout: 'built', exitCode: 0 }
    })
    const bridge = {
      identity: vi.fn(async () => ({ siteId: 'localhub', label: 'Local Hub' })),
      peers: vi.fn(async () => [{ siteId: 'peerhub', label: 'Peer Hub', online: true, status: 'active' }]),
      call,
    } as unknown as MyOwnMeshRpcBridge
    const controller = new RemoteDeviceController(connections, async () => null, {
      bridge,
      localDeviceToken: localToken,
    })

    await expect(controller.execute('peerhub', {
      op: 'exec', rootId: 'root-one', command: 'build', timeoutMs: 3_600_000,
    }, {
      sessionId: 'session-a', profileId: 'profile-a', durableRunId: 'durable-1',
    })).resolves.toMatchObject({ ok: true, stdout: 'built' })
  })

  it('pairs reciprocally over direct RPC without a Site route', async () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    const localToken = 'l'.repeat(64)
    const remoteToken = 'r'.repeat(64)
    const call = vi.fn(async (peer: string, value: unknown) => {
      expect(peer).toBe('peerhub')
      expect(value).toMatchObject({
        kind: 'pair_exchange',
        code: 'ABCD-EFGH',
        source: { siteId: 'localhub', label: 'Local Hub', token: localToken },
      })
      return { siteId: 'peerhub', label: 'Peer Hub', token: remoteToken }
    })
    const bridge = {
      identity: vi.fn(async () => ({ siteId: 'localhub', label: 'Local Hub' })),
      call,
    } as unknown as MyOwnMeshRpcBridge
    const controller = new RemoteDeviceController(connections, async () => null, { bridge, localDeviceToken: localToken })

    await expect(controller.pairDirect('peerhub', 'ABCD-EFGH')).resolves.toMatchObject({
      siteId: 'peerhub', label: 'Peer Hub', paired: true,
    })
    expect(connections.get('peerhub')?.token).toBe(remoteToken)
  })

  it('requests signed-fleet reciprocal trust without a code', async () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    const localToken = 'l'.repeat(64)
    const remoteToken = 'r'.repeat(64)
    const call = vi.fn(async (_peer: string, value: unknown) => {
      expect(value).toMatchObject({
        kind: 'fleet_trust_exchange',
        source: { siteId: 'localhub', label: 'Local Hub', token: localToken },
      })
      expect(value).not.toHaveProperty('code')
      return { siteId: 'peerhub', label: 'Peer Hub', token: remoteToken }
    })
    const bridge = {
      identity: vi.fn(async () => ({ siteId: 'localhub', label: 'Local Hub' })),
      call,
    } as unknown as MyOwnMeshRpcBridge
    const controller = new RemoteDeviceController(connections, async () => null, { bridge, localDeviceToken: localToken })

    await expect(controller.pairDirect('peerhub')).resolves.toMatchObject({
      siteId: 'peerhub', label: 'Peer Hub', paired: true,
    })
    expect(connections.get('peerhub')?.token).toBe(remoteToken)
  })

  it('does not use or pair through the direct lane while mesh exposure is disabled', async () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    connections.upsert({ siteId: 'peerhub', label: 'Peer Hub', token: 'r'.repeat(64) })
    const capabilities: DeviceExecutorCapabilities = {
      enabled: true,
      platform: process.platform,
      arch: 'site-arch',
      hostname: 'site-host',
      environments: [],
      roots: [],
    }
    const bridge = {
      identity: vi.fn(async () => ({ siteId: 'localhub', label: 'Local Hub' })),
      peers: vi.fn(async () => [{ siteId: 'peerhub', label: 'Peer Hub', online: true, status: 'active' }]),
      call: vi.fn(async () => { throw new Error('disabled direct lane must not be called') }),
    } as unknown as MyOwnMeshRpcBridge
    const resolveRoute = vi.fn(async () => ({
      siteId: 'peerhub', label: 'Peer Hub', baseUrl: 'http://127.0.0.1:9999', online: true,
    }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(capabilities), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new RemoteDeviceController(connections, resolveRoute, {
      bridge,
      localDeviceToken: 'l'.repeat(64),
      enabled: () => false,
    })

    await expect(controller.capabilities('peerhub')).resolves.toMatchObject({ hostname: 'site-host' })
    await expect(controller.pairDirect('peerhub', 'ABCD-EFGH')).rejects.toThrow(/disabled/u)
    expect(bridge.identity).not.toHaveBeenCalled()
    expect(bridge.peers).not.toHaveBeenCalled()
    expect(bridge.call).not.toHaveBeenCalled()
    expect(resolveRoute).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not repeat a possibly executed remote command over the Site fallback after a direct RPC failure', async () => {
    const dir = tempDir()
    const connections = new FleetConnectionStore(path.join(dir, 'connections.json'))
    connections.upsert({ siteId: 'peerhub', label: 'Peer Hub', token: 'r'.repeat(64) })
    const bridge = {
      identity: vi.fn(async () => ({ siteId: 'localhub', label: 'Local Hub' })),
      peers: vi.fn(async () => [{ siteId: 'peerhub', label: 'Peer Hub', online: true, status: 'active' }]),
      call: vi.fn(async () => { throw new Error('response was lost after dispatch') }),
    } as unknown as MyOwnMeshRpcBridge
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new RemoteDeviceController(connections, async () => ({
      siteId: 'peerhub', label: 'Peer Hub', baseUrl: 'http://localhost:49999', online: true,
    }), { bridge, localDeviceToken: 'l'.repeat(64) })

    await expect(controller.execute('peerhub', {
      op: 'exec', rootId: 'root-one', command: 'do-something-once',
    }, { sessionId: 'session-a', profileId: 'profile-a' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/response was lost after dispatch/u),
      failure: { stage: 'transport' },
      telemetry: { routeMs: 0, roundTripMs: expect.any(Number) },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

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
