import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { HubStore, store } from './store.svelte'
import { settings } from './settings.svelte'
import { loadLastLayout, saveLastLayout } from './uiState'
import { buildAgentRuns } from './agentTree'
import { alertDialog } from './dialog.svelte'
import { buildTaskBoard } from './taskBoard'
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
      rescanProfiles: vi.fn(async () => []),
      projects: vi.fn(async () => []),
      prefs: vi.fn(async () => ({ chatNamePool: 'everyone', steerMessagesAtToolBoundary: true })),
      setPrefs: vi.fn(async (patch: Record<string, unknown>) => ({
        chatNamePool: 'everyone',
        steerMessagesAtToolBoundary: true,
        ...patch,
      })),
      approvals: vi.fn(async () => []),
      questions: vi.fn(async () => []),
      recoveryNotices: vi.fn(async () => []),
      dismissRecoveryNotice: vi.fn(ok),
      usage: vi.fn(async () => []),
      sessions: vi.fn(async () => []),
      history: vi.fn(async () => ({ items: [], olderCursor: null, hasOlder: false })),
      replayBaseline: vi.fn(async () => ({
        version: 1,
        generation: 1,
        highWaterSeq: 0,
        resetFloorSeq: 0,
        sessions: [],
        projects: [],
        journalCompaction: null,
      })),
      journalHistory: vi.fn(async () => ({
        events: [],
        olderCursor: null,
        hasOlder: false,
        encodedBytes: 0,
        checkpointGeneration: 1,
      })),
      spawn: vi.fn(async () => rec('spawned')),
      send: vi.fn(ok),
      stop: vi.fn(ok),
      deleteSession: vi.fn(ok),
    },
  }
})

vi.mock('./dialog.svelte', () => ({
  alertDialog: vi.fn(async () => {}),
}))

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
  vi.clearAllMocks()
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
  store.questions = []
  store.recoveryNotices = []
  store.usage = []
  store.questions = []
  store.journalCompaction = null
  store.replayGeneration = 0
  store.prefs = { chatNamePool: 'everyone', steerMessagesAtToolBoundary: true }
  store.dragSession = null
  store.dropZone = null
  store.connected = false
  store.settingsOpen = false
  store.overseerUiGuide = null
  store.lastProfileId = null
  settings.autoSwitchToNewChat = true
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

  it('moves an existing pane between columns without duplicating its session', () => {
    store.splitPanes = [['a', 'b', 'c']]
    store.dropAt({ kind: 'col', row: 0, col: 3 }, 'a')
    expect(panes()).toEqual([['b', 'c', 'a']])
    expect(panes().flat().filter((id) => id === 'a')).toHaveLength(1)
  })

  it('moves an existing pane into a new row and removes its emptied source row', () => {
    store.splitPanes = [['a'], ['b', 'c']]
    store.dropAt({ kind: 'row', row: 2 }, 'a')
    expect(panes()).toEqual([['b', 'c'], ['a']])
  })

  it('treats a drop back onto the pane own slot as an exact no-op', () => {
    store.splitPanes = [['a', 'b'], ['c']]
    const before = store.splitPanes
    store.dropAt({ kind: 'col', row: 0, col: 1 }, 'b')
    expect(store.splitPanes).toBe(before)
    expect(panes()).toEqual([['a', 'b'], ['c']])
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

  it('keeps the chat visible and surfaces the workspace path when the hub refuses deletion', async () => {
    const workspace = 'C:\\Users\\Admin\\AppData\\Roaming\\AllMyAgents\\data\\workspaces\\protected'
    const reason = `workspace has recoverable uncommitted work at ${workspace}`
    seed('protected', { cwd: workspace })
    store.selectedId = 'protected'
    ;(api.deleteSession as unknown as { mockResolvedValueOnce(v: unknown): void }).mockResolvedValueOnce({
      error: reason,
    })

    await store.deleteSession('protected')

    expect(store.sessions.protected).toBeDefined()
    expect(store.selectedId).toBe('protected')
    expect(panes()).toEqual([['protected']])
    expect(alertDialog).toHaveBeenCalledWith(expect.stringContaining(reason))
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

  it('auto-switch makes a materialized background draft the primary displayed split pane', async () => {
    seed('old')
    store.profiles = [{ id: 'p1', provider: 'claude' }]
    await store.newSession('p1')
    const draftId = store.selectedId!
    // Reproduce the actual failure: selectedId changes, but App renders splitPanes. The draft is in a
    // background pane, so merely assigning selectedId cannot make the newly-created chat primary.
    store.splitPanes = [['old', draftId]]
    store.selectedId = 'old'
    settings.autoSwitchToNewChat = true

    const out = await store.materializeDraft(draftId, 'from the background')

    expect(out.error).toBeUndefined()
    expect(store.selectedId).toBe('spawned')
    expect(panes()).toEqual([['spawned', 'old']])
  })

  it('leaves a materialized background draft in its pane when auto-switch is off', async () => {
    seed('old')
    store.profiles = [{ id: 'p1', provider: 'claude' }]
    await store.newSession('p1')
    const draftId = store.selectedId!
    store.splitPanes = [['old', draftId]]
    store.selectedId = 'old'
    settings.autoSwitchToNewChat = false

    await store.materializeDraft(draftId, 'stay put')

    expect(store.selectedId).toBe('old')
    expect(panes()).toEqual([['old', 'spawned']])
  })

  it('keeps a partially created chat visible when cleanup deletion is refused', async () => {
    const workspace = 'C:\\Users\\Admin\\AppData\\Roaming\\AllMyAgents\\data\\workspaces\\spawned'
    store.profiles = [{ id: 'p1', provider: 'claude' }]
    ;(api.spawn as unknown as { mockResolvedValueOnce(v: unknown): void }).mockResolvedValueOnce(
      rec('spawned', { cwd: workspace })
    )
    ;(api.deleteSession as unknown as { mockResolvedValueOnce(v: unknown): void }).mockResolvedValueOnce({
      error: `workspace has recoverable uncommitted work at ${workspace}`,
    })
    await store.newSession('p1')
    const draftId = store.selectedId!

    const out = await store.materializeDraft(draftId, 'with attachment', async () => ({
      error: 'attachment upload failed',
    }))

    expect(out.error).toBe('attachment upload failed')
    expect(store.sessions[draftId]).toBeDefined()
    expect(store.sessions.spawned).toBeDefined()
    expect(alertDialog).toHaveBeenCalledWith(expect.stringContaining(workspace))
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
  it('accepts a live allowlisted Overseer UI guide but never replays it into navigation state', () => {
    apply(evt({
      seq: 1,
      kind: 'overseer/ui-guide-requested',
      sessionId: 'overseer',
      payload: { target: 'accounts', message: 'Sign in here.', projectId: null },
    }))
    expect(store.overseerUiGuide).toEqual({ target: 'accounts', message: 'Sign in here.', seq: 1 })

    store.overseerUiGuide = null
    ;(store as unknown as { applyingReplayedEvent: boolean }).applyingReplayedEvent = true
    apply(evt({
      seq: 2,
      kind: 'overseer/ui-guide-requested',
      sessionId: 'overseer',
      payload: { target: 'safety', message: 'Old replayed request.' },
    }))
    ;(store as unknown as { applyingReplayedEvent: boolean }).applyingReplayedEvent = false
    expect(store.overseerUiGuide).toBeNull()
  })

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

  it('shows an accepted optimistic turn as working before the status event arrives', () => {
    seed('optimistic-status')

    store.noteSent('optimistic-status')

    expect(store.status(store.sessions['optimistic-status']!)).toEqual({
      key: 'working',
      label: 'working',
    })
  })

  it('repairs a missed active status from the authoritative hub roster', async () => {
    seed('reconciled-status')
    vi.mocked(api.sessions).mockResolvedValueOnce([
      rec('reconciled-status', { status: 'active' }),
    ])

    await store.syncRecordsFromHub()

    expect(store.sessions['reconciled-status']?.record.status).toBe('active')
    expect(store.status(store.sessions['reconciled-status']!)).toMatchObject({ key: 'working' })
  })

  it('does not let a slow roster response overwrite a newer streamed status', async () => {
    seed('status-race')
    let resolveRoster!: (records: SessionRecord[]) => void
    vi.mocked(api.sessions).mockReturnValueOnce(
      new Promise<SessionRecord[]>((resolve) => {
        resolveRoster = resolve
      })
    )
    const syncing = store.syncRecordsFromHub()
    apply(
      evt({
        seq: 1,
        kind: 'session/status',
        sessionId: 'status-race',
        payload: { status: 'active' },
      })
    )
    resolveRoster([rec('status-race', { status: 'idle' })])

    await syncing

    expect(store.sessions['status-race']?.record.status).toBe('active')
  })

  it('allows only one bounded authoritative status refresh at a time', async () => {
    let resolveRoster!: (records: SessionRecord[]) => void
    vi.mocked(api.sessions).mockReturnValueOnce(
      new Promise<SessionRecord[]>((resolve) => {
        resolveRoster = resolve
      }),
    )

    const first = store.syncRecordsFromHub()
    const overlapping = store.syncRecordsFromHub()

    expect(api.sessions).toHaveBeenCalledTimes(1)
    await overlapping
    resolveRoster([])
    await first

    vi.mocked(api.sessions).mockResolvedValueOnce([])
    await store.syncRecordsFromHub()
    expect(api.sessions).toHaveBeenCalledTimes(2)
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

  it.each([
    {
      phase: 'planned',
      turnBoundary: 'completed',
      expected: 'exact turn then reached a terminal boundary',
      absent: 'Claude received',
    },
    {
      phase: 'planned',
      turnBoundary: 'unknown',
      expected: 'whether Claude processed the interruption before restart is unknown',
      absent: 'delivered to Claude',
    },
    {
      phase: 'crash',
      turnBoundary: 'unknown',
      expected: 'no interruption response was delivered',
      absent: 'live callback was released',
    },
  ] as const)(
    'renders one truthful $phase/$turnBoundary restart interruption note',
    ({ phase, turnBoundary, expected, absent }) => {
      seed('ask-restart')
      const event = evt({
        seq: 1,
        kind: 'question/restart-interrupted',
        sessionId: 'ask-restart',
        payload: { phase, turnBoundary, questionCount: 2 },
      })

      apply(event)
      apply(event)

      const notes = store.sessions['ask-restart']!.items.filter(
        (item) => item.kind === 'note'
      )
      expect(notes).toHaveLength(1)
      const text = (notes[0] as { text: string }).text
      expect(text).toContain('SYSTEM INTERRUPTION — NOT A USER RESPONSE')
      expect(text).toContain(
        'No answer, cancellation, decline, choice, or preference was supplied.'
      )
      expect(text).toContain(expected)
      expect(text).not.toContain(absent)
    }
  )
})

describe('global recovery notice replay', () => {
  it('refreshes the durable banner after journal/recovered replay without a page reload', async () => {
    vi.useFakeTimers()
    const notice = {
      planId: '11111111-1111-4111-8111-111111111111',
      generation: '7',
      snapshotMaxSeq: '40',
      snapshotEventHighWater: '44',
      quarantineDir: 'C:\\evidence\\incident',
      recordedAt: '2026-07-29T00:00:00.000Z',
    }
    vi.mocked(api.recoveryNotices).mockResolvedValueOnce([notice])

    apply(evt({ seq: 1, kind: 'journal/recovered', sessionId: null }))
    await vi.advanceTimersByTimeAsync(301)

    expect(api.recoveryNotices).toHaveBeenCalled()
    expect(store.recoveryNotices).toEqual([notice])
    vi.useRealTimers()
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

  it('applies a project rename from another operator window without a reload', () => {
    store.projects = [{ id: 'p1', name: 'Before', path: 'C:/repo', createdAt: '2026-07-31T00:00:00.000Z' }]
    ingest(evt({
      seq: 1,
      kind: 'project/updated',
      sessionId: null,
      payload: { projectId: 'p1', changes: { name: { from: 'Before', to: 'After' } } },
    }))

    flush()

    expect(store.projects[0]?.name).toBe('After')
  })

  it('adds a project created by the Overseer without a reload and de-duplicates a matching API response', () => {
    const project = {
      id: 'p-overseer',
      name: 'Overseer Lab',
      path: 'C:/repo/overseer-lab',
      createdAt: '2026-08-05T19:09:34.000Z',
    }
    ingest(evt({
      seq: 1,
      kind: 'project/created',
      sessionId: null,
      payload: { project },
    }))
    flush()

    expect(store.projects).toEqual([project])

    ingest(evt({
      seq: 2,
      kind: 'project/created',
      sessionId: null,
      payload: { project: { ...project, name: 'Overseer Lab (canonical)' } },
    }))
    flush()

    expect(store.projects).toEqual([{ ...project, name: 'Overseer Lab (canonical)' }])
  })

  it('applies an account display-name change without changing its immutable id', () => {
    store.profiles = [{ id: 'claude-a', provider: 'claude', displayName: 'Before' }]
    ingest(evt({
      seq: 1,
      kind: 'profiles/renamed',
      sessionId: null,
      payload: { id: 'claude-a', displayName: 'After' },
    }))

    flush()

    expect(store.profiles).toEqual([{ id: 'claude-a', provider: 'claude', displayName: 'After' }])
  })

  it('adds the live account alias when a bounded completion-side rescan is unavailable', () => {
    store.profiles = []
    ingest(evt({
      seq: 1,
      kind: 'profiles/added',
      sessionId: null,
      payload: { id: 'codex-research', provider: 'codex', displayName: 'Research account' },
    }))

    flush()

    expect(store.profiles).toEqual([{
      id: 'codex-research',
      provider: 'codex',
      displayName: 'Research account',
    }])
  })

  it.each(['claude-default', 'codex-default'])(
    'does not turn the internal %s import binding into a live account',
    (id) => {
      store.profiles = []
      ingest(evt({
        seq: 1,
        kind: 'profiles/added',
        sessionId: null,
        payload: { id, provider: id.startsWith('claude') ? 'claude' : 'codex', source: 'default-home' },
      }))

      flush()

      expect(store.profiles).toEqual([])
    },
  )

  it('filters internal vendor homes from a skewed rescan response', async () => {
    vi.mocked(api.rescanProfiles).mockResolvedValueOnce([
      { id: 'claude-default', provider: 'claude' },
      { id: 'codex-default', provider: 'codex' },
      { id: 'claude-work', provider: 'claude', displayName: 'Work' },
    ])

    await store.rescanProfiles()

    expect(store.profiles).toEqual([
      { id: 'claude-work', provider: 'claude', displayName: 'Work' },
    ])
  })
})

describe('workspace pressure events', () => {
  it('applies and clears the durable workspace warning on the live session record', () => {
    seed('pressure')
    const pressure = {
      level: 'warning' as const,
      totalBytes: 5 * 1024 ** 3,
      artifactBytes: 3 * 1024 ** 3,
      artifactGroups: [{ name: 'node_modules', bytes: 3 * 1024 ** 3 }],
      reasons: ['workspace-size', 'build-artifacts'] as const,
      partial: false,
      observedAt: '2026-08-02T00:00:00.000Z',
    }

    apply(evt({ seq: 1, sessionId: 'pressure', kind: 'session/workspace-pressure', payload: { pressure } }))
    expect(store.sessions.pressure?.record.workspacePressure).toEqual(pressure)

    apply(evt({ seq: 2, sessionId: 'pressure', kind: 'session/workspace-pressure-cleared', payload: {} }))
    expect(store.sessions.pressure?.record.workspacePressure).toBeUndefined()
  })
})

describe('provider context compaction lifecycle', () => {
  it('shows Claude while compaction is running and updates the same row on failure', () => {
    seed('claude-chat', { provider: 'claude' })
    apply(evt({
      seq: 1,
      sessionId: 'claude-chat',
      kind: 'claude/system',
      payload: { subtype: 'status', status: 'compacting', uuid: 'status-start' },
    }))

    let rows = store.sessions['claude-chat']!.items.filter((item) => item.kind === 'compaction')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'started', text: 'Claude context compaction started…' })

    apply(evt({
      seq: 2,
      sessionId: 'claude-chat',
      kind: 'claude/system',
      payload: {
        subtype: 'status',
        status: null,
        compact_result: 'failed',
        compact_error: 'summary request timed out',
        uuid: 'status-finish',
      },
    }))

    rows = store.sessions['claude-chat']!.items.filter((item) => item.kind === 'compaction')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'failed',
      text: 'Claude context compaction failed: summary request timed out',
    })
  })

  it('shows Codex contextCompaction from item start through completion without duplicating the deprecated notification', () => {
    seed('codex-chat', { provider: 'codex' })
    apply(evt({
      seq: 1,
      sessionId: 'codex-chat',
      kind: 'codex/item/started',
      payload: { item: { type: 'contextCompaction', id: 'compact-1' } },
    }))

    let rows = store.sessions['codex-chat']!.items.filter((item) => item.kind === 'compaction')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'started', text: 'Codex context compaction started…' })

    apply(evt({
      seq: 2,
      sessionId: 'codex-chat',
      kind: 'codex/item/completed',
      payload: { item: { type: 'contextCompaction', id: 'compact-1' } },
    }))
    apply(evt({
      seq: 3,
      sessionId: 'codex-chat',
      kind: 'codex/thread/compacted',
      payload: { threadId: 'thread-1', turnId: 'turn-1' },
    }))

    rows = store.sessions['codex-chat']!.items.filter((item) => item.kind === 'compaction')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'completed', text: 'Codex context compaction completed.' })
  })

  it('marks a started compaction unobservable when the turn ends without a terminal provider signal', () => {
    seed('codex-chat', { provider: 'codex' })
    apply(evt({
      seq: 1,
      sessionId: 'codex-chat',
      kind: 'codex/item/started',
      payload: { item: { type: 'contextCompaction', id: 'compact-unknown' } },
    }))
    apply(evt({
      seq: 2,
      sessionId: 'codex-chat',
      kind: 'codex/turn/completed',
      payload: { turn: { status: 'completed' } },
    }))

    expect(store.sessions['codex-chat']!.items.filter((item) => item.kind === 'compaction')).toEqual([
      expect.objectContaining({
        status: 'unobservable',
        text: 'Codex context compaction ended without an observable terminal result.',
      }),
    ])
  })
})

describe('replay boundary presentation', () => {
  type ReplayControl =
    | { type: 'replay-start'; generation: number; highWater: number; resetFloorSeq: number }
    | { type: 'replay-complete'; lastSeq: number; generation: number }
  type ReplayStore = {
    beginReplayPresentation(): void
    ingest(message: HubEvent | ReplayControl): void
    flushEvents(): void
  }

  function harness(): { replayStore: HubStore; transport: ReplayStore } {
    const replayStore = new HubStore()
    replayStore.replayGeneration = 1
    return { replayStore, transport: replayStore as unknown as ReplayStore }
  }

  it('marks the backlog silent and only animates transcript items after the boundary', () => {
    const { replayStore, transport } = harness()
    transport.beginReplayPresentation()
    transport.ingest({ type: 'replay-start', generation: 1, highWater: 2, resetFloorSeq: 0 })
    transport.ingest(evt({ seq: 1, kind: 'session/created', sessionId: 's1', payload: rec('s1') }))
    transport.ingest(evt({ seq: 2, kind: 'session/input', sessionId: 's1', payload: { text: 'history' } }))
    transport.flushEvents()
    expect(replayStore.replayPresentationActive).toBe(true)
    expect(replayStore.sessions.s1).toBeUndefined()

    transport.ingest({ type: 'replay-complete', lastSeq: 2, generation: 1 })
    transport.flushEvents()
    expect(replayStore.sessions.s1?.items.map((item) => item.text)).toEqual(['history'])
    transport.ingest(evt({ seq: 3, kind: 'session/input', sessionId: 's1', payload: { text: 'live' } }))

    transport.flushEvents()
    expect(replayStore.replayPresentationActive).toBe(false)

    const messages = replayStore.sessions.s1?.items.filter((item) => item.kind === 'user') ?? []
    expect(messages.map((item) => [item.text, item.replayed])).toEqual([
      ['history', true],
      ['live', false],
    ])
  })

  it('applies every replayed event to transcript state rather than dropping or deferring it', () => {
    const { replayStore, transport } = harness()
    transport.beginReplayPresentation()
    transport.ingest({ type: 'replay-start', generation: 1, highWater: 12, resetFloorSeq: 0 })
    transport.ingest(evt({ seq: 1, kind: 'session/created', sessionId: 's1', payload: rec('s1') }))
    for (let seq = 2; seq <= 12; seq++) {
      transport.ingest(
        evt({ seq, kind: 'session/input', sessionId: 's1', payload: { text: `replayed-${seq}` } })
      )
    }
    transport.ingest({ type: 'replay-complete', lastSeq: 12, generation: 1 })

    transport.flushEvents()

    expect(
      replayStore.sessions.s1?.items.filter((item) => item.kind === 'user').map((item) => item.text)
    ).toEqual(Array.from({ length: 11 }, (_, index) => `replayed-${index + 2}`))
    expect(replayStore.lastSeq).toBe(12)
  })

  it('adopts a newer generation only when its durable reset floor is already behind the cursor', () => {
    const { replayStore, transport } = harness()
    replayStore.lastSeq = 10
    transport.ingest({ type: 'replay-start', generation: 101, highWater: 10, resetFloorSeq: 8 })
    transport.ingest({ type: 'replay-complete', lastSeq: 10, generation: 101 })
    transport.flushEvents()

    expect(replayStore.replayGeneration).toBe(101)
    expect(replayStore.lastSeq).toBe(10)
  })

  it('drains a paused live-event batch without resetting or dropping overflow', async () => {
    vi.useFakeTimers()
    try {
      const { replayStore, transport } = harness()
      const internals = replayStore as unknown as {
        pendingEvents: HubEvent[]
        pendingEventBytes: number
        refreshRequiredBaseline(): Promise<boolean>
      }
      const refresh = vi
        .spyOn(internals, 'refreshRequiredBaseline')
        .mockResolvedValue(false)
      for (let seq = 1; seq <= 1_025; seq += 1) {
        transport.ingest(
          evt({
            seq,
            kind: 'session/activity',
            sessionId: 's1',
            payload: { marker: `live-${seq}` },
          })
        )
      }
      await Promise.resolve()

      // The 1,025th message synchronously drained the first bounded batch, then remained queued for
      // the ordinary frame flush. No baseline jump was allowed to skip the paused renderer's events.
      expect(replayStore.lastSeq).toBe(1_024)
      expect(internals.pendingEvents).toHaveLength(1)
      expect(internals.pendingEventBytes).toBeGreaterThan(0)
      expect(refresh).not.toHaveBeenCalled()

      transport.flushEvents()
      expect(replayStore.lastSeq).toBe(1_025)
      expect(internals.pendingEvents).toHaveLength(0)
      expect(internals.pendingEventBytes).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to normal live presentation when an older hub never sends a boundary', () => {
    vi.useFakeTimers()
    try {
      const { replayStore, transport } = harness()
      transport.beginReplayPresentation()
      transport.ingest(evt({ seq: 1, kind: 'session/created', sessionId: 's1', payload: rec('s1') }))
      transport.ingest(evt({ seq: 2, kind: 'session/input', sessionId: 's1', payload: { text: 'legacy replay' } }))
      transport.flushEvents()
      expect(replayStore.replayPresentationActive).toBe(true)

      vi.runAllTimers()
      expect(replayStore.replayPresentationActive).toBe(false)
      transport.ingest(evt({ seq: 3, kind: 'session/input', sessionId: 's1', payload: { text: 'legacy live' } }))
      transport.flushEvents()

      const messages = replayStore.sessions.s1?.items.filter((item) => item.kind === 'user') ?? []
      expect(messages.map((item) => [item.text, item.replayed])).toEqual([
        ['legacy replay', true],
        ['legacy live', false],
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('bounded cold baseline and global maintenance status', () => {
  it('installs current state without requesting or decoding any historical journal row', () => {
    vi.mocked(api.journalHistory).mockClear()
    const cold = new HubStore()
    const install = cold as unknown as {
      installReplayBaseline(baseline: Awaited<ReturnType<typeof api.replayBaseline>>): void
    }
    const payloadTrap = new Proxy(
      {},
      {
        get() {
          throw new Error('historical payload was decoded during cold baseline')
        },
      }
    )
    void payloadTrap

    install.installReplayBaseline({
      version: 1,
      generation: 7,
      highWaterSeq: 690_000,
      resetFloorSeq: 500_000,
      sessions: [rec('s1'), rec('s2')],
      projects: [],
      journalCompaction: null,
    })
    expect(cold.sessions.s1?.items).toEqual([])
    expect(cold.lastSeq).toBe(690_000)
    expect(cold.replayGeneration).toBe(7)
    expect(api.journalHistory).not.toHaveBeenCalled()
  })

  it('keeps database maintenance global instead of injecting it into every chat transcript', () => {
    seed('s1')
    apply(
      evt({
        seq: 1,
        kind: 'journal/compaction-progress',
        payload: {
          operationId: '11111111-1111-4111-8111-111111111111',
          phase: 'progress',
          startedAt: '2026-07-30T12:00:00.000Z',
          updatedAt: '2026-07-30T12:00:01.000Z',
          rowsDeleted: 5_000,
          payloadBytesDeleted: 8_000_000,
          detail: 'Committed one bounded batch.',
        },
      })
    )

    expect(store.journalCompaction).toEqual(
      expect.objectContaining({ phase: 'progress', rowsDeleted: 5_000 })
    )
    expect(store.sessions.s1?.items).toEqual([])
  })

  it('hydrates a hub-native transcript through the pure page reducer without live side effects', async () => {
    const cold = new HubStore()
    const install = cold as unknown as {
      installReplayBaseline(baseline: Awaited<ReturnType<typeof api.replayBaseline>>): void
    }
    install.installReplayBaseline({
      version: 1,
      generation: 3,
      highWaterSeq: 50,
      resetFloorSeq: 0,
      sessions: [rec('s1')],
      projects: [],
      journalCompaction: null,
    })
    vi.mocked(api.approvals).mockClear()
    vi.mocked(api.journalHistory).mockResolvedValueOnce({
      events: [
        evt({ seq: 10, kind: 'approval/requested', sessionId: 's1', payload: { id: 'old' } }),
        evt({ seq: 11, kind: 'session/input', sessionId: 's1', payload: { text: 'old prompt' } }),
      ],
      olderCursor: 10,
      hasOlder: true,
      encodedBytes: 200,
      checkpointGeneration: 3,
    })

    await cold.ensureHistory('s1')

    expect(cold.sessions.s1?.items.map((item) => item.text)).toEqual(['old prompt'])
    expect(cold.sessions.s1?.journalHistoryOlderCursor).toBe(10)
    expect(cold.sessions.s1?.lastActivity).toBe('2026-01-01T00:00:05.000Z')
    expect(cold.sessions.s1?.record.lastActivity).toBe('2026-01-01T00:00:05.000Z')
    expect(api.approvals).not.toHaveBeenCalled()
    expect(api.journalHistory).toHaveBeenCalledWith('s1', 3, 51, expect.anything())
  })

  it('rehydrates every open native pane after a required baseline reset', async () => {
    const recovering = new HubStore()
    recovering.selectedId = 's1'
    recovering.sessions.s1 = {
      record: rec('s1'),
      items: [{ key: 'stale', kind: 'assistant', ts: '2026-01-01T00:00:00.000Z', text: 'stale cutoff' }],
      lastActivity: '2026-01-01T00:00:00.000Z',
      sawReasoning: false,
    }
    vi.mocked(api.replayBaseline).mockResolvedValueOnce({
      version: 1,
      generation: 9,
      highWaterSeq: 100,
      resetFloorSeq: 80,
      sessions: [rec('s1')],
      projects: [],
      journalCompaction: null,
    })
    vi.mocked(api.journalHistory).mockResolvedValueOnce({
      events: [
        evt({
          seq: 99,
          kind: 'codex/item/completed',
          sessionId: 's1',
          payload: { item: { id: 'reply', type: 'agentMessage', text: 'recovered reply' } },
        }),
      ],
      olderCursor: null,
      hasOlder: false,
      encodedBytes: 200,
      checkpointGeneration: 9,
    })
    const transport = recovering as unknown as {
      refreshRequiredBaseline(): Promise<boolean>
    }

    await expect(transport.refreshRequiredBaseline()).resolves.toBe(true)
    await vi.waitFor(() => {
      expect(recovering.sessions.s1?.items.map((item) => item.text)).toContain('recovered reply')
    })

    expect(recovering.sessions.s1?.items.map((item) => item.text)).not.toContain('stale cutoff')
    expect(api.journalHistory).toHaveBeenCalledWith('s1', 9, 101, expect.anything())
  })

  it('retries an imported transcript after a bounded first-load failure', async () => {
    const cold = new HubStore()
    const install = cold as unknown as {
      installReplayBaseline(baseline: Awaited<ReturnType<typeof api.replayBaseline>>): void
    }
    install.installReplayBaseline({
      version: 1,
      generation: 3,
      highWaterSeq: 50,
      resetFloorSeq: 0,
      sessions: [rec('imported-1', { imported: true })],
      projects: [],
      journalCompaction: null,
    })
    vi.mocked(api.history).mockRejectedValueOnce(new Error('temporary history outage'))

    await cold.ensureHistory('imported-1')

    expect(cold.sessions['imported-1']?.loadingHistory).toBe(false)
    expect(cold.sessions['imported-1']?.historyLoadError).toContain('temporary history outage')

    vi.mocked(api.history).mockResolvedValueOnce({
      items: [{ kind: 'user', text: 'restored transcript' }],
      olderCursor: null,
      hasOlder: false,
    })
    await cold.ensureHistory('imported-1')

    expect(cold.sessions['imported-1']?.items.map((item) => item.text)).toContain(
      'restored transcript',
    )
    expect(api.history).toHaveBeenCalledTimes(2)
  })

  it('keeps every lazily loaded page and live item when scrolling or tabbing away and back', async () => {
    const cold = new HubStore()
    const install = cold as unknown as {
      installReplayBaseline(baseline: Awaited<ReturnType<typeof api.replayBaseline>>): void
    }
    install.installReplayBaseline({
      version: 1,
      generation: 4,
      highWaterSeq: 10_000,
      resetFloorSeq: 0,
      sessions: [rec('s1')],
      projects: [],
      journalCompaction: null,
    })
    cold.selectedId = 's1'
    const page = (prefix: string, start: number) => ({
      events: Array.from({ length: 80 }, (_, index) =>
        evt({
          seq: start + index,
          kind: 'session/input',
          sessionId: 's1',
          payload: { text: `${prefix}-${index}-${'x'.repeat(2_000)}` },
        })
      ),
      olderCursor: start,
      hasOlder: true,
      encodedBytes: 170_000,
      checkpointGeneration: 4,
    })
    vi.mocked(api.journalHistory).mockResolvedValueOnce(page('latest', 9_000))
    await cold.ensureHistory('s1')

    const latestCount = cold.sessions.s1?.items.length ?? 0
    expect(latestCount).toBeGreaterThan(0)

    for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
      vi.mocked(api.journalHistory).mockResolvedValueOnce(
        page(`older-${pageIndex}`, 8_000 - pageIndex * 100)
      )
      await cold.loadOlderHistory('s1')
    }

    const texts = cold.sessions.s1?.items.map((item) => item.text) ?? []
    expect(texts.some((text) => text?.startsWith('older-7-'))).toBe(true)
    expect(texts.some((text) => text?.startsWith('latest-'))).toBe(true)
    expect((cold.sessions.s1?.items.length ?? 0)).toBeGreaterThan(latestCount)

    for (let index = 0; index < 100; index += 1) {
      cold.pushUserEcho('s1', `live-${index}-${'y'.repeat(6_000)}`)
    }
    const beforeTabSwitch = cold.sessions.s1?.items.map((item) => item.key) ?? []
    cold.select('s2')
    cold.select('s1')

    expect(cold.sessions.s1?.items.map((item) => item.key)).toEqual(beforeTabSwitch)
    expect(cold.sessions.s1?.items.some((item) => item.text?.startsWith('latest-'))).toBe(true)
    expect(cold.sessions.s1?.items.some((item) => item.text?.startsWith('older-7-'))).toBe(true)
    expect(cold.sessions.s1?.items.some((item) => item.text?.startsWith('live-99-'))).toBe(true)
  })

  it('transparently retries the same older cursor when maintenance advances history generation', async () => {
    const cold = new HubStore()
    const install = cold as unknown as {
      installReplayBaseline(baseline: Awaited<ReturnType<typeof api.replayBaseline>>): void
    }
    install.installReplayBaseline({
      version: 1,
      generation: 4,
      highWaterSeq: 10_000,
      resetFloorSeq: 0,
      sessions: [rec('s1')],
      projects: [],
      journalCompaction: null,
    })
    vi.mocked(api.journalHistory).mockResolvedValueOnce({
      events: [
        evt({
          seq: 9_100,
          kind: 'codex/item/completed',
          sessionId: 's1',
          payload: { item: { id: 'latest', type: 'agentMessage', text: 'latest retained' } },
        }),
      ],
      olderCursor: 9_100,
      hasOlder: true,
      encodedBytes: 200,
      checkpointGeneration: 4,
    })
    await cold.ensureHistory('s1')

    vi.mocked(api.journalHistory)
      .mockRejectedValueOnce(
        Object.assign(new Error('journal history generation changed (4 -> 5)'), {
          name: 'JournalHistoryGenerationChangedError',
          expected: 4,
          actual: 5,
        }),
      )
      .mockResolvedValueOnce({
        events: [
          evt({
            seq: 8_500,
            kind: 'session/input',
            sessionId: 's1',
            payload: { text: 'older retained' },
          }),
        ],
        olderCursor: 8_500,
        hasOlder: true,
        encodedBytes: 100,
        checkpointGeneration: 5,
      })

    await expect(cold.loadOlderHistory('s1')).resolves.toBe(true)

    expect(api.journalHistory).toHaveBeenNthCalledWith(2, 's1', 4, 9_100, expect.anything())
    expect(api.journalHistory).toHaveBeenNthCalledWith(3, 's1', 5, 9_100, expect.anything())
    expect(cold.sessions.s1?.journalHistoryGeneration).toBe(5)
    expect(cold.sessions.s1?.historyLoadError).toBeUndefined()
    expect(cold.sessions.s1?.items.map((item) => item.text)).toEqual(
      expect.arrayContaining(['older retained', 'latest retained']),
    )
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

  it('keeps uploaded attachment ids on a queued message through the later flush', async () => {
    seed('a')
    const attachment = {
      id: 'att-1',
      name: 'queued.png',
      mime: 'image/png',
      size: 123,
      kind: 'image' as const,
    }
    store.enqueue('a', 'see this', [attachment])
    completeTurn('a', 1)
    await tick()

    expect(api.send).toHaveBeenCalledWith('a', 'see this', { attachments: ['att-1'] })
    expect(store.sessions.a?.items.find((item) => item.kind === 'user')?.attachments).toEqual([attachment])
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
  it('shows a durable parent-transcript note when an operator requests one sub-agent stop', () => {
    seed('a')
    apply(
      evt({
        seq: 1,
        kind: 'session/agent-stop-requested',
        sessionId: 'a',
        payload: { targetId: 'task-1', label: 'slow audit' },
      })
    )

    expect(
      store.sessions['a']!.items.some(
        (i) => i.kind === 'note' && i.text === 'stop requested for slow audit — work preserved'
      )
    ).toBe(true)
  })

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

describe('codex sub-agent ingest', () => {
  const id = 'codex-subagents'
  const root = 'root-thread'
  let codexSeq = 1
  const started = (agentThreadId: string, parentThreadId: string = root, over: Record<string, unknown> = {}): void => {
    apply(
      evt({
        seq: codexSeq++,
        kind: 'codex/subagent/thread/started',
        sessionId: id,
        payload: {
          threadId: root,
          agentThreadId,
          parentThreadId,
          thread: {
            id: agentThreadId,
            parentThreadId,
            preview: 'Trace the event path',
            status: { type: 'active', activeFlags: [] },
            agentRole: 'explorer',
            ...over,
          },
        },
      })
    )
  }

  beforeEach(() => {
    codexSeq = 1
    seed(id, { provider: 'codex', vendorSessionId: root })
  })

  it('creates a running agent from the real child-thread start, without a completion blob', () => {
    started('child')

    const runs = buildAgentRuns(store.sessions[id]!.items, Date.parse('2026-01-01T00:00:06.000Z'))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: 'child',
      description: 'Trace the event path',
      subagentType: 'explorer',
      status: 'running',
    })
    expect(runs[0]!.result).toBeUndefined()
  })

  it('creates the run from Codex 0.145 subAgentActivity and does not mistake interaction for completion', () => {
    apply(
      evt({
        seq: codexSeq++,
        kind: 'codex/item/completed',
        sessionId: id,
        payload: {
          threadId: root,
          turnId: 'root-turn',
          item: {
            type: 'subAgentActivity',
            id: 'spawn-call',
            kind: 'started',
            agentThreadId: 'child',
            agentPath: '/root/inspect_package',
          },
        },
      })
    )
    apply(
      evt({
        seq: codexSeq++,
        kind: 'codex/item/completed',
        sessionId: id,
        payload: {
          threadId: root,
          turnId: 'root-turn',
          item: {
            type: 'subAgentActivity',
            id: 'message-call',
            kind: 'interacted',
            agentThreadId: 'child',
            agentPath: '/root/inspect_package',
          },
        },
      })
    )

    const run = buildAgentRuns(store.sessions[id]!.items, Date.parse('2026-01-01T00:00:06.000Z'))[0]!
    expect(run).toMatchObject({
      id: 'child',
      description: 'inspect package',
      status: 'running',
    })
    expect(run.result).toBeUndefined()
  })

  it('uses the structured subAgentActivity interrupted edge as a stopped terminal state', () => {
    for (const [seq, kind] of [
      [codexSeq++, 'started'],
      [codexSeq++, 'interrupted'],
    ] as const) {
      apply(
        evt({
          seq,
          kind: 'codex/item/completed',
          sessionId: id,
          payload: {
            threadId: root,
            turnId: 'root-turn',
            item: {
              type: 'subAgentActivity',
              id: `${kind}-call`,
              kind,
              agentThreadId: 'child',
              agentPath: '/root/worker',
            },
          },
        })
      )
    }

    expect(buildAgentRuns(store.sessions[id]!.items)[0]).toMatchObject({
      id: 'child',
      status: 'failed',
      outcome: 'stopped',
    })
  })

  it('attributes the child item stream to the child and completes only on turn/completed', () => {
    started('child')
    apply(
      evt({
        seq: codexSeq++,
        kind: 'codex/subagent/item/completed',
        sessionId: id,
        payload: {
          threadId: root,
          agentThreadId: 'child',
          parentThreadId: root,
          turnId: 'child-turn',
          item: { type: 'agentMessage', id: 'answer', text: 'I traced it.' },
        },
      })
    )

    let run = buildAgentRuns(store.sessions[id]!.items, Date.parse('2026-01-01T00:00:06.000Z'))[0]!
    expect(run.status).toBe('running')
    expect(run.activity).toHaveLength(1)
    expect(run.activity[0]).toMatchObject({ kind: 'assistant', text: 'I traced it.', agentId: 'child' })

    apply(
      evt({
        seq: codexSeq++,
        kind: 'codex/subagent/turn/completed',
        sessionId: id,
        payload: {
          threadId: root,
          agentThreadId: 'child',
          parentThreadId: root,
          turn: { id: 'child-turn', status: 'completed', error: null },
        },
      })
    )
    run = buildAgentRuns(store.sessions[id]!.items, Date.parse('2026-01-01T00:00:06.000Z'))[0]!
    expect(run.status).toBe('done')
    expect(run.endedAt).toBe('2026-01-01T00:00:05.000Z')
    expect(run.result).toBeUndefined()
  })

  it('uses failed and interrupted terminal statuses verbatim instead of prose inference', () => {
    started('failed-child')
    apply(
      evt({
        seq: codexSeq++,
        kind: 'codex/subagent/turn/completed',
        sessionId: id,
        payload: {
          threadId: root,
          agentThreadId: 'failed-child',
          parentThreadId: root,
          turn: { id: 'failed-turn', status: 'failed', error: { message: 'model failed' } },
        },
      })
    )
    started('stopped-child')
    apply(
      evt({
        seq: codexSeq++,
        kind: 'codex/subagent/turn/completed',
        sessionId: id,
        payload: {
          threadId: root,
          agentThreadId: 'stopped-child',
          parentThreadId: root,
          turn: { id: 'stopped-turn', status: 'interrupted', error: null },
        },
      })
    )

    const runs = buildAgentRuns(store.sessions[id]!.items, Date.parse('2026-01-01T00:00:06.000Z'))
    expect(runs.find((run) => run.id === 'failed-child')).toMatchObject({ status: 'failed', outcome: 'failed' })
    expect(runs.find((run) => run.id === 'stopped-child')).toMatchObject({ status: 'failed', outcome: 'stopped' })
  })

  it('nests a child spawned by another child thread', () => {
    started('outer')
    started('inner', 'outer', { preview: 'Nested task' })

    const inner = buildAgentRuns(store.sessions[id]!.items, Date.parse('2026-01-01T00:00:06.000Z')).find(
      (run) => run.id === 'inner'
    )
    expect(inner?.parentId).toBe('outer')
  })

  it('does not treat a completed spawn tool call as completed agent work', () => {
    apply(
      evt({
        seq: codexSeq++,
        kind: 'codex/item/completed',
        sessionId: id,
        payload: {
          threadId: root,
          turnId: 'root-turn',
          item: {
            type: 'collabAgentToolCall',
            id: 'spawn-call',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: root,
            receiverThreadIds: ['child'],
            prompt: 'Investigate',
            model: null,
            reasoningEffort: null,
            agentsStates: { child: { status: 'running', message: null } },
          },
        },
      })
    )

    const run = buildAgentRuns(store.sessions[id]!.items, Date.parse('2026-01-01T00:00:06.000Z'))[0]!
    expect(run.status).toBe('running')
    expect(run.result).toBeUndefined()
  })

  it('uses structured agent state but never renders its message field as a returned blob', () => {
    started('child')
    apply(
      evt({
        seq: codexSeq++,
        kind: 'codex/item/completed',
        sessionId: id,
        payload: {
          threadId: root,
          turnId: 'root-turn',
          item: {
            type: 'collabAgentToolCall',
            id: 'wait-call',
            tool: 'wait',
            status: 'completed',
            senderThreadId: root,
            receiverThreadIds: ['child'],
            prompt: null,
            agentsStates: {
              child: { status: 'completed', message: 'agentId/output-file/internal coordination blob' },
            },
          },
        },
      })
    )

    const run = buildAgentRuns(store.sessions[id]!.items, Date.parse('2026-01-01T00:00:06.000Z'))[0]!
    expect(run.status).toBe('done')
    expect(run.result).toBeUndefined()
  })
})

describe('codex plan ingest', () => {
  it('materializes a durable plan snapshot that the task board can replay', () => {
    const id = 'codex-plan'
    seed(id, { provider: 'codex', vendorSessionId: 'root-thread' })

    apply(
      evt({
        seq: 1,
        kind: 'codex/turn/plan/updated',
        sessionId: id,
        payload: {
          threadId: 'root-thread',
          turnId: 'turn-1',
          explanation: 'Inspect both manifests',
          plan: [
            { step: 'Inspect package.json', status: 'completed' },
            { step: 'Inspect apps/web/package.json', status: 'inProgress' },
          ],
        },
      })
    )

    const board = buildTaskBoard(store.sessions[id]!.items)
    expect(board.source).toBe('plan')
    expect(board.tasks.map((task) => `${task.title}:${task.status}`)).toEqual([
      'Inspect package.json:completed',
      'Inspect apps/web/package.json:in_progress',
    ])
  })

  it('materializes a manager assignment on the child’s operator-visible board', () => {
    const id = 'managed-child'
    seed(id)
    apply(
      evt({
        seq: 2,
        kind: 'manager/task-assigned',
        sessionId: id,
        payload: {
          id: 'manager:1',
          title: 'Own parser.ts',
          status: 'in_progress',
          managerSessionId: 'manager',
          managerLabel: 'Curie',
        },
      }),
    )
    expect(buildTaskBoard(store.sessions[id]!.items).tasks).toEqual([
      expect.objectContaining({
        title: 'Own parser.ts',
        origin: 'manager',
        assignedByLabel: 'Curie',
      }),
    ])
  })
})
