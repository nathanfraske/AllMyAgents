import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApprovalService } from './approvals.js'
import { Journal } from './journal.js'

/**
 * REGRESSION — ApprovalService had NO auto-approve path, so "full access" could not actually mean
 * "don't ask me".
 *
 * Every request journaled `approval/requested` and blocked on the operator, and an unanswered one failed
 * CLOSED after APPROVAL_TIMEOUT_MS (10 minutes). Permission mode was enforced out in each executor's
 * canUseTool instead — unreliably, since that relied on the vendor SDK skipping the callback under
 * bypassPermissions, which it does not do. Result: full-access chats prompted on every tool, and a prompt
 * the operator missed silently killed the tool call.
 *
 * The decision now lives here, at the one chokepoint BOTH the worker relay and the in-process gate funnel
 * through (`resolveApproval` → `approvals.request(sessionId, kind, payload, approvalId)`), which also
 * means a mode/allowlist change applies to the next tool call with no worker respawn.
 *
 * The assertions that matter are about the PROMPT, not the return value: an auto-approved call must never
 * become pending and must never journal `approval/requested`. Asserting only `=== true` would pass even if
 * we had queued a prompt the operator then had to answer, which is exactly the bug.
 */

const dirs: string[] = []
const opened: Journal[] = []
afterEach(() => {
  for (const j of opened.splice(0)) j.db.close()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function makeService(): { approvals: ApprovalService; journal: Journal } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-approval-policy-'))
  dirs.push(dir)
  const journal = new Journal(path.join(dir, 'hub.db'))
  opened.push(journal)
  return { approvals: new ApprovalService(journal), journal }
}

/** Every event kind journaled for a session. `replay` is a global generator keyed on seq, not per-session. */
const kinds = (journal: Journal, sessionId: string): string[] =>
  [...journal.replay(0)].filter((e) => e.sessionId === sessionId).map((e) => e.kind)

describe('ApprovalService — auto-approve policy', () => {
  it('resolves immediately WITHOUT prompting when the policy approves', async () => {
    const { approvals, journal } = makeService()
    approvals.setAutoApprove(() => true)

    await expect(approvals.request('s1', 'claude/tool', { toolName: 'Bash' })).resolves.toBe(true)
    expect(approvals.pending()).toHaveLength(0) // never queued for the operator
    expect(kinds(journal, 's1')).not.toContain('approval/requested')
  })

  it('still journals the auto-approval, so privileged tools are never silent', async () => {
    const { approvals, journal } = makeService()
    approvals.setAutoApprove(() => true)

    await approvals.request('s1', 'claude/tool', { toolName: 'Bash' })
    expect(kinds(journal, 's1')).toContain('approval/auto-approved')
  })

  it('prompts as before when the policy declines to auto-approve', () => {
    const { approvals, journal } = makeService()
    approvals.setAutoApprove(() => false)

    void approvals.request('s1', 'claude/tool', { toolName: 'Bash' })
    expect(approvals.pending()).toHaveLength(1) // the gate is not simply disabled
    expect(kinds(journal, 's1')).toContain('approval/requested')
    approvals.resolve(approvals.pending()[0]!.id, false)
  })

  it('prompts when no policy is installed at all (unchanged default)', () => {
    const { approvals } = makeService()
    void approvals.request('s1', 'claude/tool', { toolName: 'Bash' })
    expect(approvals.pending()).toHaveLength(1)
    approvals.resolve(approvals.pending()[0]!.id, false)
  })

  it('passes sessionId/kind/payload through, so a policy can be per-chat and per-tool', async () => {
    const { approvals } = makeService()
    const seen: Array<{ sessionId: string; kind: string; payload: unknown }> = []
    approvals.setAutoApprove((sessionId, kind, payload) => {
      seen.push({ sessionId, kind, payload })
      return (payload as { toolName?: string }).toolName === 'Read'
    })

    await expect(approvals.request('s1', 'claude/tool', { toolName: 'Read' })).resolves.toBe(true)
    void approvals.request('s2', 'claude/tool', { toolName: 'Bash' })
    expect(approvals.pending()).toHaveLength(1) // Bash still prompts
    expect(seen).toEqual([
      { sessionId: 's1', kind: 'claude/tool', payload: { toolName: 'Read' } },
      { sessionId: 's2', kind: 'claude/tool', payload: { toolName: 'Bash' } },
    ])
    approvals.resolve(approvals.pending()[0]!.id, false)
  })

  /**
   * SECURITY — the policy must be a positive whitelist of ordinary execution permissions, never
   * "full ⇒ every kind". These assertions encode the shape; SessionManager.isAutoApproved implements it
   * and is covered by sessions-level tests. Kept here so the contract is stated where the gate lives.
   */
  it('an unrecognised approval kind is never auto-approved by a permissive policy shape', () => {
    const { approvals } = makeService()
    // A policy that only says yes to ordinary tool execution, as SessionManager's does.
    approvals.setAutoApprove((_s, kind) => kind === 'claude/tool')

    void approvals.request('s1', 'practice/write', { scope: 'project:p' })
    expect(approvals.pending()).toHaveLength(1) // a self-gated kind still reaches the operator
    approvals.resolve(approvals.pending()[0]!.id, false)
  })

  /**
   * Ordering guard: the resolved-before-crash recovery (§7.2) must still win over the policy. A worker
   * re-issuing a stable id after a hub restart has to get the operator's ORIGINAL decision — including a
   * DENIAL — rather than being silently re-decided by a policy that has since become permissive.
   */
  it('honours an already-recorded decision ahead of the policy on a re-issued id', async () => {
    const { approvals, journal } = makeService()
    void approvals.request('s1', 'claude/tool', { toolName: 'Bash' }, 'stable-id')
    approvals.resolve('stable-id', false) // the operator said NO

    const fresh = new ApprovalService(journal) // successor hub: in-memory map is empty, journal is durable
    fresh.setAutoApprove(() => true)
    await expect(fresh.request('s1', 'claude/tool', { toolName: 'Bash' }, 'stable-id')).resolves.toBe(false)
  })

  /**
   * SECURITY — a recovered decision must be applied ONCE, not become a standing grant.
   *
   * The worker derives the approval id from the payload (stableApprovalId(sessionId, kind, payload)), so
   * byte-identical invocations collide. While the durable-decision lookup was unbounded, the recovery
   * meant for "the worker is re-issuing the request that was in flight when the hub died" silently
   * answered every later identical call too: "Approve once" became approve-this-payload-forever, and
   * because the lookup runs BEFORE any policy, the grant was reusable across trust origins — a teammate's
   * bus turn emitting bytes the operator had once approved would execute unprompted.
   */
  it('applies a recovered decision only once, so approve-once cannot become a standing grant', async () => {
    const { approvals, journal } = makeService()
    void approvals.request('s1', 'claude/tool', { toolName: 'Bash' }, 'same-payload-id')
    approvals.resolve('same-payload-id', true) // the operator approved this exact payload, once

    const fresh = new ApprovalService(journal)
    // First re-issue is the legitimate post-restart recovery: it inherits the decision without prompting.
    await expect(fresh.request('s1', 'claude/tool', { toolName: 'Bash' }, 'same-payload-id')).resolves.toBe(true)
    expect(fresh.pending()).toHaveLength(0)

    // A LATER invocation with the same content is a new call, not a re-issue: it must be asked about.
    void fresh.request('s1', 'claude/tool', { toolName: 'Bash' }, 'same-payload-id')
    expect(fresh.pending()).toHaveLength(1)
    fresh.resolve(fresh.pending()[0]!.id, false)
  })
})
