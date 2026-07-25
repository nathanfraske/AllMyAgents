import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentWorker } from './agentWorker.js'
import { ATTACH_GAP_KIND, DEFAULT_MAX_PER_SESSION, WseqBuffer } from './wseqBuffer.js'
import { SessionManager } from './sessions.js'
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
import type { Executor } from './executor.js'
import type { LiveSession, WorkerToHub } from './workerProtocol.js'
import type { DangerFlags, Provider, SessionRecord, SessionStatus } from './types.js'

// STEP 5 (docs/agent-worker-impl.md §6 + §7.1): after a hub restart a fresh hub re-attaches to the still-
// running worker and the in-flight turn's events replay gap-free, exactly-once. These tests exercise BOTH
// halves with no live hub: the WORKER's attach() replay (gap-marked, wseq-verbatim, lifecycle-translated),
// and the HUB's attachWorker() reconcile (the durable exactly-once cursor + the three re-attach outcomes).

const SAFE: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: false, autoApproveRestart: false }

// ================================================================================================
// WORKER SIDE — AgentWorker.attach() / listLive() (socket-free; the buffer + replay work in-memory)
// ================================================================================================

/** The private worker internals these tests reach through, mirroring agentWorker.test.ts's typed cast. */
interface WorkerInternals {
  buf: WseqBuffer
  server: { send: (m: WorkerToHub) => void }
  claudeDrivers: Map<string, { busy: boolean }>
  codexThreads: Map<string, string>
  attach(since: Record<string, number>): void
  listLive(): LiveSession[]
  emitEvent(sessionId: string, kind: string, payload: unknown): void
  emitTurnStarted(sessionId: string): void
  emitTurnCompleted(sessionId: string, vendorSessionId?: string): void
  emitTurnError(sessionId: string, message: string): void
}

/** Construct an AgentWorker WITHOUT start() — no listener is bound, so the wseq buffer + attach replay run
 *  purely in-memory (the pipe path is never connected). Reach the private wiring through a typed cast. */
function makeWorker(): WorkerInternals {
  return new AgentWorker('\\\\.\\pipe\\ama-step5-never-bound') as unknown as WorkerInternals
}

/** Populate the buffer first (emit streams to nothing — no hub attached), THEN swap server.send for a
 *  recorder so attach()'s replay output is captured verbatim. */
function captureReplay(w: WorkerInternals): WorkerToHub[] {
  const sent: WorkerToHub[] = []
  w.server.send = (m: WorkerToHub): void => {
    sent.push(m)
  }
  return sent
}

const wseqOf = (m: WorkerToHub): number => (m as { wseq: number }).wseq

describe('AgentWorker.attach — gap-free, exactly-once replay (worker side, §7.1)', () => {
  it('replays ONLY wseq > since[sid] (the cursor is EXCLUSIVE — no dup, no skip)', () => {
    const w = makeWorker()
    for (let i = 1; i <= 6; i++) w.emitEvent('s1', 'claude/text', { i }) // wseq 1..6 buffered
    const sent = captureReplay(w)
    w.attach({ s1: 3 }) // the hub already durably journaled through wseq 3
    expect(sent.map(wseqOf)).toEqual([4, 5, 6])
    expect(sent.every((m) => m.t === 'event')).toBe(true)
  })

  it('translates WSEQ_TURN_* markers back to lifecycle messages; vendor events replay verbatim (wseq preserved)', () => {
    const w = makeWorker()
    w.emitTurnStarted('s1') //                          wseq 1  (a WSEQ_TURN_STARTED marker)
    w.emitEvent('s1', 'claude/text', { text: 'a' }) //  wseq 2
    w.emitEvent('s1', 'claude/text', { text: 'b' }) //  wseq 3
    w.emitTurnCompleted('s1', 'vendor-1') //            wseq 4  (a WSEQ_TURN_COMPLETED marker)
    const sent = captureReplay(w)
    w.attach({ s1: 0 }) // a fresh hub, nothing journaled yet
    // Markers replay AS their lifecycle messages (so the hub's applyLifecycle drives status, not a generic
    // journal write); vendor events replay AS events. Order + wseq are strictly preserved.
    expect(sent).toEqual([
      { t: 'turnStarted', sessionId: 's1', wseq: 1 },
      { t: 'event', sessionId: 's1', wseq: 2, kind: 'claude/text', payload: { text: 'a' } },
      { t: 'event', sessionId: 's1', wseq: 3, kind: 'claude/text', payload: { text: 'b' } },
      { t: 'turnCompleted', sessionId: 's1', wseq: 4, vendorSessionId: 'vendor-1' },
    ])
  })

  it('a turnError marker replays as a turnError lifecycle message carrying its message', () => {
    const w = makeWorker()
    w.emitTurnStarted('s1') //        wseq 1
    w.emitTurnError('s1', 'boom') //  wseq 2
    const sent = captureReplay(w)
    w.attach({ s1: 0 })
    expect(sent).toEqual([
      { t: 'turnStarted', sessionId: 's1', wseq: 1 },
      { t: 'turnError', sessionId: 's1', wseq: 2, message: 'boom' },
    ])
  })

  it('prefixes a worker/attach-gap event when the cursor predates the retained ring (drop-oldest)', () => {
    const w = makeWorker()
    const N = DEFAULT_MAX_PER_SESSION + 5
    for (let i = 1; i <= N; i++) w.emitEvent('s1', 'claude/text', { i }) // ring wraps; retains wseq 6..N
    const sent = captureReplay(w)
    w.attach({ s1: 0 }) // cursor 0 predates the retained floor (6) → a spanning replay

    // FIRST message is the synthetic gap sentinel (droppedThrough = oldestRetained - 1 = 5), forwarded as a
    // generic event so the hub journals a VISIBLE gap marker rather than silently losing the span.
    expect(sent[0]).toEqual({ t: 'event', sessionId: 's1', wseq: 5, kind: ATTACH_GAP_KIND, payload: { droppedThrough: 5 } })
    // THEN the retained survivors, in ascending wseq, no duplicates.
    expect(sent).toHaveLength(1 + DEFAULT_MAX_PER_SESSION)
    expect(sent[1]).toMatchObject({ t: 'event', wseq: 6 })
    expect(sent.at(-1)).toMatchObject({ t: 'event', wseq: N })
    const seqs = sent.map(wseqOf)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]) // strictly increasing
  })

  it('replay does NOT re-append to the buffer or bump wseq (the head is unchanged by a replay)', () => {
    const w = makeWorker()
    for (let i = 1; i <= 4; i++) w.emitEvent('s1', 'claude/text', { i })
    expect(w.buf.lastWseq('s1')).toBe(4)
    captureReplay(w)
    w.attach({ s1: 0 })
    w.attach({ s1: 0 }) // replay twice — still no new wseqs assigned
    expect(w.buf.lastWseq('s1')).toBe(4)
  })

  it('an unknown/never-seen session replays nothing', () => {
    const w = makeWorker()
    const sent = captureReplay(w)
    w.attach({ ghost: 0 })
    expect(sent).toEqual([])
  })
})

describe('AgentWorker.listLive — status semantics mirror InProcessExecutor (§6)', () => {
  it('claude reflects driver.busy; codex is ALWAYS idle across a re-attach', () => {
    const w = makeWorker()
    w.claudeDrivers.set('c-busy', { busy: true })
    w.claudeDrivers.set('c-idle', { busy: false })
    w.codexThreads.set('x-codex', 'thread-1') // a codex thread the worker still holds
    w.emitEvent('c-busy', 'claude/text', {}) // give a couple of sessions a non-zero head
    w.emitEvent('x-codex', 'codex/item', {})

    const byId = new Map(w.listLive().map((s) => [s.sessionId, s]))
    expect(byId.get('c-busy')).toMatchObject({ status: 'active', lastWseq: 1 }) // busy claude driver → active
    expect(byId.get('c-idle')).toMatchObject({ status: 'idle', lastWseq: 0 }) //   idle claude driver → idle
    expect(byId.get('x-codex')).toMatchObject({ status: 'idle', lastWseq: 1 }) //  codex → idle even mid-hold
  })
})

// ================================================================================================
// HUB SIDE — SessionManager.attachWorker() / ingestWorkerEvent() (real journal/store, FAKE executor)
// ================================================================================================

const cleanups: Array<() => void> = []
afterEach(async () => {
  // setStatus(idle) schedules deliverBus via setImmediate; flush it (a no-op with no queued messages) BEFORE
  // closing the db so a late delivery never touches a closed database.
  await new Promise((r) => setImmediate(r))
  for (const c of cleanups.splice(0)) c()
})

interface FakeHub {
  journal: Journal
  store: SessionStore
  sessions: SessionManager
  setLive: (l: LiveSession[]) => void
  attachCalls: Array<Record<string, number>>
}

/** A SessionManager wired to a FAKE executor whose listLive()/attach() the test controls. A non-InProcess
 *  executor puts the manager in WORKER MODE, so boot()/reconcileStale route to attachWorker (§6). */
function buildHub(): FakeHub {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-attach-'))
  const journal = new Journal(path.join(tmp, 'hub.db'))
  const store = new SessionStore(journal.db)
  const projects = new ProjectStore(journal.db)
  const approvals = new ApprovalService(journal)
  const usage = new UsageMonitor(journal, [], {})
  const workspace = new WorkspaceManager(path.join(tmp, 'wt'))
  const instructions = new InstructionStore(journal.db)
  const bus = new AgentBus(journal.db)
  const memory = new MemoryStore(journal.db)
  const practices = new PracticeStore(journal.db)

  let liveToReturn: LiveSession[] = []
  const attachCalls: Array<Record<string, number>> = []
  const fakeExecutor: Executor = {
    startThread: async () => 'tid',
    runTurn: async () => {},
    steer: async () => {},
    interrupt: async () => {},
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => liveToReturn,
    attach: async (since) => {
      attachCalls.push(since)
    },
    isBusy: () => false,
  }
  const sessions = new SessionManager(journal, store, new Map(), approvals, usage, workspace, projects, instructions, bus, memory, practices, SAFE, false, tmp, fakeExecutor)
  cleanups.push(() => {
    journal.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  return { journal, store, sessions, setLive: (l) => (liveToReturn = l), attachCalls }
}

function seedRecord(store: SessionStore, id: string, status: SessionStatus, provider: Provider = 'claude'): void {
  const rec: SessionRecord = { id, profileId: 'p1', provider, cwd: os.tmpdir(), status, createdAt: new Date().toISOString() }
  store.upsert(rec)
}

describe('SessionManager.attachWorker — the exactly-once replay cursor (hub side, §7.1)', () => {
  it('seeds the replay cursor from the durable lastJournaledWseq; replays wseq>cursor once, DROPS wseq<=cursor', async () => {
    const h = buildHub()
    seedRecord(h.store, 'active1', 'active')
    h.sessions.loadRecords()
    // The durable journal already reaches wseq 5 for active1 (a prior hub journaled its turn's first 5 events).
    for (let wq = 1; wq <= 5; wq++) h.sessions.ingestWorkerEvent('active1', wq, 'claude/text', { mark: `seed${wq}` })
    expect(h.sessions.lastJournaledWseq('active1')).toBe(5)

    // Re-attach: the worker reports active → attachWorker seeds since[sid] to the DURABLE cursor (5).
    h.setLive([{ sessionId: 'active1', status: 'active', lastWseq: 9 }])
    await h.sessions.attachWorker()
    expect(h.attachCalls).toEqual([{ active1: 5 }]) // the worker will replay only wseq > 5

    // The worker replays 6,7,8 (all > cursor) → journaled EXACTLY ONCE, advancing the cursor.
    h.sessions.ingestWorkerEvent('active1', 6, 'claude/text', { mark: 'six' })
    h.sessions.ingestWorkerEvent('active1', 7, 'claude/text', { mark: 'seven' })
    h.sessions.ingestWorkerEvent('active1', 8, 'claude/text', { mark: 'eight' })
    expect(h.sessions.lastJournaledWseq('active1')).toBe(8)

    // A stale/duplicate replay AT OR BELOW the cursor is dropped (defense-in-depth) — no double-write.
    h.sessions.ingestWorkerEvent('active1', 5, 'claude/text', { mark: 'DUP5' })
    h.sessions.ingestWorkerEvent('active1', 3, 'claude/text', { mark: 'DUP3' })
    h.sessions.ingestWorkerEvent('active1', 8, 'claude/text', { mark: 'DUP8' })
    expect(h.sessions.lastJournaledWseq('active1')).toBe(8) // unchanged — none re-journaled

    // Exactly the intended events reached the journal: the seed run, then 6/7/8 once each, no DUPs, no gaps.
    const marks = h.journal
      .since(0)
      .filter((e) => e.sessionId === 'active1')
      .map((e) => (e.payload as { mark?: string }).mark)
      .filter((m): m is string => !!m)
    expect(marks).toEqual(['seed1', 'seed2', 'seed3', 'seed4', 'seed5', 'six', 'seven', 'eight'])
  })

  it('after a session is swept stale, a fresh worker wseq sequence is journaled (not skipped as a duplicate)', async () => {
    const h = buildHub()
    seedRecord(h.store, 's', 'active')
    h.sessions.loadRecords()
    // A prior worker journaled through wseq 4; this hub re-attaches to it (seeding the in-memory high-water mark).
    for (let wq = 1; wq <= 4; wq++) h.sessions.ingestWorkerEvent('s', wq, 'claude/text', { mark: `old${wq}` })
    h.setLive([{ sessionId: 's', status: 'active', lastWseq: 4 }])
    await h.sessions.attachWorker()
    expect(h.attachCalls).toEqual([{ s: 4 }])

    // The WORKER crashes + respawns: listLive() is now empty → 's' is swept stale (its cursor is dropped).
    h.setLive([])
    await h.sessions.attachWorker()
    expect(h.sessions.list().find((r) => r.id === 's')!.status).toBe('idle')

    // Its next turn runs on the FRESH worker, whose per-session wseq RESTARTS at 1. These must journal (NOT
    // be swallowed as <= the old durable max of 4) — the guard must never drop a legitimate fresh sequence.
    h.sessions.ingestWorkerEvent('s', 1, 'claude/text', { mark: 'new1' })
    h.sessions.ingestWorkerEvent('s', 2, 'claude/text', { mark: 'new2' })
    const marks = h.journal
      .since(0)
      .filter((e) => e.sessionId === 's')
      .map((e) => (e.payload as { mark?: string }).mark)
    expect(marks).toContain('new1')
    expect(marks).toContain('new2')
  })
})

describe('SessionManager.attachWorker — the three re-attach outcomes (§6)', () => {
  it('active→keep active + replay from the durable cursor; idle→setStatus idle; unknown→restored-stale', async () => {
    const h = buildHub()
    seedRecord(h.store, 'active1', 'active') // worker holds it, still busy → kept active + replayed
    seedRecord(h.store, 'idle1', 'active') //   worker holds it, no live turn → flipped to idle
    seedRecord(h.store, 'stale1', 'active') //  worker never heard of it (or respawned fresh) → restored-stale
    h.sessions.loadRecords()
    for (let wq = 1; wq <= 3; wq++) h.sessions.ingestWorkerEvent('active1', wq, 'claude/text', {}) // durable cursor 3

    const journaled: Array<{ sid: string | null; kind: string }> = []
    h.journal.on('event', (e) => journaled.push({ sid: e.sessionId, kind: e.kind }))

    h.setLive([
      { sessionId: 'active1', status: 'active', lastWseq: 5 },
      { sessionId: 'idle1', status: 'idle', lastWseq: 2 },
      // stale1 is deliberately absent — the worker has no live driver for it.
    ])
    await h.sessions.attachWorker()

    const rec = (id: string): SessionRecord => h.sessions.list().find((r) => r.id === id)!
    const persisted = (id: string): SessionRecord => h.store.all().find((r) => r.id === id)!

    // OUTCOME 1 — active: kept active across the seam; attach called with its DURABLE cursor; NOT restored-stale.
    expect(rec('active1').status).toBe('active')
    expect(h.attachCalls).toEqual([{ active1: 3 }])
    expect(journaled.some((e) => e.sid === 'active1' && e.kind === 'session/restored-stale')).toBe(false)

    // OUTCOME 2 — idle: setStatus(idle) flips + persists the record and journals a session/status.
    expect(rec('idle1').status).toBe('idle')
    expect(persisted('idle1').status).toBe('idle')
    expect(journaled).toContainEqual({ sid: 'idle1', kind: 'session/status' })

    // OUTCOME 3 — unknown: the Phase-1 restored-stale path — idle + a session/restored-stale journal + persist.
    expect(rec('stale1').status).toBe('idle')
    expect(persisted('stale1').status).toBe('idle')
    expect(journaled).toContainEqual({ sid: 'stale1', kind: 'session/restored-stale' })
  })

  it('in worker mode reconcileStale re-attaches instead of blunt-sweeping (the green promote() clobber fix)', async () => {
    const h = buildHub()
    seedRecord(h.store, 'live1', 'active')
    h.sessions.loadRecords()
    for (let wq = 1; wq <= 2; wq++) h.sessions.ingestWorkerEvent('live1', wq, 'claude/text', {})
    h.setLive([{ sessionId: 'live1', status: 'active', lastWseq: 4 }])
    // A promoted green calls reconcileStale() from restartController.promote. In worker mode it MUST route to
    // attachWorker (re-attach), NOT flip the live mid-turn session to idle — which would undo the re-attach.
    h.sessions.reconcileStale()
    await new Promise((r) => setImmediate(r)) // let the async attachWorker settle
    expect(h.sessions.list().find((r) => r.id === 'live1')!.status).toBe('active') // NOT clobbered to idle
    expect(h.attachCalls).toEqual([{ live1: 2 }]) // re-attached + replays from the durable cursor
  })

  it('cold start (worker holds nothing): attach is skipped and every active|starting record is restored-stale', async () => {
    const h = buildHub()
    seedRecord(h.store, 'a', 'active')
    seedRecord(h.store, 'b', 'starting')
    seedRecord(h.store, 'c', 'idle') // already idle — untouched
    h.sessions.loadRecords()
    h.setLive([]) // the worker just booted and holds nothing

    await h.sessions.attachWorker()

    expect(h.attachCalls).toEqual([]) // nothing to replay — attachWorker gracefully IS reconcileStale
    expect(h.sessions.list().find((r) => r.id === 'a')!.status).toBe('idle')
    expect(h.sessions.list().find((r) => r.id === 'b')!.status).toBe('idle')
    expect(h.sessions.list().find((r) => r.id === 'c')!.status).toBe('idle')
  })

  it('ignores a live session the hub has no record for (worker holds one we deleted)', async () => {
    const h = buildHub()
    seedRecord(h.store, 'known', 'active')
    h.sessions.loadRecords()
    h.setLive([
      { sessionId: 'known', status: 'active', lastWseq: 1 },
      { sessionId: 'ghost', status: 'active', lastWseq: 1 }, // no hub record → skipped, never in `since`
    ])
    await h.sessions.attachWorker()
    expect(h.attachCalls).toEqual([{ known: 0 }]) // only the known session; ghost is ignored
    expect(h.sessions.list().map((r) => r.id)).toEqual(['known'])
  })
})
