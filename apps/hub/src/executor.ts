import path from 'node:path'
import { ClaudeDriver } from './adapters/claude.js'
import { CodexClient, mapCodexTokenUsage } from './adapters/codex.js'
import { buildAgentMcpServer, type AgentServices } from './agentTools.js'
import type { SessionIdentity } from './identity.js'
import type { ApprovalService } from './approvals.js'
import type { UsageMonitor } from './usage.js'
import type { MemoryStore } from './memory.js'
import type { PracticeStore } from './practices.js'
import type { BusAddress, BusMessage } from './bus.js'
import type { ClaudeLimitInfo, DangerFlags, SessionStatus } from './types.js'
import type { LiveSession, WorkerSessionSpec } from './workerProtocol.js'

/**
 * The Executor seam (docs/agent-worker-impl.md §4.1). Agent execution — the ClaudeDriver / CodexClient
 * child processes, the per-turn loops, and the in-process agent MCP server — lives behind this interface
 * so the hub (SessionManager) drives every provider through ONE surface instead of touching drivers
 * directly. `InProcessExecutor` (below) is the only implementation today and preserves current behavior
 * exactly; a future `WorkerExecutor` (a later slice) will run the same execution in a supervised sibling
 * process, but the hub-facing contract is identical.
 */
export interface Executor {
  /** Codex only: start a fresh app-server thread; returns the threadId the hub persists as vendorSessionId. */
  startThread(spec: WorkerSessionSpec): Promise<string>
  /** Run one turn. Resolves on ACCEPT (turn/start ack / turn kicked off), NOT on turn completion. */
  runTurn(spec: WorkerSessionSpec, prompt: string, origin: 'operator' | 'bus'): Promise<void>
  /** Codex only: append input to the live turn on this session's thread. */
  steer(sessionId: string, text: string): Promise<void>
  /** Interrupt the in-flight turn (claude query / codex turn). No-op if none is running. */
  interrupt(sessionId: string): Promise<void>
  /** Drop the driver/thread for a stopped/deleted session from the executor. */
  stopSession(sessionId: string): Promise<void>
  readCodexLimits(profileId: string, profileDir: string): Promise<unknown>
  /** The sessions the executor is still driving (for hub re-attach; a no-op-ish query in-process). */
  listLive(): Promise<LiveSession[]>
  /** Replay per-session events with wseq > since[sid] (a no-op in-process — the hub IS the executor). */
  attach(since: Record<string, number>): Promise<void>
  /** True while this session's claude driver is mid-turn — backs the "a turn is already in progress" guard. */
  isBusy(sessionId: string): boolean
}

// The in-process agent tools (`mcp__allmyagents__*`) split by risk. SAFE tools are auto-allowed in
// canUseTool (bus + memory reads/writes + practice reads — all ACL-enforced in-tool). SELF-GATING
// tools (practice writes above account scope, and later hook_propose) are NOT auto-allowed: their
// handlers self-gate by awaiting the operator (see agentTools.ts), which fires even under `full`
// where canUseTool is skipped entirely. Any allmyagents tool in neither set falls through to the
// generic approval gate — a safe default for a future tool that hasn't been classified yet.
const AUTO_ALLOW_TOOLS = new Set([
  'mcp__allmyagents__list_agents',
  'mcp__allmyagents__send_message',
  'mcp__allmyagents__read_messages',
  'mcp__allmyagents__memory_write',
  'mcp__allmyagents__memory_search',
  'mcp__allmyagents__memory_read',
  'mcp__allmyagents__practice_read',
  'mcp__allmyagents__practice_list',
])
const SELF_GATING_TOOLS = new Set([
  'mcp__allmyagents__practice_write',
  'mcp__allmyagents__practice_edit',
])

/** Hub-owned services the in-process executor calls directly (shared references — the same objects the
 *  hub holds, so e.g. the Danger Zone flags read live). */
export interface InProcessExecutorServices {
  approvals: ApprovalService
  usage: UsageMonitor
  danger: DangerFlags
  memory: MemoryStore
  practices: PracticeStore
}

/**
 * The hub-half side effects the in-process executor performs INLINE as it drives a turn (it *is* the
 * hub in-process, docs/agent-worker-impl.md §4.1). The hub (SessionManager) binds these to its own
 * record-keyed methods via {@link InProcessExecutor.bindHub}. In worker mode these same effects are
 * instead driven by the worker→hub lifecycle/event streams (§3.2) — here they are just direct calls.
 */
export interface InProcessExecutorHubHooks {
  /** Append a journal event (sessionId may be null for profile-scoped events like codex/exited). */
  journal(sessionId: string | null, kind: string, payload: unknown): void
  /** Apply a status transition (persist + journal session/status + idle→deliverBus), by session id. */
  setStatus(sessionId: string, status: SessionStatus): void
  /** Persist a freshly-learned vendor session id (claude driver.sessionId) onto the record. */
  persistVendorSessionId(sessionId: string, vendorSessionId: string): void
  /** Augment a prompt with auto-recalled memories (withRecall stays hub-side; journals memory/recalled). */
  recall(sessionId: string, prompt: string): string
  /** A codex app-server child exited — the hub fails its in-flight sessions (unless a planned retire). */
  onCodexExit(profileId: string, payload: unknown): void
  busSend(fromSessionId: string, to: BusAddress, subject: string | undefined, body: string): { ok: boolean; delivered: number; error?: string }
  busInbox(sessionId: string): BusMessage[]
  busRoster(sessionId: string): { sessionId: string; label: string; provider: string; status: string }[]
}

/**
 * The default, in-process executor: a straight lift of the hub's former driver half (the ClaudeDriver /
 * CodexClient maps, `claudeDriverFor` / `codexClientFor` / `ensureCodexThread`, the `runClaudeTurn` /
 * `runCodexTurn` turn loops, `checkWriteScope`, `readCodexLimits`, and the `buildAgentMcpServer` wiring).
 * It still performs every hub side effect the turn loops used to — status transitions, journal writes,
 * usage accounting, vendor-session persistence, memory recall — but now via the {@link InProcessExecutorHubHooks}
 * the hub binds. Behavior is identical to the pre-seam SessionManager.
 */
export class InProcessExecutor implements Executor {
  private readonly claudeDrivers = new Map<string, ClaudeDriver>()
  private readonly codexClients = new Map<string, CodexClient>() //         profileId → app-server client (shared per profile)
  private readonly codexThreads = new Map<string, string>() //              sessionId → threadId
  private readonly codexSessionClients = new Map<string, CodexClient>() //  sessionId → its (shared) client, for id-only ops
  // Sessions whose CURRENT in-flight turn was caused by a (semi-trusted) teammate bus message. A turn
  // is single-flight per session, so this is an accurate "this session's live turn is bus-caused" flag
  // for the whole window a tool handler can run in. Set from runTurn's `origin`, cleared in `finally`;
  // read by the self-gate + canUseTool to hard-deny risky in-process tools on bus turns.
  private readonly busTurnSessions = new Set<string>()
  private hub: InProcessExecutorHubHooks | undefined

  constructor(private readonly services: InProcessExecutorServices) {}

  /** Bind the hub-half side effects. Called once by the hub before any turn runs (mirrors the existing
   *  setRestartSignal late-binding), which breaks the hub↔executor construction cycle. */
  bindHub(hub: InProcessExecutorHubHooks): void {
    this.hub = hub
  }
  private get h(): InProcessExecutorHubHooks {
    if (!this.hub) throw new Error('InProcessExecutor: hub hooks not bound (call bindHub first)')
    return this.hub
  }

  // ---- Capability object the per-session agent MCP tools call into (identity-agnostic; every method
  //      takes the caller id the hub supplies). Mirrors the hub's former agentServices() exactly:
  //      bus/journal reach back through the hub hooks; memory/practices/approvals/danger are the shared
  //      services; isBusTurn is executor-local. -----------------------------------------------------
  private agentServices(): AgentServices {
    return {
      send: (from, to, subject, body) => this.h.busSend(from.sessionId, to, subject, body),
      inbox: (sessionId) => this.h.busInbox(sessionId),
      roster: (sessionId) => this.h.busRoster(sessionId),
      memory: this.services.memory,
      practices: this.services.practices,
      requireApproval: (id, kind, payload) => this.services.approvals.request(id.sessionId, kind, payload),
      isBusTurn: (sessionId) => this.busTurnSessions.has(sessionId),
      danger: () => this.services.danger,
      journal: (sessionId, kind, payload) => this.h.journal(sessionId, kind, payload),
    }
  }

  /** The worker reconstructs SessionIdentity directly from the spec (fields line up 1:1 with identity.ts);
   *  in-process this matches identityOf(record) because the hub built spec.label via identityOf. */
  private identityFromSpec(spec: WorkerSessionSpec): SessionIdentity {
    return {
      sessionId: spec.sessionId,
      profileId: spec.profileId,
      provider: spec.provider,
      projectId: spec.projectId,
      label: spec.label,
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

  private sessionIdForThread(threadId: string): string | undefined {
    for (const [sessionId, tid] of this.codexThreads) {
      if (tid === threadId) return sessionId
    }
    return undefined
  }

  private codexClientFor(profileId: string, profileDir: string): CodexClient {
    let client = this.codexClients.get(profileId)
    if (!client) {
      client = new CodexClient(
        profileDir,
        (kind, payload) => {
          // The app-server child died: any codex session on this profile that was mid-turn will never
          // get its turn/completed and would hang in `active` forever. Exit carries no threadId — the
          // hub matches by profile (and skips it on a planned retire). Journaled once, here.
          if (kind === 'codex/exited') {
            this.h.journal(null, kind, payload)
            this.h.onCodexExit(profileId, payload)
            return
          }
          const threadId = (payload as { threadId?: string } | null)?.threadId
          const sessionId = threadId ? this.sessionIdForThread(threadId) : undefined
          this.h.journal(sessionId ?? null, kind, payload)
          if (sessionId && kind === 'codex/turn/completed') this.h.setStatus(sessionId, 'idle')
          // Forward the app-server's token-usage notifications to the UI's live counter. The raw
          // `codex/thread/tokenUsage/updated` event is still journaled above for field verification.
          if (sessionId && kind === 'codex/thread/tokenUsage/updated') {
            const tokens = mapCodexTokenUsage(payload)
            if (tokens) this.h.journal(sessionId, 'session/tokens', tokens)
          }
        },
        async (method, params) => {
          const threadId = (params as { threadId?: string } | null)?.threadId
          const sessionId = threadId ? this.sessionIdForThread(threadId) : undefined
          const approved = await this.services.approvals.request(sessionId ?? 'unattributed', `codex/${method}`, params)
          return approved ? { decision: 'accept' } : { decision: 'decline' }
        }
      )
      this.codexClients.set(profileId, client)
    }
    return client
  }

  private claudeDriverFor(spec: WorkerSessionSpec): ClaudeDriver {
    let driver = this.claudeDrivers.get(spec.sessionId)
    if (!driver) {
      driver = new ClaudeDriver(
        spec.profileDir,
        spec.cwd,
        (kind, payload) => {
          this.h.journal(spec.sessionId, kind, payload)
          if (kind === 'claude/rate_limit_event') {
            const info = (payload as { rate_limit_info?: ClaudeLimitInfo }).rate_limit_info
            if (info) this.services.usage.noteClaude(spec.profileId, info)
          } else if (kind === 'claude/result') {
            const cost = (payload as { total_cost_usd?: number }).total_cost_usd
            this.services.usage.noteClaudeCost(spec.profileId, cost)
          }
        },
        async (toolName, input) => {
          // The hub's own SAFE agent tools (inter-agent bus + shared memory reads/writes + practice
          // reads) are ACL-enforced in-tool; gating them behind human approval would defeat
          // autonomous coordination.
          if (AUTO_ALLOW_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input }
          // RISKY in-process tools (practice writes above account scope; later hook_propose) are not
          // auto-allowed. They self-gate inside their own handler (works even under `full`, where
          // this callback is skipped). Here — the non-`full` path — we add a second, independent
          // barrier: hard-deny on a bus turn (unless the owner opted in), else allow and defer the
          // authoritative operator decision to the handler's own requireApproval (so there's a
          // single prompt, not two).
          if (SELF_GATING_TOOLS.has(toolName)) {
            if (this.busTurnSessions.has(spec.sessionId) && !this.services.danger.busCanUseRiskyTools) {
              this.h.journal(spec.sessionId, 'approval/auto-denied-bus', { toolName })
              return { behavior: 'deny', message: 'a turn caused by a teammate (bus) message may not write practices' }
            }
            return { behavior: 'allow', updatedInput: input }
          }
          const scopeError = this.checkWriteScope(spec, toolName, input)
          if (scopeError) {
            this.h.journal(spec.sessionId, 'approval/auto-denied-scope', { toolName, reason: scopeError })
            return { behavior: 'deny', message: scopeError }
          }
          const approved = await this.services.approvals.request(spec.sessionId, 'claude/tool', { toolName, input })
          return approved
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'denied from hub' }
        },
        // Per-session in-process MCP server: the inter-agent bus + shared-memory tools, bound to this
        // session's identity so every call is attributed to the real caller.
        { allmyagents: buildAgentMcpServer(this.identityFromSpec(spec), this.agentServices()) }
      )
      if (spec.vendorSessionId) driver.restore(spec.vendorSessionId)
      this.claudeDrivers.set(spec.sessionId, driver)
    }
    return driver
  }

  async startThread(spec: WorkerSessionSpec): Promise<string> {
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
      this.h.journal(spec.sessionId, 'session/thread-resumed', { threadId })
    }
    return { client, threadId }
  }

  async runTurn(spec: WorkerSessionSpec, prompt: string, origin: 'operator' | 'bus'): Promise<void> {
    // Resolves on ACCEPT, not completion, matching the pre-seam call sites: a claude turn is
    // fire-and-forget (the turn runs to completion in the background); a codex turn awaits through the
    // turn/start ack. Both turn loops catch their own errors, so neither rejects.
    if (spec.provider === 'claude') {
      void this.runClaudeTurn(spec, prompt, origin)
    } else {
      await this.runCodexTurn(spec, prompt, origin)
    }
  }

  private async runClaudeTurn(spec: WorkerSessionSpec, prompt: string, origin: 'operator' | 'bus'): Promise<void> {
    const driver = this.claudeDriverFor(spec)
    this.h.setStatus(spec.sessionId, 'active')
    // Tag the in-flight turn's provenance so risky in-process tool handlers can hard-deny on a bus
    // (teammate-message-caused) turn. Cleared in finally, so the flag is scoped to this turn.
    if (origin === 'bus') this.busTurnSessions.add(spec.sessionId)
    try {
      await driver.send(this.h.recall(spec.sessionId, prompt), {
        model: spec.model,
        permissionMode: spec.permissionMode,
        effort: spec.effort,
      })
      if (driver.sessionId) this.h.persistVendorSessionId(spec.sessionId, driver.sessionId)
      this.h.setStatus(spec.sessionId, 'idle')
    } catch (err) {
      this.h.journal(spec.sessionId, 'session/error', {
        message: err instanceof Error ? err.message : String(err),
      })
      this.h.setStatus(spec.sessionId, 'error')
    } finally {
      this.busTurnSessions.delete(spec.sessionId)
    }
  }

  private async runCodexTurn(spec: WorkerSessionSpec, prompt: string, origin: 'operator' | 'bus'): Promise<void> {
    this.h.setStatus(spec.sessionId, 'active')
    // Same bus-turn provenance tag as runClaudeTurn (Codex has no MCP tools yet, but tagging both
    // paths uniformly keeps the self-gate correct if/when Codex gains risky in-process tools).
    if (origin === 'bus') this.busTurnSessions.add(spec.sessionId)
    try {
      const { client, threadId } = await this.ensureCodexThread(spec)
      await client.sendTurn(threadId, this.h.recall(spec.sessionId, prompt), {
        model: spec.model,
        effort: spec.effort,
        serviceTier: spec.serviceTier,
        approvalPolicy: spec.permissionMode === 'full' ? 'never' : spec.permissionMode ? 'onRequest' : undefined,
      })
    } catch (err) {
      this.h.journal(spec.sessionId, 'session/error', {
        message: err instanceof Error ? err.message : String(err),
      })
      this.h.setStatus(spec.sessionId, 'error')
    } finally {
      this.busTurnSessions.delete(spec.sessionId)
    }
  }

  async steer(sessionId: string, text: string): Promise<void> {
    const client = this.codexSessionClients.get(sessionId)
    const threadId = this.codexThreads.get(sessionId)
    // Steering only applies to a codex session with a LIVE turn; CodexClient.steer enforces the
    // active-turn requirement (expectedTurnId), throwing if there is none.
    // AUDIT/F1 (intentional narrowing, 2026-07-24): the pre-seam steer routed through ensureCodexThread,
    // which would RESUME a persisted-but-not-live thread (journaling session/thread-resumed + warming the
    // cache) *before* throwing 'no active Codex turn to steer'. We no longer do that pointless
    // resume-then-reject: steering a session with no live turn rejects immediately, with no journal event
    // or thread-cache side effect. Caller-visible result (the rejection) is unchanged, and real turns still
    // resume+journal via runCodexTurn on their next send. Deliberately NOT restored — preserving it would
    // widen steer()'s interface to carry a WorkerSessionSpec into the already-built worker protocol.
    if (!client || !threadId) throw new Error('no active Codex turn to steer')
    await client.steer(threadId, text)
  }

  async interrupt(sessionId: string): Promise<void> {
    // A session is either claude (a driver) or codex (a thread), never both — branch on which the
    // executor holds, exactly as the hub used record.provider before.
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

  async stopSession(sessionId: string): Promise<void> {
    // The in-process lift of delete()'s driver-map cleanup (`claudeDrivers.delete` + `codexThreads.delete`).
    // The codexClients map is keyed by profile + shared across sessions, so it is deliberately left
    // intact. Interrupt is NOT re-issued here: every caller (delete → stop) has already interrupted.
    // AUDIT/F3 (keep synchronous, 2026-07-24): the hub's delete() removes the session record and calls
    // stopSession in the SAME synchronous run, and this method has no await before the codexThreads.delete
    // below — that ordering is load-bearing. sessionIdForThread() reads sessionId straight from
    // codexThreads, so if a thread ever outlived its record a stray codex callback would mis-attribute
    // (setStatus / session/tokens on a dead session). Do NOT insert an await before these deletes.
    this.claudeDrivers.delete(sessionId)
    this.codexThreads.delete(sessionId)
    this.codexSessionClients.delete(sessionId)
  }

  readCodexLimits(profileId: string, profileDir: string): Promise<unknown> {
    return this.codexClientFor(profileId, profileDir).readRateLimits()
  }

  async listLive(): Promise<LiveSession[]> {
    // In-process there is no wseq buffer (that lives in the worker), so lastWseq is 0. Nothing calls
    // this in-process today — boot() still uses reconcileStale — but it is faithful to the interface.
    const live: LiveSession[] = []
    for (const [sessionId, driver] of this.claudeDrivers) {
      live.push({ sessionId, status: driver.busy ? 'active' : 'idle', lastWseq: 0 })
    }
    for (const sessionId of this.codexThreads.keys()) {
      if (this.claudeDrivers.has(sessionId)) continue
      live.push({ sessionId, status: 'idle', lastWseq: 0 })
    }
    return live
  }

  async attach(_since: Record<string, number>): Promise<void> {
    // In-process the hub IS the executor, so there is never an event gap to replay — resolve at once.
  }

  isBusy(sessionId: string): boolean {
    return this.claudeDrivers.get(sessionId)?.busy ?? false
  }

  /**
   * Stop every vendor child this executor spawned — the long-lived Codex app-server children (one per
   * profile) and any in-flight Claude query — so a standalone hub stop (SIGINT/SIGTERM) doesn't orphan
   * them. The Codex kills are dispatched synchronously (before the first await) so they land even if a
   * shutdown guard timer fires early; in-flight Claude turns are interrupted concurrently. Best-effort,
   * non-throwing. NOT part of the Executor interface — it is the in-process teardown the hub calls
   * directly; in worker mode a hub shutdown must NOT kill the worker's children (that would defeat the
   * whole point), so there is no equivalent on a WorkerExecutor.
   */
  async shutdownVendors(): Promise<void> {
    for (const client of this.codexClients.values()) {
      try {
        client.stop()
      } catch {
        /* best-effort teardown — one child's failure must not block the others */
      }
    }
    await Promise.allSettled([...this.claudeDrivers.values()].map((driver) => driver.interrupt()))
  }
}
