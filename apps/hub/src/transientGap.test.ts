import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { WorkerClient, WorkerServer } from './workerTransport.js'
import { WorkerExecutor, type WorkerExecutorHubCallbacks } from './workerExecutor.js'
import { AgentWorker } from './agentWorker.js'
import { buildAgentMcpServer, type AgentServices } from './agentTools.js'
import { SessionManager, RESTART_MAX_DEFER_MS } from './sessions.js'
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
import { QuestionService } from './questions.js'
import {
  HUB_RELAY_DELIVERED_BACKSTOP_MS,
  HUB_RELAY_TIMEOUT_MS,
  HUB_UNAVAILABLE_TEXT,
  HubUnavailableError,
  type HubToWorker,
  type WorkerToHub,
} from './workerProtocol.js'
import type { Executor } from './executor.js'
import type { SessionIdentity } from './identity.js'
import type { DangerFlags, Profile, SessionRecord, SessionStatus } from './types.js'

// STEP 7 (docs/agent-worker-impl.md §8, §9.3): transient hub-unavailability during a blue-green flip — a
// mid-flip tool call must PAUSE then return its REAL result, never a permanent denied/disabled shape. These
// exercise the five step-7 properties (a)–(e) plus the transport lows (L4/L6) folded in, all socket-free.

const SAFE: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: false, autoApproveRestart: false }
const WORKER_SECRET = 'transient-gap-worker-secret-000000000000000000000000'
const IDENTITY: SessionIdentity = { sessionId: 's1', profileId: 'p1', provider: 'claude', projectId: 'proj1', label: 'demo' }

/** Flush the microtask + one macrotask so a dispatchRpc's async serve + `send` settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// ================================================================================================
// (b)/(c) + L4/L6 — WorkerServer draining / release / channel-teardown / delivered backstop
// A fake current channel injected via a typed cast (the codebase's socket-free test idiom) lets us observe
// exactly what is (and is NOT) written to the about-to-die socket without any real pipe.
// ================================================================================================

interface FakeChannel {
  send(m: WorkerToHub): void
  readonly isClosed: boolean
  destroy(): void
  readonly writes: WorkerToHub[]
}
interface ServerPeek {
  current: FakeChannel
  currentEpoch: number
  channels: Set<FakeChannel>
}

function unboundServer(): WorkerServer {
  return new WorkerServer('\\\\.\\pipe\\ama-step7-never-bound')
}

/** Attach a fake channel as the server's current one (bypassing the socket path), recording its writes. */
function attachFakeChannel(server: WorkerServer, epoch = 1): FakeChannel {
  const writes: WorkerToHub[] = []
  let closed = false
  const ch: FakeChannel = {
    send: (m) => writes.push(m),
    get isClosed() {
      return closed
    },
    destroy: () => {
      closed = true
    },
    writes,
  }
  const peek = server as unknown as ServerPeek
  peek.current = ch
  peek.currentEpoch = epoch
  peek.channels.add(ch)
  return ch
}

const rpc = (callId: string): Extract<WorkerToHub, { t: 'rpc' }> => ({ t: 'rpc', callId, method: 'memory.write', args: { note: callId } })
const callIdsOf = (writes: WorkerToHub[]): string[] => writes.filter((w) => w.t === 'rpc').map((w) => (w as Extract<WorkerToHub, { t: 'rpc' }>).callId)

describe('(b) drain pre-signal — a flip with the pre-signal has ZERO failed in-flight sends', () => {
  it('HOLDS a relay that arrives during the drain window — it is NEVER written to the about-to-die channel', async () => {
    const server = unboundServer()
    const ch = attachFakeChannel(server)
    // A relay before draining is delivered live to the channel.
    const before = server.relay(rpc('c1'))
    before.catch(() => {})
    expect(callIdsOf(ch.writes)).toEqual(['c1'])

    // Blue signals draining (the pre-flip hold). A relay that arrives NOW must queue, not race the dying socket.
    server.onHub({ t: 'draining' })
    const during = server.relay(rpc('c2'))
    during.catch(() => {})
    expect(server.pendingRelayCount).toBe(2) // both held/pending
    // The crux: c2 was NOT written to the draining channel — zero failed in-flight sends on the socket that dies.
    expect(callIdsOf(ch.writes)).toEqual(['c1'])

    await server.close()
  })
})

describe('(c) rolled-back flip — abort UN-DRAINS so the held relays flow again (the M2 regression)', () => {
  it('a held relay flushes on the un-drain push and resolves with its REAL reply (not stuck rejecting)', async () => {
    const server = unboundServer()
    const ch = attachFakeChannel(server)
    server.onHub({ t: 'draining' }) // blue drained
    const held = server.relay(rpc('c9')) // arrives during the drain window → held, not written
    const settled = held.then((r) => r, (e: unknown) => e)
    expect(ch.writes.length).toBe(0)
    expect(server.pendingRelayCount).toBe(1)

    // Rollback: blue.abort() → the un-drain push. The held relay flushes to the still-current channel...
    server.onHub({ t: 'draining', on: false })
    expect(callIdsOf(ch.writes)).toEqual(['c9'])

    // ...and resolves with the REAL result — it FLOWED, it did not sit stuck until a wrong timeout.
    server.onHub({ t: 'rpcResult', callId: 'c9', ok: true, value: { id: 'mem-real' } })
    await expect(settled).resolves.toMatchObject({ t: 'rpcResult', callId: 'c9', ok: true, value: { id: 'mem-real' } })
    expect(server.pendingRelayCount).toBe(0)

    await server.close()
  })

  it('WITHOUT the release a held relay stays stuck and wrongly terminals at the bound (the bug the M2 release prevents)', async () => {
    vi.useFakeTimers()
    try {
      const server = unboundServer()
      attachFakeChannel(server)
      server.onHub({ t: 'draining' }) // drained and NEVER released
      const held = server.relay(rpc('c9'))
      const settled = held.then(() => undefined, (e: unknown) => e)
      await vi.advanceTimersByTimeAsync(HUB_RELAY_TIMEOUT_MS)
      // The hub never actually went away, yet the un-released hold makes the relay reject — exactly the
      // "wrongly reject" symptom the release closes.
      expect(await settled).toBeInstanceOf(HubUnavailableError)
      await server.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('L4 — close() destroys every accepted channel', () => {
  it('destroys tracked channels that are not the current one (no leaked sockets on worker shutdown)', async () => {
    const server = unboundServer()
    const peek = server as unknown as { channels: Set<{ destroyed: boolean; destroy(): void }> }
    const a = { destroyed: false, destroy() { this.destroyed = true } }
    const b = { destroyed: false, destroy() { this.destroyed = true } }
    peek.channels.add(a)
    peek.channels.add(b)
    await server.close()
    expect(a.destroyed).toBe(true)
    expect(b.destroyed).toBe(true)
    expect(peek.channels.size).toBe(0)
  })
})

describe('L6 — a delivered relay cannot hang the tool forever', () => {
  it('a DELIVERED rpc gets a generous backstop → a never-replying hub terminals it (retryably)', async () => {
    vi.useFakeTimers()
    try {
      const server = unboundServer()
      attachFakeChannel(server)
      const p = server.relay(rpc('c1')) // delivered live → backstop armed, no reach timer
      const settled = p.then(() => undefined, (e: unknown) => e)
      // Well past the reach-a-hub bound (a delivered call is already at a hub) but before the backstop.
      await vi.advanceTimersByTimeAsync(HUB_RELAY_TIMEOUT_MS + 1)
      expect(server.pendingRelayCount).toBe(1)
      // At the backstop: a wedged hub that accepted the frame but never replies can't hang forever.
      await vi.advanceTimersByTimeAsync(HUB_RELAY_DELIVERED_BACKSTOP_MS - (HUB_RELAY_TIMEOUT_MS + 1))
      expect(await settled).toBeInstanceOf(HubUnavailableError)
      await server.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a DELIVERED approvalRequest gets NO backstop — it waits on the human, resolving whenever the operator decides', async () => {
    vi.useFakeTimers()
    try {
      const server = unboundServer()
      attachFakeChannel(server)
      const p = server.relay({ t: 'approvalRequest', approvalId: 'ap_1', sessionId: 's', kind: 'practice/write', payload: {} })
      const settled = p.then(() => 'resolved', () => 'rejected')
      await vi.advanceTimersByTimeAsync(HUB_RELAY_DELIVERED_BACKSTOP_MS * 2) // way past any rpc backstop
      expect(server.pendingRelayCount).toBe(1) // still waiting — an approval is not bounded by a socket timer
      server.onHub({ t: 'approvalResolved', approvalId: 'ap_1', approved: true }) // the human decides
      expect(await settled).toBe('resolved')
      await server.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ================================================================================================
// WorkerClient.signalDraining — the RELEASE wiring (un-drain push when attached; epoch reclaim when not)
// ================================================================================================

describe('WorkerClient.signalDraining — drain / release wiring (§8.4)', () => {
  interface ClientPeek {
    channel?: { send(m: HubToWorker): void; readonly isClosed: boolean; destroy(): void }
    attachEpoch: number
    authenticated: boolean
  }
  function newClient(attachEpoch?: number): WorkerClient {
    // Constructed directly; we never call connect() on a real socket, only inject/read private state.
    return new WorkerClient('\\\\.\\pipe\\ama-step7-client-never', {
      ...(attachEpoch !== undefined ? { attachEpoch } : {}),
      authSecret: WORKER_SECRET,
    })
  }

  it('signalDraining(true) sends the drain hold when attached', () => {
    const client = newClient()
    const sent: HubToWorker[] = []
    ;(client as unknown as ClientPeek).channel = { send: (m) => sent.push(m), get isClosed() { return false }, destroy() {} }
    ;(client as unknown as ClientPeek).authenticated = true
    client.signalDraining(true)
    expect(sent).toEqual([{ t: 'draining' }])
    client.close()
  })

  it('signalDraining(false) sends the un-drain push when our channel is still attached', () => {
    const client = newClient()
    const sent: HubToWorker[] = []
    ;(client as unknown as ClientPeek).channel = { send: (m) => sent.push(m), get isClosed() { return false }, destroy() {} }
    ;(client as unknown as ClientPeek).authenticated = true
    client.signalDraining(false)
    expect(sent).toEqual([{ t: 'draining', on: false }])
    client.close()
  })

  it('signalDraining(false) bumps the attachEpoch to reclaim a displaced channel when NOT attached', () => {
    const client = newClient(100)
    const peek = client as unknown as ClientPeek
    expect(peek.attachEpoch).toBe(100)
    client.signalDraining(false) // detached (a booted-then-dead green displaced us) → reclaim with a fresh, higher epoch
    expect(peek.attachEpoch).toBeGreaterThan(100)
    client.close()
  })
})

// ================================================================================================
// (a) — stable-callId write dedup: a re-flushed write returns the real id EXACTLY ONCE (no double row)
// Driven through WorkerExecutor.dispatchRpc (the hub-side served-callId cache, §8.2) over a fake client,
// with runRelay backed by a REAL SessionManager + stores so "no double row" is asserted against the DB.
// ================================================================================================

class FakeWorkerClient extends EventEmitter {
  readonly sent: HubToWorker[] = []
  connect(): void {}
  call<T>(): Promise<T> {
    return Promise.resolve({} as T)
  }
  send(m: HubToWorker): void {
    this.sent.push(m)
  }
  signalDraining(): void {}
  onEvent(cb: (m: unknown) => void): void {
    this.on('event', cb)
  }
  onTurnLifecycle(cb: (m: unknown) => void): void {
    this.on('turnLifecycle', cb)
  }
  onRelay(cb: (m: unknown) => void): void {
    this.on('relay', cb)
  }
  onRestartRequest(cb: (m: unknown) => void): void {
    this.on('restartRequest', cb)
  }
  onWelcome(cb: (m: unknown) => void): void {
    this.on('welcome', cb)
  }
  isAttached(): boolean {
    return true
  }
  close(): void {}
}

describe('(a) stable-callId write dedup — a re-flushed write executes exactly once (§8.2)', () => {
  const tmps: string[] = []
  const dbs: Journal[] = []
  afterEach(() => {
    for (const j of dbs) j.db.close()
    dbs.length = 0
    for (const t of tmps) fs.rmSync(t, { recursive: true, force: true })
    tmps.length = 0
  })

  function build(): { sessions: SessionManager; client: FakeWorkerClient; executor: WorkerExecutor } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-step7a-'))
    tmps.push(tmp)
    const journal = new Journal(path.join(tmp, 'hub.db'))
    dbs.push(journal)
    const store = new SessionStore(journal.db)
    const sessions = new SessionManager(
      journal,
      store,
      new Map(),
      new ApprovalService(journal),
      new UsageMonitor(journal, [], {}),
      new WorkspaceManager(path.join(tmp, 'wt')),
      new ProjectStore(journal.db),
      new InstructionStore(journal.db),
      new AgentBus(journal.db),
      new MemoryStore(journal.db),
      new PracticeStore(journal.db),
      SAFE,
      false,
      tmp,
      new QuestionService(journal)
    )
    const client = new FakeWorkerClient()
    const hub: WorkerExecutorHubCallbacks = {
      ingestWorkerEvent: () => {},
      applyLifecycle: () => {},
      recall: (_id, prompt) => prompt,
      requestRestart: () => {},
      runRelay: (method, args) => sessions.runRelay(method, args),
      resolveApproval: async () => true,
      attachWorker: async () => {},
    }
    const executor = new WorkerExecutor(client as unknown as WorkerClient, hub)
    return { sessions, client, executor }
  }

  it('a memory_write re-flushed under the SAME callId returns the real id twice but writes ONE row', async () => {
    const { sessions, client } = build()
    const writeArgs = { scope: 'account:p1', title: 'Flip note', body: 'saved mid-flip', fromSession: 's1', fromProfile: 'p1' }

    // The worker sends the write; the hub serves it and (its reply lost across the flip) the worker re-flushes
    // the SAME stable callId. Both dispatches carry callId wc7.
    client.emit('relay', { t: 'rpc', callId: 'wc7', method: 'memory.write', args: writeArgs })
    await flush()
    client.emit('relay', { t: 'rpc', callId: 'wc7', method: 'memory.write', args: writeArgs }) // the re-flush
    await flush()

    // Two rpcResults were sent back (once per re-flush), both carrying the SAME memory id — the second was
    // served from the cache, not a second write.
    const results = client.sent.filter((m): m is Extract<HubToWorker, { t: 'rpcResult' }> => m.t === 'rpcResult')
    expect(results).toHaveLength(2)
    expect(results[0].ok).toBe(true)
    const id0 = (results[0].value as { id: string }).id
    const id1 = (results[1].value as { id: string }).id
    expect(id1).toBe(id0)

    // And the store holds EXACTLY ONE row — no double write.
    const rows = sessions.runRelay('memory.search', { query: 'Flip', opts: { scopes: ['account:p1'] } }) as unknown[]
    expect(rows).toHaveLength(1)
    expect((rows[0] as { id: string }).id).toBe(id0)
  })

  it('a DIFFERENT callId writes a second row (dedup is keyed by callId, not by content)', async () => {
    const { sessions, client } = build()
    const writeArgs = { scope: 'account:p1', title: 'Note', body: 'body', fromSession: 's1', fromProfile: 'p1' }
    client.emit('relay', { t: 'rpc', callId: 'wc1', method: 'memory.write', args: writeArgs })
    await flush()
    client.emit('relay', { t: 'rpc', callId: 'wc2', method: 'memory.write', args: writeArgs }) // a genuinely new call
    await flush()
    const rows = sessions.runRelay('memory.search', { query: 'Note', opts: { scopes: ['account:p1'] } }) as unknown[]
    expect(rows).toHaveLength(2)
  })

  it('a re-flushed READ is not cached — it re-runs (reads are naturally idempotent)', async () => {
    const { sessions, client } = build()
    // Seed one memory directly, then read it twice under the same callId; both replies reflect live data.
    const seeded = sessions.runRelay('memory.write', { scope: 'account:p1', title: 'R', body: 'v', fromSession: 's1', fromProfile: 'p1' }) as { id: string }
    client.emit('relay', { t: 'rpc', callId: 'wcR', method: 'memory.get', args: { id: seeded.id, scopes: ['account:p1'] } })
    await flush()
    client.emit('relay', { t: 'rpc', callId: 'wcR', method: 'memory.get', args: { id: seeded.id, scopes: ['account:p1'] } })
    await flush()
    const results = client.sent.filter((m): m is Extract<HubToWorker, { t: 'rpcResult' }> => m.t === 'rpcResult')
    expect(results).toHaveLength(2)
    expect((results[0].value as { id: string }).id).toBe(seeded.id)
    expect((results[1].value as { id: string }).id).toBe(seeded.id)
  })

  // --- F1: a served write must NOT survive a worker RESPAWN (only a same-worker flap) --------------
  // `servedWrites` is keyed by callId ALONE, but a callId is unique only WITHIN one worker process — the
  // worker's callSeq resets to 0 on a respawn, so wc1, wc2, … repeat. Without the generation handshake the
  // pre-respawn cache would serve a NEW era's wc1 the DEAD era's result (id=OLD) and the new write would
  // never run. These two prove the fix: a respawn (new generation) invalidates the cache, while a same-
  // generation socket flap keeps it so §8.2 re-flush dedup is untouched.

  it('a worker RESPAWN (new generation) drops the stale cache — the new era wc1 RUNS a fresh write, not the dead era result (F1)', async () => {
    const { sessions, client } = build()

    // Worker ERA 1 attaches (generation wg-era1) and serves wc1 → cached, id = OLD.
    client.emit('welcome', { generation: 'wg-era1' })
    const era1Args = { scope: 'account:p1', title: 'Era note', body: 'first era', fromSession: 's1', fromProfile: 'p1' }
    client.emit('relay', { t: 'rpc', callId: 'wc1', method: 'memory.write', args: era1Args })
    await flush()
    const afterEra1 = client.sent.filter((m): m is Extract<HubToWorker, { t: 'rpcResult' }> => m.t === 'rpcResult')
    expect(afterEra1).toHaveLength(1)
    const oldId = (afterEra1[0].value as { id: string }).id

    // The worker CRASHES ~10s later and hubctl RESPAWNS it: a fresh process → callSeq resets to 0 (wc1 again)
    // under a NEW generation. The SAME hub reconnects on the same socket; the successor's `welcome` announces
    // the new generation AHEAD of any of its rpcs (WorkerServer sends welcome before the relay re-flush).
    client.emit('welcome', { generation: 'wg-era2' })

    // The resumed/new turn's first write is again wc1 — with DIFFERENT content.
    const era2Args = { scope: 'account:p1', title: 'Era note', body: 'second era', fromSession: 's1', fromProfile: 'p1' }
    client.emit('relay', { t: 'rpc', callId: 'wc1', method: 'memory.write', args: era2Args })
    await flush()

    const results = client.sent.filter((m): m is Extract<HubToWorker, { t: 'rpcResult' }> => m.t === 'rpcResult')
    expect(results).toHaveLength(2)
    const newId = (results[1].value as { id: string }).id
    // The crux: the respawned worker's write RAN — a fresh id, NOT the dead era's cached OLD id.
    expect(newId).not.toBe(oldId)

    // And the store holds BOTH rows: two real writes ran (the second was NOT served from the stale cache).
    const rows = sessions.runRelay('memory.search', { query: 'Era', opts: { scopes: ['account:p1'] } }) as Array<{ id: string; body: string }>
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.body).sort()).toEqual(['first era', 'second era'])
  })

  it('a same-generation socket FLAP keeps the cache — a re-flushed wc1 returns the cached result, write ran once (§8.2)', async () => {
    const { sessions, client } = build()
    const writeArgs = { scope: 'account:p1', title: 'Flap note', body: 'once', fromSession: 's1', fromProfile: 'p1' }

    // Attach (generation wg-1) and serve wc1 → cached, id = ID0.
    client.emit('welcome', { generation: 'wg-1' })
    client.emit('relay', { t: 'rpc', callId: 'wc1', method: 'memory.write', args: writeArgs })
    await flush()

    // A socket FLAP to the SAME worker: the transport re-attaches (SAME generation) and re-flushes the pending
    // wc1. The generation is unchanged, so the cache is KEPT — the re-flush must dedup, not write a second row.
    client.emit('welcome', { generation: 'wg-1' })
    client.emit('relay', { t: 'rpc', callId: 'wc1', method: 'memory.write', args: writeArgs })
    await flush()

    const results = client.sent.filter((m): m is Extract<HubToWorker, { t: 'rpcResult' }> => m.t === 'rpcResult')
    expect(results).toHaveLength(2)
    expect((results[1].value as { id: string }).id).toBe((results[0].value as { id: string }).id) // deduped

    // Exactly one row — the write ran once across the flap.
    const rows = sessions.runRelay('memory.search', { query: 'Flap', opts: { scopes: ['account:p1'] } }) as unknown[]
    expect(rows).toHaveLength(1)
  })
})

// ================================================================================================
// (d) — a >45s orphaned tool relay returns HUB_UNAVAILABLE_TEXT (retryable), never a denied/disabled shape
// End-to-end through the REAL relay lane: the worker's MCP tool → workerServices RPC proxy → WorkerServer
// relay (no hub) → HUB_RELAY_TIMEOUT_MS → HubUnavailableError → wrapRetryableHubErrors → retryable text.
// ================================================================================================

describe('(d) orphaned relay past the transient bound → retryable, NOT denied/disabled (§8.3)', () => {
  interface WorkerPeek {
    workerServices: AgentServices
    server: WorkerServer
  }
  function handlerOf(mcp: ReturnType<typeof buildAgentMcpServer>, name: string): (args: unknown, extra: unknown) => Promise<unknown> {
    const table = (mcp as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } }).instance._registeredTools
    return table[name]!.handler
  }

  it('memory_write orphaned >45s returns the retryable HUB_UNAVAILABLE_TEXT result (no isError, no denied language)', async () => {
    vi.useFakeTimers()
    try {
      const worker = new AgentWorker('\\\\.\\pipe\\ama-step7-orphan') as unknown as WorkerPeek
      const mcp = buildAgentMcpServer(IDENTITY, worker.workerServices)
      // Every tool body is wrapped so a HubUnavailableError becomes the retryable text (as agentWorker.ts does).
      const { wrapRetryableHubErrors } = await import('./agentWorker.js')
      wrapRetryableHubErrors(mcp)

      // No hub is attached → the write relay queues, awaiting a hub that never comes.
      const resultP = handlerOf(mcp, 'memory_write')({ title: 'T', body: 'B', scope: 'account' }, {})
      await vi.advanceTimersByTimeAsync(HUB_RELAY_TIMEOUT_MS) // the reach-a-hub bound elapses → terminal
      const result = await resultP

      // The ONE retryable shape — the tool "briefly unavailable, retry" — never a permanent shape.
      expect(result).toEqual({ content: [{ type: 'text', text: HUB_UNAVAILABLE_TEXT }] })
      expect((result as { isError?: boolean }).isError).toBeUndefined()
      const text = (result as { content: { text: string }[] }).content[0]!.text
      expect(text).not.toMatch(/denied|disabled|declined|not recorded|not sent|no access|gone/i)

      expect(worker.server.pendingRelayCount).toBe(0)
      await worker.server.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ================================================================================================
// (e) — turn-boundary-preferred flip: defer a mid-turn restart to the next turn boundary; flip if idle
// ================================================================================================

describe('(e) turn-boundary-preferred flip (§8.4 optimization)', () => {
  const tmps: string[] = []
  const dbs: Journal[] = []
  afterEach(async () => {
    // A turnCompleted → idle transition schedules deliverBus via setImmediate; let it run (with the DB still
    // open — empty bus, so it no-ops) before we close, so a late immediate can't hit a closed connection.
    await new Promise((r) => setImmediate(r))
    for (const j of dbs) j.db.close()
    dbs.length = 0
    for (const t of tmps) fs.rmSync(t, { recursive: true, force: true })
    tmps.length = 0
  })

  interface DeferHub {
    sessions: SessionManager
    busy: Set<string>
    restarts: Array<{ reason: string; by?: string }>
    seed(id: string, status: SessionStatus): void
  }
  function build(): DeferHub {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-step7e-'))
    tmps.push(tmp)
    const journal = new Journal(path.join(tmp, 'hub.db'))
    dbs.push(journal)
    const store = new SessionStore(journal.db)
    const busy = new Set<string>()
    const fakeExecutor: Executor = {
      startThread: async () => 'tid',
      runTurn: async () => {},
      steer: async () => {},
      interrupt: async () => {},
      stopSession: async () => {},
      readCodexLimits: async () => ({}),
      listLive: async () => [],
      attach: async () => {},
      isBusy: (id) => busy.has(id), // a non-InProcess executor → worker mode, so requestRestart may defer
    }
    const profiles = new Map<string, Profile>([['p1', { id: 'p1', provider: 'claude', dir: path.join(tmp, 'p1') }]])
    const sessions = new SessionManager(
      journal,
      store,
      profiles,
      new ApprovalService(journal),
      new UsageMonitor(journal, [], {}),
      new WorkspaceManager(path.join(tmp, 'wt')),
      new ProjectStore(journal.db),
      new InstructionStore(journal.db),
      new AgentBus(journal.db),
      new MemoryStore(journal.db),
      new PracticeStore(journal.db),
      SAFE,
      false,
      tmp,
      new QuestionService(journal),
      fakeExecutor
    )
    const restarts: Array<{ reason: string; by?: string }> = []
    sessions.setRestartSignal((reason, by) => restarts.push({ reason, by }))
    const seed = (id: string, status: SessionStatus): void => {
      const rec: SessionRecord = { id, profileId: 'p1', provider: 'claude', status, cwd: os.tmpdir(), createdAt: new Date().toISOString() }
      store.upsert(rec)
      sessions.loadRecords()
    }
    return { sessions, busy, restarts, seed }
  }

  it('flips IMMEDIATELY when the whole roster is idle', () => {
    const h = build()
    h.seed('s1', 'idle')
    expect(h.sessions.requestRestart('op idle')).toBe(true)
    expect(h.restarts).toEqual([{ reason: 'op idle', by: undefined }])
  })

  it('DEFERS a mid-turn restart, then flips at the next turnCompleted once idle', () => {
    const h = build()
    h.seed('s1', 'active')
    h.busy.add('s1') // s1 is mid-turn
    expect(h.sessions.requestRestart('op busy')).toBe(true)
    expect(h.restarts).toEqual([]) // deferred — NOT signalled while a turn is live

    // The turn completes: the worker's lifecycle clears busy first, then applyLifecycle hits the boundary.
    h.busy.delete('s1')
    h.sessions.applyLifecycle({ t: 'turnCompleted', sessionId: 's1', wseq: 1 })
    expect(h.restarts).toEqual([{ reason: 'op busy', by: undefined }]) // flipped at the boundary
  })

  it('keeps deferring while ANOTHER session is still mid-turn', () => {
    const h = build()
    h.seed('s1', 'active')
    h.seed('s2', 'active')
    h.busy.add('s1')
    h.busy.add('s2')
    h.sessions.requestRestart('op two')

    h.busy.delete('s1')
    h.sessions.applyLifecycle({ t: 'turnCompleted', sessionId: 's1', wseq: 1 })
    expect(h.restarts).toEqual([]) // s2 still busy → keep waiting

    h.busy.delete('s2')
    h.sessions.applyLifecycle({ t: 'turnError', sessionId: 's2', wseq: 1, message: 'x' })
    expect(h.restarts).toEqual([{ reason: 'op two', by: undefined }]) // both boundaries reached → flip
  })

  it('flips anyway after the max-defer even if a turn is still running', () => {
    vi.useFakeTimers()
    try {
      const h = build()
      h.seed('s1', 'active')
      h.busy.add('s1')
      h.sessions.requestRestart('op stuck')
      expect(h.restarts).toEqual([])
      vi.advanceTimersByTime(RESTART_MAX_DEFER_MS) // the max-defer elapses while s1 is STILL busy
      expect(h.restarts).toEqual([{ reason: 'op stuck', by: undefined }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a replayed turnCompleted (re-attach) does NOT fire a deferred restart (only real boundaries do)', () => {
    const h = build()
    h.seed('s1', 'active')
    h.busy.add('s1')
    h.sessions.requestRestart('op busy')
    // A re-attach replays the buffered turnCompleted marker with replay:true — a status restore, not a real
    // turn boundary. It must not trip the deferred restart (and busy is still set anyway).
    h.sessions.applyLifecycle({ t: 'turnCompleted', sessionId: 's1', wseq: 1, replay: true })
    expect(h.restarts).toEqual([])
  })
})
