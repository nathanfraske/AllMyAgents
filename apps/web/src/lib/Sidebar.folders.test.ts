import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import Sidebar from './Sidebar.svelte'
import { store, type SessionView } from './store.svelte'
import type { SessionRecord } from './api'

// The unit tests in folders.test.ts prove the partition math. This proves the SIDEBAR actually
// survives it — the requirement that matters most here is that no persisted state, however stale or
// corrupt, can crash the list or make a chat disappear from it. That can only be checked by mounting
// the real component, because the failure mode is a render-time throw, not a wrong return value.
//
// Every network call is stubbed: the component's own code path never fetches, but `store` is a
// module singleton and a stray timer must not reach a hub that isn't there.
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy({} as Record<string, unknown>, { get: () => () => Promise.resolve([]) }),
  }
})

// jsdom implements no matchMedia, and the sidebar reads it once per instance to decide whether to
// run the drag FLIP animation. Stub it to "no preference" — the normal path in the real app.
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

function seedSession(id: string, projectId: string | undefined, title: string): SessionView {
  const record = {
    id,
    profileId: 'p1',
    provider: 'claude',
    projectId,
    cwd: 'C:/work',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    title,
  } as SessionRecord
  return { record, items: [], lastActivity: '2026-01-01T00:00:00.000Z', sawReasoning: false }
}

beforeEach(() => {
  localStorage.clear()
  store.projects = [{ id: 'proj-a', name: 'Alpha', path: 'C:/work', createdAt: '2026-01-01T00:00:00.000Z' }]
  store.projectOrder = []
  store.chatOrder = {}
  store.approvals = []
  store.sessions = {
    s1: seedSession('s1', 'proj-a', 'one'),
    s2: seedSession('s2', 'proj-a', 'two'),
    s3: seedSession('s3', undefined, 'three'),
  }
})

const labels = (c: HTMLElement): string[] => [...c.querySelectorAll('.rlabel')].map((e) => e.textContent)

describe('Sidebar with folder state', () => {
  it('renders every chat when there is no folder state at all', () => {
    const { container } = render(Sidebar)
    expect(labels(container as HTMLElement).sort()).toEqual(['one', 'three', 'two'])
  })

  it('renders a chat inside its folder, and the folder header', () => {
    localStorage.setItem(
      'allmyagents.ui.chatFolders',
      JSON.stringify({ folders: [{ id: 'folder:a', groupId: 'proj-a', name: 'Specs' }], assignments: { s2: 'folder:a' } })
    )
    const { container } = render(Sidebar)
    const el = container as HTMLElement
    expect([...el.querySelectorAll('.fname')].map((e) => e.textContent)).toEqual(['Specs'])
    // The rail is what makes membership visible at a glance — the filed chat must be inside one.
    const railed = [...el.querySelectorAll('.entry.infolder .rlabel')].map((e) => e.textContent)
    expect(railed).toEqual(['two'])
    expect(labels(el).sort()).toEqual(['one', 'three', 'two']) // and nothing went missing
  })

  it('keeps an empty folder on screen as a drop target', () => {
    localStorage.setItem(
      'allmyagents.ui.chatFolders',
      JSON.stringify({ folders: [{ id: 'folder:a', groupId: 'proj-a', name: 'Empty' }], assignments: {} })
    )
    const { container } = render(Sidebar)
    expect((container as HTMLElement).querySelector('.fempty')).not.toBeNull()
  })

  it('hides a collapsed folder\'s chats but keeps the folder header', () => {
    localStorage.setItem(
      'allmyagents.ui.chatFolders',
      JSON.stringify({ folders: [{ id: 'folder:a', groupId: 'proj-a', name: 'Specs' }], assignments: { s2: 'folder:a' } })
    )
    localStorage.setItem('allmyagents.ui.collapsedFolders', JSON.stringify(['folder:a']))
    const { container } = render(Sidebar)
    const el = container as HTMLElement
    expect([...el.querySelectorAll('.fname')].map((e) => e.textContent)).toEqual(['Specs'])
    expect(labels(el).sort()).toEqual(['one', 'three'])
  })

  it('still shows a chat whose folder was deleted (stale assignment)', () => {
    localStorage.setItem('allmyagents.ui.chatFolders', JSON.stringify({ folders: [], assignments: { s2: 'folder:vanished' } }))
    const { container } = render(Sidebar)
    expect(labels(container as HTMLElement).sort()).toEqual(['one', 'three', 'two'])
  })

  it('survives outright corrupt folder state without throwing', () => {
    localStorage.setItem('allmyagents.ui.chatFolders', '{{{ not json')
    localStorage.setItem('allmyagents.ui.collapsedFolders', 'also not json')
    const { container } = render(Sidebar)
    expect(labels(container as HTMLElement).sort()).toEqual(['one', 'three', 'two'])
  })

  it('nests a child session directly beneath its operator-marked manager', () => {
    store.sessions.s1!.record.isProjectManager = true
    store.sessions.s2!.record.parentSessionId = 's1'
    const { container } = render(Sidebar)
    const el = container as HTMLElement
    const projectLabels = [...el.querySelectorAll('.group:first-child .rlabel')].map((node) => node.textContent)
    expect(projectLabels).toEqual(['one', 'two'])
    expect(el.querySelector('.row.managedchild .rlabel')?.textContent).toBe('two')
    expect(el.querySelector('.row.manager .rlabel')?.textContent).toBe('one')
    expect(el.querySelector('.manager-role')?.textContent).toMatch(/open project overview.*1 agent/i)
    expect(el.querySelector('.manager-role svg')).not.toBeNull()
  })

  it('restores a collapsed manager subtree from the existing collapsed-state store', () => {
    store.sessions.s1!.record.isProjectManager = true
    store.sessions.s2!.record.parentSessionId = 's1'
    localStorage.setItem('allmyagents.ui.collapsedFolders', JSON.stringify(['manager:s1']))
    const { container } = render(Sidebar)
    const el = container as HTMLElement
    expect(labels(el)).toContain('one')
    expect(labels(el)).not.toContain('two')
    expect(el.querySelector('.manager-toggle')).not.toBeNull()
  })

  it('keeps children beneath their manager even when the manager is filed in a folder', () => {
    store.sessions.s1!.record.isProjectManager = true
    store.sessions.s2!.record.parentSessionId = 's1'
    localStorage.setItem(
      'allmyagents.ui.chatFolders',
      JSON.stringify({
        folders: [{ id: 'folder:a', groupId: 'proj-a', name: 'Managed' }],
        assignments: { s1: 'folder:a' },
      })
    )

    const { container } = render(Sidebar)
    const el = container as HTMLElement
    const railed = [...el.querySelectorAll('.entry.infolder .rlabel')].map((node) => node.textContent)
    expect(railed).toEqual(['one', 'two'])
    expect(el.querySelector('.entry.infolder .row.managedchild .rlabel')?.textContent).toBe('two')
  })

  it('reveals only children that need attention while their manager is collapsed', () => {
    store.sessions.s1!.record.isProjectManager = true
    store.sessions.s2!.record.parentSessionId = 's1'
    store.sessions.s4 = seedSession('s4', 'proj-a', 'failed child')
    store.sessions.s4.record.parentSessionId = 's1'
    store.sessions.s4.record.status = 'error'
    store.sessions.s5 = seedSession('s5', 'proj-a', 'approval child')
    store.sessions.s5.record.parentSessionId = 's1'
    store.approvals = [{
      id: 'approval-1',
      sessionId: 's5',
      kind: 'tool',
      payload: {},
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    }]
    localStorage.setItem('allmyagents.ui.collapsedFolders', JSON.stringify(['manager:s1']))

    const { container } = render(Sidebar)
    const el = container as HTMLElement
    expect(labels(el)).not.toContain('two')
    expect(labels(el)).toContain('failed child')
    expect(labels(el)).toContain('approval child')
    expect([...el.querySelectorAll('.row.attentionchild .rlabel')].map((node) => node.textContent).sort())
      .toEqual(['approval child', 'failed child'])
  })

  it('marks a live child whose manager no longer exists instead of losing its lineage silently', () => {
    store.sessions.s2!.record.parentSessionId = 'deleted-manager'
    store.sessions.s2!.record.status = 'active'

    const { container } = render(Sidebar)
    const el = container as HTMLElement
    expect(labels(el)).toContain('two')
    expect(el.querySelector('.row.orphanedchild .rlabel')?.textContent).toBe('two')
    expect(el.querySelector('.manager-orphan')?.getAttribute('title')).toMatch(/manager.*no longer available/i)
  })

  it('keeps live children nested under a stopped manager', () => {
    store.sessions.s1!.record.isProjectManager = true
    store.sessions.s1!.record.status = 'stopped'
    store.sessions.s2!.record.parentSessionId = 's1'
    store.sessions.s2!.record.status = 'active'

    const { container } = render(Sidebar)
    const el = container as HTMLElement
    expect(el.querySelector('.row.manager .rlabel')?.textContent).toBe('one')
    expect(el.querySelector('.row.managedchild .rlabel')?.textContent).toBe('two')
  })
})
