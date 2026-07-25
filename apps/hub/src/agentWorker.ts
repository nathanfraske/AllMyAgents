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
 * STEP 4 SCOPE (docs/agent-worker-impl.md §3.3, §4.4, §8.3): the in-process MCP server + its AgentServices
 * are now wired as RPC proxies back to the hub. The claude driver runs `buildAgentMcpServer` (UNCHANGED)
 * with a relay-backed AgentServices (bus/memory/practices → `rpc`, requireApproval → the approvalRequest
 * channel, worker-local isBusTurn, hub-cached danger), every tool body wrapped in withRetryableHubErrors;
 * `canUseTool` mirrors InProcessExecutor exactly (AUTO_ALLOW / SELF_GATING bus-hard-deny / checkWriteScope /
 * operator approval RELAY); and the codex approval callback relays to the hub operator too.
 *
 * STEP 5 SCOPE (docs/agent-worker-impl.md §6, §7.1): gap-correct, exactly-once re-attach is built here.
 * `listLive()` reports each held session's status (claude → driver.busy, codex → idle) so the hub can decide
 * each session's fate, and `attach(since)` replays every buffered event with wseq > since[sid] — prefixing
 * the buffer's worker/attach-gap sentinel if the ring wrapped, and translating the WSEQ_TURN_* markers back
 * into their lifecycle messages (replayMessage) so the hub's applyLifecycle still drives status. Replay never
 * re-appends to the buffer, so the durable-cursor loop stays exactly-once.
 *
 * Still DELIBERATELY deferred with TODO markers:
 *   - Approval reconciliation across a hub restart is STEP 6 (the transport already re-flushes an
 *     outstanding relay on reconnect + the idempotent approvals.request(id) dedups it; the fail-closed
 *     branches here are only the TRUE >HUB_RELAY_TIMEOUT_MS orphan).
 *   - Transient-gap queue tuning (drain pre-signal, stable-callId write dedup) is STEP 7.
 */
import path from 'node:path'
import { ClaudeDriver } from './adapters/claude.js'
import { CodexClient } from './adapters/codex.js'
import { buildAgentMcpServer, type AgentServices } from './agentTools.js'
import { AUTO_ALLOW_TOOLS, SELF_GATING_TOOLS } from './executor.js'
import { WseqBuffer, type BufferedEvent } from './wseqBuffer.js'
import { WorkerServer } from './workerTransport.js'
import type { BusMessage } from './bus.js'
import type { Memory } from './memory.js'
import type { Practice } from './practices.js'
import type { SessionIdentity } from './identity.js'
import type { DangerFlags } from './types.js'
import {
  HUB_UNAVAILABLE_TEXT,
  HubUnavailableError,
  newWorkerGeneration,
  stableApprovalId,
  type HubToWorker,
  type LiveSession,
  type RelayMethod,
  type WorkerSessionSpec,
  type WorkerToHub,
} from './workerProtocol.js'

// The single monotonic per-session wseq space (the wseq buffer) is shared by vendor events AND the turn
// lifecycle messages — both carry `wseq`. Lifecycle messages are appended under these worker-internal
// marker kinds so the counter advances in strict send order. On re-attach (step 5) attach()'s replay
// translates each marker BACK into its lifecycle message (see replayMessage) rather than re-sending it as
// a generic `event`, so the hub's applyLifecycle still drives the status transition across the seam.
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

/** The worker reconstructs SessionIdentity straight from the spec (fields line up 1:1 with identity.ts);
 *  matches identityOf(record) because the hub built spec.label via identityOf. Mirrors executor.ts. */
function identityFromSpec(spec: WorkerSessionSpec): SessionIdentity {
  return {
    sessionId: spec.sessionId,
    profileId: spec.profileId,
    provider: spec.provider,
    projectId: spec.projectId,
    label: spec.label,
  }
}

/**
 * The RPC-proxy dependencies a worker {@link AgentServices} closes over. Extracted (with
 * {@link buildWorkerAgentServices}) so the proxy shapes are unit-testable without a socket — a fake relay
 * records the emitted messages.
 */
export interface WorkerAgentServiceDeps {
  /** Relay `rpc(method,args)` to the hub and resolve with `rpcResult.value` (throws on ok:false, and
   *  propagates HubUnavailableError past the transient bound — the tool wrapper maps that to retryable text). */
  relayRpc: (method: RelayMethod, args: unknown) => Promise<unknown>
  /** Relay an operator-approval request (stable id) and resolve true/false; throws HubUnavailableError past
   *  the bound — it NEVER returns false on a gap (§8.3), so a gap can't read as an operator "denied". */
  relayApproval: (sessionId: string, kind: string, payload: unknown) => Promise<boolean>
  /** Worker-local: is this session's in-flight turn bus-caused? (§3.3) */
  isBusTurn: (sessionId: string) => boolean
  /** Worker-cached Danger Zone flags (hub-pushed via hello on connect + dangerUpdate on change; safe until
   *  the first push). */
  danger: () => DangerFlags
  /** Audit journal → emitted into the wseq'd event stream, so the hub journals + dedups it like a vendor
   *  event (§3.3) — there is no separate un-deduped journal channel. */
  journal: (sessionId: string, kind: string, payload: unknown) => void
}

/**
 * Build the worker's {@link AgentServices} — the capability object the (UNCHANGED) in-process MCP tool
 * handlers call into. Every hub-owned capability becomes an RPC proxy over the WorkerServer relay lane
 * (docs/agent-worker-impl.md §3.3): bus/memory/practices → `rpc(...)`, requireApproval → the
 * approvalRequest channel; only isBusTurn (worker-local), danger (hub-cached), and journal (the wseq'd
 * event stream) resolve with no round-trip. The proxies PROPAGATE HubUnavailableError rather than
 * collapsing a gap into a falsy "denied" value; {@link wrapRetryableHubErrors} maps that terminal error to
 * the retryable HUB_UNAVAILABLE_TEXT at the tool boundary (§8.3).
 *
 * Identity-agnostic (every method takes the caller id/identity the hub supplies), so ONE object serves
 * every session — buildAgentMcpServer binds the per-session identity. Mirrors InProcessExecutor.agentServices().
 */
export function buildWorkerAgentServices(deps: WorkerAgentServiceDeps): AgentServices {
  return {
    send: (from, to, subject, body) =>
      deps.relayRpc('bus.send', { fromSessionId: from.sessionId, to, subject, body }) as Promise<{ ok: boolean; delivered: number; error?: string }>,
    inbox: (sessionId) => deps.relayRpc('bus.inbox', { sessionId }) as Promise<BusMessage[]>,
    roster: (sessionId) =>
      deps.relayRpc('bus.roster', { sessionId }) as Promise<{ sessionId: string; label: string; provider: string; status: string }[]>,
    memory: {
      write: (input) => deps.relayRpc('memory.write', input) as Promise<Memory>,
      search: (query, opts) => deps.relayRpc('memory.search', { query, opts }) as Promise<Memory[]>,
      get: (id, scopes) => deps.relayRpc('memory.get', { id, scopes }) as Promise<Memory | undefined>,
    },
    practices: {
      write: (input) => deps.relayRpc('practices.write', input) as Promise<Practice>,
      edit: (id, patch) => deps.relayRpc('practices.edit', { id, patch }) as Promise<Practice | undefined>,
      get: (id, scopes) => deps.relayRpc('practices.get', { id, scopes }) as Promise<Practice | undefined>,
      list: (opts) => deps.relayRpc('practices.list', opts ?? {}) as Promise<Practice[]>,
    },
    requireApproval: (id, kind, payload) => deps.relayApproval(id.sessionId, kind, payload),
    isBusTurn: deps.isBusTurn,
    danger: deps.danger,
    journal: deps.journal,
  }
}

/**
 * Wrap every tool handler in a freshly-built MCP server so a HubUnavailableError bubbling out of an
 * AgentServices RPC proxy (a hub gone past the transient bound) returns the retryable HUB_UNAVAILABLE_TEXT
 * result instead of a thrown/`isError` shape an agent reads as broken (§8.3). buildAgentMcpServer is
 * UNCHANGED, so the wrap is applied post-build to the MCP SDK's registered-tool table
 * (createSdkMcpServer stores each tool under `instance._registeredTools[name].handler`). Defensive: if the
 * SDK's internal shape ever changes we log and skip — a HubUnavailableError then still surfaces as an error
 * result whose message IS HUB_UNAVAILABLE_TEXT, so it stays retryable, just less clean.
 */
export function wrapRetryableHubErrors(server: ReturnType<typeof buildAgentMcpServer>): void {
  const table = (server as unknown as { instance?: { _registeredTools?: Record<string, { handler?: unknown }> } }).instance?._registeredTools
  if (!table) {
    console.warn('[worker] could not access the MCP tool table to wrap retryable-hub-errors — a HubUnavailableError will surface as an error result')
    return
  }
  for (const entry of Object.values(table)) {
    const original = entry.handler
    if (typeof original !== 'function') continue
    const fn = original as (...a: unknown[]) => Promise<unknown>
    entry.handler = async (...args: unknown[]): Promise<unknown> => {
      try {
        return await fn(...args)
      } catch (err) {
        if (err instanceof HubUnavailableError) return { content: [{ type: 'text', text: HUB_UNAVAILABLE_TEXT }] }
        throw err
      }
    }
  }
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
  // worker-local source of truth for isBusTurn (§3.3). Set from runTurn's origin, cleared in `finally`;
  // read by the MCP self-gate (buildWorkerAgentServices.isBusTurn) + canUseTool's SELF_GATING hard-deny.
  private readonly busTurnSessions = new Set<string>()
  // Sessions with a live turn right now (between turnStarted and turnCompleted/turnError) — used to know
  // which codex sessions to fail on an app-server crash. (listLive derives claude status from the driver's
  // own `busy` flag and reports codex as idle, mirroring InProcessExecutor, so it does not read this.)
  private readonly activeTurns = new Set<string>()
  private readonly buf = new WseqBuffer()
  private readonly server: WorkerServer
  // The per-session in-process MCP tools' capability object — RPC proxies back to the hub (§3.3). Built
  // once (identity-agnostic; buildAgentMcpServer binds the per-session identity) and reused by every driver.
  private readonly workerServices: AgentServices
  // A worker-local monotonic id for each logical relay `rpc` call. STABLE across a re-flush because the
  // WorkerServer keeps the same pending entry (it re-writes the same msg on attach), so the successor hub
  // can dedup a re-sent write by callId (§8.2) — the served-callId cache itself is STEP 7.
  private callSeq = 0
  // This worker PROCESS's generation id — minted once, announced to every hub that attaches (the `welcome`
  // handshake). callSeq above resets to 0 on each fresh process, so wc1, wc2, … repeat across a respawn; the
  // generation lets the hub tell a RESPAWN (new id → drop its now-stale served-write cache, whose reused
  // callIds would otherwise collide) from a socket FLAP to this same process (same id → keep the cache for
  // §8.2 re-flush dedup). F1.
  private readonly generation = newWorkerGeneration()
  // Last Danger Zone flags the hub pushed — via `hello` on every (re)connect (WorkerClient reads the live
  // danger fresh, so this is the fail-safe connect-time push) or a live `dangerUpdate`. Read by the MCP
  // gates through `workerServices.danger()`; safe-default (all-OFF) until the first push.
  private danger: DangerFlags = SAFE_DANGER

  constructor(socketPath: string) {
    this.server = new WorkerServer(socketPath, {
      onMessage: (msg) => this.onCommand(msg),
      onAttach: (info) => {
        this.danger = info.danger
        // Announce this process's generation to the freshly-attached hub — the handshake reply to its `hello`.
        // WorkerServer.attach() calls onAttach BEFORE it re-flushes the pending relay lane, so this `welcome`
        // reaches the hub ahead of any re-flushed rpc; the hub thus updates/clears its served-write cache
        // before a re-flushed (or new-era) write could be consulted against it (F1).
        this.server.send({ t: 'welcome', generation: this.generation })
      },
      // onBufferedEvent is deliberately left unset: every event/lifecycle message is appended to the
      // wseq buffer at emit time (to assign its wseq), so the buffer ALREADY retains it — there is nothing
      // extra to buffer here (§2.3: a pure observability sink the transport never depends on).
    })
    this.workerServices = buildWorkerAgentServices({
      relayRpc: (method, args) => this.relayRpc(method, args),
      relayApproval: (sessionId, kind, payload) => this.relayApproval(sessionId, kind, payload),
      isBusTurn: (sessionId) => this.busTurnSessions.has(sessionId),
      danger: () => this.danger,
      journal: (sessionId, kind, payload) => this.emitEvent(sessionId, kind, payload),
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

  /**
   * The sessions the worker still holds, for the hub's re-attach decision (§6). Status mirrors
   * InProcessExecutor.listLive EXACTLY so both executors reconcile identically:
   *   - claude → the driver's own `busy` flag: a busy driver is a LIVE turn the hub keeps `active` and
   *     replays across the seam (the Phase-2 win); an idle driver is a warm session with no live turn.
   *   - codex → always `idle`: a codex turn lives in the app-server child and resumes lazily on the next
   *     send, so the worker does not replay-survive it — the hub re-attaches it as idle (§6, §11).
   * `lastWseq` is the session's current buffer head (diagnostic; the hub's replay cursor is its OWN durable
   * lastJournaledWseq, not this).
   */
  private listLive(): LiveSession[] {
    const live: LiveSession[] = []
    for (const [sessionId, driver] of this.claudeDrivers) {
      live.push({ sessionId, status: driver.busy ? 'active' : 'idle', lastWseq: this.buf.lastWseq(sessionId) })
    }
    for (const sessionId of this.codexThreads.keys()) {
      if (this.claudeDrivers.has(sessionId)) continue
      live.push({ sessionId, status: 'idle', lastWseq: this.buf.lastWseq(sessionId) })
    }
    return live
  }

  /**
   * Gap-free, exactly-once re-attach replay (docs/agent-worker-impl.md §7.1) — the survival mechanism.
   * For each requested session, re-send `buf.since(sid, since[sid])`:
   *   - the cursor is EXCLUSIVE (strictly wseq > since[sid]), so the successor hub receives only events
   *     past its durable lastJournaledWseq — no duplicate, no skip (the hub seeds since[sid] FROM that
   *     cursor, closing the loop);
   *   - if the cursor predates the retained ring (a hub gone long enough that the oldest events were
   *     trimmed), buf.since prefixes a synthetic worker/attach-gap sentinel, forwarded like any event so
   *     the hub journals a VISIBLE gap marker instead of silently losing the span;
   *   - each message carries its ORIGINAL wseq — replay NEVER re-appends to the buffer or bumps the
   *     counter (we send from buf.since, not through emit*), and a WSEQ_TURN_* marker replays AS its
   *     lifecycle message (replayMessage) so the hub's applyLifecycle drives status, not a generic event.
   * The drain is synchronous, so (single-threaded JS) no live emit can interleave it: replay finishes, then
   * live emission resumes on the same channel — the replay→live join is gap-free, exactly as the journal's
   * synchronous replay() joins replay→live for the WS.
   */
  private attach(since: Record<string, number>): void {
    for (const [sessionId, afterWseq] of Object.entries(since)) {
      for (const ev of this.buf.since(sessionId, afterWseq)) {
        this.server.send(this.replayMessage(sessionId, ev))
      }
    }
  }

  /**
   * Re-express a buffered event as the worker→hub message it was ORIGINALLY sent as. A WSEQ_TURN_* marker
   * becomes its turnStarted/turnCompleted/turnError lifecycle message (so the hub drives status via
   * applyLifecycle, never by sniffing a generic event kind); every other kind — real vendor events AND the
   * worker/attach-gap sentinel — replays as a generic `event`. The wseq is the buffered one, verbatim.
   *
   * F2: each replayed lifecycle marker carries `replay: true` so the hub restores in-memory status WITHOUT
   * re-journaling the already-durable session/status|session/error row or firing a transient-idle deliverBus.
   * Vendor events need no such flag — the hub dedups them by wseq against its durable cursor. Live emission
   * (emitTurn*) never sets `replay`.
   */
  private replayMessage(sessionId: string, ev: BufferedEvent): WorkerToHub {
    switch (ev.kind) {
      case WSEQ_TURN_STARTED:
        return { t: 'turnStarted', sessionId, wseq: ev.wseq, replay: true }
      case WSEQ_TURN_COMPLETED:
        return { t: 'turnCompleted', sessionId, wseq: ev.wseq, vendorSessionId: (ev.payload as { vendorSessionId?: string } | null)?.vendorSessionId, replay: true }
      case WSEQ_TURN_ERROR:
        return { t: 'turnError', sessionId, wseq: ev.wseq, message: (ev.payload as { message?: string } | null)?.message ?? 'turn failed', replay: true }
      default:
        return { t: 'event', sessionId, wseq: ev.wseq, kind: ev.kind, payload: ev.payload }
    }
  }

  // ---- Driver / client construction (driver half of InProcessExecutor) --------------------------

  private claudeDriverFor(spec: WorkerSessionSpec): ClaudeDriver {
    let driver = this.claudeDrivers.get(spec.sessionId)
    if (!driver) {
      // The per-session in-process MCP server (inter-agent bus + shared memory + practices), bound to this
      // session's identity so every call is attributed to the real caller. Its AgentServices are RPC
      // proxies back to the hub (§3.3); every tool body is wrapped so a hub gone past the transient bound
      // returns the retryable HUB_UNAVAILABLE_TEXT rather than a thrown/denied shape (§8.3).
      const mcp = buildAgentMcpServer(identityFromSpec(spec), this.workerServices)
      wrapRetryableHubErrors(mcp)
      driver = new ClaudeDriver(
        spec.profileDir,
        spec.cwd,
        // onEvent: split from the in-process version — NO hub side effects here (no journal/usage). Each
        // event just gets a wseq and is streamed to the hub, which re-homes the side effects (§3.2).
        (kind, payload) => this.emitEvent(spec.sessionId, kind, payload),
        (toolName, input) => this.canUseTool(spec, toolName, input),
        { allmyagents: mcp }
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
        // The codex app-server approval callback RELAYS to the hub operator (step 4), replacing the step-3
        // fail-closed decline. Mirrors InProcessExecutor's codex approval (executor.ts): attribute by
        // threadId→sessionId, request `codex/<method>`, accept/decline on the operator's decision. Under
        // `full` (approvalPolicy 'never') the app-server won't ask, so this only fires under safe/edits.
        (method, params) => this.codexApproval(method, params)
      )
      client = created
      this.codexClients.set(profileId, client)
    }
    return client
  }

  /** The codex app-server approval relay (§3.3). Resolves the sessionId from the request's threadId (as
   *  in-process does), relays an operator approval, and maps the decision. A HubUnavailableError past the
   *  transient bound declines (safe terminal — the codex approval protocol has no retryable-text channel;
   *  the agent can retry the action). */
  private async codexApproval(method: string, params: unknown): Promise<{ decision: 'accept' | 'decline' }> {
    const threadId = (params as { threadId?: string } | null)?.threadId
    const sessionId = threadId ? this.sessionForThread(threadId) : undefined
    try {
      const approved = await this.relayApproval(sessionId ?? 'unattributed', `codex/${method}`, params)
      return approved ? { decision: 'accept' } : { decision: 'decline' }
    } catch {
      // TODO(step 6): a codex approval in flight across a hub restart is re-flushed by the transport +
      // deduped by the idempotent approvals.request(id); this decline is only the TRUE >45s-orphan terminal.
      return { decision: 'decline' }
    }
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
   * The claude permission callback (§3.3). Mirrors InProcessExecutor.claudeDriverFor's canUseTool EXACTLY
   * (executor.ts): the hub's own SAFE agent tools (AUTO_ALLOW) are allowed; risky SELF_GATING tools
   * hard-deny on a bus turn (unless the owner opted in via busCanUseRiskyTools) else allow + defer to the
   * handler's own requireApproval; a Write/Edit outside the worktree is denied; everything else goes to the
   * operator approval gate — which in the worker is a hub RELAY (step 4), no longer the step-3 fail-closed
   * deny. Under `full` (bypassPermissions) the SDK skips this callback entirely, so tools run freely there.
   */
  private async canUseTool(
    spec: WorkerSessionSpec,
    toolName: string,
    input: unknown
  ): Promise<{ behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }> {
    if (AUTO_ALLOW_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input }
    if (SELF_GATING_TOOLS.has(toolName)) {
      if (this.busTurnSessions.has(spec.sessionId) && !this.danger.busCanUseRiskyTools) {
        this.emitEvent(spec.sessionId, 'approval/auto-denied-bus', { toolName })
        return { behavior: 'deny', message: 'a turn caused by a teammate (bus) message may not write practices' }
      }
      return { behavior: 'allow', updatedInput: input }
    }
    const scopeError = this.checkWriteScope(spec, toolName, input)
    if (scopeError) {
      this.emitEvent(spec.sessionId, 'approval/auto-denied-scope', { toolName, reason: scopeError })
      return { behavior: 'deny', message: scopeError }
    }
    // The generic operator gate: RELAY to the hub (step 4). In-process this is
    // `approvals.request(sessionId, 'claude/tool', {toolName, input})`; here it crosses the socket.
    try {
      const approved = await this.relayApproval(spec.sessionId, 'claude/tool', { toolName, input })
      return approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'denied from hub' }
    } catch (err) {
      // A hub gone past the transient bound (HubUnavailableError): canUseTool has no retryable-text channel
      // (it can only allow/deny), so fail CLOSED with the retryable text as the deny reason — the agent can
      // retry. This is the ONLY terminal difference from the in-process gate.
      // TODO(step 6): a tool approval in flight across a hub restart is re-flushed by the transport +
      // deduped by the idempotent approvals.request(id); this deny is only the TRUE >45s-orphan terminal.
      if (err instanceof HubUnavailableError) return { behavior: 'deny', message: HUB_UNAVAILABLE_TEXT }
      throw err
    }
  }

  // ---- Hub relays (the worker's MCP handlers reaching hub-owned services, §3.3) -----------------

  private nextCallId(): string {
    this.callSeq += 1
    return `wc${this.callSeq}`
  }

  /** Relay one `rpc(method,args)` to the hub and resolve with its `rpcResult.value`. Throws on `ok:false`
   *  (a hub-side dispatch error) and PROPAGATES HubUnavailableError past the transient bound (§8.3). */
  private async relayRpc(method: RelayMethod, args: unknown): Promise<unknown> {
    const reply = await this.server.relay({ t: 'rpc', callId: this.nextCallId(), method, args })
    if (reply.t !== 'rpcResult') throw new Error(`relay ${method}: unexpected reply ${reply.t}`)
    if (!reply.ok) throw new Error(reply.error ?? `relay ${method} failed`)
    return reply.value
  }

  /** Relay an operator-approval request under a STABLE id (so a re-issue after a hub restart collides on
   *  the successor's idempotent approvals.request, §7.2/§8.2) and resolve true/false. PROPAGATES
   *  HubUnavailableError past the bound — it NEVER returns false on a gap (that would read as "denied"). */
  private async relayApproval(sessionId: string, kind: string, payload: unknown): Promise<boolean> {
    const approvalId = stableApprovalId(sessionId, kind, payload)
    const reply = await this.server.relay({ t: 'approvalRequest', approvalId, sessionId, kind, payload })
    if (reply.t !== 'approvalResolved') throw new Error(`approval ${kind}: unexpected reply ${reply.t}`)
    return reply.approved
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
