import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentWorker } from './agentWorker.js'
import { ATTACH_GAP_KIND, DEFAULT_MAX_PER_SESSION, WseqBuffer } from './wseqBuffer.js'
import { SessionManager } from './sessions.js'
import { Journal, WSEQ_RESET_KIND } from './journal.js'
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
import type { DangerFlags, Profile, Provider, SessionRecord, SessionStatus } from './types.js'

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
    // journal write) and carry replay:true (F2 — the hub restores status without re-journaling the already-
    // durable rows); vendor events replay AS events. Order + wseq are strictly preserved.
    expect(sent).toEqual([
      { t: 'turnStarted', sessionId: 's1', wseq: 1, replay: true },
      { t: 'event', sessionId: 's1', wseq: 2, kind: 'claude/text', payload: { text: 'a' } },
      { t: 'event', sessionId: 's1', wseq: 3, kind: 'claude/text', payload: { text: 'b' } },
      { t: 'turnCompleted', sessionId: 's1', wseq: 4, vendorSessionId: 'vendor-1', replay: true },
    ])
  })

  it('a turnError marker replays as a turnError lifecycle message carrying its message (replay-flagged)', () => {
    const w = makeWorker()
    w.emitTurnStarted('s1') //        wseq 1
    w.emitTurnError('s1', 'boom') //  wseq 2
    const sent = captureReplay(w)
    w.attach({ s1: 0 })
    expect(sent).toEqual([
      { t: 'turnStarted', sessionId: 's1', wseq: 1, replay: true },
      { t: 'turnError', sessionId: 's1', wseq: 2, message: 'boom', replay: true },
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

describe('worker/attach-gap — end-to-end overflow path (worker emits → hub journals; web tolerates it, §7.1)', () => {
  it('a ring overflow surfaces ONE gap marker the hub journals like any additive event, cursor + survivors intact', () => {
    // WORKER: emit past the ring so the oldest events are trimmed; a cursor-0 re-attach then spans the drop.
    const w = makeWorker()
    const N = DEFAULT_MAX_PER_SESSION + 5
    for (let i = 1; i <= N; i++) w.emitEvent('s1', 'claude/text', { i }) // retains wseq 6..N (oldest 5 trimmed)
    const sent = captureReplay(w)
    w.attach({ s1: 0 })

    // The worker forwards the synthetic sentinel as a GENERIC event (replayMessage's default arm), so the whole
    // replay is `event`s — there is no bespoke gap message type the hub would have to learn.
    expect(sent.every((m) => m.t === 'event')).toBe(true)
    const events = sent as Array<Extract<WorkerToHub, { t: 'event' }>>
    expect(events[0]).toMatchObject({ sessionId: 's1', wseq: 5, kind: ATTACH_GAP_KIND, payload: { droppedThrough: 5 } })

    // HUB: ingest the whole replay exactly as WorkerExecutor's onEvent → ingestWorkerEvent does on re-attach.
    const h = buildHub()
    seedRecord(h.store, 's1', 'active')
    h.sessions.loadRecords()
    const journaled: Array<{ kind: string; payload: unknown }> = []
    h.journal.on('event', (e) => {
      if (e.sessionId === 's1') journaled.push({ kind: e.kind, payload: e.payload })
    })
    for (const m of events) h.sessions.ingestWorkerEvent(m.sessionId, m.wseq, m.kind, m.payload)

    // The marker is journaled like ANY other kind — NOT special-cased or dropped. The unchanged journal→WS
    // path then relays it, and the web client tolerates the unknown kind via its `default: break` switch arm
    // (apps/web store.svelte.ts), so no web change is needed: the transcript shows a VISIBLE gap instead of
    // silently losing the trimmed span.
    const gapRows = journaled.filter((e) => e.kind === ATTACH_GAP_KIND)
    expect(gapRows).toHaveLength(1)
    expect(gapRows[0]!.payload).toEqual({ droppedThrough: 5 })

    // Exactly-once past the gap: every retained survivor (6..N) is journaled once and the durable re-attach
    // cursor lands on N — no duplicate, no silent loss beyond the single honest marker.
    expect(h.sessions.lastJournaledWseq('s1')).toBe(N)
    const vendorSeqs = journaled.filter((e) => e.kind === 'claude/text').map((e) => (e.payload as { i: number }).i)
    expect(vendorSeqs).toEqual(Array.from({ length: DEFAULT_MAX_PER_SESSION }, (_v, k) => k + 6)) // 6..N, once each
  })
})

describe('AgentWorker.listLive — status semantics mirror InProcessExecutor (§6)', () => {
  it('claude reflects driver.busy; a codex thread with NO live turn is idle', () => {
    const w = makeWorker()
    w.claudeDrivers.set('c-busy', { busy: true })
    w.claudeDrivers.set('c-idle', { busy: false })
    w.codexThreads.set('x-codex', 'thread-1') // a codex thread the worker still holds, but no turn running
    w.emitEvent('c-busy', 'claude/text', {}) // give a couple of sessions a non-zero head
    w.emitEvent('x-codex', 'codex/item', {})

    const byId = new Map(w.listLive().map((s) => [s.sessionId, s]))
    expect(byId.get('c-busy')).toMatchObject({ status: 'active', lastWseq: 1 }) // busy claude driver → active
    expect(byId.get('c-idle')).toMatchObject({ status: 'idle', lastWseq: 0 }) //   idle claude driver → idle
    expect(byId.get('x-codex')).toMatchObject({ status: 'idle', lastWseq: 1 }) //  warm thread, no turn → idle
  })

  /**
   * REGRESSION (Codex turns did not replay-survive a hub restart, contradicting §3.4).
   *
   * listLive used to hard-code EVERY codex session to 'idle'. SessionManager.attachWorker only builds a
   * replay cursor for sessions the worker reports 'active' — everything else takes setStatus(idle) and is
   * never passed to executor.attach(). So a codex turn that was mid-flight across a hub restart kept
   * running in the surviving app-server child and kept buffering events in the worker, and the successor
   * hub silently dropped that whole gap: no journal rows, no UI, and the chat sitting there idle while the
   * agent was demonstrably still working.
   *
   * That contradicted the documented goal head-on. docs/agent-worker-impl.md §3.4 claims Claude sub-agents
   * AND "Codex sub-tasks" survive "for free" and calls it "the single most valuable structural consequence
   * of the move" — but only the Claude half was ever wired up.
   *
   * `activeTurns` already tracked exactly this (added by emitTurnStarted, cleared by
   * emitTurnCompleted/emitTurnError); listLive just refused to read it for codex.
   */
  it('a codex session with a LIVE turn reports active, so the hub replays its gap (§3.4)', () => {
    const w = makeWorker()
    w.codexThreads.set('x-codex', 'thread-1')
    w.emitTurnStarted('x-codex') // a turn is in flight inside the app-server child
    w.emitEvent('x-codex', 'codex/item', {}) // …and it is still producing events across the seam

    const byId = new Map(w.listLive().map((s) => [s.sessionId, s]))
    expect(byId.get('x-codex')?.status).toBe('active')
  })

  /**
   * REGRESSION — a FAILED codex turn used to leave the session live forever.
   *
   * The adapter treats turn/error as terminal (it clears its own activeTurns for both completed and
   * error), but the worker emitted a lifecycle only for turn/completed. So on turn/error the session
   * stayed in activeTurns: the hub's busy set stayed set, "a turn is already in progress" refused every
   * later send, and — now that listLive derives codex status from activeTurns — a successor hub would
   * report the dead turn as active across every restart. A chat bricked by a turn that had already ended.
   */
  it('a codex turn/error ends the turn instead of leaving the session live forever', () => {
    const w = makeWorker()
    w.codexThreads.set('x-codex', 'thread-1')
    w.emitTurnStarted('x-codex')
    expect(new Map(w.listLive().map((s) => [s.sessionId, s])).get('x-codex')?.status).toBe('active')

    // The worker's own codex event path must translate the failure into a terminal lifecycle.
    w.emitTurnError('x-codex', 'boom')
    expect(new Map(w.listLive().map((s) => [s.sessionId, s])).get('x-codex')?.status).toBe('idle')
  })

  it('a codex session returns to idle once its turn completes or errors', () => {
    const w = makeWorker()
    w.codexThreads.set('done', 'thread-done')
    w.codexThreads.set('failed', 'thread-failed')
    w.emitTurnStarted('done')
    w.emitTurnCompleted('done')
    w.emitTurnStarted('failed')
    w.emitTurnError('failed', 'boom')

    const byId = new Map(w.listLive().map((s) => [s.sessionId, s]))
    expect(byId.get('done')?.status).toBe('idle')
    expect(byId.get('failed')?.status).toBe('idle')
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
  // Run a hook INSIDE executor.attach() — i.e. between attachWorker's liveIds snapshot and its stale sweep —
  // to interleave a worker-driven era-2 resumption in that exact window (N1's TOCTOU). null clears it.
  setOnAttach: (fn: ((since: Record<string, number>) => void | Promise<void>) | null) => void
  attachCalls: Array<Record<string, number>>
  // Every executor.runTurn the manager fired (e.g. a deliverBus-triggered 'bus' turn) — F2 asserts a
  // replayed idle does NOT start one.
  runTurnCalls: Array<{ sessionId: string; origin: 'operator' | 'bus' }>
  // Build a FRESH SessionManager (fresh in-memory sessions + ingestedWseq) over the SAME durable journal +
  // stores — a faithful stand-in for a SUCCESSOR hub process after a restart (F1's second-restart re-attach).
  rebuild: () => FakeHub
}

/** The durable, process-independent state a hub is built over — shared across a rebuild() so a successor
 *  SessionManager sees exactly the journal + stores its predecessor left behind. */
interface HubDeps {
  tmp: string
  journal: Journal
  store: SessionStore
  projects: ProjectStore
  approvals: ApprovalService
  usage: UsageMonitor
  workspace: WorkspaceManager
  instructions: InstructionStore
  bus: AgentBus
  memory: MemoryStore
  practices: PracticeStore
  profiles: Map<string, Profile>
}

/** Wire a fresh SessionManager (WORKER MODE — a non-InProcess executor routes boot()/reconcileStale to
 *  attachWorker, §6) over the given durable deps, with a FAKE executor whose listLive()/attach() the test
 *  controls and whose runTurn is recorded. */
function wireHub(deps: HubDeps): FakeHub {
  let liveToReturn: LiveSession[] = []
  let onAttach: ((since: Record<string, number>) => void | Promise<void>) | null = null
  const attachCalls: Array<Record<string, number>> = []
  const runTurnCalls: Array<{ sessionId: string; origin: 'operator' | 'bus' }> = []
  const fakeExecutor: Executor = {
    startThread: async () => 'tid',
    runTurn: async (spec, _prompt, origin) => {
      runTurnCalls.push({ sessionId: spec.sessionId, origin })
    },
    steer: async () => {},
    interrupt: async () => {},
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => liveToReturn,
    attach: async (since) => {
      attachCalls.push(since)
      // Fire the test hook WHILE attach() is in flight — the window between attachWorker's liveIds snapshot
      // and its stale sweep (N1). Awaited so a resumption it drives is fully applied before the sweep runs.
      if (onAttach) await onAttach(since)
    },
    isBusy: () => false,
  }
  const sessions = new SessionManager(deps.journal, deps.store, deps.profiles, deps.approvals, deps.usage, deps.workspace, deps.projects, deps.instructions, deps.bus, deps.memory, deps.practices, SAFE, false, deps.tmp, fakeExecutor)
  return { journal: deps.journal, store: deps.store, sessions, setLive: (l) => (liveToReturn = l), setOnAttach: (fn) => (onAttach = fn), attachCalls, runTurnCalls, rebuild: () => wireHub(deps) }
}

/** A SessionManager wired to a FAKE executor whose listLive()/attach() the test controls. A non-InProcess
 *  executor puts the manager in WORKER MODE, so boot()/reconcileStale route to attachWorker (§6). */
function buildHub(): FakeHub {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-attach-'))
  const journal = new Journal(path.join(tmp, 'hub.db'))
  const deps: HubDeps = {
    tmp,
    journal,
    store: new SessionStore(journal.db),
    projects: new ProjectStore(journal.db),
    approvals: new ApprovalService(journal),
    usage: new UsageMonitor(journal, [], {}),
    workspace: new WorkspaceManager(path.join(tmp, 'wt')),
    instructions: new InstructionStore(journal.db),
    bus: new AgentBus(journal.db),
    memory: new MemoryStore(journal.db),
    practices: new PracticeStore(journal.db),
    // A profile for the seeded records so a deliverBus-built spec resolves (profileOf) in the F2 bus test.
    profiles: new Map<string, Profile>([['p1', { id: 'p1', provider: 'claude', dir: path.join(tmp, 'p1') }]]),
  }
  cleanups.push(() => {
    journal.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  return wireHub(deps)
}

function seedRecord(store: SessionStore, id: string, status: SessionStatus, provider: Provider = 'claude', projectId?: string): void {
  const rec: SessionRecord = { id, profileId: 'p1', provider, projectId, cwd: os.tmpdir(), status, createdAt: new Date().toISOString() }
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

  // THE PRODUCTION OUTAGE (2026-07-25). The test above covers a respawn while the record is still 'active'.
  // But when a worker actually DIES, its exit handling flips sessions to idle/error BEFORE the hub
  // re-attaches — so the sweep's old `status === 'active' || 'starting'` test failed, the in-memory guard
  // survived from the dead era, and EVERY event of every later turn compared <= it and was dropped. Agents
  // ran, tools worked, and nothing they said ever reached the journal or the UI for ~22 minutes. The reset
  // must therefore key on "the worker does not hold this session", never on the session's status.
  it('clears the guard for a session ALREADY flipped idle by the worker exit (silent-output regression)', async () => {
    const h = buildHub()
    seedRecord(h.store, 's', 'active')
    h.sessions.loadRecords()
    for (let wq = 1; wq <= 165; wq++) h.sessions.ingestWorkerEvent('s', wq, 'claude/text', { mark: `old${wq}` })
    h.setLive([{ sessionId: 's', status: 'active', lastWseq: 165 }])
    await h.sessions.attachWorker()

    // The worker dies. Its exit path fails the in-flight session FIRST, so the record is NOT active by the
    // time the hub re-attaches to the respawned worker — the case the original reset silently skipped.
    h.sessions.applyLifecycle({ t: 'turnError', sessionId: 's', wseq: 166, message: 'codex app-server exited (1) mid-turn' })
    h.setLive([])
    await h.sessions.attachWorker()

    // The fresh worker's first events (wseq 1, 2 — far below the dead era's 165) MUST be journaled.
    h.sessions.ingestWorkerEvent('s', 1, 'claude/text', { mark: 'fresh1' })
    h.sessions.ingestWorkerEvent('s', 2, 'claude/text', { mark: 'fresh2' })
    const marks = h.journal
      .since(0)
      .filter((e) => e.sessionId === 's')
      .map((e) => (e.payload as { mark?: string }).mark)
    expect(marks).toContain('fresh1')
    expect(marks).toContain('fresh2')
  })

  // THE OTHER HALF OF THE SAME OUTAGE. The stale sweep used to set `record.status = 'idle'` directly and
  // journal only a `session/restored-stale` note. Clients react to `session/status` and nothing else, so
  // every open UI stayed pinned on "active" for a turn that no longer existed — the chat looked frozen,
  // the operator hit Stop, and (before reopen() existed) that was a permanent brick. A stale sweep MUST
  // emit a client-visible status event, not just mutate the record.
  it('journals a client-visible session/status when a worker death sweeps a session stale', async () => {
    const h = buildHub()
    seedRecord(h.store, 's', 'active')
    h.sessions.loadRecords()
    h.setLive([{ sessionId: 's', status: 'active', lastWseq: 3 }])
    await h.sessions.attachWorker()

    h.setLive([]) // the worker died and respawned holding nothing
    await h.sessions.attachWorker()

    const forSession = h.journal.since(0).filter((e) => e.sessionId === 's')
    const statusEvents = forSession.filter((e) => e.kind === 'session/status')
    expect(statusEvents.length).toBeGreaterThan(0)
    expect((statusEvents.at(-1)!.payload as { status?: string }).status).toBe('idle')
    // The human-readable breadcrumb stays too — it explains WHY, but it is not what un-sticks a client.
    expect(forSession.some((e) => e.kind === 'session/restored-stale')).toBe(true)
    expect(h.sessions.list().find((r) => r.id === 's')!.status).toBe('idle')
    // And the durable baseline is rebased too, so a LATER hub restart cannot re-derive a cursor from the
    // dead era and swallow the fresh one all over again.
    expect(h.journal.since(0).some((e) => e.sessionId === 's' && e.kind === WSEQ_RESET_KIND)).toBe(true)
  })

  it('F1: a fresh post-respawn wseq sequence FOLLOWED BY a re-attach journals every fresh event exactly once', async () => {
    // The case the audit named as missing: a worker RESPAWN (wseq restarts at 1) and then a SECOND hub
    // restart. The successor re-derives since[sid] from the DURABLE cursor, so that cursor must reflect the
    // fresh worker era — not the stale, higher old-era MAX(wseq) that would drop the live turn's events.
    const h = buildHub()
    seedRecord(h.store, 's', 'active')
    h.sessions.loadRecords()

    // ERA 1 — a prior worker journaled this turn through wseq 5 on the first hub.
    for (let wq = 1; wq <= 5; wq++) h.sessions.ingestWorkerEvent('s', wq, 'claude/text', { era: 1, wq })
    h.setLive([{ sessionId: 's', status: 'active', lastWseq: 5 }])
    await h.sessions.attachWorker()
    expect(h.attachCalls.at(-1)).toEqual({ s: 5 })

    // The WORKER crashes + respawns → listLive() empty → 's' swept stale. The stale-sweep rebases the DURABLE
    // baseline (a WSEQ_RESET_KIND marker) so the next era is measured from 0 — matching the worker's restart.
    h.setLive([])
    await h.sessions.attachWorker()
    expect(h.sessions.list().find((r) => r.id === 's')!.status).toBe('idle')

    // ERA 2 — the session resumes on the FRESH worker, whose per-session wseq RESTARTS at 1.
    h.sessions.ingestWorkerEvent('s', 1, 'claude/text', { era: 2, wq: 1 })
    h.sessions.ingestWorkerEvent('s', 2, 'claude/text', { era: 2, wq: 2 })
    h.sessions.ingestWorkerEvent('s', 3, 'claude/text', { era: 2, wq: 3 })

    // THE F1 INVARIANT: the DURABLE re-attach cursor now reflects ERA 2 (max 3), NOT the contaminated old-era
    // max (5). Without the reset it would still read 5 (MAX over both eras) and drop the fresh turn's tail.
    expect(h.sessions.lastJournaledWseq('s')).toBe(3)

    // A SECOND hub restart. A SUCCESSOR hub (fresh in-memory ingestedWseq) re-attaches to the still-running
    // ERA-2 worker mid-turn, seeding since[s] from the durable cursor.
    const h2 = h.rebuild()
    h2.sessions.loadRecords()
    h2.setLive([{ sessionId: 's', status: 'active', lastWseq: 3 }])
    await h2.sessions.attachWorker()
    // Had the cursor stayed contaminated at 5, since[s] would be 5 and the whole ERA-2 tail (wseq ≤ 5) would
    // be DROPPED. With the reset it is 3, so the worker replays wseq > 3 and the live turn continues.
    expect(h2.attachCalls).toEqual([{ s: 3 }])

    // The worker replays wseq 4,5,6 (all > 3) → journaled EXACTLY ONCE on the successor; none dropped, none doubled.
    h2.sessions.ingestWorkerEvent('s', 4, 'claude/text', { era: 2, wq: 4 })
    h2.sessions.ingestWorkerEvent('s', 5, 'claude/text', { era: 2, wq: 5 })
    h2.sessions.ingestWorkerEvent('s', 6, 'claude/text', { era: 2, wq: 6 })
    expect(h2.sessions.lastJournaledWseq('s')).toBe(6)

    // Every ERA-2 event is present exactly once, in order — the fresh turn survived the respawn+restart boundary.
    const era2 = h2.journal
      .since(0)
      .filter((e) => e.sessionId === 's' && (e.payload as { era?: number }).era === 2)
      .map((e) => (e.payload as { wq: number }).wq)
    expect(era2).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('SessionManager.attachWorker — the three re-attach outcomes (§6)', () => {
  it('active→keep active; held sessions replay from durable cursors; idle→setStatus idle; unknown→restored-stale', async () => {
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
    expect(h.attachCalls).toEqual([{ active1: 3, idle1: 0 }])
    expect(journaled.some((e) => e.sid === 'active1' && e.kind === 'session/restored-stale')).toBe(false)

    // OUTCOME 2 — idle: setStatus(idle) flips + persists the record and journals a session/status.
    // It is also replayed from its durable cursor so output completed during the
    // hub gap is not stranded in the worker buffer.
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

  /**
   * REGRESSION — a re-attach revived a chat the operator had STOPPED.
   *
   * stop() interrupts and marks the record stopped but never drops the driver (only delete does), so the
   * worker goes on reporting the session. This loop then reconciled it straight back to 'idle' — on every
   * hub restart, needing no mid-turn timing at all. Worker liveness describes what the WORKER still
   * holds; it is not evidence about what the operator asked for. And since stop() has already removed the
   * worktree, a revived chat points at a directory that no longer exists.
   */
  it('never revives a STOPPED session, whatever the worker still holds', async () => {
    const h = buildHub()
    seedRecord(h.store, 'stopped-one', 'stopped')
    h.sessions.loadRecords()
    h.setLive([{ sessionId: 'stopped-one', status: 'idle', lastWseq: 3 }])

    await h.sessions.attachWorker()

    expect(h.sessions.list().find((r) => r.id === 'stopped-one')?.status).toBe('stopped')
    expect(h.attachCalls).toEqual([]) // and it is never asked to replay
    const revived = h.journal
      .since(0)
      .filter((e) => e.sessionId === 'stopped-one' && e.kind === 'session/status')
      .map((e) => (e.payload as { status?: string })?.status)
    expect(revived).not.toContain('idle')
  })

  it('never revives a stopped session even when the worker calls it active', async () => {
    const h = buildHub()
    seedRecord(h.store, 'stopped-two', 'stopped')
    h.sessions.loadRecords()
    h.setLive([{ sessionId: 'stopped-two', status: 'active', lastWseq: 5 }])

    await h.sessions.attachWorker()

    expect(h.sessions.list().find((r) => r.id === 'stopped-two')?.status).toBe('stopped')
    expect(h.attachCalls).toEqual([])
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

// ================================================================================================
// HUB SIDE — SessionManager.applyLifecycle() replayed markers are inert on the journal + bus (F2)
// ================================================================================================

/**
 * REGRESSION — Stop undid itself.
 *
 * Interrupting a turn does not delete the turn's terminal event: the vendor still reports how it ended,
 * and that arrives AFTER stop() has returned and marked the record 'stopped'. Both executors routed the
 * terminal through setStatusById unconditionally, so 'stopped' was flipped back to 'idle' — persisted and
 * journaled. Stop appeared to work, then quietly reverted.
 *
 * The consequences compose: idle schedules bus delivery, the web flushes queued messages on a completed
 * turn, and stop() has by then REMOVED the worktree — so a resurrected chat could start executing against
 * a directory that no longer exists.
 */
describe('SessionManager — an operator Stop survives the interrupted turn\'s own terminal event', () => {
  it('a late turnCompleted cannot move a stopped session back to idle', () => {
    const h = buildHub()
    seedRecord(h.store, 's', 'stopped')
    h.sessions.loadRecords()

    h.sessions.applyLifecycle({ t: 'turnCompleted', sessionId: 's', wseq: 7 })

    expect(h.sessions.list().find((r) => r.id === 's')?.status).toBe('stopped')
    const statuses = h.journal
      .since(0)
      .filter((e) => e.sessionId === 's' && e.kind === 'session/status')
      .map((e) => (e.payload as { status?: string })?.status)
    expect(statuses).not.toContain('idle')
  })

  /**
   * The status is only half of it. Fencing setStatusById alone still left applyLifecycle journaling a
   * durable `session/error` for a chat the operator had deliberately stopped — a red card that replays
   * forever, which is the exact "error beside something I stopped on purpose" symptom. The first version
   * of this test asserted only the status and passed while the transcript still lied.
   */
  it('a late turnError neither errors a stopped session NOR journals a red card for it', () => {
    const h = buildHub()
    seedRecord(h.store, 's', 'stopped')
    h.sessions.loadRecords()
    const errorRows = (): number => h.journal.since(0).filter((e) => e.sessionId === 's' && e.kind === 'session/error').length
    const before = errorRows()

    h.sessions.applyLifecycle({ t: 'turnError', sessionId: 's', wseq: 8, message: 'boom' })

    expect(h.sessions.list().find((r) => r.id === 's')?.status).toBe('stopped')
    expect(errorRows()).toBe(before) // no durable error card for an intentional stop
  })

  /** A live session must still report its failures — the fence is about stopped chats, not about errors. */
  it('still journals a real error for a session that was not stopped', () => {
    const h = buildHub()
    seedRecord(h.store, 'live', 'active')
    h.sessions.loadRecords()

    h.sessions.applyLifecycle({ t: 'turnError', sessionId: 'live', wseq: 8, message: 'boom' })

    expect(h.sessions.list().find((r) => r.id === 'live')?.status).toBe('error')
    expect(h.journal.since(0).filter((e) => e.sessionId === 'live' && e.kind === 'session/error')).toHaveLength(1)
  })

  /**
   * A rejected second send must leave NO trace. The busy guard used to test only Claude (its driver is
   * the only one exposing a busy flag), so a second Codex send was journaled and auto-titled, answered
   * {ok:true}, and then had its rejection caught internally — clearing busy and marking the FIRST,
   * still-running turn as errored. The record's own status is the vendor-independent fact.
   */
  it('rejects a send while a turn is in progress when mid-turn steering is off, before journaling anything', async () => {
    const h = buildHub()
    ;(h.sessions as unknown as { prefs: { chatNamePool: 'everyone'; steerMessagesAtToolBoundary: boolean } }).prefs = {
      chatNamePool: 'everyone',
      steerMessagesAtToolBoundary: false,
    }
    seedRecord(h.store, 'busy-one', 'active')
    h.sessions.loadRecords()
    const before = h.journal.since(0).length

    await expect(h.sessions.send('busy-one', 'second prompt')).rejects.toThrow(/already in progress/)

    // No session/input, no auto-title, no override persistence — nothing at all.
    expect(h.journal.since(0).length).toBe(before)
  })

  /** Un-stopping stays an explicit operator action: reopen() goes through setStatus, not the fence. */
  it('reopen still un-stops the session', () => {
    const h = buildHub()
    seedRecord(h.store, 's', 'stopped')
    h.sessions.loadRecords()

    h.sessions.reopen('s')

    expect(h.sessions.list().find((r) => r.id === 's')?.status).toBe('idle')
  })
})

describe('SessionManager.applyLifecycle — replayed markers do not re-journal or start a bus turn (F2)', () => {
  it('a re-attach does NOT duplicate session/status | session/error rows', async () => {
    const h = buildHub()
    seedRecord(h.store, 's', 'active')
    h.sessions.loadRecords()

    const statusRows = (): number =>
      h.journal.since(0).filter((e) => e.sessionId === 's' && (e.kind === 'session/status' || e.kind === 'session/error')).length

    // LIVE lifecycle from the prior hub: turnStarted→active (1 session/status), turnError→error (1
    // session/error + 1 session/status) = 3 durable rows.
    h.sessions.applyLifecycle({ t: 'turnStarted', sessionId: 's', wseq: 1 })
    h.sessions.applyLifecycle({ t: 'turnError', sessionId: 's', wseq: 9, message: 'boom' })
    expect(statusRows()).toBe(3)

    // RE-ATTACH: the worker re-emits the SAME markers flagged replay:true. They restore in-memory status but
    // must NOT append duplicate (out-of-temporal-order) rows — those are already durable from the prior hub.
    h.sessions.applyLifecycle({ t: 'turnStarted', sessionId: 's', wseq: 1, replay: true })
    h.sessions.applyLifecycle({ t: 'turnError', sessionId: 's', wseq: 9, message: 'boom', replay: true })
    expect(statusRows()).toBe(3) // unchanged — no duplicate session/status | session/error rows
    expect(h.sessions.list().find((r) => r.id === 's')!.status).toBe('error') // final status still correct
  })

  it('a replayed turnCompleted vendorSessionId is still persisted (final vendorSessionId stays correct)', async () => {
    const h = buildHub()
    seedRecord(h.store, 's', 'active')
    h.sessions.loadRecords()
    h.sessions.applyLifecycle({ t: 'turnCompleted', sessionId: 's', wseq: 4, vendorSessionId: 'vendor-xyz', replay: true })
    expect(h.store.all().find((r) => r.id === 's')!.vendorSessionId).toBe('vendor-xyz')
  })

  it('a replayed idle does NOT start a bus turn; a LIVE idle still flushes the queue', async () => {
    const h = buildHub()
    // This regression is specifically about the historical idle-only delivery lane. Keep steering off so
    // the active busSend remains queued and the replay-vs-live idle distinction stays observable.
    ;(h.sessions as unknown as { prefs: { chatNamePool: 'everyone'; steerMessagesAtToolBoundary: boolean } }).prefs = {
      chatNamePool: 'everyone',
      steerMessagesAtToolBoundary: false,
    }
    seedRecord(h.store, 's', 'active', 'claude', 'proj1') // recipient, mid-turn → a bus message queues
    seedRecord(h.store, 't', 'idle', 'claude', 'proj1') //   a same-project teammate to send from
    h.sessions.loadRecords()

    // Queue a teammate message for 's'. It is ACTIVE, so deliverBus can't flush it now → it stays pending.
    expect(h.sessions.busSend('t', { kind: 'session', id: 's' }, 'hi', 'ping')).toEqual({ ok: true, delivered: 1 })

    // A REPLAYED turnCompleted (idle) must NOT schedule deliverBus — else it could start a clamped bus turn on
    // a session the worker is still driving mid-turn (the ordering hazard F2 calls out).
    h.sessions.applyLifecycle({ t: 'turnCompleted', sessionId: 's', wseq: 7, replay: true })
    await new Promise((r) => setImmediate(r)) // let any (wrongly) scheduled deliverBus run
    expect(h.runTurnCalls).toEqual([]) // no bus turn started
    expect(h.sessions.list().find((r) => r.id === 's')!.status).toBe('idle') // status restored in memory

    // Contrast — a LIVE idle transition DOES flush the same queued message into a clamped 'bus' turn, proving
    // the replayed idle was specifically gated (not that delivery is simply broken).
    h.sessions.applyLifecycle({ t: 'turnCompleted', sessionId: 's', wseq: 8 })
    await new Promise((r) => setImmediate(r))
    expect(h.runTurnCalls).toEqual([{ sessionId: 's', origin: 'bus' }])
  })
})

// ================================================================================================
// HUB SIDE — SessionManager.attachWorker() ingest guard never lowers on a raced double-attach (F3)
// ================================================================================================

describe('SessionManager.attachWorker — the ingest guard never lowers on a raced double-attach (F3)', () => {
  it('a second attach reading a stale-low cursor does NOT lower the guard (no re-journaled duplicates)', async () => {
    const h = buildHub()
    seedRecord(h.store, 's', 'active')
    h.sessions.loadRecords()

    // A run journaled + guarded this session's turn through wseq 8 (durable cursor 8, in-memory guard 8).
    for (let wq = 1; wq <= 8; wq++) h.sessions.ingestWorkerEvent('s', wq, 'claude/text', { wq })
    expect(h.sessions.lastJournaledWseq('s')).toBe(8)

    // Stage the green-flip race outcome: the DURABLE cursor reads LOW (0) for the next attach while the
    // in-memory guard is still HIGH (8). A WSEQ_RESET_KIND marker rebases the reset-aware MAX(wseq) query to 0
    // (the concurrent run's stale-low read) WITHOUT clearing the guard.
    h.journal.append('s', WSEQ_RESET_KIND, { reason: 'stage a stale-low cursor read' })
    expect(h.sessions.lastJournaledWseq('s')).toBe(0)

    // The racing second attach seeds since[s] from that low cursor (0). The guard must stay 8 — lowering it to
    // 0 would let the already-journaled wseq 1..8 re-flush and DUPLICATE. Math.max(guard=8, cursor=0) keeps 8.
    h.setLive([{ sessionId: 's', status: 'active', lastWseq: 8 }])
    await h.sessions.attachWorker()
    const guard = (h.sessions as unknown as { ingestedWseq: Map<string, number> }).ingestedWseq
    expect(guard.get('s')).toBe(8) // NOT lowered to the stale-low cursor (0)

    // Behavioral proof: a re-flush of an already-journaled wseq (6 ≤ 8) is still DROPPED, not re-journaled.
    const rows6 = (): number => h.journal.since(0).filter((e) => e.sessionId === 's' && (e.payload as { wq?: number }).wq === 6).length
    expect(rows6()).toBe(1)
    h.sessions.ingestWorkerEvent('s', 6, 'claude/text', { wq: 6 }) // a stale re-flush of an already-journaled event
    expect(rows6()).toBe(1) // guard held at 8 → the duplicate was dropped (had it lowered to 0, this would be 2)
  })
})

// ================================================================================================
// HUB SIDE — SessionManager.attachWorker() stale sweep re-verifies staleness at sweep time (N1)
// ================================================================================================

describe('SessionManager.attachWorker — the stale sweep never resets a session that resumed since the snapshot (N1)', () => {
  it('an era-2 resumption BETWEEN the liveIds snapshot and the sweep is NOT reset (no spurious marker; cursor keeps era-2; no duplicate re-journal)', async () => {
    const h = buildHub()
    // `keeper` is an unrelated session the worker still holds — it makes `since` non-empty so attachWorker
    // AWAITS executor.attach(), the exact window a respawned worker resumes `s` in. `s` was mid-turn when the
    // hub died and the worker RESPAWNED, so it is absent from the top-of-function snapshot → a stale-sweep
    // candidate — until it resumes a fresh era mid-attach.
    seedRecord(h.store, 'keeper', 'active')
    seedRecord(h.store, 's', 'active')
    h.sessions.loadRecords()
    // Top-of-function snapshot: the worker holds only `keeper`; `s` is absent (its era-1 driver is gone).
    h.setLive([{ sessionId: 'keeper', status: 'active', lastWseq: 0 }])

    // THE INTERLEAVE: while attachWorker is awaiting executor.attach({keeper:0}) — after the liveIds snapshot,
    // before the stale sweep — the fresh worker RESUMES `s` into ERA 2: turnStarted flips it active and wseq
    // 1,2 land in the journal. listLive now reports `s` live (the reality the stale top snapshot missed). This
    // is the single-call form of the green-flip double-fire: the resume lands inside the snapshot→sweep gap.
    h.setOnAttach(() => {
      h.sessions.applyLifecycle({ t: 'turnStarted', sessionId: 's', wseq: 1 }) // era-2 turn begins → s active
      h.sessions.ingestWorkerEvent('s', 1, 'claude/text', { era: 2, wq: 1 }) //   fresh wseq row journaled
      h.sessions.ingestWorkerEvent('s', 2, 'claude/text', { era: 2, wq: 2 }) //   fresh wseq row journaled
      h.setLive([
        { sessionId: 'keeper', status: 'active', lastWseq: 0 },
        { sessionId: 's', status: 'active', lastWseq: 2 }, // the worker now holds the resumed session
      ])
      h.setOnAttach(null) // one-shot — don't re-resume on any later attach
    })

    await h.sessions.attachWorker()

    // PROOF 1 — no spurious reset: the sweep re-checks a FRESH listLive() (now including `s`), so the resumed
    // session is skipped. Pre-fix the STALE snapshot journals a WSEQ_RESET_KIND for `s` AFTER its era-2 rows.
    const resetRows = h.journal.since(0).filter((e) => e.sessionId === 's' && e.kind === WSEQ_RESET_KIND)
    expect(resetRows).toHaveLength(0)

    // PROOF 2 — the durable re-attach cursor reflects ERA 2 (max wseq 2), NOT 0. A spurious reset appended
    // after the era-2 rows would rebase MAX(wseq WHERE seq > reset) to 0, hiding the live era.
    expect(h.sessions.lastJournaledWseq('s')).toBe(2)

    // PROOF 3 — `s` stays active across the seam; a spurious sweep would wrongly flip it idle (and could then
    // fire a clamped bus turn on a session the worker is still mid-turn on).
    expect(h.sessions.list().find((r) => r.id === 's')!.status).toBe('active')

    // PROOF 4 — a SUBSEQUENT re-attach (successor hub, fresh in-memory ingestedWseq) seeds since[s] from the
    // ERA-2 cursor (2) and does NOT re-journal the era-2 rows as duplicates. Pre-fix since would be 0 and the
    // worker's replay of wseq 1,2 would be re-journaled (the durable duplication N1 introduces).
    const h2 = h.rebuild()
    h2.sessions.loadRecords()
    h2.setLive([{ sessionId: 's', status: 'active', lastWseq: 2 }])
    await h2.sessions.attachWorker()
    expect(h2.attachCalls).toEqual([{ s: 2 }]) // replay only wseq > 2 — the era-2 rows are already durable

    // The worker re-flushes wseq 1,2 (≤ cursor) on replay → DROPPED; a genuinely new wseq 3 is journaled once.
    h2.sessions.ingestWorkerEvent('s', 1, 'claude/text', { era: 2, wq: 1 })
    h2.sessions.ingestWorkerEvent('s', 2, 'claude/text', { era: 2, wq: 2 })
    h2.sessions.ingestWorkerEvent('s', 3, 'claude/text', { era: 2, wq: 3 })
    const era2 = h2.journal
      .since(0)
      .filter((e) => e.sessionId === 's' && (e.payload as { era?: number }).era === 2)
      .map((e) => (e.payload as { wq: number }).wq)
    expect(era2).toEqual([1, 2, 3]) // each fresh event present exactly once — no duplicates from a spurious reset
  })
})
