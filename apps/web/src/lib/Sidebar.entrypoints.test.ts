import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import Sidebar from './Sidebar.svelte'
import { store } from './store.svelte'

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

const project = {
  id: 'project-default',
  name: 'Product',
  path: 'C:/work/product',
  createdAt: '2026-07-27T00:00:00.000Z',
}

beforeEach(() => {
  localStorage.clear()
  store.sessions = {}
  store.projects = [project]
  store.profiles = [{ id: 'claude-main', provider: 'claude' }]
  store.selectedId = null
  store.splitPanes = []
  store.projectViewId = null
  store.projectViewMode = null
  store.lastProfileId = null
})

afterEach(() => cleanup())

describe('sidebar launch controls', () => {
  it('keeps the sidebar navigation-only without leaving an empty launch-action wrapper', () => {
    const { container } = render(Sidebar)

    expect(screen.queryByRole('button', { name: /New Project/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /New Scratchpad/ })).toBeNull()
    expect(screen.queryByTitle('new project')).toBeNull()
    expect(screen.queryByTitle('new chat')).toBeNull()
    expect(screen.queryByPlaceholderText('project name')).toBeNull()
    expect(container.querySelector('.creation-entrypoints')).toBeNull()
    expect(container.querySelector('.sec-head')?.nextElementSibling?.classList.contains('list')).toBe(true)
    expect(screen.getByTitle('new chat here')).toBeTruthy()
    expect(screen.getByTitle('project managers')).toBeTruthy()
  })

  it('opens a manager row directly in its full project-scoped conversation', async () => {
    store.sessions = {
      manager: {
        record: {
          id: 'manager',
          profileId: 'claude-main',
          provider: 'claude',
          projectId: project.id,
          cwd: project.path,
          status: 'idle',
          title: 'Noether',
          isProjectManager: true,
          createdAt: project.createdAt,
        },
        items: [],
        lastActivity: project.createdAt,
        sawReasoning: false,
      },
    }
    store.selectedId = 'some-other-chat'
    store.splitPanes = [['some-other-chat']]

    render(Sidebar)

    const manager = screen.getByRole('button', { name: 'Open Product manager conversation' })
    await fireEvent.click(manager)

    expect(store.projectViewId).toBe(project.id)
    expect(store.projectViewMode).toBe('manager')
    expect(store.selectedId).toBeNull()
    expect(store.splitPanes).toEqual([])
  })

  it('opens the new project chat instead of bubbling back to the project overview', async () => {
    store.projectViewId = project.id
    render(Sidebar)

    await fireEvent.click(screen.getByTitle('new chat here'))

    expect(store.projectViewId).toBeNull()
    expect(store.selectedId).toMatch(/^draft:/)
    expect(store.sessions[store.selectedId!]?.record.projectId).toBe(project.id)
  })

  it('lets the operator inspect a managed child purpose without opening its chat', async () => {
    store.sessions = {
      manager: {
        record: {
          id: 'manager', profileId: 'claude-main', provider: 'claude', projectId: project.id,
          cwd: project.path, status: 'idle', title: 'Noether', isProjectManager: true,
          managerTeams: [{ id: 'team-a', name: 'Core', createdAt: project.createdAt, activatedAt: project.createdAt }],
          managerActiveTeamId: 'team-a', createdAt: project.createdAt,
        },
        items: [], lastActivity: project.createdAt, sawReasoning: false,
      },
      child: {
        record: {
          id: 'child', profileId: 'claude-main', provider: 'claude', projectId: project.id,
          cwd: project.path, status: 'idle', title: 'Bose', parentSessionId: 'manager',
          managerTeamId: 'team-a', managerTeamName: 'Core', role: 'Audit concurrency and reproduce races.',
          createdAt: project.createdAt,
        },
        items: [], lastActivity: project.createdAt, sawReasoning: false,
      },
    }

    render(Sidebar)
    const purpose = screen.getByRole('button', {
      name: 'Bose purpose: Audit concurrency and reproduce races.',
    })
    await fireEvent.click(purpose)

    expect(store.selectedId).toBeNull()
    expect(purpose.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('note').textContent).toMatch(/Audit concurrency and reproduce races\./u)
  })
})
