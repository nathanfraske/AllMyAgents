import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { AgentWorker, wrapRetryableHubErrors } from './agentWorker.js'
import { WorkerClient } from './workerTransport.js'
import { WorkerExecutor, type WorkerExecutorHubCallbacks } from './workerExecutor.js'
import { ApprovalService } from './approvals.js'
import { Journal } from './journal.js'
import { PracticeStore } from './practices.js'
import { buildAgentMcpServer, type AgentServices } from './agentTools.js'
import type { SessionIdentity } from './identity.js'
import type { DangerFlags } from './types.js'
import type { RelayMethod } from './workerProtocol.js'

// STEP 6 (docs/agent-worker-impl.md §7.2): approval reconciliation across a hub restart. This is the full
// end-to-end proof over a REAL worker socket: a practice_write handler runs in the worker, blocks on an
// operator approval that is IN FLIGHT when the hub "crashes", and — after a fresh hub re-attaches — resolves
// on the SUCCESSOR and completes EXACTLY ONCE (the practice is written a single time, never double-executed).
// It exercises the true production wiring: the worker's relay-backed AgentServices + wrapRetryableHubErrors,
// the transport's relay-lane re-flush on re-attach, the real WorkerExecutor dispatch, and the idempotent
// approvals.request(...,id).

const IDENTITY: SessionIdentity = { sessionId: 's1', profileId: 'p1', provider: 'claude', projectId: 'proj1', label: 'demo' }
const SAFE: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: false, autoApproveRestart: false }

/** Invoke a built MCP tool handler exactly as the SDK dispatch does — `tool.handler(args, extra)` off the
 *  instance's registered-tool table (mirrors agentWorker.test.ts). Returns the WRAPPED handler. */
function handlerOf(mcp: ReturnType<typeof buildAgentMcpServer>, name: string): (args: unknown, extra: unknown) => Promise<unknown> {
  const table = (mcp as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } }).instance._registeredTools
  return table[name]!.handler
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Resolve once `emitter` emits `event` (one-shot, argument-agnostic). */
function once(emitter: EventEmitter, event: string): Promise<void> {
  return new Promise((r) => emitter.once(event, () => r()))
}

/** A platform-appropriate unique socket path (Windows named pipe / unix domain socket under a tmp dir). */
function uniqueSocket(tmp: string): string {
  const rand = Math.random().toString(36).slice(2)
  return process.platform === 'win32' ? `\\\\.\\pipe\\ama-step6-${rand}` : path.join(tmp, `w-${rand}.sock`)
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

describe('approval reconciliation across a hub restart (§7.2) — end-to-end over a real worker socket', () => {
  it('a practice_write approval PENDING across a restart is re-flushed to the successor and completes EXACTLY ONCE', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-step6-'))
    const socketPath = uniqueSocket(tmp)
    const journal = new Journal(path.join(tmp, 'hub.db'))
    const practices = new PracticeStore(journal.db)
    cleanups.push(() => {
      journal.db.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    // WORKER: bind the real listener, then build the practice_write MCP handler exactly as the worker's driver
    // does — buildAgentMcpServer over the worker's OWN relay-backed AgentServices + the retryable-error wrap.
    // Calling it drives real relays over the real socket to whichever hub is currently attached.
    const worker = new AgentWorker(socketPath)
    await worker.start()
    cleanups.push(() => worker.stop())
    const workerServices = (worker as unknown as { workerServices: AgentServices }).workerServices
    const mcp = buildAgentMcpServer(IDENTITY, workerServices)
    wrapRetryableHubErrors(mcp)
    const practiceWrite = handlerOf(mcp, 'practice_write')

    // The hub-side relay dispatch shared by both eras: an rpc(practices.write) → the real PracticeStore (the
    // same call SessionManager.runRelay makes). The approval dispatch differs per era (fresh ApprovalService).
    const runRelay = (method: RelayMethod, args: unknown): unknown => {
      if (method === 'practices.write') return practices.write(args as Parameters<PracticeStore['write']>[0])
      throw new Error(`unexpected relay in this test: ${method}`)
    }
    const baseCallbacks: Omit<WorkerExecutorHubCallbacks, 'resolveApproval'> = {
      ingestWorkerEvent: () => {},
      applyLifecycle: () => {},
      recall: (_sessionId, prompt) => prompt,
      requestRestart: () => {},
      runRelay,
      resolveQuestion: async () => ({ kind: 'cancelled' }),
      abortQuestion: () => false,
      attachWorker: async () => {},
    }

    // --- Hub A: it never resolves the approval; it will "crash" with the request still pending. ---
    const approvalsA = new ApprovalService(journal)
    const reachedA = deferred()
    const clientA = new WorkerClient(socketPath, { attachEpoch: 1, danger: () => SAFE })
    // resolveApproval mirrors index.ts exactly: approvals.request(sessionId, kind, payload, approvalId).
    new WorkerExecutor(clientA, {
      ...baseCallbacks,
      resolveApproval: (approvalId, sessionId, kind, payload) => {
        reachedA.resolve()
        return approvalsA.request(sessionId, kind, payload, approvalId)
      },
    })
    await once(clientA, 'attached')

    // Kick the handler. scope 'project' with safe danger → decidePracticeGate returns 'approve', so the handler
    // BLOCKS on services.requireApproval → the worker relays an approvalRequest to hub A.
    const resultPromise = practiceWrite({ scope: 'project', title: 'Test convention', body: 'always run pnpm test before pushing' }, {}) as Promise<{ content: { type: 'text'; text: string }[] }>
    await reachedA.promise
    expect(approvalsA.pending()).toHaveLength(1) // the approval is PENDING across the restart (operator undecided)
    const id = approvalsA.pending()[0]!.id

    // --- The hub CRASHES: drop its socket. approvalsA's in-memory pending Promise + resolver die with it —
    //     exactly the failure step 6 fixes (the worker's await would otherwise hang forever). ---
    clientA.close()

    // --- Hub B (the successor process): a FRESH ApprovalService over the SAME durable journal, higher epoch. ---
    const approvalsB = new ApprovalService(journal)
    const reachedB = deferred()
    const clientB = new WorkerClient(socketPath, { attachEpoch: 2, danger: () => SAFE })
    cleanups.push(() => clientB.close())
    new WorkerExecutor(clientB, {
      ...baseCallbacks,
      resolveApproval: (approvalId, sessionId, kind, payload) => {
        reachedB.resolve()
        return approvalsB.request(sessionId, kind, payload, approvalId)
      },
    })

    // On B's attach the worker RE-FLUSHES the outstanding approvalRequest (the transport's relay lane re-sends
    // every pending relay to the successor). Hub B re-offers it via the idempotent approvals.request(id): its
    // map is empty and the journal holds no resolution → a fresh pending entry under the SAME stable id.
    await reachedB.promise
    expect(approvalsB.pending().map((r) => r.id)).toEqual([id]) // re-offered on the successor, same id → same pane button

    // The operator resolves on the SUCCESSOR (POST /api/approvals/:id → approvals.resolve on the new hub).
    expect(approvalsB.resolve(id, true)).toBe(true)

    // The worker's SINGLE pending relay resolves once → requireApproval returns true → the handler continues →
    // practices.write runs. resultPromise resolves with the tool's success text.
    const result = await resultPromise
    expect(result.content[0]!.text).toContain('Recorded')

    // EXACTLY ONCE: the practice was written a single time despite the approvalRequest crossing the restart and
    // being re-issued — no double-execute. (One pending relay, coalesced by stable id; resolved once.)
    const rows = practices.list({ scopes: ['project:proj1'] })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('Test convention')
    // And the successor never re-prompted after resolving: nothing is left pending on hub B.
    expect(approvalsB.pending()).toHaveLength(0)
  })

  it('an approval RESOLVED before the crash is recovered on the successor — the handler completes with NO re-prompt', async () => {
    // The other half of §7.2: hub A actually resolved the approval (journaled), but its approvalResolved never
    // reached the worker (the socket dropped in between), so the worker's relay is STILL pending. On re-attach
    // the successor must recover the durable decision from the journal and answer immediately — the operator is
    // never asked again, and the practice still writes exactly once.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-step6b-'))
    const socketPath = uniqueSocket(tmp)
    const journal = new Journal(path.join(tmp, 'hub.db'))
    const practices = new PracticeStore(journal.db)
    cleanups.push(() => {
      journal.db.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    const worker = new AgentWorker(socketPath)
    await worker.start()
    cleanups.push(() => worker.stop())
    const workerServices = (worker as unknown as { workerServices: AgentServices }).workerServices
    const mcp = buildAgentMcpServer(IDENTITY, workerServices)
    wrapRetryableHubErrors(mcp)
    const practiceWrite = handlerOf(mcp, 'practice_write')

    const runRelay = (method: RelayMethod, args: unknown): unknown => {
      if (method === 'practices.write') return practices.write(args as Parameters<PracticeStore['write']>[0])
      throw new Error(`unexpected relay in this test: ${method}`)
    }
    const baseCallbacks: Omit<WorkerExecutorHubCallbacks, 'resolveApproval'> = {
      ingestWorkerEvent: () => {},
      applyLifecycle: () => {},
      recall: (_s, p) => p,
      requestRestart: () => {},
      runRelay,
      resolveQuestion: async () => ({ kind: 'cancelled' }),
      abortQuestion: () => false,
      attachWorker: async () => {},
    }

    // Hub A: it RESOLVES the approval (durable), but we drop its socket so approvalResolved is never delivered.
    const approvalsA = new ApprovalService(journal)
    const reachedA = deferred()
    // Suppress hub A's approvalResolved so it truly never reaches the worker (simulating the lost-in-flight reply):
    // we resolve approvalsA out-of-band but the client is closed before the send lands.
    const clientA = new WorkerClient(socketPath, { attachEpoch: 1, danger: () => SAFE })
    let approvalIdSeen = ''
    new WorkerExecutor(clientA, {
      ...baseCallbacks,
      resolveApproval: (approvalId, sessionId, kind, payload) => {
        approvalIdSeen = approvalId
        reachedA.resolve()
        return approvalsA.request(sessionId, kind, payload, approvalId)
      },
    })
    await once(clientA, 'attached')

    const resultPromise = practiceWrite({ scope: 'project', title: 'Resolved before crash', body: 'convention body' }, {}) as Promise<{ content: { type: 'text'; text: string }[] }>
    await reachedA.promise

    // Hub A journals the operator's approval, THEN crashes before its approvalResolved reaches the worker.
    approvalsA.resolve(approvalIdSeen, true) // durable approval/resolved(approved) in the journal
    clientA.close() //                         the reply is lost; the worker's relay is still pending

    // Hub B (successor, fresh map, same journal). On re-attach the worker re-flushes the approvalRequest; hub B's
    // approvals.request(id) finds the durable resolution and answers immediately — WITHOUT re-prompting.
    const approvalsB = new ApprovalService(journal)
    const clientB = new WorkerClient(socketPath, { attachEpoch: 2, danger: () => SAFE })
    cleanups.push(() => clientB.close())
    let reOffered = false
    new WorkerExecutor(clientB, {
      ...baseCallbacks,
      resolveApproval: (approvalId, sessionId, kind, payload) => {
        const p = approvalsB.request(sessionId, kind, payload, approvalId)
        // Recovery returns a settled Promise and creates NO pending entry — the operator is not asked again.
        if (approvalsB.pending().length > 0) reOffered = true
        return p
      },
    })

    // The handler completes off the recovered decision alone — no operator action on hub B.
    const result = await resultPromise
    expect(result.content[0]!.text).toContain('Recorded')
    expect(reOffered).toBe(false) //            never re-prompted — the durable approve was honored
    expect(approvalsB.pending()).toHaveLength(0)
    expect(practices.list({ scopes: ['project:proj1'] })).toHaveLength(1) // written exactly once
  })
})
