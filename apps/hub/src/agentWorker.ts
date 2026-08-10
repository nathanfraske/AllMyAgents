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
import { ClaudeDriver, type ClaudePermissionContext } from './adapters/claude.js'
import {
  CodexClient,
  codexRequestResult,
  isOwnAgentServerRequest,
  codexTurnErrorMessage,
  codexTurnOutcome,
  codexTurnPolicy,
  codexGrantKey,
} from './adapters/codex.js'
import { buildAgentMcpServer, type AgentServices } from './agentTools.js'
import type { ManagerSpawnResult } from './agentToolCore.js'
import { AUTO_ALLOW_TOOLS, SELF_GATING_TOOLS } from './executor.js'
import { WseqBuffer, type BufferedEvent } from './wseqBuffer.js'
import { WorkerServer } from './workerTransport.js'
import { checkWriteScope } from './writeScope.js'
import type { AttachmentMeta } from './attachments.js'
import type { BusMessage } from './bus.js'
import type { Memory } from './memory.js'
import type { Practice } from './practices.js'
import {
  ASK_UNAVAILABLE_MESSAGE,
  parseAskUserQuestionInput,
  QuestionInputError,
  type QuestionOutcome,
} from './questions.js'
import type { SessionIdentity } from './identity.js'
import type { DangerFlags } from './types.js'
import {
  CLAUDE_PERMISSION_DENIED_TEXT,
  HUB_UNAVAILABLE_TEXT,
  HubUnavailableError,
  InvalidQuestionCorrelationError,
  newWorkerGeneration,
  stableApprovalId,
  stableQuestionId,
  workerWelcomeProof,
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
    send: (from, to, subject, body, wake) =>
      deps.relayRpc('bus.send', {
        fromSessionId: from.sessionId,
        to,
        subject,
        body,
        ...(wake === undefined ? {} : { wake }),
      }) as Promise<{
        ok: boolean
        delivered: number
        deferred?: number
        error?: string
      }>,
    inbox: (sessionId) => deps.relayRpc('bus.inbox', { sessionId }) as Promise<BusMessage[]>,
    roster: (sessionId) =>
      deps.relayRpc('bus.roster', { sessionId }) as Promise<Array<{
        sessionId: string
        label: string
        provider: string
        status: string
        projectId?: string
        role?: string
        isOverseer?: boolean
      }>>,
    peek: (caller, target, options) =>
      deps.relayRpc('bus.peek', { caller, target, options }) as Promise<{ found: boolean; summary?: string }>,
    childStatus: (managerSessionId) =>
      deps.relayRpc('manager.childStatus', { managerSessionId }) as Promise<{
        ok: boolean
        summary?: string
        error?: string
      }>,
    manageTeam: (managerSessionId, input) =>
      deps.relayRpc('manager.manageTeam', { managerSessionId, input }) as ReturnType<
        NonNullable<AgentServices['manageTeam']>
      >,
    manageChild: (managerSessionId, input) =>
      deps.relayRpc('manager.manageChild', { managerSessionId, input }) as ReturnType<
        NonNullable<AgentServices['manageChild']>
      >,
    spawnAgent: (managerSessionId, input) =>
      deps.relayRpc('manager.spawn', { managerSessionId, input }) as Promise<ManagerSpawnResult>,
    setChildAuthority: (managerSessionId, childSessionId, authorities, tools, permissionMode) =>
      deps.relayRpc('manager.setChildAuthority', {
        managerSessionId,
        childSessionId,
        authorities,
        tools,
        permissionMode,
      }) as Promise<{ ok: boolean; error?: string }>,
    decideChildApproval: (managerSessionId, approvalId, approve, remember) =>
      deps.relayRpc('manager.decideChildApproval', {
        managerSessionId,
        approvalId,
        approve,
        remember,
      }) as Promise<{ ok: boolean; remembered?: boolean; warning?: string; error?: string }>,
    assignChildTask: (managerSessionId, childSessionId, input) =>
      deps.relayRpc('manager.assignChildTask', {
        managerSessionId,
        childSessionId,
        input,
      }) as Promise<{ ok: boolean; taskId?: string; warning?: string; error?: string }>,
    startRun: (callerSessionId, input) =>
      deps.relayRpc('manager.startRun', { callerSessionId, input }) as ReturnType<
        NonNullable<AgentServices['startRun']>
      >,
    inspectRuns: (callerSessionId, input) =>
      deps.relayRpc('manager.inspectRuns', { callerSessionId, input }) as ReturnType<
        NonNullable<AgentServices['inspectRuns']>
      >,
    controlRun: (callerSessionId, runId, operation) =>
      deps.relayRpc('manager.controlRun', { callerSessionId, runId, operation }) as ReturnType<
        NonNullable<AgentServices['controlRun']>
      >,
    queryTeam: (callerSessionId, input) =>
      deps.relayRpc('manager.queryTeam', { callerSessionId, input }) as ReturnType<
        NonNullable<AgentServices['queryTeam']>
      >,
    browser: (sessionId, operation, args) =>
      deps.relayRpc('browser.execute', { sessionId, operation, args }) as ReturnType<AgentServices['browser']>,
    remoteDevices: (sessionId) =>
      deps.relayRpc('remote.list', { sessionId }) as ReturnType<AgentServices['remoteDevices']>,
    remoteExecute: (sessionId, siteId, action) =>
      deps.relayRpc('remote.execute', { sessionId, siteId, action }) as ReturnType<AgentServices['remoteExecute']>,
    remotePrepareProjectLocation: (sessionId, siteId, rootId) =>
      deps.relayRpc('remote.prepareProjectLocation', { sessionId, siteId, rootId }) as ReturnType<AgentServices['remotePrepareProjectLocation']>,
    overseerControl: (sessionId, input) =>
      deps.relayRpc('overseer.control', { sessionId, input }) as ReturnType<AgentServices['overseerControl']>,
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
  private readonly codexClients = new Map<string, CodexClient>() //          profile + filesystem → app-server client
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

  constructor(socketPath: string, authSecret = '') {
    this.server = new WorkerServer(socketPath, {
      onMessage: (msg) => this.onCommand(msg),
      onAttach: (info) => {
        this.danger = info.danger
        // Announce this process's generation to the freshly-attached hub — the handshake reply to its `hello`.
        // WorkerServer.attach() calls onAttach BEFORE it re-flushes the pending relay lane, so this `welcome`
        // reaches the hub ahead of any re-flushed rpc; the hub thus updates/clears its served-write cache
        // before a re-flushed (or new-era) write could be consulted against it (F1).
        this.server.send({
          t: 'welcome',
          generation: this.generation,
          authProof: workerWelcomeProof(authSecret, info.authNonce, info.attachEpoch, this.generation),
        })
      },
      // onBufferedEvent is deliberately left unset: every event/lifecycle message is appended to the
      // wseq buffer at emit time (to assign its wseq), so the buffer ALREADY retains it — there is nothing
      // extra to buffer here (§2.3: a pure observability sink the transport never depends on).
    }, authSecret)
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
        this.steer(msg.sessionId, msg.text, msg.attachments)
          .then(() => this.ack(msg.reqId, true))
          .catch((err) => this.ack(msg.reqId, false, errMessage(err)))
        return
      case 'interrupt':
        this.interrupt(msg.sessionId)
          .then(() => this.ack(msg.reqId, true))
          .catch((err) => this.ack(msg.reqId, false, errMessage(err)))
        return
      case 'interruptAgent':
        this.interruptAgent(msg.sessionId, msg.targetId)
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
    const { spec, prompt, origin, attachments = [] } = msg
    if (spec.provider === 'claude') {
      // Fire-and-progress: a claude turn runs to completion in the background (matches the in-process
      // `void runClaudeTurn`), so the accept is immediate.
      void this.runClaudeTurn(spec, prompt, origin, attachments)
      this.ack(msg.reqId, true)
    } else {
      // A codex turn awaits through the turn/start ack, then streams. runCodexTurn catches its own errors
      // (reporting them via turnError), so the accept resolves either way — the ack mirrors the in-process
      // `await runCodexTurn` returning on accept.
      this.runCodexTurn(spec, prompt, origin, attachments)
        .then(() => this.ack(msg.reqId, true))
        .catch((err) => this.ack(msg.reqId, false, errMessage(err)))
    }
  }

  private ack(reqId: string, ok: boolean, error?: string): void {
    this.server.send({ t: 'ack', reqId, ok, error })
  }

  // ---- Turn loops (the driver half of InProcessExecutor.runClaudeTurn / runCodexTurn) -----------

  private async runClaudeTurn(
    spec: WorkerSessionSpec,
    prompt: string,
    origin: 'operator' | 'bus',
    attachments: readonly AttachmentMeta[]
  ): Promise<void> {
    const driver = this.claudeDriverFor(spec)
    this.emitTurnStarted(spec.sessionId)
    if (origin === 'bus') this.busTurnSessions.add(spec.sessionId)
    try {
      // The prompt is ALREADY recall-augmented by the hub (withRecall stays hub-side, §4.2) — the worker
      // holds no MemoryStore, so it must not re-recall here.
      await driver.send(
        prompt,
        {
          model: spec.model,
          permissionMode: spec.permissionMode,
          effort: spec.effort,
          systemPrompt: spec.claudeSystemPrompt,
          trustProjectConfig: spec.trustProjectConfig,
        },
        attachments
      )
      this.emitTurnCompleted(spec.sessionId, driver.sessionId)
    } catch (err) {
      this.emitTurnError(spec.sessionId, errMessage(err))
    } finally {
      this.busTurnSessions.delete(spec.sessionId)
    }
  }

  private async runCodexTurn(
    spec: WorkerSessionSpec,
    prompt: string,
    origin: 'operator' | 'bus',
    attachments: readonly AttachmentMeta[]
  ): Promise<void> {
    this.emitTurnStarted(spec.sessionId)
    if (origin === 'bus') this.busTurnSessions.add(spec.sessionId)
    try {
      const { client, threadId } = await this.ensureCodexThread(spec)
      // Only the ACCEPT (turn/start ack) is awaited here, matching in-process. turnCompleted is emitted
      // later, when the app-server's `codex/turn/completed` notification fires in the client callback.
      await client.sendTurn(
        threadId,
        prompt,
        {
          model: spec.model,
          effort: spec.effort,
          serviceTier: spec.serviceTier,
          ...codexTurnPolicy(spec), // approval + sandbox together; see the note on codexTurnPolicy
        },
        attachments
      )
    } catch (err) {
      this.emitTurnError(spec.sessionId, errMessage(err))
    } finally {
      // Mirrors in-process runCodexTurn exactly: the bus-turn tag is cleared after ACCEPT (not completion).
      this.busTurnSessions.delete(spec.sessionId)
    }
  }

  private async startThread(spec: WorkerSessionSpec): Promise<string> {
    const client = this.codexClientFor(spec.profileId, spec.profileDir, spec.wsl)
    const threadId = await client.startThread(spec.cwd, spec.codexDeveloperInstructions)
    this.codexThreads.set(spec.sessionId, threadId)
    this.codexSessionClients.set(spec.sessionId, client)
    return threadId
  }

  private async ensureCodexThread(spec: WorkerSessionSpec): Promise<{ client: CodexClient; threadId: string }> {
    const client = this.codexClientFor(spec.profileId, spec.profileDir, spec.wsl)
    this.codexSessionClients.set(spec.sessionId, client)
    let threadId = this.codexThreads.get(spec.sessionId)
    if (!threadId) {
      if (!spec.vendorSessionId) throw new Error('codex session has no persisted thread id')
      await client.resumeThread(spec.vendorSessionId, spec.codexDeveloperInstructions)
      threadId = spec.vendorSessionId
      this.codexThreads.set(spec.sessionId, threadId)
      // In-process journals session/thread-resumed here (a hub side effect); in the worker it is emitted
      // into the wseq'd event stream so the hub journals it identically (§3.2).
      this.emitEvent(spec.sessionId, 'session/thread-resumed', { threadId })
    }
    await client.ensureDeveloperInstructions(threadId, spec.codexDeveloperInstructions)
    return { client, threadId }
  }

  private async steer(sessionId: string, text: string, attachments: readonly AttachmentMeta[] = []): Promise<void> {
    const driver = this.claudeDrivers.get(sessionId)
    if (driver) {
      await driver.steer(text, attachments)
      return
    }
    const client = this.codexSessionClients.get(sessionId)
    const threadId = this.codexThreads.get(sessionId)
    // CodexClient.steer enforces the LIVE-turn requirement through expectedTurnId (mirrors in-process).
    if (!client || !threadId) throw new Error('no active Codex turn to steer')
    await client.steer(threadId, text, attachments)
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

  private async interruptAgent(sessionId: string, targetId: string): Promise<void> {
    const driver = this.claudeDrivers.get(sessionId)
    if (driver) {
      await driver.stopTask(targetId)
      return
    }
    const client = this.codexSessionClients.get(sessionId)
    if (client) {
      await client.interrupt(targetId)
      return
    }
    throw new Error('this session has no independently stoppable sub-agent')
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
   *   - codex → `activeTurns`: a live codex turn runs inside the app-server child, which the worker owns and
   *     which therefore OUTLIVES a hub restart exactly like a claude driver does. So a codex session with a
   *     turn in flight is `active` and replays its gap; a warm thread with no turn is `idle`.
   * `lastWseq` is the session's current buffer head (diagnostic; the hub's replay cursor is its OWN durable
   * lastJournaledWseq, not this).
   *
   * Codex used to be hard-coded `idle` here, on the reasoning that a codex turn "resumes lazily on the next
   * send". That silently broke the documented goal (§3.4: Claude sub-agents AND *Codex sub-tasks* survive
   * "for free"). SessionManager.attachWorker only builds a replay cursor for sessions reported `active`;
   * everything else is set idle and never passed to executor.attach(). So a codex turn crossing a hub
   * restart kept running and kept buffering events in the worker, while the successor hub dropped that
   * entire gap — no journal rows, no UI, and the chat sitting idle while the agent was still working. The
   * app-server child survives either way; only the hub's willingness to drain it was missing.
   */
  private listLive(): LiveSession[] {
    const live: LiveSession[] = []
    for (const [sessionId, driver] of this.claudeDrivers) {
      live.push({ sessionId, status: driver.busy ? 'active' : 'idle', lastWseq: this.buf.lastWseq(sessionId) })
    }
    for (const sessionId of this.codexThreads.keys()) {
      if (this.claudeDrivers.has(sessionId)) continue
      live.push({
        sessionId,
        status: this.activeTurns.has(sessionId) ? 'active' : 'idle',
        lastWseq: this.buf.lastWseq(sessionId),
      })
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
        (toolName, input, context) => this.canUseTool(spec, toolName, input, context),
        { allmyagents: mcp },
        spec.wsl,
      )
      if (spec.vendorSessionId) driver.restore(spec.vendorSessionId)
      this.claudeDrivers.set(spec.sessionId, driver)
    }
    return driver
  }

  private codexClientFor(
    profileId: string,
    profileDir: string,
    wsl?: { distro: string },
  ): CodexClient {
    const clientKey = wsl ? `${profileId}\0wsl:${wsl.distro.toLowerCase()}` : `${profileId}\0local`
    let client = this.codexClients.get(clientKey)
    if (!client) {
      const created = new CodexClient(
        profileDir,
        (kind, payload) => this.onCodexEvent(created, kind, payload),
        // The codex app-server approval callback RELAYS to the hub operator (step 4), replacing the step-3
        // fail-closed decline. Mirrors InProcessExecutor's codex approval (executor.ts): attribute by
        // threadId→sessionId, request `codex/<method>`, accept/decline on the operator's decision. Under
        // `full` (approvalPolicy 'never') the app-server won't ask, so this only fires under safe/edits.
        (method, params) => this.codexApproval(method, params),
        wsl,
      )
      client = created
      this.codexClients.set(clientKey, client)
    }
    return client
  }

  /** The codex app-server approval relay (§3.3). Resolves the sessionId from the request's threadId (as
   *  in-process does), relays an operator approval, and maps the decision. A HubUnavailableError past the
   *  transient bound declines (safe terminal — the codex approval protocol has no retryable-text channel;
   *  the agent can retry the action). */
  private async codexApproval(method: string, params: unknown): Promise<Record<string, unknown>> {
    // Our own agent MCP server needs no prompt (parity with the Claude AUTO_ALLOW set).
    if (isOwnAgentServerRequest(method, params)) return codexRequestResult(method, true, params)
    const threadId = (params as { threadId?: string } | null)?.threadId
    const sessionId = threadId ? this.sessionForThread(threadId) : undefined
    try {
      // Give the payload the same `toolName` shape a Claude approval has, so the card title, the
      // "Always allow" button and the hub's allowlist all work for Codex without a second code path.
      const approvalPayload = { ...(params as Record<string, unknown> | null), toolName: codexGrantKey(method) }
      const approved = await this.relayApproval(sessionId ?? 'unattributed', `codex/${method}`, approvalPayload)
      return codexRequestResult(method, approved, params)
    } catch {
      // TODO(step 6): a codex approval in flight across a hub restart is re-flushed by the transport +
      // deduped by the idempotent approvals.request(id); this decline is only the TRUE >45s-orphan terminal.
      return codexRequestResult(method, false, params)
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
    if (kind === 'codex/turn/completed') {
      // Every codex turn — success, interruption, failure — arrives as turn/completed; turn.status tells
      // them apart. Emitting turnCompleted unconditionally reported a FAILED turn as a successful one,
      // which is the false-green this project has now produced three separate ways.
      const outcome = codexTurnOutcome(payload)
      if (outcome.kind === 'failed') this.emitTurnError(sessionId, outcome.message)
      else this.emitTurnCompleted(sessionId)
    }
    // A failed Codex turn is TERMINAL and must emit a lifecycle, exactly like a completed one. Only
    // `turn/completed` used to, so `turn/error` left this session in `activeTurns` forever: the hub's
    // busySessions stayed set, the "a turn is already in progress" guard refused every later send, and —
    // now that listLive derives Codex status from activeTurns so turns can replay-survive — a successor
    // hub would go on reporting the dead turn as active across every restart. Deliberately NOT mapped to
    // turnCompleted: that would resurrect the false-green we just removed from the Claude path.
    else if (kind === 'codex/turn/error') this.emitTurnError(sessionId, codexTurnErrorMessage(payload))
  }

  /**
   * The claude permission callback (§3.3). Mirrors InProcessExecutor.claudeDriverFor's canUseTool EXACTLY
   * (executor.ts): the hub's own SAFE agent tools (AUTO_ALLOW) are allowed; risky SELF_GATING tools
   * hard-deny on a bus turn (unless the owner opted in via busCanUseRiskyTools) else allow + defer to the
   * handler's own requireApproval; a Write/Edit outside the worktree is denied; everything else goes to the
   * operator approval gate — which in the worker is a hub RELAY (step 4), no longer the step-3 fail-closed
   * deny. Under `full` we allow explicitly (see below) rather than relying on the SDK to skip the callback.
   */
  private async canUseTool(
    spec: WorkerSessionSpec,
    toolName: string,
    input: unknown,
    context?: ClaudePermissionContext
  ): Promise<{ behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }> {
    if (toolName === 'AskUserQuestion') {
      return this.askUserQuestion(spec, input, context)
    }
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
    // NOTE: `full` is deliberately NOT short-circuited here. An earlier fix did exactly that — allow
    // locally whenever spec.permissionMode === 'full' — which stopped the spurious prompts but created a
    // SECOND permission authority inside the worker, and a worse one:
    //   - it never reaches the hub, so nothing is journaled: full-access tool runs had no audit trail;
    //   - it never consults the hub's policy, so the bus-origin clamp, the eligible-kind whitelist and the
    //     never-auto-approve list were all bypassed for exactly the mode that most needs them;
    //   - `spec` is captured at TURN START, so switching the chat Full → Safe mid-turn changed the pill
    //     and changed nothing else. The operator would believe they had tightened access while every
    //     remaining tool in that turn still ran unchecked. Tightening must never be cosmetic.
    // Relaying always, and letting the hub's single policy decide, costs one round-trip and buys back the
    // audit trail, the provenance checks, and a mode the operator can actually change mid-turn.
    // The generic operator gate: RELAY to the hub (step 4). In-process this is
    // `approvals.request(sessionId, 'claude/tool', {toolName, input})`; here it crosses the socket.
    try {
      const approved = await this.relayApproval(spec.sessionId, 'claude/tool', {
        toolName,
        input,
        // Carried so the hub's auto-approve policy can honour a user-configured ask rule.
        matchedAskRule: context?.matchedAskRule,
      })
      return approved
        ? { behavior: 'allow', updatedInput: input }
        : {
            behavior: 'deny',
            message: CLAUDE_PERMISSION_DENIED_TEXT,
          }
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

  /** Worker-mode parity for the in-process AskUserQuestion callback. The hub owns validation,
   * persistence, rendering, answers and restart recovery; the worker owns only the vendor promise. */
  private async askUserQuestion(
    spec: WorkerSessionSpec,
    input: unknown,
    context?: ClaudePermissionContext,
  ): Promise<{ behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }> {
    if (!context?.toolUseID || !context.requestId || !context.signal) {
      return {
        behavior: 'deny',
        message: 'AskUserQuestion arrived without required SDK correlation; no answer was submitted',
      }
    }

    let id: string
    let validatedInput: ReturnType<typeof parseAskUserQuestionInput>
    try {
      id = stableQuestionId(spec.sessionId, context.toolUseID, context.requestId)
      validatedInput = parseAskUserQuestionInput(input)
    } catch (error) {
      if (error instanceof QuestionInputError || error instanceof InvalidQuestionCorrelationError) {
        this.emitEvent(spec.sessionId, 'question/rejected', {
          code: 'invalid-question-input',
          toolUseIdLength: typeof context.toolUseID === 'string' ? context.toolUseID.length : null,
          requestIdLength: typeof context.requestId === 'string' ? context.requestId.length : null,
        })
        return {
          behavior: 'deny',
          message: `AskUserQuestion was rejected because its input was invalid: ${error.message}`,
        }
      }
      throw error
    }

    if (context.signal.aborted) {
      return { behavior: 'deny', message: 'The question was cancelled because the turn was interrupted.' }
    }

    const abort = (): void => {
      // The request relay is inserted before this listener can fire. WorkerServer preserves that order on
      // a live socket and on a reconnect flush, so abort cannot overtake registration of its question.
      void this.relayRpc('questions.abort', { id, sessionId: spec.sessionId }).catch(() => {
        // The pending request relay remains restart-safe and will settle from the hub's durable row.
      })
    }
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      const outcome = (await this.relayRpc('questions.request', {
        id,
        sessionId: spec.sessionId,
        toolUseId: context.toolUseID,
        requestId: context.requestId,
        input: validatedInput,
      })) as QuestionOutcome
      if (outcome.kind === 'answered') {
        return { behavior: 'allow', updatedInput: outcome.updatedInput }
      }
      if (outcome.kind === 'interrupted') {
        return { behavior: 'deny', message: outcome.message }
      }
      return {
        behavior: 'deny',
        message:
          outcome.reason === 'aborted'
            ? 'The question was cancelled because the turn was interrupted.'
            : outcome.reason === 'recovery-unknown'
              ? 'The answer was submitted before a hub restart, but exact delivery could not be verified. Ask again if the answer is still needed.'
              : outcome.reason === 'unavailable'
                ? outcome.message ?? ASK_UNAVAILABLE_MESSAGE
                : 'The user cancelled the question.',
      }
    } catch (error) {
      if (error instanceof HubUnavailableError) return { behavior: 'deny', message: HUB_UNAVAILABLE_TEXT }
      return { behavior: 'deny', message: `AskUserQuestion could not be completed: ${errMessage(error)}` }
    } finally {
      context.signal.removeEventListener('abort', abort)
    }
  }

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

  /** Relay one interactive question under vendor per-invocation identity. The request is inserted before
   * the abort relay, so an already-aborted signal still reaches a successor hub in request→abort order. */
  /** Worktree containment. Shared with InProcessExecutor via ./writeScope.js — see the note there on why
   *  this must not exist twice, and on the NotebookEdit escape both copies used to have. */
  private checkWriteScope(spec: WorkerSessionSpec, toolName: string, input: unknown): string | undefined {
    return checkWriteScope(spec, toolName, input)
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
  const authSecret = process.env.HUB_WORKER_SECRET
  // The worker launches vendor CLIs. Never let the control-channel credential enter their environment.
  delete process.env.HUB_WORKER_SECRET
  if (!socketPath) {
    console.error('[worker] HUB_WORKER_SOCKET is not set — nothing to listen on; exiting')
    process.exit(1)
  }
  if (!authSecret || authSecret.length < 32) {
    console.error('[worker] HUB_WORKER_SECRET is missing or too short; exiting')
    process.exit(1)
  }
  const worker = new AgentWorker(socketPath, authSecret)
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
