import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import Sidebar from './Sidebar.svelte'
import { settings } from './settings.svelte'
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
  settings.detachedDefaultProjectId = null
  store.sessions = {}
  store.projects = [project]
  store.profiles = [{ id: 'claude-main', provider: 'claude' }]
  store.selectedId = null
  store.splitPanes = []
  store.projectViewId = null
  store.lastProfileId = null
})

afterEach(() => {
  cleanup()
  settings.detachedDefaultProjectId = null
})

describe('sidebar creation entry points', () => {
  it('opens the one New Project flow and removes the obsolete global creation controls', async () => {
    const onnewproject = vi.fn()
    render(Sidebar, { props: { onnewproject } })

    await fireEvent.click(screen.getByRole('button', { name: 'New Project — set up a project and team' }))

    expect(onnewproject).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'New Scratchpad — no project, isolated workspace, start typing' })).toBeTruthy()
    expect(screen.queryByTitle('new project')).toBeNull()
    expect(screen.queryByTitle('new chat')).toBeNull()
    expect(screen.queryByPlaceholderText('project name')).toBeNull()
    expect(screen.getByTitle('new chat here')).toBeTruthy()
    expect(screen.getByTitle('project managers')).toBeTruthy()
  })

  it('always starts an unfiled scratch draft even when detached chats have a default project', async () => {
    settings.detachedDefaultProjectId = project.id
    render(Sidebar, { props: { onnewproject: vi.fn() } })

    await fireEvent.click(screen.getByRole('button', { name: 'New Scratchpad — no project, isolated workspace, start typing' }))

    expect(store.selectedId).toMatch(/^draft:/)
    expect(store.sessions[store.selectedId!]?.draft).toBe(true)
    expect(store.sessions[store.selectedId!]?.record.projectId).toBeUndefined()
  })
})
