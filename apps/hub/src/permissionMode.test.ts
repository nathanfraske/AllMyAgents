import { describe, expect, it } from 'vitest'
import { AgentWorker } from './agentWorker.js'
import type { WorkerSessionSpec } from './workerProtocol.js'

/**
 * REGRESSION — "full access" sessions were still prompting the operator on every tool.
 *
 * The permission callback is the thing that decides prompt-vs-run, and both executors used to assume the
 * vendor SDK suppressed that callback entirely under `full` (bypassPermissions). The comments said so
 * outright: "under `full` ... the SDK skips this callback entirely, so tools run freely there". It does
 * not — the SDK documents canUseTool as "called before each tool execution", and an explicitly-supplied
 * handler is consulted regardless of permissionMode.
 *
 * So with `full` selected, every non-auto-allowed tool still relayed to the hub and raised an operator
 * approval. Worse, that prompt fails CLOSED: ApprovalService.request has no auto-approve path at all, and
 * an unanswered request resolves false after APPROVAL_TIMEOUT_MS, killing the tool call with
 * "denied from hub". Full access behaved like safe mode with extra steps.
 *
 * The assertion that matters is NOT that the tool is allowed — it is that NO approval is raised at all.
 * A test that only checked `behavior === 'allow'` would pass even if we prompted the operator and they
 * happened to say yes, which is precisely the bug.
 */

interface WorkerCanUseToolInternals {
  canUseTool(
    spec: WorkerSessionSpec,
    toolName: string,
    input: unknown
  ): Promise<{ behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }>
  relayApproval(sessionId: string, kind: string, payload: unknown): Promise<boolean>
}

/** An AgentWorker with no listener bound (never started), with the approval relay swapped for a counter. */
function makeGate(): { worker: WorkerCanUseToolInternals; relayed: () => number } {
  const w = new AgentWorker('\\\\.\\pipe\\ama-perm-never-bound') as unknown as WorkerCanUseToolInternals
  let count = 0
  w.relayApproval = async () => {
    count++
    return true // approve, so a failure shows up as "prompted" rather than as "denied"
  }
  return { worker: w, relayed: () => count }
}

const specWith = (permissionMode: 'safe' | 'edits' | 'full'): WorkerSessionSpec =>
  ({
    sessionId: 's1',
    provider: 'claude',
    profileId: 'p',
    profileDir: '/tmp/p',
    cwd: '/tmp',
    permissionMode,
  }) as unknown as WorkerSessionSpec

describe('AgentWorker.canUseTool — the hub owns the decision, in every mode', () => {
  /**
   * The worker must NOT decide `full` locally. Doing so stopped the spurious prompts but created a second
   * permission authority with no audit trail, no bus-origin clamp, no eligible-kind whitelist, and a mode
   * frozen at turn start — so tightening a live chat Full → Safe would have changed the pill and nothing
   * else. Relaying always is what makes the hub's policy the single, live, audited authority.
   *
   * "No prompt in full access" is still true; it is now the HUB's answer (ApprovalService's auto-approve
   * policy returns immediately) rather than a decision the worker made on its own.
   */
  it('relays even in full access, so the hub can audit and apply its policy', async () => {
    const { worker, relayed } = makeGate()
    const res = await worker.canUseTool(specWith('full'), 'Bash', { command: 'ls' })
    expect(res.behavior).toBe('allow')
    expect(relayed()).toBe(1)
  })

  it('relays in safe mode', async () => {
    const { worker, relayed } = makeGate()
    const res = await worker.canUseTool(specWith('safe'), 'Bash', { command: 'ls' })
    expect(res.behavior).toBe('allow') // our stub approved it
    expect(relayed()).toBe(1)
  })

  it('relays in edits mode for a non-edit tool', async () => {
    const { worker, relayed } = makeGate()
    await worker.canUseTool(specWith('edits'), 'Bash', { command: 'ls' })
    expect(relayed()).toBe(1)
  })

  /** A denial from the hub is honoured whatever the chat's mode says — the hub is the authority. */
  it('denies when the hub denies, even on a full-access chat', async () => {
    const { worker } = makeGate()
    ;(worker as unknown as { relayApproval: () => Promise<boolean> }).relayApproval = async () => false
    const res = await worker.canUseTool(specWith('full'), 'Bash', { command: 'ls' })
    expect(res.behavior).toBe('deny')
  })
})
