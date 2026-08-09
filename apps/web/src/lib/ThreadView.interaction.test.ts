import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ThreadView from './ThreadView.svelte'
import { store, type SessionView } from './store.svelte'
import type { SessionRecord } from './api'

const apiMock = vi.hoisted(() => ({
  send: vi.fn(),
  browserStatus: vi.fn(),
}))

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy(apiMock as Record<string, unknown>, {
      get: (target, property: string) =>
        property in target ? target[property] : () => Promise.resolve([]),
    }),
  }
})

window.matchMedia = (() => ({
  matches: false,
  media: '',
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

function seed(): SessionView {
  const record = {
    id: 'interaction-session',
    profileId: 'p1',
    provider: 'codex',
    cwd: 'C:/work',
    status: 'idle',
    createdAt: '2026-07-31T00:00:00.000Z',
  } as SessionRecord
  const view: SessionView = {
    record,
    items: [],
    lastActivity: record.createdAt,
    sawReasoning: false,
    journalHistoryOlderCursor: 42,
    journalHistoryGeneration: 1,
  }
  store.sessions = { [record.id]: view }
  store.selectedId = record.id
  return view
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

beforeEach(() => {
  apiMock.send.mockReset().mockResolvedValue({ ok: true })
  apiMock.browserStatus.mockReset().mockResolvedValue({
    enabled: false,
    available: true,
    retainedProfile: false,
    publicOriginGrants: [],
    localNetworkEnabled: false,
    tabsEnabled: false,
    downloadsEnabled: false,
  })
  localStorage.clear()
  store.sessions = {}
  store.selectedId = null
  store.approvals = []
  store.questions = []
  store.projects = []
  store.prefs.steerMessagesAtToolBoundary = true
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('transcript interaction boundaries', () => {
  it('offers an explicit retry when latest history could not be loaded', async () => {
    const view = seed()
    view.historyLoadError = 'Latest journal history is temporarily unavailable.'
    const retry = vi.spyOn(store, 'ensureHistory').mockResolvedValue()
    const rendered = render(ThreadView, { props: { sessionId: 'interaction-session' } })
    retry.mockClear()

    await fireEvent.click(rendered.getByRole('button', { name: 'Retry history' }))

    expect(retry).toHaveBeenCalledWith('interaction-session')
  })

  it('opens Browser as the same mutually-exclusive in-flow side panel used by Agents', async () => {
    const view = seed()
    view.items = [{
      key: 'agent-spawn',
      kind: 'tool',
      ts: '2026-07-31T00:00:01.000Z',
      toolName: 'Agent',
      toolUseId: 'spawn-1',
      toolInput: { description: 'Audit the browser panel' },
      agentTaskId: 'task-1',
    }]
    const rendered = render(ThreadView, { props: { sessionId: 'interaction-session' } })

    await fireEvent.click(rendered.getByTitle('Open isolated browser controls'))
    expect(await rendered.findByRole('complementary', { name: 'Browser' })).toBeTruthy()

    await fireEvent.click(rendered.getByTitle('Show the agents this chat spawned'))
    expect(await rendered.findByRole('complementary', { name: 'Agents' })).toBeTruthy()
    expect(rendered.queryByRole('complementary', { name: 'Browser' })).toBeNull()
  })

  it('loads older history automatically when the transcript is scrolled to the top', async () => {
    seed()
    const load = vi.spyOn(store, 'loadOlderHistory').mockResolvedValue(true)
    const { container } = render(ThreadView, { props: { sessionId: 'interaction-session' } })
    const transcript = container.querySelector('.stream.scroll') as HTMLDivElement
    Object.defineProperties(transcript, {
      scrollTop: { value: 0, writable: true },
      scrollHeight: { value: 1_000, configurable: true },
      clientHeight: { value: 500, configurable: true },
    })

    await fireEvent.scroll(transcript)

    await waitFor(() => expect(load).toHaveBeenCalledWith('interaction-session'))
  })

  it('loads another page automatically when the latest history is too short to make a scrollbar', async () => {
    const view = seed()
    const load = vi.spyOn(store, 'loadOlderHistory').mockResolvedValue(true)
    const { container } = render(ThreadView, { props: { sessionId: 'interaction-session' } })
    const transcript = container.querySelector('.stream.scroll') as HTMLDivElement
    Object.defineProperties(transcript, {
      scrollTop: { value: 0, writable: true },
      scrollHeight: { value: 320, configurable: true },
      clientHeight: { value: 500, configurable: true },
    })

    // A completed latest-page render changes the tracked content without producing a scroll event.
    view.items = [{
      key: 'latest-page-item',
      kind: 'assistant',
      ts: '2026-07-31T00:00:01.000Z',
      text: 'A short latest page.',
      historical: true,
    }]

    await waitFor(() => expect(load).toHaveBeenCalledWith('interaction-session'))
  })

  it('keeps the live tail rendered after older history has been reached', () => {
    const view = seed()
    view.record.provider = 'claude'
    view.journalHistoryOlderCursor = null
    view.historyViewingOlder = true
    view.items = Array.from({ length: 160 }, (_, index) => ({
      key: `history-${index}`,
      kind: 'assistant' as const,
      ts: `2026-07-31T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      text: index === 0 ? 'oldest reached reply' : index === 159 ? 'actual latest reply' : `reply ${index}`,
      historical: index < 80,
    }))

    const rendered = render(ThreadView, { props: { sessionId: 'interaction-session' } })

    expect(rendered.getByText('oldest reached reply')).toBeTruthy()
    // Regression: the older-history branch rendered slice(0, 120), so the apparent scroll bottom
    // permanently omitted this live-tail item after the operator had scrolled upward once.
    expect(rendered.getByText('actual latest reply')).toBeTruthy()
  }, 15_000)

  it('makes only the pane header draggable so transcript and composer text remain selectable', () => {
    seed()
    const { container } = render(ThreadView, {
      props: { sessionId: 'interaction-session', multiPane: true },
    })
    const header = container.querySelector('.head')
    const textarea = container.querySelector('.composer textarea')
    const transcript = container.querySelector('.stream.scroll')

    expect(header?.getAttribute('draggable')).toBe('true')
    expect(textarea?.closest('[draggable="true"]')).toBeNull()
    expect(transcript?.closest('[draggable="true"]')).toBeNull()
  })

  it('queues and clears Enter during turn startup instead of attempting a premature steer', async () => {
    const view = seed()
    view.record.status = 'starting'
    const { getByRole } = render(ThreadView, { props: { sessionId: 'interaction-session' } })
    const composer = getByRole('textbox') as HTMLTextAreaElement

    await fireEvent.input(composer, { target: { value: 'Follow this once startup settles.' } })
    await fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(store.queueFor('interaction-session')).toEqual([
      'Follow this once startup settles.',
    ]))
    expect(apiMock.send).not.toHaveBeenCalled()
    expect(composer.value).toBe('')
  })

  it('hands off a new turn immediately and never clears text typed while dispatch is pending', async () => {
    seed()
    const pending = deferred<{ ok: true }>()
    apiMock.send.mockReturnValue(pending.promise)
    const { container } = render(ThreadView, { props: { sessionId: 'interaction-session' } })
    const composer = container.querySelector('.composer textarea') as HTMLTextAreaElement

    await fireEvent.input(composer, { target: { value: 'Start the turn.' } })
    await fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(apiMock.send).toHaveBeenCalledTimes(1))
    expect(composer.value).toBe('')
    await fireEvent.input(composer, { target: { value: 'My next thought.' } })
    pending.resolve({ ok: true })

    await waitFor(() => expect(composer.value).toBe('My next thought.'))
  })

  it('hands off a steer immediately and never clears text typed while steering is pending', async () => {
    const view = seed()
    view.record.status = 'active'
    const pending = deferred<{ ok: true }>()
    apiMock.send.mockReturnValue(pending.promise)
    const { container } = render(ThreadView, { props: { sessionId: 'interaction-session' } })
    const composer = container.querySelector('.composer textarea') as HTMLTextAreaElement

    await fireEvent.input(composer, { target: { value: 'Steer this turn.' } })
    await fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(apiMock.send).toHaveBeenCalledTimes(1))
    expect(composer.value).toBe('')
    await fireEvent.input(composer, { target: { value: 'Do not delete this.' } })
    pending.resolve({ ok: true })

    await waitFor(() => expect(composer.value).toBe('Do not delete this.'))
  })

  it('restores a failed submission ahead of any newer text without losing either', async () => {
    seed()
    const pending = deferred<{ error: string }>()
    apiMock.send.mockReturnValue(pending.promise)
    const { container, findByRole } = render(ThreadView, {
      props: { sessionId: 'interaction-session' },
    })
    const composer = container.querySelector('.composer textarea') as HTMLTextAreaElement

    await fireEvent.input(composer, { target: { value: 'Retry this message.' } })
    await fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(apiMock.send).toHaveBeenCalledTimes(1))
    await fireEvent.input(composer, { target: { value: 'New text stays too.' } })
    pending.resolve({ error: 'hub unavailable' })

    expect((await findByRole('alert')).textContent).toContain('hub unavailable')
    expect(composer.value).toBe('Retry this message.\n\nNew text stays too.')
  })
})
