import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard.svelte'
import { store } from './store.svelte'

const stats = vi.hoisted(() => vi.fn())

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, stats } }
})

window.matchMedia = ((query: string) => ({
  matches: query.includes('prefers-reduced-motion'),
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
})) as unknown as typeof window.matchMedia

beforeEach(() => {
  stats.mockResolvedValue({ days: [], totalTurns: 0, totalCost: 0 })
  store.sessions = {}
  store.projects = []
  store.lastLayout = null
  store.restorableLayout = null
})

afterEach(() => cleanup())

describe('Dashboard project front door', () => {
  it('presents New Project as a primary action and opens the pipeline', async () => {
    const onnewproject = vi.fn()
    render(Dashboard, { onnewproject })

    const button = screen.getByRole('button', { name: 'New Project' })
    expect(button.classList.contains('new-project')).toBe(true)
    await fireEvent.click(button)
    expect(onnewproject).toHaveBeenCalledOnce()
  })
})
