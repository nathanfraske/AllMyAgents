/**
 * The typed hub <-> agent-worker RPC protocol (docs/agent-worker-impl.md §1). Types + a few PURE
 * helpers only, no I/O — the single place the hub and the worker agree on message shapes, the role
 * restartHandshake.ts plays for the supervisor IPC. Three sub-channels multiplexed over one socket:
 * commands (hub→worker, reqId-correlated), the vendor event stream (worker→hub, wseq-tagged), and the
 * tool-handler relays (worker→hub, callId/approvalId-correlated) + one hub→worker push (dangerUpdate).
 */
import crypto from 'node:crypto'
import type { DangerFlags } from './types.js'

/** The subset of a SessionRecord the worker's driver needs — the worker holds no record + never opens the store. */
export interface WorkerSessionSpec {
  sessionId: string
  provider: 'claude' | 'codex'
  profileId: string
  profileDir: string // → CLAUDE_CONFIG_DIR / CODEX_HOME
  cwd: string
  worktree?: string
  projectId?: string
  label: string
  model?: string
  effort?: string
  serviceTier?: string
  permissionMode?: 'safe' | 'edits' | 'full'
  vendorSessionId?: string // claude --resume id / codex threadId to resume
}

/** Hub → worker. Commands carry a reqId (request/reply); pushes are fire-and-forget. */
export type HubToWorker =
  | { t: 'hello'; attachEpoch: number; danger: DangerFlags } // first frame on every (re)connect; establishes the live channel
  | { t: 'startThread'; reqId: string; spec: WorkerSessionSpec }
  | { t: 'runTurn'; reqId: string; spec: WorkerSessionSpec; prompt: string; origin: 'operator' | 'bus' }
  | { t: 'steer'; reqId: string; sessionId: string; text: string }
  | { t: 'interrupt'; reqId: string; sessionId: string }
  | { t: 'stopSession'; reqId: string; sessionId: string }
  | { t: 'listLive'; reqId: string }
  | { t: 'attach'; reqId: string; since: Record<string, number> }
  | { t: 'readCodexLimits'; reqId: string; profileId: string; profileDir: string }
  // pushes (no reqId):
  | { t: 'dangerUpdate'; danger: DangerFlags }
  | { t: 'draining' } // pre-flip: hold new relays before the socket drops (§8.4)
  | { t: 'approvalResolved'; approvalId: string; approved: boolean }
  | { t: 'rpcResult'; callId: string; ok: boolean; value?: unknown; error?: string }

/** Worker → hub. */
export type WorkerToHub =
  // vendor event stream — the SAME kinds the hub journals today (claude/*, codex/*, session/tokens, …),
  // each tagged sessionId + a per-session monotonic wseq (§7):
  | { t: 'event'; sessionId: string; wseq: number; kind: string; payload: unknown }
  // turn lifecycle — drives the hub's setStatus + vendorSessionId persistence + deliverBus:
  | { t: 'turnStarted'; sessionId: string; wseq: number }
  | { t: 'turnCompleted'; sessionId: string; wseq: number; vendorSessionId?: string }
  | { t: 'turnError'; sessionId: string; wseq: number; message: string }
  // self-gating tool-handler relays (worker's MCP handlers reaching hub-owned services):
  | { t: 'approvalRequest'; approvalId: string; sessionId: string; kind: string; payload: unknown }
  | { t: 'rpc'; callId: string; method: RelayMethod; args: unknown } // callId STABLE across re-flush → hub dedups writes (§8.2)
  | { t: 'restartRequest'; reason: string; bySession?: string }
  // command acks/replies:
  | { t: 'ack'; reqId: string; ok: boolean; error?: string }
  | { t: 'threadStarted'; reqId: string; threadId: string }
  | { t: 'codexLimits'; reqId: string; ok: boolean; value?: unknown; error?: string }
  | { t: 'live'; reqId: string; sessions: LiveSession[] }

export interface LiveSession {
  sessionId: string
  status: 'active' | 'idle'
  lastWseq: number
}

export type RelayMethod =
  | 'bus.send'
  | 'bus.inbox'
  | 'bus.roster'
  | 'memory.write'
  | 'memory.search'
  | 'memory.get'
  | 'practices.write'
  | 'practices.edit'
  | 'practices.get'
  | 'practices.list'

// --- Transient-gap constants + retryable shape (§1.5) — single source of truth for both sides. ---

export const HUB_RECONNECT_INTERVAL_MS = 1_000 // hub WorkerClient reconnect cadence (matches the web WS)
export const HUB_RELAY_TIMEOUT_MS = 45_000 //     transient→terminal bound; covers a restart AND a rollback (§8.3)
export const RELAY_QUEUE_MAX = 1_000 //           worker relay-lane bound; overflow = terminal for that call (§8.1)

/** The ONE retryable shape a tool returns when a relay exceeds the transient bound — never a permanent
 *  "denied"/"disabled"/"gone" shape, which an agent reads as a broken system (§8.3). */
export const HUB_UNAVAILABLE_TEXT =
  'The hub is briefly unavailable (it is restarting). Nothing was lost — retry this tool call in a moment.'

export class HubUnavailableError extends Error {
  readonly retryable = true
  constructor(message = HUB_UNAVAILABLE_TEXT) {
    super(message)
    this.name = 'HubUnavailableError'
  }
}

// --- Pure correlation helpers ---

let reqCounter = 0
/** A fresh monotonic id for a hub→worker command. */
export function nextReqId(): string {
  reqCounter += 1
  return `r${reqCounter}`
}

/**
 * DETERMINISTIC approval id from (sessionId, kind, payload) so a re-issue after a hub restart collides
 * on the same id and the successor's idempotent approvals.request dedups it (§7.2, §8.2).
 */
export function stableApprovalId(sessionId: string, kind: string, payload: unknown): string {
  const h = crypto.createHash('sha1')
  h.update(sessionId)
  h.update('\0')
  h.update(kind)
  h.update('\0')
  h.update(safeStringify(payload))
  return `ap_${h.digest('hex').slice(0, 24)}`
}

/** Stable JSON for hashing — recursively sorts object keys so equal payloads hash equal regardless of
 *  key order. Uses CODE-UNIT ordering (not localeCompare) so the canonical form is identical across
 *  runtimes/locales/ICU versions — the whole point is cross-process determinism. */
function safeStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val
  )
}
