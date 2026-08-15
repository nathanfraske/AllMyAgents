import { describe, it, expect, vi, afterEach } from 'vitest'
import { Journal } from './journal.js'
import { ApprovalService, DEFAULT_APPROVAL_TIMEOUT_MS } from './approvals.js'
import type { HubEvent, ApprovalStatus } from './types.js'

// Track opened in-memory journals so their sqlite handles are released after each test.
const opened: Journal[] = []

// A fresh service over an in-memory journal, capturing every journaled event so tests can assert on
// exactly how many approval/requested + approval/resolved rows were written (the dedup guarantee).
function fresh() {
  const journal = new Journal(':memory:')
  opened.push(journal)
  const events: HubEvent[] = []
  journal.on('event', (e) => events.push(e))
  const approvals = new ApprovalService(journal)
  const count = (kind: string) => events.filter((e) => e.kind === kind).length
  const statusOf = (kind: string) =>
    (events.find((e) => e.kind === kind)?.payload as { status?: ApprovalStatus } | undefined)?.status
  return { approvals, journal, events, count, statusOf }
}

afterEach(() => {
  vi.useRealTimers()
  while (opened.length) opened.pop()!.db.close()
})

describe('ApprovalService — existing new-request paths (regression)', () => {
  it('new request → approve resolves true, auto-generates an id, journals requested + resolved(approved)', async () => {
    const { approvals, count, statusOf } = fresh()
    const p = approvals.request('s1', 'claude/tool', { toolName: 'bash' })
    expect(approvals.pending()).toHaveLength(1)
    const id = approvals.pending()[0]!.id
    expect(id).toBeTruthy() // generated when the caller supplies none (unchanged behavior)

    expect(approvals.resolve(id, true)).toBe(true)
    await expect(p).resolves.toBe(true)
    expect(approvals.pending()).toHaveLength(0)
    expect(count('approval/requested')).toBe(1)
    expect(count('approval/resolved')).toBe(1)
    expect(statusOf('approval/resolved')).toBe('approved')
  })

  it('new request → deny resolves false with status denied', async () => {
    const { approvals, statusOf } = fresh()
    const p = approvals.request('s1', 'claude/tool', {})
    approvals.resolve(approvals.pending()[0]!.id, false)
    await expect(p).resolves.toBe(false)
    expect(statusOf('approval/resolved')).toBe('denied')
  })

  it('fail-closed timeout resolves false with status timeout and clears the pending entry', async () => {
    vi.useFakeTimers()
    const { approvals, statusOf } = fresh()
    const p = approvals.request('s1', 'claude/tool', {})
    let outcome: boolean | undefined
    void p.then((v) => {
      outcome = v
    })
    expect(outcome).toBeUndefined() // still pending before the window elapses
    await vi.advanceTimersByTimeAsync(DEFAULT_APPROVAL_TIMEOUT_MS)
    expect(outcome).toBe(false) // fail-closed
    expect(approvals.pending()).toHaveLength(0)
    expect(statusOf('approval/resolved')).toBe('timeout')
  })

  it('uses an explicit timeout override without changing the safer one-hour default', async () => {
    vi.useFakeTimers()
    const journal = new Journal(':memory:')
    opened.push(journal)
    const approvals = new ApprovalService(journal, { timeoutMs: 2_000 })
    const pending = approvals.request('s1', 'claude/tool', {})
    await vi.advanceTimersByTimeAsync(1_999)
    expect(approvals.pending()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(false)
  })

  it('deterministically releases all affected pending requests after a policy widening', async () => {
    const { approvals, events } = fresh()
    let allowed = false
    approvals.setAutoApprove((sessionId, _kind, payload) =>
      allowed && sessionId === 'child' && (payload as { toolName?: string }).toolName === 'fileChange',
    )
    const first = approvals.request('child', 'codex/item/fileChange/requestApproval', { toolName: 'fileChange' })
    const second = approvals.request('child', 'codex/item/fileChange/requestApproval', { toolName: 'fileChange' })
    void approvals.request('other', 'codex/item/fileChange/requestApproval', { toolName: 'fileChange' })
    allowed = true
    expect(approvals.recheckPending({ sessionIds: ['child'], reason: 'manager-grant-change' })).toBe(2)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(approvals.pending().map((entry) => entry.sessionId)).toEqual(['other'])
    expect(events.filter((event) => event.kind === 'approval/re-evaluated')).toHaveLength(2)
  })
})

describe('ApprovalService — idempotent + re-issuable (agent detachment §2.5)', () => {
  // (a) Re-issuing the SAME id while it is still pending returns the same Promise and does not double-journal.
  it('re-issuing a still-pending id returns the identical Promise and journals requested only once', async () => {
    const { approvals, count } = fresh()
    const p1 = approvals.request('s1', 'claude/tool', { toolName: 'bash' }, 'stable-1')
    const p2 = approvals.request('s1', 'claude/tool', { toolName: 'bash' }, 'stable-1')

    expect(p2).toBe(p1) // the dedup path hands back the existing Promise
    expect(approvals.pending()).toHaveLength(1) // no duplicate pending entry
    expect(count('approval/requested')).toBe(1) // journaled exactly once despite two request() calls

    approvals.resolve('stable-1', true)
    await expect(p1).resolves.toBe(true)
    await expect(p2).resolves.toBe(true) // the single shared Promise settles both awaiters
    expect(count('approval/resolved')).toBe(1)
  })

  // The cross-restart re-attach path: a stable id that is NOT currently pending (the fresh hub's map is
  // empty) is re-created under that exact id and re-journaled — the operator then resolves the new hub.
  it('a supplied id that is not pending is re-created under that exact id (restart re-attach)', async () => {
    const { approvals, count } = fresh() // stands in for the freshly-restarted hub: empty pending map
    const p = approvals.request('s7', 'claude/tool', { toolName: 'bash' }, 'worker-stable-42')

    expect(approvals.pending().map((r) => r.id)).toEqual(['worker-stable-42']) // kept the caller's stable id
    expect(count('approval/requested')).toBe(1) // re-journaled on the new hub under the same id

    expect(approvals.resolve('worker-stable-42', true)).toBe(true) // operator resolves against the new hub
    await expect(p).resolves.toBe(true)
  })

  // (b) resolve is idempotent: a second resolve is a no-op and cannot re-settle / flip the Promise.
  it('resolve is idempotent: the second resolve is a no-op and cannot flip or re-settle the outcome', async () => {
    const { approvals, count } = fresh()
    const p = approvals.request('s1', 'claude/tool', {}, 'id-b')

    expect(approvals.resolve('id-b', true)).toBe(true) // first resolve settles it
    await expect(p).resolves.toBe(true)

    expect(approvals.resolve('id-b', false)).toBe(false) // second resolve (opposite decision) → no-op
    expect(approvals.pending()).toHaveLength(0)
    await expect(p).resolves.toBe(true) // outcome unchanged; the settled Promise was never re-settled
    expect(count('approval/resolved')).toBe(1) // journaled once, not twice
  })

  // (c) Resolving an unknown id is a safe no-op — never throws, journals nothing.
  it('resolving an unknown id is a safe no-op (returns false, no throw, nothing journaled)', () => {
    const { approvals, count } = fresh()
    expect(() => approvals.resolve('never-existed', true)).not.toThrow()
    expect(approvals.resolve('never-existed', false)).toBe(false)
    expect(count('approval/resolved')).toBe(0)
  })

  it('a timed-out id is then a no-op for a late operator resolve (idempotent across timeout)', async () => {
    vi.useFakeTimers()
    const { approvals, count } = fresh()
    const p = approvals.request('s1', 'claude/tool', {}, 'id-timeout')
    void p.then(() => {})
    await vi.advanceTimersByTimeAsync(DEFAULT_APPROVAL_TIMEOUT_MS)
    await expect(p).resolves.toBe(false)

    // A late operator click on an id the timeout already retired must not throw or re-journal.
    expect(approvals.resolve('id-timeout', true)).toBe(false)
    expect(count('approval/resolved')).toBe(1) // only the timeout's resolved event
  })
})

describe('ApprovalService — resolved-before-crash recovery across a hub restart (§7.2)', () => {
  // The scenario step 6 fixes: hub A resolves an approval (durably journaled), then crashes BEFORE the
  // worker's approvalResolved is delivered. On re-attach the worker re-issues the SAME stable id to the
  // SUCCESSOR hub, whose in-memory pending map is empty. The successor must honor the prior decision from the
  // journal — immediately, no re-prompt, no re-journal — so the operator's approve/deny/timeout is applied
  // EXACTLY ONCE and an already-decided approval is never re-offered. A fresh ApprovalService over the SAME
  // journal is a faithful stand-in for the restarted successor hub.

  it('an approved id re-issued after a restart resolves true immediately — no re-prompt, no re-journal', async () => {
    const { approvals, journal, count } = fresh()
    const payload = { scope: 'project:proj1', title: 't', body: 'b' }
    const p = approvals.request('s1', 'practice/write', payload, 'stable-approved')
    approvals.resolve('stable-approved', true) // hub A: the operator approves; durably journaled
    await expect(p).resolves.toBe(true)
    expect(count('approval/requested')).toBe(1)
    expect(count('approval/resolved')).toBe(1)

    // Hub A crashes; a SUCCESSOR ApprovalService over the SAME journal starts with an EMPTY pending map.
    const successor = new ApprovalService(journal)
    const recovered = successor.request('s1', 'practice/write', payload, 'stable-approved')
    await expect(recovered).resolves.toBe(true) // the operator's prior approve is recovered from the journal
    expect(successor.pending()).toHaveLength(0) // NOT re-offered to the operator (no phantom pending entry)
    expect(count('approval/requested')).toBe(1) // no second request row — recovery does not re-journal
    expect(count('approval/resolved')).toBe(1) //  nor a second resolved row
  })

  it('a denied id re-issued after a restart resolves false immediately (the decline is honored once)', async () => {
    const { approvals, journal, count } = fresh()
    const p = approvals.request('s1', 'claude/tool', { toolName: 'bash' }, 'stable-denied')
    approvals.resolve('stable-denied', false)
    await expect(p).resolves.toBe(false)

    const successor = new ApprovalService(journal)
    await expect(successor.request('s1', 'claude/tool', { toolName: 'bash' }, 'stable-denied')).resolves.toBe(false)
    expect(successor.pending()).toHaveLength(0)
    expect(count('approval/requested')).toBe(1) // the successor did not re-offer it
  })

  it('a timed-out id re-issued after a restart stays denied (a fail-closed timeout is a durable decision)', async () => {
    vi.useFakeTimers()
    const { approvals, journal } = fresh()
    const p = approvals.request('s1', 'claude/tool', {}, 'stable-timeout')
    void p.then(() => {})
    await vi.advanceTimersByTimeAsync(DEFAULT_APPROVAL_TIMEOUT_MS)
    await expect(p).resolves.toBe(false)

    const successor = new ApprovalService(journal)
    // A timed-out approval was decided (fail-closed) and journaled resolved(timeout) → not re-offered.
    await expect(successor.request('s1', 'claude/tool', {}, 'stable-timeout')).resolves.toBe(false)
    expect(successor.pending()).toHaveLength(0)
  })

  it('an id REQUESTED but never resolved is NOT recovered — the successor re-offers it (pending-across-restart)', async () => {
    const { approvals, journal, count } = fresh()
    approvals.request('s1', 'practice/write', { scope: 'project:proj1' }, 'stable-open') // pending, never resolved
    expect(count('approval/requested')).toBe(1)

    // A journaled REQUEST must not be mistaken for a RESOLUTION: the successor re-creates the pending entry
    // (the operator still has to decide) rather than returning a phantom value. This guards that recovery
    // keys strictly on `approval/resolved`, never on `approval/requested`.
    const successor = new ApprovalService(journal)
    const p = successor.request('s1', 'practice/write', { scope: 'project:proj1' }, 'stable-open')
    expect(successor.pending().map((r) => r.id)).toEqual(['stable-open']) // re-offered under the same id
    expect(count('approval/requested')).toBe(2) // one offer per hub (the dead hub's + the successor's)
    successor.resolve('stable-open', true) // the operator decides on the successor
    await expect(p).resolves.toBe(true)
  })

  it('recovery matches the LATEST decision for an id and never leaks across distinct ids', async () => {
    const { approvals, journal } = fresh()
    approvals.request('s1', 'claude/tool', {}, 'id-A')
    approvals.resolve('id-A', true) // A → approved
    approvals.request('s2', 'claude/tool', {}, 'id-B')
    approvals.resolve('id-B', false) // B → denied

    const successor = new ApprovalService(journal)
    await expect(successor.request('s1', 'claude/tool', {}, 'id-A')).resolves.toBe(true) //  distinct id, correct value
    await expect(successor.request('s2', 'claude/tool', {}, 'id-B')).resolves.toBe(false) // distinct id, correct value
    // A never-seen id has no durable decision → a genuine fresh request (re-prompts), proving no false match.
    successor.request('s3', 'claude/tool', {}, 'id-never')
    expect(successor.pending().map((r) => r.id)).toEqual(['id-never'])
  })
})

describe('ApprovalService durable decision audit and persistence', () => {
  it('returns explicit connector persistence and keeps the disposition queryable across restart', async () => {
    const { approvals, journal } = fresh()
    const pending = approvals.requestDetailed(
      'codex-session',
      'codex/mcpServer/elicitation/request',
      { toolName: 'update_pull_request' },
      'persisted-approval',
    )
    expect(approvals.resolve('persisted-approval', true, {
      decider: 'overseer:application',
      persist: 'session',
    })).toBe(true)
    await expect(pending).resolves.toEqual({ approved: true, status: 'approved', persist: 'session' })

    const successor = new ApprovalService(journal)
    expect(successor.recentResolved(['codex-session'])).toEqual([
      expect.objectContaining({
        id: 'persisted-approval',
        sessionId: 'codex-session',
        status: 'approved',
        decider: 'overseer:application',
        persist: 'session',
      }),
    ])
  })

  it('never records persistence on a denial', async () => {
    const { approvals } = fresh()
    const pending = approvals.requestDetailed('s1', 'codex/mcpServer/elicitation/request', {}, 'denied-persist')
    approvals.resolve('denied-persist', false, { decider: 'operator:api', persist: 'always' })
    await expect(pending).resolves.toEqual({ approved: false, status: 'denied' })
    const decisions = approvals.recentResolved(['s1'])
    expect(decisions).toEqual([
      expect.objectContaining({ id: 'denied-persist', status: 'denied', decider: 'operator:api' }),
    ])
    expect(decisions[0]).not.toHaveProperty('persist')
  })
})
