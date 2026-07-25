import { describe, it, expect } from 'vitest'
import { WorkerExecutor, type WorkerExecutorHubCallbacks } from './workerExecutor.js'
import { HubUnavailableError } from './workerProtocol.js'
import type { WorkerClient } from './workerTransport.js'
import type { WorkerSessionSpec, WorkerToHub } from './workerProtocol.js'

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
