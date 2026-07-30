import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
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

  it('announces one appended card once without stealing composer focus', async () => {
    seed()
    render(ThreadView, { props: { sessionId: 's1' } })
    const composer = screen.getByRole('textbox')
    composer.focus()
    expect(document.activeElement).toBe(composer)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toBe(
      'One pending question from Claude.'
    )

    store.questions = [question, { ...question, id: 'q2' }]
    await waitFor(() =>
      expect(
        screen.getByRole('form', { name: 'Question from Claude 2 of 2' })
      ).toBeTruthy()
    )
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toBe(
      'New question from Claude. 2 pending.'
    )
    expect(document.activeElement).toBe(composer)

    store.questions = [question]
    await waitFor(() => {
      expect(
        screen.getByRole('form', { name: 'Question from Claude 1 of 1' })
      ).toBeTruthy()
      expect(screen.getByRole('status').textContent).toBe('')
    })
    expect(document.activeElement).toBe(composer)

    store.questions = [question, { ...question, id: 'q2' }]
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'New question from Claude. 2 pending.'
      )
    )
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(document.activeElement).toBe(composer)
  })

  it('does not announce removal or reorder as a new arrival', async () => {
    seed()
    const records = ['q1', 'q2', 'q3'].map((id) => ({
      ...question,
      id,
      questions: [{ ...question.questions[0]!, question: `Prompt ${id}?` }],
    }))
    store.questions = records
    render(ThreadView, { props: { sessionId: 's1' } })
    const stack = screen.getByRole('region', { name: 'Pending questions' })
    const announcement = screen.getByRole('status').textContent
    expect(announcement).toBe('3 pending questions from Claude.')

    store.questions = [records[2]!, records[0]!, records[1]!]
    await waitFor(() =>
      expect(
        Array.from(stack.querySelectorAll('.prompt'), (node) => node.textContent)
      ).toEqual(['Prompt q3?', 'Prompt q1?', 'Prompt q2?'])
    )
    expect(screen.getByRole('status').textContent).toBe(announcement)

    store.questions = [records[2]!, records[0]!]
    await waitFor(() =>
      expect(
        stack.querySelectorAll('form[aria-label^="Question from Claude "]')
      ).toHaveLength(2)
    )
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('bounds the aggregate question stack so the composer remains reachable on short viewports', () => {
    seed()
    const maxQuestions = Array.from({ length: 4 }, (_, questionIndex) => ({
      question: `Question ${questionIndex + 1}: ${'q'.repeat(200)}`,
      header: `Header ${questionIndex + 1}`.slice(0, 12),
      options: Array.from({ length: 4 }, (_, optionIndex) => ({
        label: `Option ${optionIndex + 1}`,
        description: `Description ${optionIndex + 1}: ${'d'.repeat(200)}`,
        preview: `Preview ${optionIndex + 1}: ${'p'.repeat(500)}`,
      })),
      multiSelect: questionIndex % 2 === 0,
    }))
    store.questions = Array.from({ length: 4 }, (_, index) => ({
      ...question,
      id: `q${index + 1}`,
      questions: maxQuestions,
    }))
    const { container } = render(ThreadView, { props: { sessionId: 's1' } })

    const stack = screen.getByRole('region', { name: 'Pending questions' })
    expect(stack.classList.contains('question-stack')).toBe(true)
    expect(
      stack.querySelectorAll('form[aria-label^="Question from Claude "]')
    ).toHaveLength(4)
    expect(
      stack.querySelector('form[aria-label="Question from Claude 1 of 4"]')
    ).toBeTruthy()
    expect(
      stack.querySelector('form[aria-label="Question from Claude 4 of 4"]')
    ).toBeTruthy()
    const forms = Array.from(
      stack.querySelectorAll<HTMLFormElement>('form[aria-label^="Question from Claude "]')
    )
    expect(new Set(forms.map((form) => form.getAttribute('aria-label'))).size).toBe(4)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toBe(
      '4 pending questions from Claude.'
    )
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'ThreadView.svelte'),
      'utf8'
    )
    expect(source).toMatch(/\.question-stack\s*\{[\s\S]*?max-height:\s*min\(42dvh,\s*30rem\)/)
    expect(source).toMatch(/\.question-stack\s*\{[\s\S]*?overflow-y:\s*auto/)
    expect(source).toMatch(
      /@media \(max-height:\s*650px\)[\s\S]*?\.question-stack\s*\{\s*max-height:\s*34dvh/
    )
    expect(container.querySelector('.composer-wrap')).toBeTruthy()
  })
})
