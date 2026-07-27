import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import { render } from '@testing-library/svelte'
import Sidebar from './Sidebar.svelte'
import { store, type SessionView } from './store.svelte'
import type { HubEvent, SessionRecord } from './api'

// The sidebar's ONLY job while several agents run at once is to stay still. These tests drive the real
// event path (`store.apply`, the same method the WebSocket feeds) and assert on the order the sidebar
// actually renders, because "rows jump around" is a render-level complaint that a unit test of a
// comparator cannot prove on its own. chatOrder.test.ts covers the comparator itself.
//
// Every network call is stubbed: the store is a module singleton and a stray timer must not reach a hub
// that isn't there.
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy({} as Record<string, unknown>, { get: () => () => Promise.resolve([]) }),
  }
})

// jsdom implements no matchMedia; the sidebar reads it once to decide whether to run the drag FLIP.
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

const PROJ = 'proj-a'

function seed(id: string, title: string, createdAt: string, lastActivity = createdAt): void {
  const record = {
    id,
    profileId: 'p1',
    provider: 'claude',
    projectId: PROJ,
    cwd: 'C:/work',
    status: 'idle',
    createdAt,
    lastActivity,
    title,
  } as SessionRecord
  // Deliberately NO sort-key field here: a view seeded straight from the roster is exactly what the app
  // has before any event arrives, and the ordering must be correct from that state alone.
  store.sessions[id] = { record, items: [], lastActivity, sawReasoning: false }
}

let seq = 0
function apply(kind: string, sessionId: string, ts: string, payload: unknown = {}): void {
  const event: HubEvent = { seq: ++seq, ts, sessionId, kind, payload }
  ;(store as unknown as { apply(e: HubEvent): void }).apply(event)
}

/**
 * Minutes of streamed output: interleaved deltas and token counters across every chat.
 *
 * Each round walks the ids forward then BACKWARD, so a round always ends on `ids[0]` — the chat
 * lowest in the list. A one-directional burst ends on whichever chat was already on top and would
 * therefore pass even against a comparator that reorders on every single event.
 */
function burst(ids: string[], rounds: number, startSec: number): void {
  let sec = startSec
  const sweep = [...ids, ...[...ids].reverse()]
  for (let r = 0; r < rounds; r++) {
    for (const id of sweep) {
      const ts = at(sec++)
      apply('codex/item/agentMessage/delta', id, ts, { itemId: `m${r}`, delta: 'x' })
      apply('session/tokens', id, ts, { input: r * 10, output: r * 5 })
    }
  }
}

function at(sec: number): string {
  const m = String(Math.floor(sec / 60)).padStart(2, '0')
  const s = String(sec % 60).padStart(2, '0')
  return `2026-01-01T10:${m}:${s}.000Z`
}

/** The order the sidebar would render for the project group, by chat title. */
function order(): string[] {
  const inGroup = store.sessionList.filter((s) => (s.record.projectId ?? '__none__') === PROJ)
  return store.orderedChats(PROJ, inGroup).map((s) => s.record.title ?? s.record.id)
}

/** The order actually painted into the DOM. */
function rendered(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.rlabel')].map((e) => e.textContent ?? '')
}

beforeEach(() => {
  localStorage.clear()
  seq = 0
  store.sessions = {}
  store.approvals = []
  store.queues = {}
  store.selectedId = null
  store.splitPanes = []
  store.lastSeq = 0
  store.chatOrder = {}
  store.projectOrder = []
  store.projects = [{ id: PROJ, name: 'Alpha', path: 'C:/work', createdAt: at(0) }]
})

describe('sidebar ordering while chats stream', () => {
  it('does not reorder under a burst of activity on several chats at once', () => {
    seed('s1', 'one', at(0))
    seed('s2', 'two', at(60))
    seed('s3', 'three', at(120))

    // All three start working, staggered — this is the state the operator is looking at.
    apply('session/status', 's1', at(180), { status: 'active' })
    apply('session/status', 's2', at(181), { status: 'active' })
    apply('session/status', 's3', at(182), { status: 'active' })
    const before = order()

    // Minutes of interleaved streaming from all three.
    burst(['s1', 's2', 's3'], 20, 200)

    expect(order()).toEqual(before)
  })

  it('does not yank a chat to the top mid-stream, and moves it only once the turn settles', () => {
    // Creation order and recency order are deliberately OPPOSITE, so freezing everything on createdAt
    // would fail the very first assertion: an idle fleet still lists most-recently-active first.
    seed('s1', 'one', at(0), at(300))
    seed('s2', 'two', at(60), at(120))
    seed('s3', 'three', at(120), at(60))
    expect(order()).toEqual(['one', 'two', 'three'])

    // The BOTTOM chat starts working and streams for a while.
    apply('session/status', 's3', at(360), { status: 'active' })
    burst(['s3'], 15, 380)
    expect(order()).toEqual(['one', 'two', 'three']) // still parked where it was

    // Turn over — now, and only now, it takes its new place.
    apply('session/status', 's3', at(600), { status: 'idle' })
    expect(order()).toEqual(['three', 'one', 'two'])
  })

  it('keeps the manual order, and a burst on an unarranged chat cannot reshuffle the rest', () => {
    seed('s1', 'one', at(0))
    seed('s2', 'two', at(60))
    seed('s3', 'three', at(120))
    seed('s4', 'four', at(180))
    // The operator dragged three above one. two/four were never arranged, so they trail by recency.
    store.chatOrder = { [PROJ]: ['s3', 's1'] }
    expect(order()).toEqual(['three', 'one', 'four', 'two'])

    apply('session/status', 's2', at(240), { status: 'active' })
    burst(['s2'], 15, 260)

    expect(order()).toEqual(['three', 'one', 'four', 'two'])
  })

  it('gives the same order however the chats happen to arrive', () => {
    // Two chats the store cannot tell apart by recency. Whatever the bucketing handed us, the rendered
    // order must be identical — equal keys that swap between renders are thrash from a second cause.
    seed('a', 'a', at(0))
    seed('b', 'b', at(0))
    const forward = store.orderedChats(PROJ, [store.sessions.a!, store.sessions.b!])
    const backward = store.orderedChats(PROJ, [store.sessions.b!, store.sessions.a!])
    expect(backward.map((s) => s.record.id)).toEqual(forward.map((s) => s.record.id))
  })
})

describe('the rendered sidebar while chats stream', () => {
  it('paints the same rows in the same places through a burst, inside folders and out', () => {
    localStorage.setItem(
      'allmyagents.ui.chatFolders',
      JSON.stringify({
        folders: [{ id: 'folder:a', groupId: PROJ, name: 'Specs' }],
        assignments: { s1: 'folder:a', s2: 'folder:a' },
      })
    )
    seed('s1', 'one', at(0))
    seed('s2', 'two', at(60))
    seed('s3', 'three', at(120))

    const { container } = render(Sidebar)
    const el = container as HTMLElement
    const before = rendered(el)
    expect(before).toEqual(['two', 'one', 'three']) // folder rows first, then the loose one

    apply('session/status', 's1', at(180), { status: 'active' })
    apply('session/status', 's3', at(181), { status: 'active' })
    burst(['s1', 's3'], 20, 200)
    flushSync()

    expect(rendered(el)).toEqual(before)
  })
})
