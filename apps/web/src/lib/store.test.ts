import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { store } from './store.svelte'
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

// Reset the singleton between tests — it persists across the file.
beforeEach(() => {
  store.sessions = {}
  store.queues = {}
  store.selectedId = null
  store.splitPanes = []
  store.lastLayout = null
  store.lastSeq = 0
  store.profiles = []
  store.projects = []
  store.approvals = []
  store.usage = []
  store.dragSession = null
  store.dropZone = null
  store.connected = false
  store.settingsOpen = false
  store.lastProfileId = null
  ;(store as unknown as { creating: boolean }).creating = false
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

// --- newSession double-spawn guard ----------------------------------------------------------

describe('newSession', () => {
  it('spawns only once for concurrent calls, then optimistically ensures + navigates', async () => {
    let resolveSpawn!: (v: SessionRecord) => void
    vi.mocked(api.spawn).mockImplementationOnce(
      () => new Promise<SessionRecord>((res) => { resolveSpawn = res })
    )

    const p1 = store.newSession('p1')
    const p2 = store.newSession('p1') // must be short-circuited by the `creating` guard

    resolveSpawn(rec('fresh'))
    await Promise.all([p1, p2])

    expect(api.spawn).toHaveBeenCalledTimes(1)
    expect(store.sessions.fresh).toBeDefined() // optimistic ensure()
    expect(store.selectedId).toBe('fresh') // navigation via select()
    expect(store.lastProfileId).toBe('p1')
  })

  it('opens settings instead of spawning when there is no profile at all', async () => {
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

  it('session/status idle flushes any queued message to the hub', () => {
    seed('st2')
    store.enqueue('st2', 'pending')
    apply(evt({ seq: 1, kind: 'session/status', sessionId: 'st2', payload: { status: 'idle' } }))
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
