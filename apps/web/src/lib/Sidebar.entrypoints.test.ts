import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
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
})
