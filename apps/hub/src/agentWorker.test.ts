import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentWorker, buildWorkerAgentServices, wrapRetryableHubErrors, type WorkerAgentServiceDeps } from './agentWorker.js'
import { WorkerServer } from './workerTransport.js'
import { HUB_UNAVAILABLE_TEXT, HubUnavailableError, stableApprovalId, type RelayMethod } from './workerProtocol.js'
import { buildAgentMcpServer, type AgentServices } from './agentTools.js'
import type { SessionIdentity } from './identity.js'
import type { DangerFlags, SessionRecord } from './types.js'
import { Journal } from './journal.js'
import { SessionStore } from './store.js'
import { ProjectStore } from './projects.js'
import { ApprovalService } from './approvals.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { InstructionStore } from './instructions.js'
import { AgentBus } from './bus.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { SessionManager } from './sessions.js'
import { QuestionService } from './questions.js'

// STEP 4 round-trips (docs/agent-worker-impl.md §3.3): the worker's MCP tool handlers relay bus/memory/
// practices/approval back to hub-owned services. These two halves must agree on the wire shape, so they
// are tested together: the WORKER proxy emits `rpc(method, args)`, and the HUB's runRelay dispatches that
// exact `(method, args)` to the same stores InProcessExecutor.agentServices() uses. No hub, no socket.

const IDENTITY: SessionIdentity = { sessionId: 's1', profileId: 'p1', provider: 'claude', projectId: 'proj1', label: 'demo' }
const SAFE: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: false, autoApproveRestart: false }

// --- Worker half: buildWorkerAgentServices proxy shapes (pure, with a recording relay) ----------

describe('buildWorkerAgentServices — proxy shapes (the exact relay args the hub must dispatch)', () => {
  function withRecorder() {
    const rpcCalls: Array<{ method: RelayMethod; args: unknown }> = []
    const approvalCalls: Array<{ sessionId: string; kind: string; payload: unknown }> = []
    const journalCalls: Array<{ sessionId: string; kind: string; payload: unknown }> = []
    let rpcReturn: unknown = { ok: true }
    let approvalReturn: Promise<boolean> = Promise.resolve(true)
    const deps: WorkerAgentServiceDeps = {
      relayRpc: (method, args) => {
        rpcCalls.push({ method, args })
        return Promise.resolve(rpcReturn)
      },
      relayApproval: (sessionId, kind, payload) => {
        approvalCalls.push({ sessionId, kind, payload })
        return approvalReturn
      },
      isBusTurn: (sid) => sid === 'busy',
      danger: () => SAFE,
      journal: (sessionId, kind, payload) => journalCalls.push({ sessionId, kind, payload }),
    }
    return {
      services: buildWorkerAgentServices(deps),
      rpcCalls,
      approvalCalls,
      journalCalls,
      setRpcReturn: (v: unknown) => (rpcReturn = v),
      setApproval: (p: Promise<boolean>) => (approvalReturn = p),
    }
  }

  it('send → rpc(bus.send, {fromSessionId,to,subject,body}) and returns the reply', async () => {
    const h = withRecorder()
    h.setRpcReturn({ ok: true, delivered: 2 })
    const r = await h.services.send(IDENTITY, { kind: 'project', id: 'proj1' }, 'subj', 'hello')
    expect(h.rpcCalls).toEqual([
      { method: 'bus.send', args: { fromSessionId: 's1', to: { kind: 'project', id: 'proj1' }, subject: 'subj', body: 'hello' } },
    ])
    expect(r).toEqual({ ok: true, delivered: 2 })
  })

  it('inbox/roster → rpc(bus.inbox|bus.roster, {sessionId})', async () => {
    const h = withRecorder()
    h.setRpcReturn([])
    await h.services.inbox('s9')
    await h.services.roster('s9')
    expect(h.rpcCalls).toEqual([
      { method: 'bus.inbox', args: { sessionId: 's9' } },
      { method: 'bus.roster', args: { sessionId: 's9' } },
    ])
  })

  it('remote project preparation relays only the caller and attached location identity', async () => {
    const h = withRecorder()
    await h.services.remotePrepareProjectLocation('s1', 'site-a', 'root-a')
    expect(h.rpcCalls).toEqual([
      {
        method: 'remote.prepareProjectLocation',
        args: { sessionId: 's1', siteId: 'site-a', rootId: 'root-a' },
      },
    ])
  })

  it('memory.{write,search,get} → rpc(memory.*) with the store-shaped args', async () => {
    const h = withRecorder()
    const input = { scope: 'account:p1', title: 't', body: 'b', tags: ['x'], fromSession: 's1', fromProfile: 'p1' }
    await h.services.memory.write(input)
    await h.services.memory.search('q', { scopes: ['global'], limit: 5 })
    await h.services.memory.get('m1', ['global'])
    expect(h.rpcCalls).toEqual([
      { method: 'memory.write', args: input },
      { method: 'memory.search', args: { query: 'q', opts: { scopes: ['global'], limit: 5 } } },
      { method: 'memory.get', args: { id: 'm1', scopes: ['global'] } },
    ])
  })

  it('practices.{write,edit,get,list} → rpc(practices.*)', async () => {
    const h = withRecorder()
    const input = { scope: 'project:proj1', title: 't', body: 'b', fromSession: 's1', fromProfile: 'p1' }
    await h.services.practices.write(input)
    await h.services.practices.edit('p9', { title: 'nt' })
    await h.services.practices.get('p9', ['project:proj1'])
    await h.services.practices.list({ scopes: ['project:proj1'] })
    expect(h.rpcCalls).toEqual([
      { method: 'practices.write', args: input },
      { method: 'practices.edit', args: { id: 'p9', patch: { title: 'nt' } } },
      { method: 'practices.get', args: { id: 'p9', scopes: ['project:proj1'] } },
      { method: 'practices.list', args: { scopes: ['project:proj1'] } },
    ])
  })

  it('requireApproval → relayApproval(sessionId,kind,payload) and returns the operator decision', async () => {
    const h = withRecorder()
    h.setApproval(Promise.resolve(true))
    const ok = await h.services.requireApproval(IDENTITY, 'practice/write', { scope: 'project:proj1' })
    expect(h.approvalCalls).toEqual([{ sessionId: 's1', kind: 'practice/write', payload: { scope: 'project:proj1' } }])
    expect(ok).toBe(true)
  })

  it('requireApproval PROPAGATES HubUnavailableError — it never returns false on a gap (§8.3)', async () => {
    const h = withRecorder()
    h.setApproval(Promise.reject(new HubUnavailableError()))
    await expect(h.services.requireApproval(IDENTITY, 'practice/write', {})).rejects.toBeInstanceOf(HubUnavailableError)
  })

  it('isBusTurn/danger/journal resolve worker-locally (no relay round-trip)', () => {
    const h = withRecorder()
    expect(h.services.isBusTurn('busy')).toBe(true)
    expect(h.services.isBusTurn('s1')).toBe(false)
    expect(h.services.danger()).toBe(SAFE)
    h.services.journal('s1', 'practice/wrote', { id: 'p1' })
    expect(h.journalCalls).toEqual([{ sessionId: 's1', kind: 'practice/wrote', payload: { id: 'p1' } }])
    expect(h.rpcCalls).toEqual([]) // none of these three hit the relay lane
  })
})

// --- Worker half: the real relay lane end-to-end (AgentWorker + WorkerServer, socket-free) -------

describe('AgentWorker relay helpers — real WorkerServer relay lane (worker half, socket-free)', () => {
  // Construct an AgentWorker WITHOUT start() (no listener bound); the relay lane works purely in-memory,
  // exactly like the transport tests' unboundServer. Reach the private wiring through a typed cast.
  function makeWorker() {
    return new AgentWorker('\\\\.\\pipe\\ama-step4-never-bound') as unknown as {
      workerServices: AgentServices
      server: WorkerServer
    }
  }

  it('memory.write emits rpc(memory.write) on the relay lane and resolves with the rpcResult value', async () => {
    const w = makeWorker()
    const p = w.workerServices.memory.write({ scope: 'account:p1', title: 't', body: 'b' })
    // No hub attached → one pending relay, minted callId wc1 (callSeq starts at 0).
    expect(w.server.pendingRelayCount).toBe(1)
    const mem = { id: 'mem-1', scope: 'account:p1', title: 't', body: 'b', tags: [], fromSession: null, fromProfile: null, createdAt: 'x', updatedAt: 'x' }
    w.server.onHub({ t: 'rpcResult', callId: 'wc1', ok: true, value: mem })
    await expect(p).resolves.toEqual(mem)
    expect(w.server.pendingRelayCount).toBe(0)
    await w.server.close()
  })

  it('an rpcResult ok:false rejects the proxy (a hub-side dispatch error)', async () => {
    const w = makeWorker()
    const p = w.workerServices.roster('s1')
    w.server.onHub({ t: 'rpcResult', callId: 'wc1', ok: false, error: 'unknown sender' })
    await expect(p).rejects.toThrow('unknown sender')
    await w.server.close()
  })

  it('requireApproval emits approvalRequest under the STABLE id and resolves with the decision', async () => {
    const w = makeWorker()
    const payload = { scope: 'project:proj1', title: 't' }
    const p = w.workerServices.requireApproval(IDENTITY, 'practice/write', payload)
    expect(w.server.pendingRelayCount).toBe(1)
    // The worker keys the relay by the deterministic stableApprovalId(sessionId, kind, payload).
    w.server.onHub({ t: 'approvalResolved', approvalId: stableApprovalId('s1', 'practice/write', payload), approved: true })
    await expect(p).resolves.toBe(true)
    await w.server.close()
  })
})

// --- Worker half: withRetryableHubErrors wraps the built MCP server's tool bodies (§8.3) ---------

describe('wrapRetryableHubErrors — a HubUnavailableError from a proxy becomes retryable text', () => {
  // Invoke a wrapped tool handler exactly as the MCP SDK dispatch does — tool.handler(args, extra) off the
  // instance's registered-tool table — so this also guards the SDK-internal shape the wrap reaches into.
  function handlerOf(mcp: ReturnType<typeof buildAgentMcpServer>, name: string): (args: unknown, extra: unknown) => Promise<unknown> {
    const table = (mcp as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } }).instance._registeredTools
    return table[name]!.handler
  }
  function servicesRejecting(err: Error): AgentServices {
    return buildWorkerAgentServices({
      relayRpc: () => Promise.reject(err),
      relayApproval: () => Promise.reject(err),
      isBusTurn: () => false,
      danger: () => SAFE,
      journal: () => {},
    })
  }

  it('list_agents returns the retryable HUB_UNAVAILABLE_TEXT result (not a throw/isError) past the bound', async () => {
    const mcp = buildAgentMcpServer(IDENTITY, servicesRejecting(new HubUnavailableError()))
    wrapRetryableHubErrors(mcp)
    const result = await handlerOf(mcp, 'list_agents')({}, {})
    expect(result).toEqual({ content: [{ type: 'text', text: HUB_UNAVAILABLE_TEXT }] })
  })

  it('a NON-HubUnavailable error still propagates (the wrap only softens the transient-gap terminal)', async () => {
    const mcp = buildAgentMcpServer(IDENTITY, servicesRejecting(new Error('boom')))
    wrapRetryableHubErrors(mcp)
    await expect(handlerOf(mcp, 'list_agents')({}, {})).rejects.toThrow('boom')
  })
})

// --- Hub half: SessionManager.runRelay dispatch (the same stores agentServices() uses) -----------

describe('SessionManager.runRelay — hub-side dispatch (mirrors InProcessExecutor.agentServices)', () => {
  let tmp = ''
  const opened: Journal[] = []
  function build() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-relay-'))
    const journal = new Journal(path.join(tmp, 'hub.db'))
    opened.push(journal)
    const store = new SessionStore(journal.db)
    const projects = new ProjectStore(journal.db)
    const approvals = new ApprovalService(journal)
    const usage = new UsageMonitor(journal, [], {})
    const workspace = new WorkspaceManager(path.join(tmp, 'wt'))
    const instructions = new InstructionStore(journal.db)
    const bus = new AgentBus(journal.db)
    const memory = new MemoryStore(journal.db)
    const practices = new PracticeStore(journal.db)
    const questions = new QuestionService(journal)
    const notifications = { publish: vi.fn() }
    const sessions = new SessionManager(
      journal, store, new Map(), approvals, usage, workspace, projects, instructions, bus, memory,
      practices, SAFE, false, tmp, questions, undefined,
      { chatNamePool: 'everyone', steerMessagesAtToolBoundary: true }, undefined, notifications,
    )
    return { sessions, questions, notifications }
  }
  afterEach(() => {
    for (const j of opened) j.db.close()
    opened.length = 0
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('memory.write persists + returns the Memory; memory.get / memory.search read it back (scope-enforced)', () => {
    const { sessions } = build()
    const m = sessions.runRelay('memory.write', { scope: 'account:p1', title: 'Build', body: 'pnpm test', fromSession: 's1', fromProfile: 'p1' }) as { id: string; scope: string; title: string }
    expect(m.scope).toBe('account:p1')
    expect(m.title).toBe('Build')
    expect((sessions.runRelay('memory.get', { id: m.id, scopes: ['account:p1'] }) as { id: string }).id).toBe(m.id)
    expect(sessions.runRelay('memory.search', { query: 'pnpm', opts: { scopes: ['account:p1'] } })).toHaveLength(1)
    // A non-readable scope hides it — the readableScopes filter the worker relays through is honored.
    expect(sessions.runRelay('memory.get', { id: m.id, scopes: ['global'] })).toBeUndefined()
  })

  it('practices.write persists; list/get/edit round-trip', () => {
    const { sessions } = build()
    const p = sessions.runRelay('practices.write', { scope: 'project:proj1', title: 'Style', body: 'tabs', fromSession: 's1', fromProfile: 'p1' }) as { id: string; title: string }
    expect(p.title).toBe('Style')
    expect(sessions.runRelay('practices.list', { scopes: ['project:proj1'] })).toHaveLength(1)
    expect((sessions.runRelay('practices.edit', { id: p.id, patch: { title: 'Style v2' } }) as { title: string }).title).toBe('Style v2')
    expect((sessions.runRelay('practices.get', { id: p.id, scopes: ['project:proj1'] }) as { title: string }).title).toBe('Style v2')
  })

  it('turn questions create one durable operator-attention notification', () => {
    const { sessions, questions, notifications } = build()
    questions.activatePublicOwner()
    ;(sessions as unknown as { sessions: Map<string, SessionRecord> }).sessions.set('overseer-1', {
      id: 'overseer-1',
      profileId: 'p1',
      provider: 'claude',
      cwd: tmp,
      status: 'active',
      createdAt: new Date().toISOString(),
      title: 'Overseer',
      isOverseer: true,
    })
    void sessions.runRelay('questions.request', {
      id: 'question-1',
      sessionId: 'overseer-1',
      toolUseId: 'tool-1',
      requestId: 'request-1',
      input: {
        questions: [{
          question: 'Which project should I create?',
          header: 'Project',
          options: [
            { label: 'Alpha', description: 'Create Alpha.' },
            { label: 'Beta', description: 'Create Beta.' },
          ],
          multiSelect: false,
        }],
      },
    })
    expect(notifications.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'question-required',
      sourceRole: 'overseer',
      route: 'operator',
      title: 'Overseer needs your response',
      body: 'Which project should I create?',
      dedupeKey: 'question-required:question-1',
    }))
    questions.cancel('question-1')
  })

  it('bus.* routes to busSend/busInbox/busRoster (proven by the no-session results)', () => {
    const { sessions } = build()
    expect(sessions.runRelay('bus.roster', { sessionId: 'nope' })).toEqual([])
    expect(sessions.runRelay('bus.inbox', { sessionId: 'nope' })).toEqual([])
    expect(sessions.runRelay('bus.send', { fromSessionId: 'nope', to: { kind: 'session', id: 'x' }, subject: undefined, body: 'hi' })).toEqual({ ok: false, delivered: 0, error: 'unknown sender' })
  })

  it('an unknown relay method throws (surfaced to the worker as rpcResult.ok:false)', () => {
    const { sessions } = build()
    expect(() => sessions.runRelay('nope.method' as RelayMethod, {})).toThrow(/unknown relay method/)
  })
})
