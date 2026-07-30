import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import QuestionCard from './QuestionCard.svelte'
import type { QuestionRecord } from './api'

const record: QuestionRecord = {
  id: 'q1',
  sessionId: 's1',
  toolUseId: 'toolu_1',
  requestId: 'control_1',
  status: 'pending',
  createdAt: '2026-07-29T00:00:00.000Z',
  questions: [
    {
      question: 'Which format should I use?',
      header: 'Format',
      options: [
        { label: 'Summary', description: 'A short overview.' },
        { label: 'Detailed', description: 'A complete explanation.' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which sections should I include?',
      header: 'Sections',
      options: [
        { label: 'Intro', description: 'Opening context.' },
        { label: 'Results', description: 'Measured results.' },
      ],
      multiSelect: true,
    },
  ],
}

afterEach(() => cleanup())

describe('QuestionCard', () => {
  it('renders a distinct answer form with automatic Other and no permission/grant controls', () => {
    render(QuestionCard, { props: { record, onsubmit: vi.fn(), oncancel: vi.fn() } })

    expect(screen.getByText('QUESTION FROM CLAUDE')).toBeTruthy()
    expect(screen.getByText('Which format should I use?')).toBeTruthy()
    expect(screen.getAllByText('Other')).toHaveLength(2)
    expect(screen.queryByText(/approve once/i)).toBeNull()
    expect(screen.queryByText(/always allow/i)).toBeNull()
    expect(screen.queryByText(/permission/i)).toBeNull()
  })

  it('submits exact question keys, comma-joined multi-select labels, and free-text Other', async () => {
    const onsubmit = vi.fn(async (_answers: Record<string, string>) => {})
    render(QuestionCard, { props: { record, onsubmit, oncancel: vi.fn() } })

    const format = screen.getByRole('group', { name: 'Format: Which format should I use?' })
    await fireEvent.click(within(format).getByLabelText('Detailed'))

    const sections = screen.getByRole('group', { name: 'Sections: Which sections should I include?' })
    await fireEvent.click(within(sections).getByLabelText('Intro'))
    await fireEvent.click(within(sections).getByLabelText('Other'))
    await fireEvent.input(within(sections).getByLabelText('Other answer'), {
      target: { value: 'Appendix with raw data' },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(onsubmit).toHaveBeenCalledWith({
      'Which format should I use?': 'Detailed',
      'Which sections should I include?': 'Intro, Appendix with raw data',
    })
  })

  it('requires every question, supports cancel, and prevents double submit while pending', async () => {
    let release!: () => void
    const onsubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const oncancel = vi.fn(async () => {})
    render(QuestionCard, { props: { record, onsubmit, oncancel } })

    await fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(onsubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/answer every question/i)

    await fireEvent.click(screen.getByLabelText('Summary'))
    await fireEvent.click(screen.getByLabelText('Results'))
    const submit = screen.getByRole('button', { name: 'Submit answers' })
    await fireEvent.click(submit)
    await fireEvent.click(submit)
    expect(onsubmit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveProperty('disabled', true)
    release()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel question' })).toHaveProperty(
        'disabled',
        false
      )
    )

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel question' }))
    expect(oncancel).toHaveBeenCalledTimes(1)
  })

  it('preserves __proto__ and constructor keys through the form and renders preview as inert text', async () => {
    const onsubmit = vi.fn(async (_answers: Record<string, string>) => {})
    const hostile: QuestionRecord = {
      ...record,
      id: 'q-hostile-keys',
      questions: [
        {
          question: '__proto__',
          header: 'Prototype',
          options: [
            {
              label: 'Keep',
              description: 'Keep the exact key.',
              preview: '<img src=x onerror=alert(1)>',
            },
            { label: 'Reject', description: 'Reject it.' },
          ],
          multiSelect: false,
        },
        {
          question: 'constructor',
          header: 'Constructor',
          options: [
            { label: 'Own', description: 'Create an own property.' },
            { label: 'Skip', description: 'Skip it.' },
          ],
          multiSelect: false,
        },
      ],
    }
    const { container } = render(QuestionCard, {
      props: { record: hostile, onsubmit, oncancel: vi.fn() },
    })
    await fireEvent.click(screen.getByLabelText('Keep'))
    await fireEvent.click(screen.getByLabelText('Own'))
    await fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))

    const answers = onsubmit.mock.calls[0]?.[0] as Record<string, string>
    expect(Object.hasOwn(answers, '__proto__')).toBe(true)
    expect(Object.hasOwn(answers, 'constructor')).toBe(true)
    expect(JSON.parse(JSON.stringify(answers))).toEqual(
      JSON.parse('{"__proto__":"Keep","constructor":"Own"}')
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('fails closed with an invalid record shape', () => {
    render(QuestionCard, {
      props: {
        record: { ...record, questions: [] },
        onsubmit: vi.fn(),
        oncancel: vi.fn(),
      },
    })
    expect(screen.getByRole('alert').textContent).toMatch(/cannot display/i)
    expect(screen.queryByRole('button', { name: 'Submit answers' })).toBeNull()
  })
})
