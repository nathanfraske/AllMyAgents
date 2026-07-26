import crypto from 'node:crypto'
import type { Journal } from './journal.js'
import type { ApprovalRecord } from './types.js'

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

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

export class ApprovalService {
  private readonly pendingMap = new Map<string, PendingEntry>()
  private autoApprove: AutoApprovePolicy | undefined
  /** When this hub process started, bounding the resolved-before-crash recovery (see {@link request}). */
  private readonly bootAt = Date.now()
  /** Ids already served from a durable decision, so one recovery never becomes a standing grant. */
  private readonly recoveredIds = new Set<string>()

  constructor(private readonly journal: Journal) {}

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

  pending(): ApprovalRecord[] {
    return [...this.pendingMap.values()].map((e) => e.record)
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
      this.journal.append(sessionId, 'approval/auto-approved', { id: id ?? null, kind, payload })
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
      this.finish(record.id, false, 'timeout')
    }, APPROVAL_TIMEOUT_MS)
    this.pendingMap.set(record.id, { record, resolve, timer, promise })
    return promise
  }

  /**
   * Resolve a pending approval. IDEMPOTENT: resolving an id that is unknown or already resolved
   * (including one that already timed out) is a safe no-op that returns `false` — it never throws
   * and never double-settles the already-settled Promise. Returns `true` only when this call is the
   * one that actually settled a pending entry. (Kept as a boolean so the `/api/approvals/:id` route's
   * `found ? 200 : 404` contract is preserved.)
   */
  resolve(id: string, approved: boolean): boolean {
    return this.finish(id, approved, approved ? 'approved' : 'denied')
  }

  private finish(id: string, approved: boolean, status: ApprovalRecord['status']): boolean {
    const entry = this.pendingMap.get(id)
    if (!entry) return false // idempotent no-op: unknown or already-resolved/timed-out id
    this.pendingMap.delete(id)
    clearTimeout(entry.timer)
    entry.record.status = status
    this.journal.append(entry.record.sessionId, 'approval/resolved', {
      id: entry.record.id,
      status,
      kind: entry.record.kind,
    })
    entry.resolve(approved)
    return true
  }
}
