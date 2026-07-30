import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ThreadView from './ThreadView.svelte'
import { store, type SessionView } from './store.svelte'
import type { QuestionRecord, SessionRecord } from './api'

const apiMock = vi.hoisted(() => ({
  answerQuestion: vi.fn(),
  cancelQuestion: vi.fn(),
  approvals: vi.fn(),
  questions: vi.fn(),
  usage: vi.fn(),
})) as Record<string, ReturnType<typeof vi.fn>>

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy(apiMock, {
      get: (target, property: string) =>
        property in target ? target[property] : () => Promise.resolve([]),
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

const createdAt = '2026-07-29T00:00:00.000Z'

const question: QuestionRecord = {
  id: 'q1',
  sessionId: 's1',
  toolUseId: 'tool1',
  requestId: 'request1',
  status: 'pending',
  createdAt,
  questions: [
    {
      question: 'Which format?',
      header: 'Format',
      options: [
        { label: 'Summary', description: 'Short.' },
        { label: 'Detailed', description: 'Long.' },
      ],
      multiSelect: false,
    },
  ],
}

function seed(): SessionView {
  const record: SessionRecord = {
    id: 's1',
    profileId: 'p1',
    provider: 'claude',
    cwd: 'C:/work',
    status: 'active',
    createdAt,
  }
  const view: SessionView = {
    record,
    items: [],
    lastActivity: createdAt,
    sawReasoning: false,
  }
  store.sessions = { s1: view }
  store.selectedId = 's1'
  store.questions = [question]
  return view
}

beforeEach(() => {
  for (const mock of Object.values(apiMock)) mock.mockReset()
  apiMock.approvals.mockResolvedValue([])
  apiMock.questions.mockResolvedValue([])
  apiMock.usage.mockResolvedValue([])
  store.sessions = {}
  store.selectedId = null
  store.approvals = []
  store.questions = []
  store.usage = []
})

afterEach(() => cleanup())

describe('ThreadView question lifecycle', () => {
  it('removes a successfully answered card locally without waiting for a WebSocket refresh', async () => {
    apiMock.answerQuestion.mockResolvedValue({ ok: true })
    const view = seed()
    render(ThreadView, { props: { sessionId: 's1' } })

    expect(store.status(view)).toEqual({ key: 'question', label: 'awaiting answer' })
    expect(screen.queryByText(/approve once/i)).toBeNull()
    await fireEvent.click(screen.getByLabelText('Summary'))
    await fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))

    expect(apiMock.answerQuestion).toHaveBeenCalledWith('q1', { 'Which format?': 'Summary' })
    await waitFor(() => expect(screen.queryByText('Which format?')).toBeNull())
    expect(store.questions).toEqual([])
  })

  it('uses a distinct question count/status from permission approvals and removes successful cancel', async () => {
    apiMock.cancelQuestion.mockResolvedValue({ ok: true })
    const view = seed()
    store.approvals = [
      {
        id: 'approval1',
        sessionId: 's1',
        kind: 'claude/tool',
        payload: { toolName: 'Bash', input: { command: 'pnpm test' } },
        status: 'pending',
        createdAt,
      },
    ]
    render(ThreadView, { props: { sessionId: 's1' } })

    expect(store.questions).toHaveLength(1)
    expect(store.approvals).toHaveLength(1)
    expect(store.status(view)).toEqual({ key: 'question', label: 'awaiting answer' })
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel question' }))

    expect(apiMock.cancelQuestion).toHaveBeenCalledWith('q1')
    await waitFor(() => expect(screen.queryByText('Which format?')).toBeNull())
    expect(store.questions).toEqual([])
    expect(store.approvals).toHaveLength(1)
    expect(store.status(view)).toEqual({ key: 'approval', label: 'needs approval' })
  })
})
