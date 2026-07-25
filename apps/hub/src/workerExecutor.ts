import type { Executor } from './executor.js'
import type { WorkerClient } from './workerTransport.js'
import { nextReqId, type HubToWorker, type LiveSession, type WorkerSessionSpec, type WorkerToHub } from './workerProtocol.js'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * What a {@link WorkerExecutor} needs back from the hub (SessionManager). The worker holds no durable
 * state, so every side effect a turn used to run inline (docs/agent-worker-impl.md §4.1) is re-homed to
 * the hub over the worker→hub streams and delivered through these callbacks:
 *   - `ingestWorkerEvent` — the vendor event stream (journal + usage + token derivation, §3.2).
 *   - `applyLifecycle`    — turn lifecycle → status transitions + vendorSessionId persistence (§3.2).
 *   - `recall`            — auto-memory recall stays hub-side (§4.2): the WorkerExecutor runs IN the hub
 *                           process, so it augments the prompt here BEFORE it crosses to the worker (which
 *                           holds no MemoryStore). This is the worker-mode analogue of the in-process
 *                           executor's own inline `this.h.recall`; flag-off keeps recalling in the driver
 *                           loop, untouched.
 *   - `requestRestart`    — the restart_hub tool relayed worker→hub → hubctl (wired now; the tool itself
 *                           lands with the MCP relays in a later slice).
 */
export interface WorkerExecutorHubCallbacks {
  ingestWorkerEvent(sessionId: string, wseq: number, kind: string, payload: unknown): void
  applyLifecycle(msg: Extract<WorkerToHub, { t: 'turnStarted' | 'turnCompleted' | 'turnError' }>): void
  recall(sessionId: string, prompt: string): string
  requestRestart(reason: string, bySession?: string): void
}

/**
 * The worker-backed {@link Executor} (docs/agent-worker-impl.md §4.1). Each interface method relays to the
 * long-lived agent worker over a {@link WorkerClient} — `call()` for request/reply commands, `send()` for
 * fire-and-forget pushes — instead of driving vendor children inline. It performs NO turn side effects
 * itself: the worker→hub event + lifecycle streams carry them back and this class forwards them to the
 * hub callbacks wired in its constructor. `isBusy` is tracked from the lifecycle stream (turnStarted →
 * busy; turnCompleted/turnError → idle), with an optimistic set on `runTurn` accept so the hub's
 * "a turn is already in progress" guard stays as tight as the in-process `driver.busy` it replaces.
 *
 * STEP 3 SCOPE (docs/agent-worker-impl.md §9.3): turns run in the worker behind the HUB_WORKER_SOCKET
 * flag, with no re-attach yet (a hub restart still loses the turn — Phase-1 parity). The relay stream
 * (bus/memory/practices/approval MCP handlers) and the `'attached'` → `attachWorker()` re-attach are left
 * unwired here with clear TODO markers.
 */
export class WorkerExecutor implements Executor {
  // Sessions the worker is currently driving a turn for, tracked from the lifecycle stream (authoritative)
  // plus an optimistic add on runTurn accept (a synchronous bridge until the worker's turnStarted lands).
  private readonly busySessions = new Set<string>()

  constructor(
    private readonly client: WorkerClient,
    private readonly hub: WorkerExecutorHubCallbacks
  ) {
    // Wire the worker→hub streams to the hub callbacks (§4.1). The vendor event stream re-homes journal +
    // usage + token derivation; the lifecycle stream drives status + vendorSessionId; a restart request
    // from the (future) restart_hub tool reaches hubctl through the hub's existing requestRestart.
    this.client.onEvent((m) => this.hub.ingestWorkerEvent(m.sessionId, m.wseq, m.kind, m.payload))
    this.client.onTurnLifecycle((m) => {
      if (m.t === 'turnStarted') this.busySessions.add(m.sessionId)
      else this.busySessions.delete(m.sessionId) // turnCompleted / turnError → idle
      this.hub.applyLifecycle(m)
    })
    this.client.onRestartRequest((m) => this.hub.requestRestart(m.reason, m.bySession))
    // TODO(step 4): this.client.onRelay(...) — the worker's MCP tool handlers (bus/memory/practices) and
    //   requireApproval relayed back to hub-owned services, replied via client.send({t:'rpcResult'|...}).
    // TODO(step 5): this.client.on('attached', () => hub.attachWorker()) — re-attach + wseq replay after a
    //   hub restart, so an in-flight turn survives the seam (attachWorker/lastJournaledWseq not built yet).
    this.client.connect()
  }

  async startThread(spec: WorkerSessionSpec): Promise<string> {
    const reply = await this.client.call<Extract<WorkerToHub, { t: 'threadStarted' }>>({
      t: 'startThread',
      reqId: nextReqId(),
      spec,
    })
    return reply.threadId
  }

  async runTurn(spec: WorkerSessionSpec, prompt: string, origin: 'operator' | 'bus'): Promise<void> {
    // Recall stays hub-side (§4.2): augment the prompt in the hub process before it crosses to the worker.
    const augmented = this.hub.recall(spec.sessionId, prompt)
    // Optimistically mark busy on accept so the "a turn is already in progress" guard (SessionManager.send)
    // holds synchronously, before the worker's turnStarted round-trips back. The lifecycle stream remains
    // the source of truth and confirms (turnStarted) or clears (turnCompleted/turnError) it.
    this.busySessions.add(spec.sessionId)
    try {
      await this.callAck({ t: 'runTurn', reqId: nextReqId(), spec, prompt: augmented, origin })
    } catch (err) {
      // The worker never took the turn (unreachable / dropped accept). Like the in-process executor,
      // runTurn NEVER rejects — its callers `void` it (claude / bus) or await it as fire-on-accept (codex),
      // so a rejection would be an unhandled one. Clear the optimistic busy so the session isn't wedged and
      // swallow: a worker-unreachable turn is simply lost (Phase-1 parity for step 3; step 5's re-attach +
      // step 8's transient queue make it robust). A codex ACCEPT failure is caught worker-side and reported
      // via turnError instead, so this branch is only the worker-down case (§9.2).
      this.busySessions.delete(spec.sessionId)
      console.warn(`[worker-executor] runTurn not accepted for ${spec.sessionId}: ${errText(err)}`)
    }
  }

  async steer(sessionId: string, text: string): Promise<void> {
    await this.callAck({ t: 'steer', reqId: nextReqId(), sessionId, text })
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.callAck({ t: 'interrupt', reqId: nextReqId(), sessionId })
  }

  async stopSession(sessionId: string): Promise<void> {
    this.busySessions.delete(sessionId)
    // Best-effort cleanup: the in-process stopSession is synchronous map deletes that never fail, and
    // SessionManager.delete() depends on it not throwing so it can still remove the persisted snapshot
    // (otherwise a hub restart would resurrect the deleted session). If the worker is unreachable, its
    // driver dies with it anyway. So relay it but never reject.
    try {
      await this.callAck({ t: 'stopSession', reqId: nextReqId(), sessionId })
    } catch (err) {
      console.warn(`[worker-executor] stopSession relay failed for ${sessionId}: ${errText(err)}`)
    }
  }

  async readCodexLimits(profileId: string, profileDir: string): Promise<unknown> {
    const reply = await this.client.call<Extract<WorkerToHub, { t: 'codexLimits' }>>({
      t: 'readCodexLimits',
      reqId: nextReqId(),
      profileId,
      profileDir,
    })
    if (!reply.ok) throw new Error(reply.error ?? 'readCodexLimits failed in worker')
    return reply.value
  }

  async listLive(): Promise<LiveSession[]> {
    const reply = await this.client.call<Extract<WorkerToHub, { t: 'live' }>>({ t: 'listLive', reqId: nextReqId() })
    return reply.sessions
  }

  async attach(since: Record<string, number>): Promise<void> {
    // STEP 5: the hub drives this from the WorkerClient's 'attached' event via attachWorker() to replay the
    // gap after a restart. In step 3 nothing calls it (boot still uses reconcileStale), but the relay is
    // faithful so it works the moment re-attach is wired.
    await this.callAck({ t: 'attach', reqId: nextReqId(), since })
  }

  isBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId)
  }

  /** Issue a command whose reply is a plain `ack`, throwing the worker's error when `ok:false`. */
  private async callAck(msg: Extract<HubToWorker, { reqId: string }>): Promise<void> {
    const reply = await this.client.call<Extract<WorkerToHub, { t: 'ack' }>>(msg)
    if (!reply.ok) throw new Error(reply.error ?? 'worker command failed')
  }
}
