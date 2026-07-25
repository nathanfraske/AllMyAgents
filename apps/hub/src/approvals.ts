import crypto from 'node:crypto'
import type { Journal } from './journal.js'
import type { ApprovalRecord } from './types.js'

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

interface PendingEntry {
  record: ApprovalRecord
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
  // The Promise handed back to the original caller. Kept so a re-issue of the same still-pending id
  // returns the identical Promise instead of minting a duplicate (docs/agent-detachment-impl.md §2.5).
  promise: Promise<boolean>
}

export class ApprovalService {
  private readonly pendingMap = new Map<string, PendingEntry>()

  constructor(private readonly journal: Journal) {}

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
      const resolved = this.journal.resolvedApproval(id)
      if (resolved !== undefined) return Promise.resolve(resolved === 'approved')
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
