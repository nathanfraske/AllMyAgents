import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { store } from './store.svelte'
import { loadLastLayout, saveLastLayout } from './uiState'
import type { HubEvent, SessionRecord } from './api'

// The store imports ./api (real network / WebSocket) and ./settings.svelte (localStorage).
// We mock ./api entirely so nothing hits the wire; settings runs for real against jsdom's
// localStorage (empty -> defaults), which is enough. HUB_WS is exported for the store's
// wsBase(); we never open a socket in these tests, but the symbol must resolve.
vi.mock('./api', () => {
  const ok = async () => ({ ok: true })
  return {
    HUB_HTTP: '',
    HUB_WS: '',
    api: {
      profiles: vi.fn(async () => []),
      projects: vi.fn(async () => []),
      prefs: vi.fn(async () => ({ chatNamePool: 'everyone', steerMessagesAtToolBoundary: true })),
      setPrefs: vi.fn(async (patch: Record<string, unknown>) => ({
        chatNamePool: 'everyone',
        steerMessagesAtToolBoundary: true,
        ...patch,
      })),
      approvals: vi.fn(async () => []),
      usage: vi.fn(async () => []),
      sessions: vi.fn(async () => []),
      spawn: vi.fn(async () => rec('spawned')),
      send: vi.fn(ok),
      stop: vi.fn(ok),
      deleteSession: vi.fn(ok),
    },
  }
})

describe('owner preferences', () => {
  it('defaults mid-turn steering on and applies a live preference update without restarting', async () => {
    expect(store.prefs.steerMessagesAtToolBoundary).toBe(true)

    await store.setPrefs({ steerMessagesAtToolBoundary: false })

    expect(store.prefs.steerMessagesAtToolBoundary).toBe(false)
    expect(api.setPrefs).toHaveBeenCalledWith({ steerMessagesAtToolBoundary: false })
  })
})

// --- helpers -------------------------------------------------------------------------------

function rec(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    profileId: 'p1',
    provider: 'claude',
    cwd: '/work',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

// Seed a session directly into the store (bypassing the network) so pane / removal logic has
// something to operate on. `lastActivity` is staggered by index so sessionList ordering is
// deterministic (newest first).
let seedN = 0
function seed(id: string, over: Partial<SessionRecord> = {}): void {
  const ts = `2026-01-01T00:00:${String(10 + seedN++).padStart(2, '0')}.000Z`
  store.sessions[id] = { record: rec(id, over), items: [], lastActivity: ts, sawReasoning: false }
}

// Snapshot the reactive panes getter as plain arrays (strip the Svelte state proxy) so toEqual
// compares structurally.
function panes(): string[][] {
  return store.panes.map((r) => [...r])
}

// apply() is private on the class but present at runtime; drive it directly for event tests.
function apply(event: HubEvent): void {
  ;(store as unknown as { apply(e: HubEvent): void }).apply(event)
}

function evt(over: Partial<HubEvent> & { seq: number; kind: string }): HubEvent {
  return { ts: '2026-01-01T00:00:05.000Z', sessionId: null, payload: undefined, ...over }
}

// Reset the singleton between tests — it persists across the file. localStorage is cleared too so
// the layout-persistence tests don't leak stored state into one another.
beforeEach(() => {
  localStorage.clear()
  store.sessions = {}
  store.queues = {}
  store.selectedId = null
  store.splitPanes = []
  store.lastLayout = null
  store.restorableLayout = null
  store.lastSeq = 0
  store.profiles = []
  store.projects = []
  store.approvals = []
  store.usage = []
  store.prefs = { chatNamePool: 'everyone', steerMessagesAtToolBoundary: true }
  store.dragSession = null
  store.dropZone = null
  store.connected = false
  store.settingsOpen = false
  store.lastProfileId = null
  vi.stubGlobal('alert', vi.fn())
  seedN = 0
})

// --- harness sanity: proves runes compiled & are reactive -----------------------------------

describe('harness', () => {
  it('boots the runes store singleton with an empty layout', () => {
    expect(store).toBeDefined()
    expect(store.selectedId).toBeNull()
    expect(panes()).toEqual([])
  })
})

// --- pane math (the 2D split logic that regressed) ------------------------------------------

describe('basePanes / panes derivation', () => {
  it('is empty on the dashboard (no selection, no split)', () => {
    expect(panes()).toEqual([])
  })

  it('derives a single pane from selectedId when not split', () => {
    store.selectedId = 'a'
    expect(panes()).toEqual([['a']])
  })

  it('uses splitPanes verbatim when split', () => {
    store.splitPanes = [['a', 'b'], ['c']]
    expect(panes()).toEqual([['a', 'b'], ['c']])
  })
})

describe('dropAt', () => {
  it('from the dashboard just opens the chat (no split)', () => {
    store.selectedId = null
    store.splitPanes = []
    store.dropAt({ kind: 'col', row: 0, col: 0 }, 'a')
    expect(store.selectedId).toBe('a')
    expect(store.splitPanes).toEqual([])
    expect(panes()).toEqual([['a']])
  })

  it('col-right adds a second column (classic horizontal split)', () => {
    store.selectedId = 'a' // base = [[a]]
    store.dropAt({ kind: 'col', row: 0, col: 1 }, 'b')
    expect(panes()).toEqual([['a', 'b']])
    expect(store.selectedId).toBe('a')
  })

  it('col-left inserts before the existing column', () => {
    store.selectedId = 'a'
    store.dropAt({ kind: 'col', row: 0, col: 0 }, 'b')
    expect(panes()).toEqual([['b', 'a']])
  })

  it('row-above inserts a new row before', () => {
    store.selectedId = 'a'
    store.dropAt({ kind: 'row', row: 0 }, 'b')
    expect(panes()).toEqual([['b'], ['a']])
    expect(store.selectedId).toBe('b') // primary pane follows row0col0
  })

  it('row-below inserts a new row after', () => {
    store.selectedId = 'a'
    store.dropAt({ kind: 'row', row: 1 }, 'b')
    expect(panes()).toEqual([['a'], ['b']])
    expect(store.selectedId).toBe('a')
  })

  it('clamps an out-of-range column index into the target row', () => {
    store.splitPanes = [['a', 'b']]
    store.dropAt({ kind: 'col', row: 0, col: 99 }, 'c')
    expect(panes()).toEqual([['a', 'b', 'c']])
  })

  it('clamps an out-of-range row index to append a new row', () => {
    store.splitPanes = [['a']]
    store.dropAt({ kind: 'row', row: 99 }, 'b')
    expect(panes()).toEqual([['a'], ['b']])
  })
})

describe('commit (via dropAt / closePane)', () => {
  it('collapses back to a single pane when only one remains', () => {
    store.splitPanes = [['a', 'b']]
    store.closePane(1) // remove b -> [[a]] -> collapse
    expect(store.splitPanes).toEqual([])
    expect(store.selectedId).toBe('a')
    expect(panes()).toEqual([['a']])
  })

  it('clears selectedId to null (dashboard) when the last pane closes', () => {
    store.selectedId = 'a' // base = [[a]], not in split mode
    store.closePane(0)
    expect(store.splitPanes).toEqual([])
    expect(store.selectedId).toBeNull()
    expect(panes()).toEqual([])
  })

  it('drops emptied rows and keeps the multi-pane layout otherwise', () => {
    store.splitPanes = [['a', 'b'], ['c']]
    store.closePane(2) // flat index 2 -> row1col0 = c ; row1 becomes empty and is dropped
    expect(panes()).toEqual([['a', 'b']])
    expect(store.selectedId).toBe('a')
  })
})

describe('coord mapping (row-major flat index -> row/col)', () => {
  it('maps a flat index that spans into the second row', () => {
    store.splitPanes = [['a', 'b'], ['c', 'd']]
    store.closePane(3) // 0:a 1:b 2:c 3:d -> removes d
    expect(panes()).toEqual([['a', 'b'], ['c']])
  })

  it('maps a flat index inside the first row', () => {
    store.splitPanes = [['a', 'b'], ['c', 'd']]
    store.closePane(1) // removes b
    expect(panes()).toEqual([['a'], ['c', 'd']])
  })

  it('ignores an out-of-range flat index', () => {
    store.splitPanes = [['a', 'b']]
    store.closePane(9)
    expect(panes()).toEqual([['a', 'b']])
  })
})

describe('setPaneSession', () => {
  it('swaps the session in a non-primary pane without touching selection', () => {
    store.splitPanes = [['a', 'b']]
    store.selectedId = 'a'
    store.setPaneSession(1, 'z')
    expect(panes()).toEqual([['a', 'z']])
    expect(store.selectedId).toBe('a')
  })

  it('updates selectedId when the primary pane (0,0) changes', () => {
    store.splitPanes = [['a', 'b']]
    store.selectedId = 'a'
    store.setPaneSession(0, 'z')
    expect(panes()).toEqual([['z', 'b']])
    expect(store.selectedId).toBe('z')
  })

  it('is a no-op for an out-of-range index', () => {
    store.splitPanes = [['a', 'b']]
    store.setPaneSession(5, 'z')
    expect(panes()).toEqual([['a', 'b']])
  })
})

describe('startSplit', () => {
  it('adds a second column to the last row using another session', () => {
    seed('a')
    seed('b')
    store.selectedId = 'a' // base = [[a]]
    store.startSplit()
    expect(panes()).toEqual([['a', 'b']])
  })

  it('is a no-op on the dashboard (nothing to split)', () => {
    store.startSplit()
    expect(panes()).toEqual([])
  })
})

describe('select', () => {
  it('sets the selection and stays single-pane when not split', () => {
    store.select('x')
    expect(store.selectedId).toBe('x')
    expect(store.splitPanes).toEqual([])
    expect(panes()).toEqual([['x']])
  })

  it('drives the primary pane (row0col0) when split', () => {
    store.splitPanes = [['a', 'b']]
    store.select('z')
    expect(store.selectedId).toBe('z')
    expect(panes()).toEqual([['z', 'b']])
  })
})

// --- session removal ------------------------------------------------------------------------

describe('deleteSession / removeSessionLocal', () => {
  it('removes the session from sessions, queue, panes, and repairs selection', async () => {
    seed('s1')
    seed('s2')
    store.enqueue('s1', 'queued text')
    store.splitPanes = [['s1', 's2']]
    store.selectedId = 's1'

    await store.deleteSession('s1')

    expect(api.deleteSession).toHaveBeenCalledWith('s1')
    expect(store.sessions.s1).toBeUndefined()
    expect(store.sessions.s2).toBeDefined()
    expect(store.queueFor('s1')).toEqual([])
    // panes collapsed to the surviving session; selection moved off the deleted one
    expect(panes()).toEqual([['s2']])
    expect(store.selectedId).toBe('s2')
  })

  it('falls back to the dashboard when the only session is deleted', async () => {
    seed('only')
    store.selectedId = 'only'
    await store.deleteSession('only')
    expect(store.sessions.only).toBeUndefined()
    expect(store.selectedId).toBeNull()
    expect(panes()).toEqual([])
  })
})

// --- newSession (local draft) + materializeDraft --------------------------------------------
// A new chat is a LOCAL DRAFT — no hub session until the first send. It's excluded from the
// roster (sidebar/dashboard) and only spawns for real via materializeDraft.

describe('newSession (draft) + materializeDraft', () => {
  it('creates a local draft (no hub spawn) and selects it', async () => {
    store.profiles = [{ id: 'p1', provider: 'claude' }]
    await store.newSession('p1')
    expect(api.spawn).not.toHaveBeenCalled()
    const id = store.selectedId
    expect(id).toMatch(/^draft:/)
    expect(store.sessions[id!]?.draft).toBe(true)
    expect(store.sessionList).toEqual([]) // drafts are hidden from the roster
  })

  it('materializeDraft spawns the real session with the prompt and swaps the pane over', async () => {
    store.profiles = [{ id: 'p1', provider: 'claude' }]
    await store.newSession('p1')
    const draftId = store.selectedId!
    const out = await store.materializeDraft(draftId, 'hello there')
    expect(out.error).toBeUndefined()
    expect(api.spawn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.spawn).mock.calls[0]?.[0]).toMatchObject({ profileId: 'p1', prompt: 'hello there' })
    expect(store.sessions[draftId]).toBeUndefined() // draft consumed
    expect(store.sessions.spawned).toBeDefined() // real session ensured
    expect(store.selectedId).toBe('spawned') // pane swapped onto the real id
  })

  it('opens settings instead of drafting when there is no profile at all', async () => {
    store.profiles = []
    await store.newSession() // no profileId, no default account
    expect(api.spawn).not.toHaveBeenCalled()
    expect(store.settingsOpen).toBe(true)
  })
})

// --- event application (apply) --------------------------------------------------------------

describe('apply()', () => {
  it('session/created ensures the session view', () => {
    apply(evt({ seq: 1, kind: 'session/created', sessionId: 'c1', payload: rec('c1') }))
    expect(store.sessions.c1).toBeDefined()
    expect(store.sessions.c1?.record.id).toBe('c1')
    expect(store.lastSeq).toBe(1)
  })

  it('session/deleted (tombstone) removes the session everywhere', () => {
    seed('d1')
    seed('d2')
    store.splitPanes = [['d1', 'd2']]
    store.selectedId = 'd1'
    apply(evt({ seq: 1, kind: 'session/deleted', sessionId: 'd1', payload: { id: 'd1' } }))
    expect(store.sessions.d1).toBeUndefined()
    expect(store.sessions.d2).toBeDefined()
    expect(panes()).toEqual([['d2']])
    expect(store.selectedId).toBe('d2')
  })

  it('session/tokens records the live token counter', () => {
    seed('t1')
    apply(evt({ seq: 1, kind: 'session/tokens', sessionId: 't1', payload: { input: 10, output: 5, total: 15 } }))
    expect(store.sessions.t1?.liveTokens).toEqual({ input: 10, output: 5, total: 15 })
  })

  it('session/tokens derives total from input+output when omitted', () => {
    seed('t2')
    apply(evt({ seq: 1, kind: 'session/tokens', sessionId: 't2', payload: { input: 7, output: 3 } }))
    expect(store.sessions.t2?.liveTokens?.total).toBe(10)
  })

  it('session/status sets turnStartedAt while active and clears it when idle', () => {
    seed('st1')
    expect(store.sessions.st1?.turnStartedAt).toBeUndefined()

    apply(evt({ seq: 1, kind: 'session/status', sessionId: 'st1', payload: { status: 'active' } }))
    expect(typeof store.sessions.st1?.turnStartedAt).toBe('number')
    expect(store.sessions.st1?.record.status).toBe('active')

    apply(evt({ seq: 2, kind: 'session/status', sessionId: 'st1', payload: { status: 'idle' } }))
    expect(store.sessions.st1?.turnStartedAt).toBeUndefined()
    expect(store.sessions.st1?.record.status).toBe('idle')
  })

  // The flush is now DEFERRED to the end of the tick, so the status can be superseded before anything is
  // sent (see scheduleQueueFlush). This test asserted the old synchronous behaviour; awaiting a tick is
  // the whole change, and the send itself is unchanged.
  it('session/status idle flushes any queued message to the hub', async () => {
    seed('st2')
    store.enqueue('st2', 'pending')
    // A queue flush now requires a turn that actually SUCCEEDED, not merely an idle session — idle is
    // also reached by reopen, stale reconcile and interrupt unwind. Drive the real sequence.
    apply(evt({ seq: 1, kind: 'claude/result', sessionId: 'st2', payload: { is_error: false, result: 'ok' } }))
    apply(evt({ seq: 2, kind: 'session/status', sessionId: 'st2', payload: { status: 'idle' } }))
    await new Promise((r) => setTimeout(r, 0))
    expect(api.send).toHaveBeenCalledWith('st2', 'pending')
    expect(store.queueFor('st2')).toEqual([])
  })

  it('ignores events whose seq is <= lastSeq (dedup / replay guard)', () => {
    store.lastSeq = 5
    apply(evt({ seq: 5, kind: 'session/created', sessionId: 'old', payload: rec('old') }))
    expect(store.sessions.old).toBeUndefined() // stale, dropped
    expect(store.lastSeq).toBe(5)

    apply(evt({ seq: 6, kind: 'session/created', sessionId: 'new', payload: rec('new') }))
    expect(store.sessions.new).toBeDefined() // newer, applied
    expect(store.lastSeq).toBe(6)
  })
})

// --- cross-restart UI-state persistence -----------------------------------------------------
// The last-open layout is persisted to localStorage and surfaced on the home screen as a "reopen
// last session" OFFER. Loading it must NOT auto-select anything — the app opens to home and only
// applies the layout when the operator accepts the offer.

describe('restore offer (persist / hydrate / restore)', () => {
  it('hydrateRestorableLayout loads the offer WITHOUT auto-selecting (home stays home)', () => {
    saveLastLayout({ selectedId: 's1', splitPanes: [['s1', 's2']], title: 'S1', paneCount: 2 })
    store.selectedId = null
    store.splitPanes = []
    store.restorableLayout = null

    store.hydrateRestorableLayout()

    // the offer is loaded...
    expect(store.restorableLayout).toMatchObject({ selectedId: 's1', paneCount: 2 })
    // ...but nothing is auto-selected or auto-split — the home screen is untouched.
    expect(store.selectedId).toBeNull()
    expect(panes()).toEqual([])
  })

  it('restoreLastLayout applies the offer to selection + panes, then clears it', () => {
    seed('s1')
    seed('s2')
    store.restorableLayout = { selectedId: 's1', splitPanes: [['s1', 's2']], paneCount: 2 }

    store.restoreLastLayout()

    expect(store.selectedId).toBe('s1')
    expect(panes()).toEqual([['s1', 's2']])
    expect(store.restorableLayout).toBeNull()
  })

  it('restoreLastLayout reopens a single chat when there was no split', () => {
    seed('s1')
    store.restorableLayout = { selectedId: 's1', splitPanes: [], paneCount: 1 }
    store.restoreLastLayout()
    expect(store.selectedId).toBe('s1')
    expect(panes()).toEqual([['s1']])
  })

  it('restoreLastLayout skips sessions that no longer exist', () => {
    seed('s2') // s1 was deleted since last run
    store.restorableLayout = { selectedId: 's1', splitPanes: [['s1', 's2']], paneCount: 2 }
    store.restoreLastLayout()
    expect(panes()).toEqual([['s2']])
    expect(store.selectedId).toBe('s2')
  })

  it('restoreLastLayout stays on home when nothing survives the restart', () => {
    store.restorableLayout = { selectedId: 'gone', splitPanes: [['gone']], paneCount: 1 }
    store.restoreLastLayout()
    expect(store.selectedId).toBeNull()
    expect(panes()).toEqual([])
    expect(store.restorableLayout).toBeNull()
  })

  it('dismissRestore hides the offer without changing the layout', () => {
    store.selectedId = null
    store.restorableLayout = { selectedId: 's1', splitPanes: [], paneCount: 1 }
    store.dismissRestore()
    expect(store.restorableLayout).toBeNull()
    expect(store.selectedId).toBeNull()
    expect(panes()).toEqual([])
  })

  it('persistCurrentLayout saves a meaningful layout that round-trips through storage', () => {
    seed('s1', { title: 'Alpha' })
    seed('s2')
    store.splitPanes = [['s1', 's2']]
    store.selectedId = 's1'

    store.persistCurrentLayout()

    expect(loadLastLayout()).toMatchObject({ selectedId: 's1', splitPanes: [['s1', 's2']], title: 'Alpha', paneCount: 2 })
  })

  it('persistCurrentLayout never overwrites with the empty home layout', () => {
    saveLastLayout({ selectedId: 's1', splitPanes: [], title: 'kept', paneCount: 1 })
    store.selectedId = null
    store.splitPanes = []

    store.persistCurrentLayout() // on the home screen — must be a no-op

    expect(loadLastLayout()).toMatchObject({ selectedId: 's1', title: 'kept' })
  })

  it('persistCurrentLayout drops an unspawned draft (keeps the last real layout)', () => {
    saveLastLayout({ selectedId: 's9', splitPanes: [], title: 'kept', paneCount: 1 })
    store.selectedId = 'draft:abc'
    store.splitPanes = []

    store.persistCurrentLayout()

    expect(loadLastLayout()).toMatchObject({ selectedId: 's9', title: 'kept' }) // unchanged
  })

  it('select clears a pending restore offer (opening a chat supersedes it)', () => {
    store.restorableLayout = { selectedId: 's1', splitPanes: [], paneCount: 1 }
    store.select('x')
    expect(store.restorableLayout).toBeNull()
  })

  it('dropAt clears a pending restore offer', () => {
    store.selectedId = null
    store.splitPanes = []
    store.restorableLayout = { selectedId: 's1', splitPanes: [], paneCount: 1 }
    store.dropAt({ kind: 'col', row: 0, col: 0 }, 'a')
    expect(store.restorableLayout).toBeNull()
  })
})

// Opening a chat after a refresh used to visibly REPLAY the transcript — you watched it build itself
// line by line down to the bottom. Journal events arrive one WebSocket message at a time, so a
// reconnect applied the whole backlog as hundreds of separate ticks: a render and a re-scroll PER
// EVENT. Batching collapses each burst into one pass. These tests pin the two properties that matter,
// because the first attempt at this shipped without them and got blamed for an unrelated outage.
describe('event batching (replay does not render frame-by-frame)', () => {
  const ingest = (e: HubEvent): void => {
    ;(store as unknown as { ingest(x: HubEvent): void }).ingest(e)
  }
  const flush = (): void => {
    ;(store as unknown as { flushEvents(): void }).flushEvents()
  }

  // The bug the FIRST attempt shipped: queueMicrotask drains at the end of the same task that queued
  // it, and each WebSocket message is its own task — so it batched exactly one event and the transcript
  // still replayed line by line. Awaiting a microtask here proves the flush is NOT microtask-scheduled.
  it('does not flush on a microtask boundary (macrotask deferral is what makes batching real)', async () => {
    ingest(evt({ seq: 1, kind: 'session/created', sessionId: 's1', payload: rec('s1') }))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.sessions.s1).toBeUndefined()
    flush()
    expect(store.sessions.s1).toBeDefined()
  })

  it('buffers instead of applying immediately, then applies the whole batch in order', () => {
    ingest(evt({ seq: 1, kind: 'session/created', sessionId: 's1', payload: rec('s1') }))
    ingest(evt({ seq: 2, kind: 'session/input', sessionId: 's1', payload: { text: 'first' } }))
    ingest(evt({ seq: 3, kind: 'session/input', sessionId: 's1', payload: { text: 'second' } }))
    // Nothing applied yet — that is the whole point: one render, not three.
    expect(store.sessions.s1).toBeUndefined()

    flush()

    const items = store.sessions.s1?.items ?? []
    const texts = items.filter((i) => i.kind === 'user').map((i) => i.text)
    expect(texts).toEqual(['first', 'second']) // strict FIFO, no reordering, nothing dropped
  })

  it('one throwing event cannot swallow the events behind it in the same batch', () => {
    ingest(evt({ seq: 1, kind: 'session/created', sessionId: 's1', payload: rec('s1') }))
    // A payload shape the handler will choke on, sandwiched between two good events.
    ingest(evt({ seq: 2, kind: 'session/input', sessionId: 's1', payload: null }))
    ingest(evt({ seq: 3, kind: 'session/input', sessionId: 's1', payload: { text: 'survivor' } }))

    flush()

    const texts = (store.sessions.s1?.items ?? []).filter((i) => i.kind === 'user').map((i) => i.text)
    expect(texts).toContain('survivor')
  })
})


// A replayed session/deleted used to HIJACK the home screen: removeSessionLocal tested `!selectedId`,
// which is true when you are deliberately on home, and filled it with the most recently active chat.
// Deletions replay on every reconnect, so each refresh threw you into an unrelated chat.
describe('session removal does not hijack the home screen', () => {
  it('stays on home when an unrelated chat is removed', () => {
    seed('a')
    seed('b')
    store.selectedId = null // home, deliberately
    apply(evt({ seq: 1, kind: 'session/deleted', sessionId: 'a', payload: { id: 'a' } }))
    expect(store.selectedId).toBeNull()
  })

  it('clears the selection when the OPEN chat is the one removed', () => {
    seed('a')
    seed('b')
    store.selectedId = 'a'
    apply(evt({ seq: 1, kind: 'session/deleted', sessionId: 'a', payload: { id: 'a' } }))
    expect(store.selectedId).toBeNull()
  })

  it('leaves an unrelated open chat alone', () => {
    seed('a')
    seed('b')
    store.selectedId = 'b'
    apply(evt({ seq: 1, kind: 'session/deleted', sessionId: 'a', payload: { id: 'a' } }))
    expect(store.selectedId).toBe('b')
  })
})

/**
 * REGRESSION — a cold launch could brick the app permanently.
 *
 * init() awaited profiles/projects/side-data UNCAUGHT, and connect() — the only place the WebSocket is
 * ever created — ran after them. App.svelte calls `void store.init()`, so one transient rejection threw
 * out of init, was swallowed, and left the app with no socket and no retry: blank until a manual reload.
 * On a cold or first launch the hub is still starting while the UI mounts, so that ordering is the
 * EXPECTED case — the app was most likely to brick on the very first run.
 */
// NOT TESTED HERE, and deliberately so rather than silently. Driving init() needs this file's api mock to
// cover every endpoint it touches (auth, mesh, fleet, …) — and a missing one throws SYNCHRONOUSLY, before
// any .catch() can apply, so a partial mock fails for a reason unrelated to the behaviour under test. I
// wrote those tests, could not run them locally, and they broke CI for everyone; guessing at the harness a
// second time would be worse than admitting the gap. The production fix (loadBootstrapData) stands on its
// own and is small enough to read. Covering it properly wants a bootstrap-level test with a complete api
// double, which belongs with the ApiResult<T> work rather than bolted onto this file.

/**
 * REGRESSION — a queued message must never vanish.
 *
 * flushQueue used to dequeue, persist the removal, echo the message, and `void api.send(...)` without ever
 * checking the result. `jpost` RESOLVES with `{error}` rather than throwing, so any failure destroyed the
 * queued text while leaving a bubble claiming it had been sent; a reload removed the bubble too and the
 * message had never existed anywhere.
 *
 * And it was reachable without any failure at all: the WebSocket replays the journal from seq 0 on every
 * connect with no replay-complete marker, so an OLD `session/status idle` from a previous turn flushed the
 * queue during catch-up — before replay reached the `active` that says the session is busy right now.
 */
describe('queued messages — replay must not send, and a failed send must not lose text', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  // The api mock is module-level and this file's global beforeEach does not reset call history, so an
  // earlier test's send would make "was never called" pass or fail for the wrong reason.
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * NOTE ON WHAT THIS DOES AND DOES NOT PROVE. It drives both events in ONE tick, so it verifies only
   * that a status superseded within the same batch cannot send. It does NOT prove replay safety: every
   * WebSocket message arrives as its own task, so a real replay backlog spans several batches and the
   * deferred check can run before the later `active` is delivered. Closing that needs a replay-complete
   * envelope from the server (see scheduleQueueFlush). Written this way deliberately rather than named
   * "does not send during replay", which would be a test whose name asserts a guarantee it never checks.
   */
  it('does not send when an idle is superseded within the same batch', async () => {
    seed('a')
    store.queues = { a: ['must not lose'] }
    apply(evt({ seq: 1, kind: 'session/status', sessionId: 'a', payload: { status: 'idle' } }))
    apply(evt({ seq: 2, kind: 'session/status', sessionId: 'a', payload: { status: 'active' } }))
    await tick()
    expect(api.send).not.toHaveBeenCalled()
    expect(store.queues['a']).toEqual(['must not lose'])
  })

  /** The realistic completion sequence: the turn's result, then the idle status. */
  const completeTurn = (id: string, startSeq: number): void => {
    apply(evt({ seq: startSeq, kind: 'claude/result', sessionId: id, payload: { is_error: false, result: 'ok' } }))
    apply(evt({ seq: startSeq + 1, kind: 'session/status', sessionId: id, payload: { status: 'idle' } }))
  }

  it('sends once when the final replayed state really is idle', async () => {
    seed('a')
    store.queues = { a: ['go'] }
    apply(evt({ seq: 1, kind: 'session/status', sessionId: 'a', payload: { status: 'active' } }))
    completeTurn('a', 2)
    await tick()
    expect(api.send).toHaveBeenCalledTimes(1)
    expect(api.send).toHaveBeenCalledWith('a', 'go')
  })

  /**
   * An interrupt SENDS the queue. The operator ended that turn deliberately and their queued follow-up is
   * usually why — making them re-type it is friction, not safety. (A Stop is different: its status is
   * 'stopped', never 'idle', so it never reaches the flush at all.)
   */
  it('sends queued text after an interrupt', async () => {
    seed('a')
    store.queues = { a: ['the thing I actually wanted'] }
    apply(evt({ seq: 1, kind: 'session/status', sessionId: 'a', payload: { status: 'active' } }))
    apply(
      evt({
        seq: 2,
        kind: 'claude/result',
        sessionId: 'a',
        payload: { is_error: true, terminal_reason: 'aborted_streaming' },
      })
    )
    apply(evt({ seq: 3, kind: 'session/status', sessionId: 'a', payload: { status: 'idle' } }))
    await tick()
    expect(api.send).toHaveBeenCalledWith('a', 'the thing I actually wanted')
  })

  /** A FAILED turn still holds it: with a broken worker, flushing drains the whole queue into the wall. */
  it('does not send after a failed turn', async () => {
    seed('a')
    store.queues = { a: ['hold me'] }
    apply(evt({ seq: 1, kind: 'session/status', sessionId: 'a', payload: { status: 'active' } }))
    apply(
      evt({
        seq: 2,
        kind: 'claude/result',
        sessionId: 'a',
        payload: { is_error: true, errors: ['boom'], terminal_reason: 'api_error' },
      })
    )
    apply(evt({ seq: 3, kind: 'session/status', sessionId: 'a', payload: { status: 'idle' } }))
    await tick()
    expect(api.send).not.toHaveBeenCalled()
    expect(store.queues['a']).toEqual(['hold me'])
  })

  it('restores the text and withdraws the bubble when the send fails', async () => {
    seed('a')
    store.queues = { a: ['keep me'] }
    ;(api.send as unknown as { mockResolvedValueOnce(v: unknown): void }).mockResolvedValueOnce({
      error: 'hub unavailable',
    })
    completeTurn('a', 1)
    await tick()
    await tick()
    expect(store.queues['a']).toEqual(['keep me']) // still recoverable
    const items = store.sessions['a']!.items
    expect(items.some((i) => i.kind === 'user' && i.text === 'keep me')).toBe(false) // no false "sent"
    expect(items.some((i) => /not sent/i.test(i.text ?? ''))).toBe(true) // and the operator is told
  })

  it('does not fire the queue into a failure on an error status', async () => {
    seed('a')
    store.queues = { a: ['do not spend me'] }
    apply(evt({ seq: 1, kind: 'session/status', sessionId: 'a', payload: { status: 'error' } }))
    await tick()
    expect(api.send).not.toHaveBeenCalled()
    expect(store.queues['a']).toEqual(['do not spend me'])
  })
})

/**
 * REGRESSION — red "errors" appearing next to output that was perfectly fine.
 *
 * Three independent sources, all of which painted a successful or deliberate outcome as a failure:
 *   - `claude/result` read `p.result` for the error text, but the SDK's SDKResultError shape has NO
 *     `result` field (it carries `errors: string[]`), so a genuine failure rendered a BLANK red card;
 *   - an operator interrupt ends the query with terminal_reason 'aborted_streaming' / 'aborted_tools'
 *     and is_error set, so pressing stop produced an error item and a failed turn;
 *   - the auto-denied guardrails were rendered as `error` even though the guardrail firing is the system
 *     working as designed and the turn usually goes on to succeed.
 */
describe('turn outcome — only real failures may look like failures', () => {
  const items = (id: string) => store.sessions[id]!.items
  const errors = (id: string) => items(id).filter((i) => i.kind === 'error')

  it('shows the reason from errors[] instead of a blank error card', () => {
    seed('a')
    apply(
      evt({
        seq: 1,
        kind: 'claude/result',
        sessionId: 'a',
        payload: { is_error: true, subtype: 'error_during_execution', errors: ['boom'], terminal_reason: 'api_error' },
      })
    )
    expect(errors('a')).toHaveLength(1)
    expect(errors('a')[0]!.text).toBe('boom')
    expect(store.sessions['a']!.lastTurnOk).toBe(false)
  })

  it('never renders an error with no text at all', () => {
    seed('a')
    apply(evt({ seq: 1, kind: 'claude/result', sessionId: 'a', payload: { is_error: true, terminal_reason: 'model_error' } }))
    expect(errors('a')).toHaveLength(1)
    expect(errors('a')[0]!.text).toBeTruthy()
  })

  // `errors: ['']` is length-1, so a `??` chain accepts the empty string and still renders a blank card.
  it('never renders a blank error when errors[] holds only empty/whitespace entries', () => {
    seed('a')
    apply(
      evt({
        seq: 1,
        kind: 'claude/result',
        sessionId: 'a',
        payload: { is_error: true, errors: ['  ', ''], terminal_reason: 'api_error' },
      })
    )
    expect(errors('a')).toHaveLength(1)
    expect(errors('a')[0]!.text?.trim()).toBeTruthy()
  })

  /**
   * An interrupt must be NEUTRAL — neither red nor green. status() renders idle + lastTurnOk===true as
   * "completed", so marking a deliberately-cut-short turn as ok would simply swap a false failure for a
   * false success. Asserting the rendered STATUS, not just the flag, is what catches that.
   */
  it('treats an operator interrupt as neutral — not failed, and not completed either', () => {
    seed('a')
    apply(
      evt({
        seq: 1,
        kind: 'claude/result',
        sessionId: 'a',
        payload: { is_error: true, terminal_reason: 'aborted_streaming', result: 'Request interrupted by user' },
      })
    )
    apply(evt({ seq: 2, kind: 'session/status', sessionId: 'a', payload: { status: 'idle' } }))
    expect(errors('a')).toHaveLength(0) // pressing stop is not an error
    expect(items('a').some((i) => i.kind === 'note' && /interrupt/i.test(i.text ?? ''))).toBe(true)
    expect(store.status(store.sessions['a']!).key).not.toBe('completed')
  })

  /**
   * A new turn invalidates the old verdict. Otherwise a turn that ends without a result — worker loss,
   * restored-stale, anything going straight back to idle — inherits the previous turn's success.
   */
  it('does not report a lost turn as completed by reusing the previous turn verdict', () => {
    seed('a')
    apply(evt({ seq: 1, kind: 'claude/result', sessionId: 'a', payload: { is_error: false, result: 'ok' } }))
    apply(evt({ seq: 2, kind: 'session/status', sessionId: 'a', payload: { status: 'active' } }))
    expect(store.sessions['a']!.lastTurnOk).toBeUndefined()
    apply(evt({ seq: 3, kind: 'session/status', sessionId: 'a', payload: { status: 'idle' } }))
    expect(store.status(store.sessions['a']!).key).not.toBe('completed')
  })

  it('keeps a successful turn green when a guardrail denied a tool along the way', () => {
    seed('a')
    apply(
      evt({
        seq: 1,
        kind: 'approval/auto-denied-scope',
        sessionId: 'a',
        payload: { toolName: 'Write', reason: 'outside the worktree' },
      })
    )
    apply(evt({ seq: 2, kind: 'claude/result', sessionId: 'a', payload: { is_error: false, result: 'done' } }))
    expect(errors('a')).toHaveLength(0)
    expect(store.sessions['a']!.lastTurnOk).toBe(true)
    // still surfaced, just not as a failure
    expect(items('a').some((i) => /scope guard denied Write/.test(i.text ?? ''))).toBe(true)
  })

  it('does not leave a stale success standing after a session error', () => {
    seed('a')
    apply(evt({ seq: 1, kind: 'claude/result', sessionId: 'a', payload: { is_error: false, result: 'ok' } }))
    expect(store.sessions['a']!.lastTurnOk).toBe(true)
    apply(evt({ seq: 2, kind: 'session/error', sessionId: 'a', payload: { message: 'worker unavailable' } }))
    expect(store.sessions['a']!.lastTurnOk).toBe(false)
  })
})

/**
 * THE ROOT CAUSE OF THE "EVERY SUB-AGENT IS DONE" BUG.
 *
 * The hub forwards every SDK message as `claude/<type>`, so a sub-agent's real lifecycle arrives as
 * `claude/system` with the meaning in `payload.subtype`. `apply()` dispatches on `kind`, and with no
 * `claude/system` case those rows fell through `default: break` — this hub's journal holds hundreds of
 * `task_started` / `task_progress` / `task_notification` rows that were written and then dropped. The
 * panel inferred status from the spawn's tool_result instead, which for a backgrounded agent is a launch
 * ack, so everything read "done" instantly.
 *
 * Payload shapes below are verbatim from real journal rows.
 */
describe('claude/system — sub-agent task lifecycle ingest', () => {
  const spawnItem = (id: string) => store.sessions[id]!.items.find((i) => i.toolName === 'Agent')!

  // The assistant message carrying the Agent tool_use block always precedes the lifecycle rows
  // (verified: 9/9 spawns in this hub's journal, 3-4 seq later), which is what makes merging safe.
  function seedSpawn(id: string, toolUseId = 'toolu_014ekbTX8TwZMReHWnB4jpw6'): void {
    seed(id)
    apply(
      evt({
        seq: 1,
        kind: 'claude/assistant',
        sessionId: id,
        payload: {
          message: {
            content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: 't3code mode UI', subagent_type: 'Explore' } }],
          },
        },
      })
    )
  }

  const system = (id: string, seq: number, payload: unknown, ts = '2026-01-01T00:05:00.000Z') =>
    apply(evt({ seq, kind: 'claude/system', sessionId: id, payload, ts }))

  it('merges task_started onto the spawn item', () => {
    seedSpawn('a')
    system('a', 2, {
      type: 'system', subtype: 'task_started', task_id: 'a8d7352e676bd71b1',
      tool_use_id: 'toolu_014ekbTX8TwZMReHWnB4jpw6', description: 't3code mode UI',
      subagent_type: 'Explore', task_type: 'local_agent',
    })
    expect(spawnItem('a').agentTaskId).toBe('a8d7352e676bd71b1')
    expect(spawnItem('a').agentProgressTs).toBe('2026-01-01T00:05:00.000Z')
  })

  it('records the task_progress heartbeat — the liveness signal behind `stalled`', () => {
    seedSpawn('a')
    system('a', 2, {
      type: 'system', subtype: 'task_progress', task_id: 'acb94dd932f8b8ac1',
      tool_use_id: 'toolu_014ekbTX8TwZMReHWnB4jpw6', description: 'Running…',
      usage: { total_tokens: 126455, tool_uses: 42, duration_ms: 533438 }, last_tool_name: 'Bash',
    })
    expect(spawnItem('a').agentLastTool).toBe('Bash')
    expect(spawnItem('a').agentToolUses).toBe(42)
    expect(spawnItem('a').agentProgressTs).toBe('2026-01-01T00:05:00.000Z')
  })

  it('records a completed task_notification, including the summary that replaces the launch-ack blob', () => {
    seedSpawn('a')
    system('a', 2, {
      type: 'system', subtype: 'task_notification', task_id: 'b3rklprx0',
      tool_use_id: 'toolu_014ekbTX8TwZMReHWnB4jpw6', status: 'completed', output_file: '',
      summary: 'Survey packages and server structure',
    })
    expect(spawnItem('a').agentOutcome).toBe('completed')
    expect(spawnItem('a').agentOutcomeTs).toBe('2026-01-01T00:05:00.000Z')
    expect(spawnItem('a').agentSummary).toBe('Survey packages and server structure')
  })

  it('records a failed task_notification', () => {
    seedSpawn('f')
    system('f', 2, { type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_014ekbTX8TwZMReHWnB4jpw6', status: 'failed' })
    expect(spawnItem('f').agentOutcome).toBe('failed')
  })

  // Kept separate from `failed`: a deliberate kill and a crash are different facts, and flattening them
  // loses the only thing worth knowing about a run that did not finish.
  it('records a stopped task_notification as stopped, not as an error', () => {
    seedSpawn('s')
    system('s', 2, { type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_014ekbTX8TwZMReHWnB4jpw6', status: 'stopped' })
    expect(spawnItem('s').agentOutcome).toBe('stopped')
  })

  // `task_updated` never carries a tool_use_id, and a handful of `stopped` notifications omit it too.
  // Without the task_id fallback a killed agent would keep its running dot forever.
  it('correlates by task_id when the row carries no tool_use_id', () => {
    seedSpawn('a')
    system('a', 2, { type: 'system', subtype: 'task_started', task_id: 'b8e2xx6j8', tool_use_id: 'toolu_014ekbTX8TwZMReHWnB4jpw6' })
    system('a', 3, { type: 'system', subtype: 'task_updated', task_id: 'b8e2xx6j8', patch: { status: 'killed', end_time: 1785013571376 } })
    expect(spawnItem('a').agentOutcome).toBe('stopped')
  })

  it('a non-terminal task_updated never clears an outcome already recorded', () => {
    seedSpawn('a')
    system('a', 2, { type: 'system', subtype: 'task_started', task_id: 'b8e2xx6j8', tool_use_id: 'toolu_014ekbTX8TwZMReHWnB4jpw6' })
    system('a', 3, { type: 'system', subtype: 'task_notification', task_id: 'b8e2xx6j8', tool_use_id: 'toolu_014ekbTX8TwZMReHWnB4jpw6', status: 'completed' })
    system('a', 4, { type: 'system', subtype: 'task_updated', task_id: 'b8e2xx6j8', patch: { status: 'running' } })
    expect(spawnItem('a').agentOutcome).toBe('completed')
  })

  it('ignores the noisy subtypes and anything it cannot correlate, without throwing', () => {
    seedSpawn('a')
    system('a', 2, { type: 'system', subtype: 'thinking_tokens', tokens: 1024 })
    system('a', 3, { type: 'system', subtype: 'init', tools: [], skills: [] })
    // background_tasks_changed is deliberately not consumed: the SDK calls it a level signal carrying ids
    // only, with nothing emitted at CLI startup, so a replayed snapshot could wedge a run as live.
    system('a', 4, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'zzz', task_type: 'local_agent', description: 'x' }] })
    // A background Bash task: same subtypes, but its tool_use_id belongs to a Bash call, not a spawn.
    system('a', 5, { type: 'system', subtype: 'task_notification', task_id: 'bjka37p48', tool_use_id: 'toolu_someBashCall', status: 'completed' })
    expect(spawnItem('a').agentOutcome).toBeUndefined()
    expect(spawnItem('a').agentTaskId).toBeUndefined()
  })
})
