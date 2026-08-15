import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
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
  store.selectedId = null
  store.splitPanes = []
  store.projectViewId = null
  store.connected = true
  store.hubConnectionPhase = 'connected'
  store.hubDownSeconds = 0
  store.journalCompaction = null
})

afterEach(cleanup)

describe('compact system status indicators', () => {
  it('opens hub details from the connection indicator and closes on Escape', async () => {
    render(Sidebar)

    const trigger = screen.getByRole('button', { name: 'Hub: connected' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    await fireEvent.click(trigger)
    const popout = screen.getByRole('dialog', { name: 'Hub connection' })
    expect(popout.textContent).toContain('The live connection to the local hub is active.')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    await fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Hub connection' })).toBeNull()
  })

  it('presents cold startup as loading rather than a broken connection', async () => {
    store.connected = false
    store.hubConnectionPhase = 'starting'
    store.hubDownSeconds = 7
    render(Sidebar)

    const trigger = screen.getByRole('button', { name: 'Hub: starting' })
    expect(trigger.textContent).toContain('Starting hub… 7s')
    await fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Hub connection' }).textContent).toContain(
      'Preparing the local hub.',
    )
  })

  it('reserves reconnecting language for a connection that was actually lost', async () => {
    store.connected = false
    store.hubConnectionPhase = 'reconnecting'
    store.hubDownSeconds = 7
    render(Sidebar)

    const trigger = screen.getByRole('button', { name: 'Hub: reconnecting' })
    expect(trigger.textContent).toContain('Reconnecting… 7s')
    await fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Hub connection' }).textContent).toContain(
      'live connection was interrupted',
    )
  })

  it('shows journal lifecycle detail in an adjacent indicator instead of an always-open bar', async () => {
    store.journalCompaction = {
      operationId: 'maintenance-1',
      phase: 'progress',
      startedAt: '2026-07-31T12:00:00.000Z',
      updatedAt: '2026-07-31T12:01:00.000Z',
      rowsDeleted: 12_345,
      payloadBytesDeleted: 2_621_440,
      detail: 'Committed bounded cleanup batches behind a verified snapshot.',
    }
    render(Sidebar)

    const trigger = screen.getByRole('button', { name: 'Journal maintenance: working' })
    await fireEvent.click(trigger)

    const popout = screen.getByRole('dialog', { name: 'Journal maintenance' })
    expect(within(popout).getByText('12,345')).toBeTruthy()
    expect(within(popout).getByText('2.5 MiB')).toBeTruthy()
    expect(popout.textContent).toContain('Committed bounded cleanup batches')

    await fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Journal maintenance' })).toBeNull()
  })

  it('keeps journal status inspectable when no operation has run', async () => {
    render(Sidebar)

    await fireEvent.click(screen.getByRole('button', { name: 'Journal maintenance: idle' }))

    expect(screen.getByRole('dialog', { name: 'Journal maintenance' }).textContent).toContain(
      'No journal maintenance activity has been reported during this run.',
    )
  })

  it.each([
    ['active', 'thinking'],
    ['starting', 'thinking'],
    ['idle', 'idle'],
    ['error', 'error'],
    ['stopped', 'stopped'],
  ] as const)('shows the Overseer %s lifecycle as %s', (status, label) => {
    store.sessions = {
      overseer: {
        record: {
          id: 'overseer',
          profileId: 'claude-overseer',
          provider: 'claude',
          cwd: 'C:/work/app',
          status,
          title: 'Overseer',
          isOverseer: true,
          createdAt: '2026-08-05T12:00:00.000Z',
        },
        items: [],
        lastActivity: '2026-08-05T12:00:00.000Z',
        sawReasoning: false,
      },
    }

    render(Sidebar)

    const entry = screen.getByRole('button', { name: `Open Overseer — ${label}` })
    expect(within(entry).getByText(label)).toBeTruthy()
    expect(entry.querySelector('.overseer-state')?.classList.contains(label)).toBe(true)
  })

  it('never promotes a paired hub Overseer into the local application-control slot', async () => {
    store.sessions = {
      'peer-node:remote-overseer': {
        record: {
          id: 'peer-node:remote-overseer',
          profileId: 'peer-node:claude-remote',
          provider: 'claude',
          cwd: 'C:/remote/app',
          status: 'active',
          title: 'Overseer @ Remote Hub',
          isOverseer: true,
          siteId: 'peer-node',
          siteLabel: 'Remote Hub',
          siteOnline: true,
          createdAt: '2026-08-08T12:00:00.000Z',
        },
        items: [],
        lastActivity: '2026-08-08T12:00:00.000Z',
        sawReasoning: false,
      },
    }

    render(Sidebar)

    const localEntry = screen.getByRole('button', { name: /Open Overseer.*not set up/i })
    expect(screen.queryByText('Overseer @ Remote Hub')).toBeNull()

    await fireEvent.click(localEntry)
    expect(store.selectedId).toBeNull()
    expect(store.settingsOpen).toBe(true)
  })

  it('opens the local Overseer while keeping a peer Overseer out of the local chat catalog', async () => {
    store.sessions = {
      local: {
        record: {
          id: 'local', profileId: 'claude-local', provider: 'claude', cwd: 'C:/local/app',
          status: 'idle', title: 'Overseer', isOverseer: true, createdAt: '2026-08-08T12:00:00.000Z',
        },
        items: [], lastActivity: '2026-08-08T12:00:00.000Z', sawReasoning: false,
      },
      'peer-node:remote': {
        record: {
          id: 'peer-node:remote', profileId: 'peer-node:claude-remote', provider: 'claude', cwd: 'C:/remote/app',
          status: 'active', title: 'Overseer @ Remote Hub', isOverseer: true,
          siteId: 'peer-node', siteLabel: 'Remote Hub', siteOnline: true,
          createdAt: '2026-08-08T12:00:00.000Z',
        },
        items: [], lastActivity: '2026-08-08T12:00:00.000Z', sawReasoning: false,
      },
    }

    render(Sidebar)
    await fireEvent.click(screen.getByRole('button', { name: /Open Overseer.*idle/i }))

    expect(store.selectedId).toBe('local')
    expect(screen.queryByText('Overseer @ Remote Hub')).toBeNull()
  })
})
