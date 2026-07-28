import { cleanup, render } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar.svelte'
import { store, type SessionView } from './store.svelte'
import type { SessionRecord } from './api'

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy({} as Record<string, unknown>, {
      get: () => () => Promise.resolve([]),
    }),
  }
})

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

const createdAt = '2026-07-27T00:00:00.000Z'

function session(id: string, title: string, worktree?: string, branch?: string): SessionView {
  const record: SessionRecord = {
    id,
    profileId: 'p1',
    provider: 'codex',
    projectId: 'project-1',
    cwd: worktree ?? 'C:/repo',
    worktree,
    branch,
    title,
    status: 'idle',
    createdAt,
  }
  return { record, items: [], lastActivity: createdAt, sawReasoning: false }
}

beforeEach(() => {
  localStorage.clear()
  store.projects = [{ id: 'project-1', name: 'Project', path: 'C:/repo', createdAt }]
  store.projectOrder = []
  store.chatOrder = {}
  store.sessions = {
    isolated: session('isolated', 'isolated chat', 'C:/data/worktrees/37fa1798', 'agent/37fa1798'),
    direct: session('direct', 'direct chat'),
  }
})

afterEach(() => cleanup())

describe('sidebar worktree marker', () => {
  it('shows the recorded branch and full worktree path only for worktree chats', () => {
    const { container } = render(Sidebar)
    const rows = [...container.querySelectorAll<HTMLElement>('.row')]
    const isolated = rows.find((row) => row.textContent?.includes('isolated chat'))
    const direct = rows.find((row) => row.textContent?.includes('direct chat'))

    const marker = isolated?.querySelector<HTMLElement>('.wtbadge')
    expect(marker?.textContent).toContain('agent/37fa1798')
    expect(marker?.title).toBe('C:/data/worktrees/37fa1798')
    expect(direct?.querySelector('.wtbadge')).toBeNull()
  })

  it('provides atomic compact labels for the combined narrow manager and worktree row', () => {
    const manager = session(
      'manager',
      'Project coordination manager with a deliberately long identity',
      'C:/data/worktrees/d7af8a04',
      'agent/d7af8a04-with-a-deliberately-long-branch',
    )
    manager.record.isProjectManager = true
    const child = session('child', 'delegated child')
    child.record.parentSessionId = 'manager'
    store.sessions = { manager, child }

    const { container } = render(Sidebar)
    const row = container.querySelector<HTMLElement>('.row.manager')
    expect(row?.querySelector('.rlabel')?.textContent).toBe(manager.record.title)

    const marker = row?.querySelector<HTMLElement>('.wtbadge')
    expect(marker?.querySelector('.wtbadge-label')?.textContent).toBe(manager.record.branch)
    expect(marker?.title).toBe(manager.record.worktree)

    expect(row?.querySelector('.manager-role-full')?.textContent).toMatch(/open project overview.*1 agent/i)
    expect(row?.querySelector('.manager-role-compact')?.textContent?.trim()).toBe('1')
    expect(row?.querySelector('.manager-role-compact')?.getAttribute('aria-hidden')).toBe('true')
  })
})
