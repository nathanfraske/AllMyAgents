import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import Sidebar from './Sidebar.svelte'
import { store, type SessionView } from './store.svelte'
import { alertDialog } from './dialog.svelte'
import type { SessionRecord } from './api'

const apiMock = vi.hoisted(() => ({
  stop: vi.fn(),
  interrupt: vi.fn(),
}))

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy(apiMock, {
      get: (target, property: string) =>
        property in target ? target[property as keyof typeof target] : () => Promise.resolve([]),
    }),
  }
})

vi.mock('./dialog.svelte', () => ({
  confirmDialog: vi.fn(async () => true),
  alertDialog: vi.fn(async () => {}),
}))

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

function seed(): void {
  const record: SessionRecord = {
    id: 'session-1',
    profileId: 'p1',
    provider: 'claude',
    cwd: 'C:/work',
    title: 'Protected chat',
    status: 'active',
    createdAt,
  }
  const view: SessionView = { record, items: [], lastActivity: createdAt, sawReasoning: false }
  store.sessions = { [record.id]: view }
  store.projects = []
}

beforeEach(() => {
  apiMock.stop.mockReset()
  apiMock.interrupt.mockReset()
  vi.mocked(alertDialog).mockClear()
  localStorage.clear()
  seed()
})

afterEach(() => cleanup())

describe('sidebar lifecycle controls', () => {
  it('surfaces a Stop refusal instead of treating the resolved error as success', async () => {
    apiMock.stop.mockResolvedValue({ error: 'worker could not stop' })
    render(Sidebar)

    await fireEvent.click(screen.getByTitle('stop'))

    expect(apiMock.stop).toHaveBeenCalledWith('session-1')
    expect(alertDialog).toHaveBeenCalledWith('stop failed: worker could not stop')
  })
})
