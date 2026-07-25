import { describe, it, expect, vi, afterEach } from 'vitest'
import { Journal } from './journal.js'
import { ApprovalService } from './approvals.js'
import type { HubEvent, ApprovalStatus } from './types.js'

// The fail-closed window (mirrors APPROVAL_TIMEOUT_MS in approvals.ts — not exported, kept in sync here).
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

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
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS)
    expect(outcome).toBe(false) // fail-closed
    expect(approvals.pending()).toHaveLength(0)
    expect(statusOf('approval/resolved')).toBe('timeout')
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
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS)
    await expect(p).resolves.toBe(false)

    // A late operator click on an id the timeout already retired must not throw or re-journal.
    expect(approvals.resolve('id-timeout', true)).toBe(false)
    expect(count('approval/resolved')).toBe(1) // only the timeout's resolved event
  })
})
