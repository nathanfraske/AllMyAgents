import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

window.matchMedia = (() => ({
  matches: true,
  media: '(prefers-reduced-motion: reduce)',
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
})) as unknown as typeof window.matchMedia

beforeEach(() => {
  localStorage.clear()
  store.projects = []
  store.sessions = {}
  store.approvals = []
  store.selectedId = 'open-chat'
  store.splitPanes = [['open-chat']]
  store.projectViewId = null
  store.connected = true
  store.hubDownSeconds = 0
})

afterEach(cleanup)

describe('Sidebar Home affordance', () => {
  it('is a prominent labelled destination and returns to the launchpad', async () => {
    render(Sidebar)

    const home = screen.getByRole('button', { name: 'Home' })
    expect(home.textContent).toContain('Home')
    expect(home.classList.contains('homebtn')).toBe(true)

    await fireEvent.click(home)
    expect(store.selectedId).toBeNull()
    expect(store.splitPanes).toEqual([])
    expect(store.projectViewId).toBeNull()
  })
})
