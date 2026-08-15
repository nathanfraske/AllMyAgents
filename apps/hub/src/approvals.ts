import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Journal } from './journal.js'
import type {
  ApprovalDecisionRecord,
  ApprovalPersistence,
  ApprovalRecord,
} from './types.js'

/** A human-facing approval should survive an ordinary meeting, break, or unattended build. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000

/**
 * How long after hub startup a durable approval decision may still be applied to a re-issued id.
 *
 * A successor hub re-attaches to the surviving worker within seconds, and the worker re-flushes its
 * outstanding relays immediately, so the legitimate recovery window is short. Beyond it, a request
 * carrying an already-decided (content-derived) id is treated as a genuinely new invocation and asked
 * about again. Generous relative to re-attach, tiny relative to "forever", which is what it replaced.
 */
const RESOLVED_RECOVERY_WINDOW_MS = 2 * 60 * 1000

interface PendingEntry {
  record: ApprovalRecord
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
  // The Promise handed back to the original caller. Kept so a re-issue of the same still-pending id
  // returns the identical Promise instead of minting a duplicate (docs/agent-detachment-impl.md §2.5).
  promise: Promise<boolean>
}

/** Decides whether a request may skip the operator entirely. `true` → auto-approve; anything else → ask. */
export type AutoApprovePolicy = (sessionId: string, kind: string, payload: unknown) => boolean

export interface ApprovalServiceOptions {
  timeoutMs?: number
}

export interface ApprovalDecision {
  approved: boolean
  status: Extract<ApprovalRecord['status'], 'approved' | 'denied' | 'timeout'>
  persist?: ApprovalPersistence
}

export interface ApprovalResolutionOptions {
  decider?: string
  persist?: ApprovalPersistence
}

/** Connector bodies can be very large; the policy-specific event carries their bounded digest summary. */
function boundedAutoApprovalAuditPayload(kind: string, payload: unknown): unknown {
  if (kind !== 'codex/mcpServer/elicitation/request') return payload
  const p = payload as {
    serverName?: unknown
    mode?: unknown
    toolName?: unknown
    _meta?: {
      source?: unknown
      connector_name?: unknown
      codex_approval_kind?: unknown
      tool_title?: unknown
    }
  } | null
  if (p?.serverName !== 'codex_apps' || p._meta?.source !== 'connector') return payload
  return {
    serverName: p.serverName,
    mode: p.mode,
    toolName: p.toolName,
    _meta: {
      source: p._meta.source,
      connector_name: p._meta.connector_name,
      codex_approval_kind: p._meta.codex_approval_kind,
      tool_title: p._meta.tool_title,
      tool_params: '[recorded as bounded github-automation/auto-approved parameterSummary]',
    },
  }
}

export class ApprovalService {
  private readonly pendingMap = new Map<string, PendingEntry>()
  private autoApprove: AutoApprovePolicy | undefined
  private pendingListener: ((record: ApprovalRecord) => void) | undefined
  private resolvedListener: ((record: ApprovalRecord) => void) | undefined
  /** When this hub process started, bounding the resolved-before-crash recovery (see {@link request}). */
  private readonly bootAt = Date.now()
  /** Ids already served from a durable decision, so one recovery never becomes a standing grant. */
  private readonly recoveredIds = new Set<string>()
  private readonly timeoutMs: number
  private readonly insertDecisionStmt: Database.Statement
  private readonly latestDecisionStmt: Database.Statement

  constructor(private readonly journal: Journal, options: ApprovalServiceOptions = {}) {
    const requested = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.timeoutMs = Number.isFinite(requested) && requested >= 1_000
      ? Math.floor(requested)
      : DEFAULT_APPROVAL_TIMEOUT_MS
    journal.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_decisions (
        decision_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        approval_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('approved', 'denied', 'timeout')),
        created_at TEXT NOT NULL,
        resolved_at TEXT NOT NULL,
        decider TEXT NOT NULL,
        persist TEXT CHECK (persist IS NULL OR persist IN ('session', 'always'))
      );
      CREATE INDEX IF NOT EXISTS idx_approval_decisions_session_recent
        ON approval_decisions(session_id, decision_seq DESC);
      CREATE INDEX IF NOT EXISTS idx_approval_decisions_id_recent
        ON approval_decisions(approval_id, decision_seq DESC);
    `)
    this.insertDecisionStmt = journal.db.prepare(`
      INSERT INTO approval_decisions
        (approval_id, session_id, kind, status, created_at, resolved_at, decider, persist)
      VALUES
        (@id, @sessionId, @kind, @status, @createdAt, @resolvedAt, @decider, @persist)
    `)
    this.latestDecisionStmt = journal.db.prepare(`
      SELECT persist FROM approval_decisions
      WHERE approval_id = ?
      ORDER BY decision_seq DESC
      LIMIT 1
    `)
  }

  /**
   * Install the policy that lets a request bypass the operator prompt (see {@link request}).
   *
   * This class had NO auto-approve path at all: every request journaled `approval/requested` and blocked
   * until the operator answered or the 10-minute timeout failed it CLOSED. That meant "full access" chats
   * still prompted on every tool — the permission mode was enforced (unreliably) out in each executor's
   * canUseTool rather than here, at the one place both executors actually funnel through.
   *
   * Set from index.ts once the SessionManager exists (it owns the records the policy reads). Because the
   * decision is made HERE, in the hub, a mode or allowlist change takes effect on the very next tool call
   * without respawning the long-lived agent worker.
   */
  setAutoApprove(policy: AutoApprovePolicy): void {
    this.autoApprove = policy
  }

  setPendingListener(listener: (record: ApprovalRecord) => void): void {
    this.pendingListener = listener
  }

  setResolvedListener(listener: (record: ApprovalRecord) => void): void {
    this.resolvedListener = listener
  }

  pending(): ApprovalRecord[] {
    return [...this.pendingMap.values()].map((e) => e.record)
  }

  /**
   * Re-run the live auto-approval policy after an operator changes a grant or automation policy.
   * This is deliberately explicit instead of a polling loop: every affected pending request is evaluated
   * exactly once against the new policy and receives a durable audit row before it is released.
   */
  recheckPending(options: { sessionIds?: Iterable<string>; reason: string }): number {
    if (!this.autoApprove) return 0
    const allowedSessions = options.sessionIds ? new Set(options.sessionIds) : undefined
    let released = 0
    for (const entry of [...this.pendingMap.values()]) {
      if (allowedSessions && !allowedSessions.has(entry.record.sessionId)) continue
      if (this.autoApprove(entry.record.sessionId, entry.record.kind, entry.record.payload) !== true) continue
      this.journal.append(entry.record.sessionId, 'approval/re-evaluated', {
        id: entry.record.id,
        kind: entry.record.kind,
        reason: options.reason,
        decision: 'approved',
      })
      if (this.finish(entry.record.id, true, 'approved', { decider: `policy:${options.reason}` })) released += 1
    }
    return released
  }

  /**
   * Request operator approval. Resolves `true` (approved), `false` (denied), or `false` (fail-closed
   * once the {@link APPROVAL_TIMEOUT_MS} window elapses).
   *
   * `id` is OPTIONAL and last, so every existing caller (which passes none) is unchanged. When omitted
   * an id is generated as before. A caller that must survive a hub restart — a detached agent worker,
   * docs/agent-detachment-impl.md §2.5, docs/agent-worker-impl.md §7.2 — supplies a STABLE id so it can
   * RE-ISSUE the same request. The three re-issue outcomes are all honored exactly once:
   * - id already pending on THIS hub  → dedup no-op: returns the existing pending Promise, creates no
   *   second entry and journals no second `approval/requested`.
   * - id already RESOLVED before a crash (in-memory map gone, but the decision is durable in the journal)
   *   → returns that decision immediately: no re-prompt, no re-journal. This is the resolved-before-crash
   *   recovery (§7.2) — the worker re-issues on re-attach and the operator's prior approve/deny/timeout is
   *   applied EXACTLY ONCE instead of the successor hub re-offering an already-decided approval.
   * - id not pending and not resolved (a freshly restarted hub whose operator never decided) → treated as a
   *   fresh request under that exact id and journaled, which is precisely the pending-across-restart path.
   */
  request(sessionId: string, kind: string, payload: unknown, id?: string): Promise<boolean> {
    if (id !== undefined) {
      const existing = this.pendingMap.get(id)
      if (existing) return existing.promise // re-issue/dedup: same Promise, no duplicate entry, no re-journal
      // Resolved-before-crash recovery (§7.2): this hub's in-memory map is empty (a restart), but the
      // operator's decision may be durable in the journal. Honor it immediately — do NOT re-prompt or
      // re-journal. In-process callers never supply an id, so this is worker-mode only (flag-off unchanged).
      //
      // BOUNDED, because the id is CONTENT-DERIVED. The worker builds it as
      // stableApprovalId(sessionId, kind, payload), so two invocations with byte-identical payloads share
      // an id — there is no per-invocation identity to distinguish "the worker is re-issuing the request
      // that was in flight when the hub died" from "the same command is being run a second time". While
      // this lookup was unbounded, the first meaning silently granted the second: "Approve once" became
      // "approve this exact payload forever in this chat", a denial became permanent for exact retries,
      // and — worst of all — the decision was reusable ACROSS TRUST ORIGINS, since it is consulted before
      // any policy runs. A teammate's bus turn producing bytes the operator had once approved would
      // execute with no prompt and no provenance check.
      //
      // The recovery only ever needed to cover re-issues that arrive as a successor hub re-attaches, which
      // happens seconds after boot. Restricting it to a window after startup, and to once per id, keeps
      // that guarantee while making an ordinary later invocation a fresh request that is asked about
      // again. This is a containment measure, not the cure: the real fix is per-invocation identity at the
      // source (the SDK supplies toolUseID/requestId), after which this can key on a true request id.
      if (!this.recoveredIds.has(id) && Date.now() - this.bootAt <= RESOLVED_RECOVERY_WINDOW_MS) {
        const resolved = this.journal.resolvedApproval(id)
        if (resolved !== undefined) {
          this.recoveredIds.add(id)
          return Promise.resolve(resolved === 'approved')
        }
      }
    }
    // Auto-approval (full access, or a tool the operator chose "always allow" for in this chat). Checked
    // AFTER the dedup/resolved-before-crash lookups above so a re-issued id still returns its recorded
    // decision, and BEFORE any prompt is journaled — an auto-approved call must never appear as pending,
    // never start the timeout timer, and never reach the operator's approval queue.
    //
    // Still journaled, as `approval/auto-approved` rather than `approval/requested`: silently running
    // privileged tools with no audit trail would be strictly worse than prompting. The operator can see
    // everything that ran on their behalf without having been asked.
    if (this.autoApprove?.(sessionId, kind, payload) === true) {
      const decisionId = id ?? crypto.randomUUID()
      const decidedAt = new Date().toISOString()
      this.journal.atomic(() => {
        this.journal.append(sessionId, 'approval/auto-approved', {
          id: decisionId,
          kind,
          payload: boundedAutoApprovalAuditPayload(kind, payload),
        })
        this.insertDecisionStmt.run({
          id: decisionId,
          sessionId,
          kind,
          status: 'approved',
          createdAt: decidedAt,
          resolvedAt: decidedAt,
          decider: 'policy:auto-approve',
          persist: null,
        })
      })
      return Promise.resolve(true)
    }
    const record: ApprovalRecord = {
      id: id ?? crypto.randomUUID(),
      sessionId,
      kind,
      payload,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    this.journal.append(sessionId, 'approval/requested', record)
    let resolve!: (approved: boolean) => void
    const promise = new Promise<boolean>((res) => {
      resolve = res
    })
    const timer = setTimeout(() => {
      this.finish(record.id, false, 'timeout', { decider: 'system:timeout' })
    }, this.timeoutMs)
    this.pendingMap.set(record.id, { record, resolve, timer, promise })
    try {
      this.pendingListener?.(record)
    } catch (error) {
      this.journal.append(record.sessionId, 'approval/pending-listener-error', {
        id: record.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return promise
  }

  /** The same request with a terminal reason, for callers that must distinguish expiry from denial. */
  async requestDetailed(sessionId: string, kind: string, payload: unknown, id?: string): Promise<ApprovalDecision> {
    const decisionId = id ?? crypto.randomUUID()
    const approved = await this.request(sessionId, kind, payload, decisionId)
    const row = this.latestDecisionStmt.get(decisionId) as { persist?: ApprovalPersistence | null } | undefined
    if (approved) {
      return {
        approved: true,
        status: 'approved',
        ...(row?.persist ? { persist: row.persist } : {}),
      }
    }
    const status = this.journal.resolvedApproval(decisionId)
    return { approved: false, status: status === 'timeout' ? 'timeout' : 'denied' }
  }

  /** Recent durable dispositions remain queryable after they leave the pending queue and across restarts. */
  recentResolved(sessionIds?: readonly string[], limit = 50): ApprovalDecisionRecord[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 200))
    if (sessionIds && sessionIds.length === 0) return []
    const where = sessionIds
      ? `WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})`
      : ''
    const rows = this.journal.db.prepare(`
      SELECT
        decision_seq AS decisionSeq,
        approval_id AS id,
        session_id AS sessionId,
        kind,
        status,
        created_at AS createdAt,
        resolved_at AS resolvedAt,
        decider,
        persist
      FROM approval_decisions
      ${where}
      ORDER BY decision_seq DESC
      LIMIT ?
    `).all(...(sessionIds ?? []), bounded) as Array<ApprovalDecisionRecord & { persist: ApprovalPersistence | null }>
    return rows.map((row) => {
      const { persist, ...rest } = row
      return { ...rest, ...(persist ? { persist } : {}) }
    })
  }

  /**
   * Resolve a pending approval. IDEMPOTENT: resolving an id that is unknown or already resolved
   * (including one that already timed out) is a safe no-op that returns `false` — it never throws
   * and never double-settles the already-settled Promise. Returns `true` only when this call is the
   * one that actually settled a pending entry. (Kept as a boolean so the `/api/approvals/:id` route's
   * `found ? 200 : 404` contract is preserved.)
   */
  resolve(id: string, approved: boolean, options: ApprovalResolutionOptions = {}): boolean {
    return this.finish(id, approved, approved ? 'approved' : 'denied', options)
  }

  private finish(
    id: string,
    approved: boolean,
    status: ApprovalRecord['status'],
    options: ApprovalResolutionOptions = {},
  ): boolean {
    const entry = this.pendingMap.get(id)
    if (!entry) return false // idempotent no-op: unknown or already-resolved/timed-out id
    const terminalStatus = status === 'approved' || status === 'denied' || status === 'timeout'
      ? status
      : approved ? 'approved' : 'denied'
    const resolvedAt = new Date().toISOString()
    const decider = options.decider?.trim() || 'operator:unspecified'
    const persist = approved ? options.persist : undefined
    this.journal.atomic(() => {
      this.journal.append(entry.record.sessionId, 'approval/resolved', {
        id: entry.record.id,
        status: terminalStatus,
        kind: entry.record.kind,
        createdAt: entry.record.createdAt,
        resolvedAt,
        decider,
        persist: persist ?? null,
      })
      this.insertDecisionStmt.run({
        id: entry.record.id,
        sessionId: entry.record.sessionId,
        kind: entry.record.kind,
        status: terminalStatus,
        createdAt: entry.record.createdAt,
        resolvedAt,
        decider,
        persist: persist ?? null,
      })
    })
    this.pendingMap.delete(id)
    clearTimeout(entry.timer)
    entry.record.status = terminalStatus
    entry.record.resolvedAt = resolvedAt
    entry.record.decider = decider
    if (persist) entry.record.persist = persist
    entry.resolve(approved)
    try {
      this.resolvedListener?.(entry.record)
    } catch (error) {
      this.journal.append(entry.record.sessionId, 'approval/resolved-listener-error', {
        id: entry.record.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return true
  }
}
