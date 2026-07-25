/**
 * agentWorker — the long-lived agent executor process (docs/agent-worker-impl.md §3).
 *
 * hubctl spawns this as a supervised SIBLING of the hub, launched exactly like the hub
 * (`node dist/agentWorker.js` in prod, `node --import tsx/esm agentWorker.ts` in dev). It hosts
 * EVERYTHING execution and NOTHING durable (§3.5): the ClaudeDriver / CodexClient child processes, the
 * driver-half turn loops lifted from InProcessExecutor, and a per-session wseq buffer — but no Journal,
 * no stores, no ApprovalService, no DB handle. Every side effect a turn used to run inline is re-homed to
 * the hub: each vendor event becomes a wseq-tagged `event` message, and each turn emits explicit
 * `turnStarted` / `turnCompleted` / `turnError` lifecycle messages the hub turns into status transitions.
 *
 * STEP 3 SCOPE (docs/agent-worker-impl.md §9.3): a spawn→turn→idle cycle runs in the worker behind the
 * HUB_WORKER_SOCKET flag, both providers, with NO re-attach yet (Phase-1 parity — a hub restart still
 * loses the turn). Two things are DELIBERATELY deferred with TODO markers:
 *   - The `buildAgentMcpServer` wiring + the AgentServices RPC proxies (bus/memory/practices/approval)
 *     are STEP 4: the claude driver here runs with NO in-process MCP server, and both providers' approval
 *     gates fail CLOSED (deny) rather than reach an operator that isn't relayed yet.
 *   - Gap-correct `attach(since)` replay is STEP 5: the handler below does a minimal buffer replay.
 */
import path from 'node:path'
import { ClaudeDriver } from './adapters/claude.js'
import { CodexClient } from './adapters/codex.js'
import { WseqBuffer } from './wseqBuffer.js'
import { WorkerServer } from './workerTransport.js'
import type { DangerFlags } from './types.js'
import type { HubToWorker, LiveSession, WorkerSessionSpec } from './workerProtocol.js'

// The single monotonic per-session wseq space (the wseq buffer) is shared by vendor events AND the turn
// lifecycle messages — both carry `wseq`. Lifecycle messages are appended under these worker-internal
// marker kinds so the counter advances in strict send order. Step 3 never drives attach()/replay, so
// these markers are pure bookkeeping today.
// TODO(step 5): teach attach()'s replay to re-emit a marker as its lifecycle message, not as an `event`.
const WSEQ_TURN_STARTED = 'worker/turn/started'
const WSEQ_TURN_COMPLETED = 'worker/turn/completed'
const WSEQ_TURN_ERROR = 'worker/turn/error'

const SAFE_DANGER: DangerFlags = {
  busCanUseRiskyTools: false,
  autoApprovePractices: false,
  autoApproveRestart: false,
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The worker's execution core. Owns the driver maps + turn loops (the driver HALF of InProcessExecutor)
 * and a {@link WorkerServer} speaking the typed hub↔worker protocol. Constructed with the socket path;
 * {@link start} binds the listener.
 */
export class AgentWorker {
  private readonly claudeDrivers = new Map<string, ClaudeDriver>() //        sessionId → driver
  private readonly codexClients = new Map<string, CodexClient>() //          profileId → app-server client (shared per profile)
  private readonly codexThreads = new Map<string, string>() //               sessionId → threadId
  private readonly codexSessionClients = new Map<string, CodexClient>() //   sessionId → its (shared) client, for id-only ops
  // Sessions whose CURRENT in-flight turn was caused by a (semi-trusted) teammate bus message — the
  // worker-local source of truth for isBusTurn (§3.3). Set from runTurn's origin, cleared in `finally`.
  // Unused in step 3 (no MCP tools consult it yet); it is wired now so the maps match InProcessExecutor.
  private readonly busTurnSessions = new Set<string>()
  // Sessions with a live turn right now (between turnStarted and turnCompleted/turnError), for listLive's
  // status and to know which codex sessions to fail on an app-server crash.
  private readonly activeTurns = new Set<string>()
  private readonly buf = new WseqBuffer()
  private readonly server: WorkerServer
  // Last Danger Zone flags the hub pushed (via hello on connect, or a dangerUpdate). Cached for the
  // worker-local `danger()` the MCP gates read — consumed in STEP 4; harmless to track now.
  private danger: DangerFlags = SAFE_DANGER

  constructor(socketPath: string) {
    this.server = new WorkerServer(socketPath, {
      onMessage: (msg) => this.onCommand(msg),
      onAttach: (info) => {
        this.danger = info.danger
      },
      // onBufferedEvent is deliberately left unset: every event/lifecycle message is appended to the
      // wseq buffer at emit time (to assign its wseq), so the buffer ALREADY retains it — there is nothing
      // extra to buffer here (§2.3: a pure observability sink the transport never depends on).
    })
  }

  /** Bind the listener and start accepting the hub connection. */
  async start(): Promise<void> {
    await this.server.listen()
  }

  /** Best-effort teardown of the vendor children (a WORKER shutdown — hubctl-driven, rare). */
  async stop(): Promise<void> {
    for (const client of this.codexClients.values()) {
      try {
        client.stop()
      } catch {
        /* best-effort — one child's failure must not block the others */
      }
    }
    await Promise.allSettled([...this.claudeDrivers.values()].map((d) => d.interrupt()))
    await this.server.close()
  }

  // ---- Hub → worker command dispatch ------------------------------------------------------------

  /** Handle one hub→worker command/push (transport-internal frames never reach here — §2.3). */
  private onCommand(msg: HubToWorker): void {
    switch (msg.t) {
      case 'startThread':
        this.startThread(msg.spec)
          .then((threadId) => this.server.send({ t: 'threadStarted', reqId: msg.reqId, threadId }))
          .catch((err) => this.server.send({ t: 'ack', reqId: msg.reqId, ok: false, error: errMessage(err) }))
        return
      case 'runTurn':
        this.handleRunTurn(msg)
        return
      case 'steer':
        this.steer(msg.sessionId, msg.text)
          .then(() => this.ack(msg.reqId, true))
          .catch((err) => this.ack(msg.reqId, false, errMessage(err)))
        return
      case 'interrupt':
        this.interrupt(msg.sessionId)
          .then(() => this.ack(msg.reqId, true))
          .catch((err) => this.ack(msg.reqId, false, errMessage(err)))
        return
      case 'stopSession':
        try {
          this.stopSession(msg.sessionId)
          this.ack(msg.reqId, true)
        } catch (err) {
          this.ack(msg.reqId, false, errMessage(err))
        }
        return
      case 'listLive':
        this.server.send({ t: 'live', reqId: msg.reqId, sessions: this.listLive() })
        return
      case 'attach':
        try {
          this.attach(msg.since)
          this.ack(msg.reqId, true)
        } catch (err) {
          this.ack(msg.reqId, false, errMessage(err))
        }
        return
      case 'readCodexLimits':
        this.readCodexLimits(msg.profileId, msg.profileDir)
          .then((value) => this.server.send({ t: 'codexLimits', reqId: msg.reqId, ok: true, value }))
          .catch((err) => this.server.send({ t: 'codexLimits', reqId: msg.reqId, ok: false, error: errMessage(err) }))
        return
      case 'dangerUpdate':
        this.danger = msg.danger // cached for the STEP 4 MCP-gate danger(); unused today
        return
      default:
        // hello / draining / approvalResolved / rpcResult are consumed inside WorkerServer, not here.
        break
    }
  }

  private handleRunTurn(msg: Extract<HubToWorker, { t: 'runTurn' }>): void {
    const { spec, prompt, origin } = msg
    if (spec.provider === 'claude') {
      // Fire-and-progress: a claude turn runs to completion in the background (matches the in-process
      // `void runClaudeTurn`), so the accept is immediate.
      void this.runClaudeTurn(spec, prompt, origin)
      this.ack(msg.reqId, true)
    } else {
      // A codex turn awaits through the turn/start ack, then streams. runCodexTurn catches its own errors
      // (reporting them via turnError), so the accept resolves either way — the ack mirrors the in-process
      // `await runCodexTurn` returning on accept.
      this.runCodexTurn(spec, prompt, origin)
        .then(() => this.ack(msg.reqId, true))
        .catch((err) => this.ack(msg.reqId, false, errMessage(err)))
    }
  }

  private ack(reqId: string, ok: boolean, error?: string): void {
    this.server.send({ t: 'ack', reqId, ok, error })
  }

  // ---- Turn loops (the driver half of InProcessExecutor.runClaudeTurn / runCodexTurn) -----------

  private async runClaudeTurn(spec: WorkerSessionSpec, prompt: string, origin: 'operator' | 'bus'): Promise<void> {
    const driver = this.claudeDriverFor(spec)
    this.emitTurnStarted(spec.sessionId)
    if (origin === 'bus') this.busTurnSessions.add(spec.sessionId)
    try {
      // The prompt is ALREADY recall-augmented by the hub (withRecall stays hub-side, §4.2) — the worker
      // holds no MemoryStore, so it must not re-recall here.
      await driver.send(prompt, {
        model: spec.model,
        permissionMode: spec.permissionMode,
        effort: spec.effort,
      })
      this.emitTurnCompleted(spec.sessionId, driver.sessionId)
    } catch (err) {
      this.emitTurnError(spec.sessionId, errMessage(err))
    } finally {
      this.busTurnSessions.delete(spec.sessionId)
    }
  }

  private async runCodexTurn(spec: WorkerSessionSpec, prompt: string, origin: 'operator' | 'bus'): Promise<void> {
    this.emitTurnStarted(spec.sessionId)
    if (origin === 'bus') this.busTurnSessions.add(spec.sessionId)
    try {
      const { client, threadId } = await this.ensureCodexThread(spec)
      // Only the ACCEPT (turn/start ack) is awaited here, matching in-process. turnCompleted is emitted
      // later, when the app-server's `codex/turn/completed` notification fires in the client callback.
      await client.sendTurn(threadId, prompt, {
        model: spec.model,
        effort: spec.effort,
        serviceTier: spec.serviceTier,
        approvalPolicy: spec.permissionMode === 'full' ? 'never' : spec.permissionMode ? 'on-request' : undefined,
      })
    } catch (err) {
      this.emitTurnError(spec.sessionId, errMessage(err))
    } finally {
      // Mirrors in-process runCodexTurn exactly: the bus-turn tag is cleared after ACCEPT (not completion).
      this.busTurnSessions.delete(spec.sessionId)
    }
  }

  private async startThread(spec: WorkerSessionSpec): Promise<string> {
    const client = this.codexClientFor(spec.profileId, spec.profileDir)
    const threadId = await client.startThread(spec.cwd)
    this.codexThreads.set(spec.sessionId, threadId)
    this.codexSessionClients.set(spec.sessionId, client)
    return threadId
  }

  private async ensureCodexThread(spec: WorkerSessionSpec): Promise<{ client: CodexClient; threadId: string }> {
    const client = this.codexClientFor(spec.profileId, spec.profileDir)
    this.codexSessionClients.set(spec.sessionId, client)
    let threadId = this.codexThreads.get(spec.sessionId)
    if (!threadId) {
      if (!spec.vendorSessionId) throw new Error('codex session has no persisted thread id')
      await client.resumeThread(spec.vendorSessionId)
      threadId = spec.vendorSessionId
      this.codexThreads.set(spec.sessionId, threadId)
      // In-process journals session/thread-resumed here (a hub side effect); in the worker it is emitted
      // into the wseq'd event stream so the hub journals it identically (§3.2).
      this.emitEvent(spec.sessionId, 'session/thread-resumed', { threadId })
    }
    return { client, threadId }
  }

  private async steer(sessionId: string, text: string): Promise<void> {
    const client = this.codexSessionClients.get(sessionId)
    const threadId = this.codexThreads.get(sessionId)
    // Steering only applies to a codex session with a LIVE turn; CodexClient.steer enforces the
    // active-turn requirement (expectedTurnId), throwing if there is none (mirrors in-process).
    if (!client || !threadId) throw new Error('no active Codex turn to steer')
    await client.steer(threadId, text)
  }

  private async interrupt(sessionId: string): Promise<void> {
    // A session is either claude (a driver) or codex (a thread), never both — branch on which we hold.
    const driver = this.claudeDrivers.get(sessionId)
    if (driver) {
      await driver.interrupt()
      return
    }
    const threadId = this.codexThreads.get(sessionId)
    if (threadId) {
      const client = this.codexSessionClients.get(sessionId)
      if (client) await client.interrupt(threadId)
    }
  }

  private stopSession(sessionId: string): void {
    // The worker lift of delete()'s driver-map cleanup. The codexClients map is keyed by profile + shared
    // across sessions, so it is deliberately left intact. Also release the per-session wseq buffer — a
    // deleted session never re-attaches (delete → stopSession is terminal).
    this.claudeDrivers.delete(sessionId)
    this.codexThreads.delete(sessionId)
    this.codexSessionClients.delete(sessionId)
    this.activeTurns.delete(sessionId)
    this.buf.forget(sessionId)
  }

  private readCodexLimits(profileId: string, profileDir: string): Promise<unknown> {
    return this.codexClientFor(profileId, profileDir).readRateLimits()
  }

  private listLive(): LiveSession[] {
    const live: LiveSession[] = []
    for (const sessionId of this.claudeDrivers.keys()) {
      live.push({ sessionId, status: this.activeTurns.has(sessionId) ? 'active' : 'idle', lastWseq: this.buf.lastWseq(sessionId) })
    }
    for (const sessionId of this.codexThreads.keys()) {
      if (this.claudeDrivers.has(sessionId)) continue
      live.push({ sessionId, status: this.activeTurns.has(sessionId) ? 'active' : 'idle', lastWseq: this.buf.lastWseq(sessionId) })
    }
    return live
  }

  private attach(since: Record<string, number>): void {
    // STEP 5 owns gap-correct re-attach. Minimal replay for now: re-emit each requested session's buffered
    // events with wseq > since[sid] (the buffer prefixes a worker/attach-gap sentinel if the cursor
    // predates the retained window). Nothing drives this in step 3 (the hub still uses reconcileStale).
    for (const [sessionId, afterWseq] of Object.entries(since)) {
      for (const ev of this.buf.since(sessionId, afterWseq)) {
        this.server.send({ t: 'event', sessionId, wseq: ev.wseq, kind: ev.kind, payload: ev.payload })
      }
    }
  }

  // ---- Driver / client construction (driver half of InProcessExecutor) --------------------------

  private claudeDriverFor(spec: WorkerSessionSpec): ClaudeDriver {
    let driver = this.claudeDrivers.get(spec.sessionId)
    if (!driver) {
      driver = new ClaudeDriver(
        spec.profileDir,
        spec.cwd,
        // onEvent: split from the in-process version — NO hub side effects here (no journal/usage). Each
        // event just gets a wseq and is streamed to the hub, which re-homes the side effects (§3.2).
        (kind, payload) => this.emitEvent(spec.sessionId, kind, payload),
        (toolName, input) => this.canUseTool(spec, toolName, input),
        // STEP 3: no in-process MCP server. TODO(step 4): construct { allmyagents: buildAgentMcpServer(
        //   identityFromSpec(spec), <RPC-proxy AgentServices>) } — bus/memory/practices relayed to the hub,
        //   requireApproval over the approvalRequest channel, worker-local isBusTurn, hub-cached danger.
        undefined
      )
      if (spec.vendorSessionId) driver.restore(spec.vendorSessionId)
      this.claudeDrivers.set(spec.sessionId, driver)
    }
    return driver
  }

  private codexClientFor(profileId: string, profileDir: string): CodexClient {
    let client = this.codexClients.get(profileId)
    if (!client) {
      const created = new CodexClient(
        profileDir,
        (kind, payload) => this.onCodexEvent(created, kind, payload),
        // STEP 3: the codex app-server approval callback can't reach the operator yet (no relay), so it
        // fails CLOSED — never auto-accept an unapproved codex action. Under `full` (approvalPolicy
        // 'never') the app-server won't ask, so this only bites under safe/edits.
        // TODO(step 4): relay to the hub as { t:'approvalRequest' } and honor the operator's decision.
        async () => ({ decision: 'decline' })
      )
      client = created
      this.codexClients.set(profileId, client)
    }
    return client
  }

  /** The codex client event callback (per profile). Resolves the sessionId from the threadId, streams the
   *  event, and translates codex-specific completion/exit into provider-agnostic lifecycle messages. */
  private onCodexEvent(client: CodexClient, kind: string, payload: unknown): void {
    if (kind === 'codex/exited') {
      // The app-server child died. In worker mode a hub shutdown never kills it (§4.3 — the WorkerExecutor
      // is not an InProcessExecutor, so SessionManager.shutdown skips vendor teardown), so an exit is a
      // real crash: fail every LIVE codex turn on this client (the worker analogue of the hub's
      // failInFlightCodexSessions). The exit carries no threadId, so match by client. The `retiring` guard
      // is moot here — the worker's children outlive hub retires by design.
      const code = (payload as { code?: unknown } | null)?.code
      for (const [sessionId, c] of this.codexSessionClients) {
        if (c === client && this.activeTurns.has(sessionId)) {
          this.emitTurnError(sessionId, `codex app-server exited (${code ?? 'unknown'}) mid-turn`)
        }
      }
      return
    }
    const threadId = (payload as { threadId?: string } | null)?.threadId
    const sessionId = threadId ? this.sessionForThread(threadId) : undefined
    // A threadless codex event (stderr/raw/handshake) has no session to tag the per-session stream with.
    // In-process these journal with a NULL session; the worker stream is sessionId-keyed, so they are
    // dropped in worker mode. TODO(step 4/5): a profile-scoped audit channel for these diagnostic lines.
    if (!sessionId) return
    this.emitEvent(sessionId, kind, payload)
    // Turn completion is detected here (codex-specific) and re-expressed as the uniform turnCompleted
    // lifecycle — the hub no longer sniffs `codex/turn/completed` (§3.2). Codex's vendorSessionId is the
    // threadId, already persisted at startThread, so it is not re-sent here.
    if (kind === 'codex/turn/completed') this.emitTurnCompleted(sessionId)
  }

  /**
   * The claude permission callback (§3.3), worker step-3 shape. The worker-LOCAL write-scope guard runs
   * with no hub round-trip; the operator approval gate is a hub RELAY that is not wired until step 4, so
   * anything reaching it fails CLOSED (deny) rather than silently auto-allowing — never weaken the gate.
   * Under `full` (bypassPermissions) the SDK skips this callback entirely, so tools run freely there.
   */
  private async canUseTool(
    spec: WorkerSessionSpec,
    toolName: string,
    input: unknown
  ): Promise<{ behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }> {
    const scopeError = this.checkWriteScope(spec, toolName, input)
    if (scopeError) return { behavior: 'deny', message: scopeError }
    // TODO(step 4): relay the operator approval gate — services.approvals.request → { t:'approvalRequest' }
    //   → hub → operator → { t:'approvalResolved' }. Also fold back the AUTO_ALLOW allmyagents tools + the
    //   SELF_GATING bus-turn hard-deny once the MCP server is wired. Until then, fail closed.
    return {
      behavior: 'deny',
      message: 'operator approval is unavailable in worker mode until the approval relay ships (step 4)',
    }
  }

  private checkWriteScope(spec: WorkerSessionSpec, toolName: string, input: unknown): string | undefined {
    if (!spec.worktree) return undefined
    if (!['Write', 'Edit', 'NotebookEdit'].includes(toolName)) return undefined
    const filePath = (input as { file_path?: string } | null)?.file_path
    if (!filePath) return undefined
    const resolved = path.resolve(spec.cwd, filePath).toLowerCase()
    const root = spec.worktree.toLowerCase()
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return `write to ${filePath} is outside this session's worktree (${spec.worktree}) — use a path inside the worktree`
    }
    return undefined
  }

  private sessionForThread(threadId: string): string | undefined {
    for (const [sessionId, tid] of this.codexThreads) {
      if (tid === threadId) return sessionId
    }
    return undefined
  }

  // ---- Outbound stream helpers (wseq assignment) ------------------------------------------------

  /** Assign the next per-session wseq and stream a vendor event to the hub. */
  private emitEvent(sessionId: string, kind: string, payload: unknown): void {
    const wseq = this.buf.append(sessionId, { kind, payload })
    this.server.send({ t: 'event', sessionId, wseq, kind, payload })
  }

  private emitTurnStarted(sessionId: string): void {
    this.activeTurns.add(sessionId)
    const wseq = this.buf.append(sessionId, { kind: WSEQ_TURN_STARTED, payload: {} })
    this.server.send({ t: 'turnStarted', sessionId, wseq })
  }

  private emitTurnCompleted(sessionId: string, vendorSessionId?: string): void {
    this.activeTurns.delete(sessionId)
    const wseq = this.buf.append(sessionId, { kind: WSEQ_TURN_COMPLETED, payload: { vendorSessionId } })
    this.server.send({ t: 'turnCompleted', sessionId, wseq, vendorSessionId })
  }

  private emitTurnError(sessionId: string, message: string): void {
    this.activeTurns.delete(sessionId)
    const wseq = this.buf.append(sessionId, { kind: WSEQ_TURN_ERROR, payload: { message } })
    this.server.send({ t: 'turnError', sessionId, wseq, message })
  }
}

// ---- Entry point ------------------------------------------------------------------------------

async function main(): Promise<void> {
  const socketPath = process.env.HUB_WORKER_SOCKET
  if (!socketPath) {
    console.error('[worker] HUB_WORKER_SOCKET is not set — nothing to listen on; exiting')
    process.exit(1)
  }
  const worker = new AgentWorker(socketPath)
  await worker.start()
  console.log(`[worker] listening on ${socketPath} (pid ${process.pid})`)
  // A worker shutdown is a full teardown (hubctl killTree, rare) — best-effort stop the vendor children.
  // Note this is NOT a hub restart: a hub bounce leaves the worker (and its children) running by design.
  const shutdown = (signal: string): void => {
    console.log(`[worker] ${signal} — stopping`)
    void worker.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// Only run the process entry when launched directly (hubctl spawns `agentWorker.js`), not when imported
// by a test that constructs AgentWorker itself.
const invokedDirectly = process.argv[1] !== undefined && /agentWorker\.(js|ts)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[worker] fatal', err)
    process.exit(1)
  })
}
