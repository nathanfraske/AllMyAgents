import type { Executor } from './executor.js'
import type { WorkerClient } from './workerTransport.js'
import type { DangerFlags } from './types.js'
import { nextReqId, type HubToWorker, type LiveSession, type RelayMethod, type WorkerSessionSpec, type WorkerToHub } from './workerProtocol.js'

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
 *   - `runRelay`          — a worker MCP tool handler's `rpc(method,args)` dispatched to the hub's real
 *                           services (bus/memory/practices) — the SAME calls InProcessExecutor.agentServices
 *                           makes, just over the socket (§3.3). Sync today; awaited so a future async store
 *                           still works.
 *   - `resolveApproval`   — a worker `approvalRequest` → `approvals.request(sessionId, kind, payload, id)`,
 *                           the idempotent-id signature (§7.2) so a re-issue across a restart dedups.
 */
export interface WorkerExecutorHubCallbacks {
  ingestWorkerEvent(sessionId: string, wseq: number, kind: string, payload: unknown): void
  applyLifecycle(msg: Extract<WorkerToHub, { t: 'turnStarted' | 'turnCompleted' | 'turnError' }>): void
  recall(sessionId: string, prompt: string): string
  requestRestart(reason: string, bySession?: string): void
  runRelay(method: RelayMethod, args: unknown): unknown
  resolveApproval(approvalId: string, sessionId: string, kind: string, payload: unknown): Promise<boolean>
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
 * STEP 4 SCOPE (docs/agent-worker-impl.md §3.3, §4.4): turns run in the worker behind the HUB_WORKER_SOCKET
 * flag AND the worker's MCP tool handlers now relay back to hub-owned services — `onRelay` dispatches
 * `rpc` to the hub bus/memory/practices and `approvalRequest` to the operator, and `pushDanger` keeps the
 * worker's cached danger live. Still no re-attach (a hub restart loses the turn — Phase-1 parity): the
 * `'attached'` → `attachWorker()` wseq replay is left unwired with a clear TODO(step 5) marker.
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
    // The worker's MCP tool handlers reaching hub-owned services (§3.3): an `rpc` dispatches to the hub's
    // bus/memory/practices; an `approvalRequest` blocks on the operator. Each is answered on this same
    // channel (rpcResult / approvalResolved); the WorkerServer correlates the reply by callId/approvalId.
    this.client.onRelay((msg) => {
      if (msg.t === 'rpc') this.dispatchRpc(msg)
      else this.dispatchApproval(msg)
    })
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

  /**
   * Push the live Danger Zone flags to the worker so its cached `danger()` (read by the MCP gates, §3.3)
   * stays current — called from POST /api/config/danger on CHANGE (server.ts). Best-effort: dropped if the
   * worker is momentarily unattached, but never permanently lost — the WorkerClient's `hello` re-sends the
   * current danger on the next (re)connect (index.ts builds it with `{ danger: () => danger }`), which is
   * the fail-safe connect-time push. The worker defaults to all-OFF/safe until the first of the two lands.
   */
  pushDanger(danger: DangerFlags): void {
    this.client.send({ t: 'dangerUpdate', danger })
  }

  /** Dispatch a worker `rpc` relay to the hub's real services and answer with the correlated `rpcResult`.
   *  `runRelay` is synchronous today (the stores are sync) but awaited so a future async store still works. */
  private dispatchRpc(msg: Extract<WorkerToHub, { t: 'rpc' }>): void {
    void (async (): Promise<void> => {
      try {
        const value = await this.hub.runRelay(msg.method, msg.args)
        this.client.send({ t: 'rpcResult', callId: msg.callId, ok: true, value })
      } catch (err) {
        this.client.send({ t: 'rpcResult', callId: msg.callId, ok: false, error: errText(err) })
      }
    })()
  }

  /** Dispatch a worker `approvalRequest` to the operator (via the idempotent approvals.request) and answer
   *  with `approvalResolved`. resolveApproval resolves true/false (fail-closed on its own 10-min timeout)
   *  and never rejects in practice; if it ever does, reply fail-closed so the worker's relay can't hang. */
  private dispatchApproval(msg: Extract<WorkerToHub, { t: 'approvalRequest' }>): void {
    this.hub
      .resolveApproval(msg.approvalId, msg.sessionId, msg.kind, msg.payload)
      .then((approved) => this.client.send({ t: 'approvalResolved', approvalId: msg.approvalId, approved }))
      .catch((err) => {
        console.warn(`[worker-executor] approval resolve failed for ${msg.approvalId}: ${errText(err)}`)
        this.client.send({ t: 'approvalResolved', approvalId: msg.approvalId, approved: false })
      })
  }

  /** Issue a command whose reply is a plain `ack`, throwing the worker's error when `ok:false`. */
  private async callAck(msg: Extract<HubToWorker, { reqId: string }>): Promise<void> {
    const reply = await this.client.call<Extract<WorkerToHub, { t: 'ack' }>>(msg)
    if (!reply.ok) throw new Error(reply.error ?? 'worker command failed')
  }
}
