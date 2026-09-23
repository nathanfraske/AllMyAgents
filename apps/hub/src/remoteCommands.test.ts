import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceExecutor, FleetConnectionStore, RemoteDeviceController, remoteCapabilityForAction } from './remoteDevices.js'
import type { MyOwnMeshRpcBridge } from './myOwnMeshRpc.js'
import type { DirectHubEnvelope } from './directHubProtocol.js'

const dirs: string[] = []
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-command-'))
  dirs.push(dir)
  const file = path.join(dir, 'executor.json')
  const executor = new DeviceExecutor(file)
  const rootId = executor.update({ enabled: true, roots: [{ path: dir, read: true, write: true, terminal: true }] }).roots[0]!.id
  const jobId = crypto.randomUUID()
  return { dir, file, executor, rootId, jobId, actor: { durableRunId: jobId, sessionId: 'session', profileId: 'profile' } }
}
async function terminal(f: ReturnType<typeof fixture>) {
  let result
  await vi.waitFor(async () => {
    result = await f.executor.execute({ op: 'exec_status', rootId: f.rootId, jobId: f.jobId }, f.actor)
    expect(result.jobState).toBe('completed')
  }, { timeout: 15000 })
  return result
}
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('target durable commands', () => {
  it('admits once, returns immediately, supports no deadline, and retains results across executor restart', async () => {
    const f = fixture()
    const action = { op: 'exec_start' as const, rootId: f.rootId, jobId: f.jobId, command: 'echo durable', timeoutMs: 0 }
    expect(await f.executor.execute(action, f.actor)).toMatchObject({ ok: true, jobState: 'running' })
    expect(await f.executor.execute(action, f.actor)).toMatchObject({ ok: false, outcomeUnknown: true })
    expect(await terminal(f)).toMatchObject({ ok: true, stdout: expect.stringContaining('durable'), exitCode: 0, timedOut: false })
    expect(await new DeviceExecutor(f.file).execute({ op: 'exec_status', rootId: f.rootId, jobId: f.jobId }, f.actor))
      .toMatchObject({ ok: true, jobState: 'completed' })
  }, 20000)

  it('cancels a running command and never reports an interrupted executor as successful', async () => {
    const f = fixture()
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60'
    await f.executor.execute({ op: 'exec_start', rootId: f.rootId, jobId: f.jobId, command, timeoutMs: 0 }, f.actor)
    expect(await new DeviceExecutor(f.file).execute({ op: 'exec_status', rootId: f.rootId, jobId: f.jobId }, f.actor))
      .toMatchObject({ ok: false, outcomeUnknown: true, jobState: 'outcome_unknown' })
    await f.executor.execute({ op: 'exec_cancel', rootId: f.rootId, jobId: f.jobId }, f.actor)
    expect(await terminal(f)).toMatchObject({ ok: false, cancelled: true })
  }, 20000)

  it('keeps all job operations behind terminal authority and exact run/root identity', async () => {
    const f = fixture()
    for (const op of ['exec_start', 'exec_status', 'exec_cancel'] as const) {
      const action = { op, rootId: f.rootId, jobId: f.jobId, command: 'echo denied' }
      expect(remoteCapabilityForAction(action)).toBe('terminal')
      expect(await f.executor.execute(action)).toMatchObject({ ok: false })
      expect(await f.executor.execute({ ...action, jobId: '../../escape' }, f.actor)).toMatchObject({ ok: false })
    }
    f.executor.update({ enabled: true, roots: [{ path: f.dir, read: true, terminal: false }] })
    expect(await f.executor.execute({ op: 'exec_start', rootId: f.rootId, jobId: f.jobId, command: 'echo denied' }, f.actor))
      .toMatchObject({ ok: false, error: expect.stringContaining('terminal access') })
    expect(fs.existsSync(path.join(f.dir, 'remote-command-results'))).toBe(false)
  })

  it('reconciles a lost start acknowledgement using status, never a second execution', async () => {
    const f = fixture()
    const connections = new FleetConnectionStore(path.join(f.dir, 'connections.json'))
    connections.upsert({ siteId: 'peer', label: 'peer', token: 'x'.repeat(64) })
    const operations: string[] = []
    const bridge = {
      peers: async () => [{ siteId: 'peer', online: true }], identity: async () => ({ siteId: 'local', label: 'local' }),
      call: async (_peer: string, payload: { envelope: DirectHubEnvelope }) => {
        if (payload.envelope.operation === 'device_capabilities') return { durableCommands: 1 }
        const action = (payload.envelope.payload as { action: { op: string } }).action
        operations.push(action.op)
        if (action.op === 'exec_start') throw new Error('response lost after admission')
        return { ok: true, jobState: 'completed', stdout: 'one execution', exitCode: 0 }
      },
    } as unknown as MyOwnMeshRpcBridge
    const controller = new RemoteDeviceController(connections, async () => null, { bridge, localDeviceToken: 'y'.repeat(64) })
    expect(await controller.execute('peer', { op: 'exec', rootId: f.rootId, command: 'echo one', timeoutMs: 0 }, f.actor))
      .toMatchObject({ ok: true, stdout: 'one execution' })
    expect(operations).toEqual(['exec_start', 'exec_status'])
  })

  it('refuses unsupported unbounded commands on old peers before sending a write', async () => {
    const f = fixture()
    const controller = new RemoteDeviceController(new FleetConnectionStore(path.join(f.dir, 'connections.json')), async () => null)
    vi.spyOn(controller, 'capabilities').mockResolvedValue({ durableCommands: undefined } as never)
    expect(await controller.execute('old', { op: 'exec', rootId: f.rootId, command: 'no', timeoutMs: 0 }, f.actor))
      .toMatchObject({ ok: false, failure: { stage: 'admission', code: 'DURABLE_COMMAND_UPGRADE_REQUIRED' } })
  })

  it.each([false, true])('polls across connection loss and sends cancellation at most once (cancel=%s)', async (cancel) => {
    vi.useFakeTimers()
    const f = fixture()
    const connections = new FleetConnectionStore(path.join(f.dir, 'connections.json'))
    connections.upsert({ siteId: 'peer', label: 'peer', token: 'x'.repeat(64) })
    const operations: string[] = []
    let polls = 0
    const bridge = {
      peers: async () => [{ siteId: 'peer', online: true }], identity: async () => ({ siteId: 'local', label: 'local' }),
      call: async (_peer: string, payload: { envelope: DirectHubEnvelope }, timeout: number) => {
        expect(timeout).toBeLessThanOrEqual(15000)
        if (payload.envelope.operation === 'device_capabilities') return { durableCommands: 1 }
        const action = (payload.envelope.payload as { action: { op: string } }).action
        operations.push(action.op)
        if (action.op === 'exec_status') {
          if (++polls === 1) throw new Error('transient disconnection')
          return { ok: !cancel, jobState: 'completed', cancelled: cancel, exitCode: cancel ? null : 0 }
        }
        return { ok: true, jobState: 'running' }
      },
    } as unknown as MyOwnMeshRpcBridge
    const controller = new RemoteDeviceController(connections, async () => null, { bridge, localDeviceToken: 'y'.repeat(64) })
    const pending = controller.execute('peer', { op: 'exec', rootId: f.rootId, command: 'work', timeoutMs: 0 }, f.actor, () => cancel)
    await vi.advanceTimersByTimeAsync(10000)
    expect(await pending).toMatchObject({ ok: !cancel, jobState: 'completed' })
    expect(operations.filter(op => op === 'exec_start')).toHaveLength(1)
    expect(operations.filter(op => op === 'exec_cancel')).toHaveLength(cancel ? 1 : 0)
    expect(controller.canCancelDurableCommand('peer', f.jobId)).toBe(false)
  })

  it.each([false, true])('reports a prolonged observation failure as unknown without resubmitting a write (malformed=%s)', async (malformed) => {
    vi.useFakeTimers()
    const f = fixture()
    const connections = new FleetConnectionStore(path.join(f.dir, 'connections.json'))
    connections.upsert({ siteId: 'peer', label: 'peer', token: 'x'.repeat(64) })
    let starts = 0
    const bridge = {
      peers: async () => [{ siteId: 'peer', online: true }], identity: async () => ({ siteId: 'local', label: 'local' }),
      call: async (_peer: string, payload: { envelope: DirectHubEnvelope }) => {
        if (payload.envelope.operation === 'device_capabilities') return { durableCommands: 1 }
        if ((payload.envelope.payload as { action: { op: string } }).action.op === 'exec_start') starts++
        if (malformed) return { ok: true } // A response without a job state cannot prove progress.
        throw new Error('lost transport')
      },
    } as unknown as MyOwnMeshRpcBridge
    const controller = new RemoteDeviceController(connections, async () => null, { bridge, localDeviceToken: 'y'.repeat(64) })
    const pending = controller.execute('peer', { op: 'exec', rootId: f.rootId, command: 'work', timeoutMs: 0 }, f.actor)
    await vi.advanceTimersByTimeAsync(61000)
    expect(await pending).toMatchObject({ ok: false, outcomeUnknown: true })
    expect(starts).toBe(1)
  })

  it('detaches observation on source shutdown without cancelling or restarting the target', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const connections = new FleetConnectionStore(path.join(f.dir, 'connections.json'))
    connections.upsert({ siteId: 'peer', label: 'peer', token: 'x'.repeat(64) })
    const operations: string[] = []
    const bridge = {
      peers: async () => [{ siteId: 'peer', online: true }], identity: async () => ({ siteId: 'local', label: 'local' }),
      call: async (_peer: string, payload: { envelope: DirectHubEnvelope }) => {
        if (payload.envelope.operation === 'device_capabilities') return { durableCommands: 1 }
        operations.push((payload.envelope.payload as { action: { op: string } }).action.op)
        return { ok: true, jobState: 'running' }
      },
    } as unknown as MyOwnMeshRpcBridge
    const controller = new RemoteDeviceController(connections, async () => null, { bridge, localDeviceToken: 'y'.repeat(64) })
    const pending = controller.execute('peer', { op: 'exec', rootId: f.rootId, command: 'work', timeoutMs: 0 }, f.actor)
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.canCancelDurableCommand('peer', f.jobId)).toBe(true)
    controller.stopObserving()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({ ok: false, outcomeUnknown: true })
    expect(operations).toEqual(['exec_start', 'exec_status'])
    expect(controller.canCancelDurableCommand('peer', f.jobId)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
