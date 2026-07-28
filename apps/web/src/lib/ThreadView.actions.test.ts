import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/svelte'
import ThreadView from './ThreadView.svelte'
import { store, type SessionView } from './store.svelte'
import type { SessionRecord } from './api'
import { modelsFor } from './catalog'

// A hub write that fails must SURFACE, at its control — the class of bug we spent the day killing (a POST
// whose result was discarded, so a failed action looked done). These drive the real buttons and assert
// on the rendered error, because "did the failure show, and next to the right control" is a render-level
// claim a unit test of a helper cannot make. Confirmed to fail against the pre-fix handlers (see report).

// Per-method api results we can set per test. The Proxy hands any un-set method a benign async () => [],
// so children calling api on mount (profiles/commands/usage) don't explode.
// vi.hoisted so the (hoisted) vi.mock factory below can reference these without a TDZ error.
const apiMock = vi.hoisted(() => ({
  stop: vi.fn(),
  interrupt: vi.fn(),
  reopen: vi.fn(),
  setSettings: vi.fn(),
})) as Record<string, ReturnType<typeof vi.fn>>
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy(apiMock, {
      get: (target, prop: string) => (prop in target ? target[prop] : () => Promise.resolve([])),
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

const claudeModels = modelsFor('claude')

function seed(over: Partial<SessionRecord> = {}): void {
  const record = {
    id: 's1',
    profileId: 'p1',
    provider: 'claude',
    cwd: 'C:/work',
    status: 'active',
    createdAt: '2026-07-26T00:00:00.000Z',
    model: claudeModels[0]?.slug,
    ...over,
  } as SessionRecord
  const view: SessionView = { record, items: [], lastActivity: record.createdAt, sawReasoning: false }
  store.sessions = { s1: view }
  store.selectedId = 's1'
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset()
  store.sessions = {}
  store.approvals = []
  store.usage = []
  store.selectedId = null
  store.replayPresentationActive = false
})
afterEach(() => cleanup())

describe('session lifecycle buttons surface a failed write at the footer', () => {
  it.each(['starting', 'active', 'idle', 'error'] as const)(
    'keeps interrupt reachable while status is %s',
    async (status) => {
      apiMock.interrupt.mockResolvedValue({ ok: true })
      seed({ status })
      render(ThreadView, { props: { sessionId: 's1' } })

      const button = screen.getByTitle('interrupt current turn') as HTMLButtonElement
      expect(button.disabled).toBe(false)
      await fireEvent.click(button)
      expect(apiMock.interrupt).toHaveBeenCalledWith('s1')
    }
  )

  it('shows the error when stop does not take', async () => {
    apiMock.stop.mockResolvedValue({ error: 'worker gone' })
    seed({ status: 'active' })
    render(ThreadView, { props: { sessionId: 's1' } })
    await fireEvent.click(screen.getByTitle('stop session'))
    expect(await screen.findByText(/stop failed: worker gone/)).toBeTruthy()
  })

  it('shows the error when interrupt does not take', async () => {
    apiMock.interrupt.mockResolvedValue({ error: 'no active turn' })
    seed({ status: 'active' })
    render(ThreadView, { props: { sessionId: 's1' } })
    await fireEvent.click(screen.getByTitle('interrupt current turn'))
    expect(await screen.findByText(/interrupt failed: no active turn/)).toBeTruthy()
  })

  it('shows the error when reopen does not take', async () => {
    apiMock.reopen.mockResolvedValue({ error: 'cannot reopen' })
    seed({ status: 'stopped' })
    render(ThreadView, { props: { sessionId: 's1' } })
    await fireEvent.click(screen.getByTitle('reopen this stopped chat so you can use it again'))
    expect(await screen.findByText(/reopen failed: cannot reopen/)).toBeTruthy()
  })

  it('shows NOTHING on a successful action', async () => {
    apiMock.interrupt.mockResolvedValue({ ok: true })
    seed({ status: 'active' })
    render(ThreadView, { props: { sessionId: 's1' } })
    await fireEvent.click(screen.getByTitle('interrupt current turn'))
    await Promise.resolve()
    expect(screen.queryByText(/failed:/)).toBeNull()
  })
})

describe('replay presentation', () => {
  it('keeps an in-progress multi-frame rebuild hidden until the boundary state clears', async () => {
    seed({ status: 'idle' })
    store.replayPresentationActive = true
    const rendered = render(ThreadView, { props: { sessionId: 's1' } })
    expect(rendered.container.querySelector('.stream')?.classList.contains('replay-rebuild')).toBe(true)

    store.replayPresentationActive = false
    await waitFor(() => {
      expect(rendered.container.querySelector('.stream')?.classList.contains('replay-rebuild')).toBe(false)
    })
  })

  it('omits the enter-animation class from replayed items and keeps it on live items', () => {
    seed({ status: 'idle' })
    store.sessions.s1!.items = [
      {
        key: 'history',
        kind: 'user',
        ts: '2026-07-26T00:00:01.000Z',
        text: 'replayed transcript item',
        replayed: true,
      },
      {
        key: 'live',
        kind: 'assistant',
        ts: '2026-07-26T00:00:02.000Z',
        text: 'live transcript item',
        replayed: false,
      },
    ]

    render(ThreadView, { props: { sessionId: 's1' } })

    expect(
      screen.getByText('replayed transcript item').closest('.stream-node')?.classList.contains('animate-in')
    ).toBe(false)
    expect(
      screen.getByText('live transcript item').closest('.stream-node')?.classList.contains('animate-in')
    ).toBe(true)
  })
})

describe('a failed model-pill write reverts the pill (no confidently-wrong UI)', () => {
  it('rolls the pill back to the hub value and shows the error when the write fails', async () => {
    // Need two distinct models to switch between.
    expect(claudeModels.length).toBeGreaterThanOrEqual(2)
    const first = claudeModels[0]!
    const second = claudeModels[1]!
    apiMock.setSettings.mockResolvedValue({ error: 'not persisted' })
    seed({ status: 'active', model: first.slug })
    render(ThreadView, { props: { sessionId: 's1' } })

    // Open the model pill (its label is the current model's short/long name) and pick the OTHER model.
    await fireEvent.click(screen.getByText(first.shortName ?? first.name))
    await fireEvent.click(screen.getByText(second.name))

    // The write failed, so the record — the thing the next turn is built from — must be back to `first`,
    // not left showing a pick the hub never persisted.
    expect(await screen.findByText(/model change failed: not persisted/)).toBeTruthy()
    expect(store.sessions.s1?.record.model).toBe(first.slug)
  })
})
