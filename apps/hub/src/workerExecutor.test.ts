import { describe, it, expect } from 'vitest'
import { WorkerExecutor, type WorkerExecutorHubCallbacks } from './workerExecutor.js'
import { HubUnavailableError } from './workerProtocol.js'
import type { WorkerClient } from './workerTransport.js'
import type { WorkerSessionSpec, WorkerToHub } from './workerProtocol.js'
import type { AttachmentMeta } from './attachments.js'

/**
 * A WorkerClient whose `call()` always rejects the way the real one does when the worker is not
 * attached (workerTransport.ts: `if (!this.isAttached()) return Promise.reject(new HubUnavailableError())`).
 * Every stream registration is a no-op — this fixture only exercises the command path.
 */
function unattachedClient(): { client: WorkerClient; calls: unknown[] } {
  const calls: unknown[] = []
  const client = {
    onEvent: () => {},
    onTurnLifecycle: () => {},
    onRestartRequest: () => {},
    onRelay: () => {},
    onWelcome: () => {},
    on: () => {},
    connect: () => {},
    call: (msg: unknown) => {
      calls.push(msg)
      return Promise.reject(new HubUnavailableError())
    },
    send: () => {},
  } as unknown as WorkerClient
  return { client, calls }
}

function recordingHub(): {
  hub: WorkerExecutorHubCallbacks
  lifecycle: Extract<WorkerToHub, { t: 'turnStarted' | 'turnCompleted' | 'turnError' }>[]
} {
  const lifecycle: Extract<WorkerToHub, { t: 'turnStarted' | 'turnCompleted' | 'turnError' }>[] = []
  const hub: WorkerExecutorHubCallbacks = {
    ingestWorkerEvent: () => {},
    applyLifecycle: (m) => void lifecycle.push(m),
    recall: (_s, prompt) => prompt,
    requestRestart: () => {},
    runRelay: () => undefined,
    resolveApproval: async () => false,
    attachWorker: async () => {},
  }
  return { hub, lifecycle }
}

const SPEC: WorkerSessionSpec = {
  sessionId: 's1',
  provider: 'claude',
  profileId: 'p',
  profileDir: '/tmp/p',
  cwd: '/tmp',
} as unknown as WorkerSessionSpec

/**
 * REGRESSION (worker-unavailable send is silently lost).
 *
 * SessionManager.send() journals `session/input` and returns success BEFORE the turn reaches the
 * worker, and the web client starts its thinking timer off that. If the worker is not attached,
 * `WorkerClient.call()` rejects immediately — it does not queue — and `runTurn` used to catch that,
 * clear its private busy set, `console.warn`, and swallow. Nothing was journaled and no status was
 * emitted, so the prompt vanished and the UI span forever with no way to discover it had failed.
 *
 * Reachable on cold start (hubctl spawns the worker and the hub races it), on worker respawn, and on
 * any socket flap — and worker mode ships ON.
 *
 * The fix routes the failure through the SAME channel a worker-reported failure uses (`turnError` →
 * applyLifecycle → journal `session/error` + status 'error'), so every client un-sticks identically.
 */
describe('WorkerExecutor.runTurn — a turn the worker never accepted must not vanish', () => {
  it('carries attachment metadata through both worker commands', async () => {
    const { client, calls } = unattachedClient()
    const { hub } = recordingHub()
    const exec = new WorkerExecutor(client, hub)
    const attachment: AttachmentMeta = {
      id: 'a1',
      name: 'shot.png',
      mime: 'image/png',
      size: 3,
      path: '/tmp/shot.png',
    }

    await exec.runTurn(SPEC, 'look', 'operator', [attachment])
    await expect(exec.steer('s1', 'again', [attachment])).rejects.toBeInstanceOf(HubUnavailableError)

    expect(calls).toEqual([
      expect.objectContaining({ t: 'runTurn', attachments: [attachment] }),
      expect.objectContaining({ t: 'steer', attachments: [attachment] }),
    ])
  })

  it('reports turnError to the hub when the worker is unattached, instead of swallowing', async () => {
    const { client } = unattachedClient()
    const { hub, lifecycle } = recordingHub()
    const exec = new WorkerExecutor(client, hub)

    // Must not reject: callers `void` it (claude/bus), so a rejection would be an unhandled one.
    await expect(exec.runTurn(SPEC, 'hello', 'operator')).resolves.toBeUndefined()

    const errors = lifecycle.filter((m) => m.t === 'turnError')
    expect(errors).toHaveLength(1)
    expect(errors[0].sessionId).toBe('s1')
    // The operator has to be able to tell WHY it failed, not just that it did.
    expect(errors[0].t === 'turnError' && errors[0].message).toMatch(/worker/i)
    // Not a replay: this must actually journal session/error, and applyLifecycle skips journaling
    // whenever replay is true.
    expect(errors[0].replay).not.toBe(true)
  })

  it('clears the optimistic busy flag so the session is not wedged for the next send', async () => {
    const { client } = unattachedClient()
    const { hub } = recordingHub()
    const exec = new WorkerExecutor(client, hub)

    await exec.runTurn(SPEC, 'hello', 'operator')
    expect(exec.isBusy('s1')).toBe(false)
  })
})

describe('WorkerExecutor.listLive — reconnect snapshots reconcile the busy cache', () => {
  it('clears a stale busy bit when the worker authoritatively reports the session idle', async () => {
    const calls: unknown[] = []
    const client = {
      onEvent: () => {},
      onTurnLifecycle: () => {},
      onRestartRequest: () => {},
      onRelay: () => {},
      onWelcome: () => {},
      on: () => {},
      connect: () => {},
      send: () => {},
      call: async (msg: { t: string; reqId: string }) => {
        calls.push(msg)
        if (msg.t === 'runTurn') return { t: 'ack', reqId: msg.reqId, ok: true }
        if (msg.t === 'listLive') {
          return {
            t: 'live',
            reqId: msg.reqId,
            sessions: [{ sessionId: 's1', status: 'idle', lastWseq: 4 }],
          }
        }
        throw new Error(`unexpected command: ${msg.t}`)
      },
    } as unknown as WorkerClient
    const { hub } = recordingHub()
    const exec = new WorkerExecutor(client, hub)

    // runTurn's optimistic admission bit survives a socket gap when the terminal lifecycle message was
    // missed. That makes an idle SessionRecord look executor-busy and used to strand queued bus mail.
    await exec.runTurn(SPEC, 'hello', 'operator')
    expect(exec.isBusy('s1')).toBe(true)

    await exec.listLive()

    expect(exec.isBusy('s1')).toBe(false)
    expect(calls.map((call) => (call as { t: string }).t)).toEqual(['runTurn', 'listLive'])

    // The repair must not create the inverse race: a listLive request that began before a NEW runTurn may
    // return an older idle snapshot afterwards. The newer local mutation wins.
    let resolveSnapshot:
      | ((value: {
          t: 'live'
          reqId: string
          sessions: Array<{ sessionId: string; status: 'idle'; lastWseq: number }>
        }) => void)
      | undefined
    const racingClient = {
      onEvent: () => {},
      onTurnLifecycle: () => {},
      onRestartRequest: () => {},
      onRelay: () => {},
      onWelcome: () => {},
      on: () => {},
      connect: () => {},
      send: () => {},
      call: (msg: { t: string; reqId: string }) => {
        if (msg.t === 'runTurn') return Promise.resolve({ t: 'ack', reqId: msg.reqId, ok: true })
        if (msg.t === 'listLive') {
          return new Promise((resolve) => {
            resolveSnapshot = resolve
          })
        }
        return Promise.reject(new Error(`unexpected command: ${msg.t}`))
      },
    } as unknown as WorkerClient
    const newer = new WorkerExecutor(racingClient, recordingHub().hub)
    await newer.runTurn(SPEC, 'old turn', 'operator')
    const staleSnapshot = newer.listLive()
    await newer.runTurn(SPEC, 'new turn accepted after snapshot request', 'operator')
    resolveSnapshot?.({
      t: 'live',
      reqId: 'stale',
      sessions: [{ sessionId: 's1', status: 'idle', lastWseq: 4 }],
    })
    await staleSnapshot
    expect(newer.isBusy('s1')).toBe(true)
  })
})
