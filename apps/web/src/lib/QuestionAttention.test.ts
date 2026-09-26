import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import QuestionAttention from './QuestionAttention.svelte'
import QuestionDeadline from './QuestionDeadline.svelte'
import { store } from './store.svelte'
import { api } from './api'
import type { QuestionRecord } from './api'

const question: QuestionRecord = { id: 'q1', sessionId: 'worker', provider: 'codex', blocking: false, status: 'pending',
  createdAt: '2026-09-14T00:00:00Z', questions: [{ id: 'q', header: 'Q', question: 'Private prompt', isSecret: true, multiSelect: false, allowFreeText: true, options: [] }] }
beforeEach(() => {
  store.questions = []; store.sessions = {}; store.selectedId = 'other'; store.connected = false; store.settingsOpen = false
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); store.questions = [] })

describe('global question attention', () => {
  it('appears for another chat, opens the exact chat without leaking prompt text, and disappears on resolution', async () => {
    const select = vi.spyOn(store, 'select').mockImplementation(() => {})
    render(QuestionAttention)
    expect(screen.queryByLabelText('Question notification')).toBeNull()
    store.questions = [question]
    await tick()
    expect(screen.getByLabelText('Question notification')).toBeTruthy()
    expect(screen.queryByText('Private prompt')).toBeNull()
    await fireEvent.click(screen.getByText('Open question'))
    expect(select).toHaveBeenCalledWith('worker')
    store.questions = []
    await tick()
    expect(screen.queryByLabelText('Question notification')).toBeNull()
  })
  it('opens the selected chat question once and keeps pending attention after closing without answering', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    store.questions = [question]
    store.selectedId = 'worker'
    render(QuestionAttention)
    expect(screen.getByRole('dialog', { name: 'Agent question' })).toBeTruthy()
    const listener = vi.fn()
    window.addEventListener('keydown', listener)
    await fireEvent.keyDown(window, { key: 'Escape' })
    await fireEvent.keyDown(window, { key: 'Escape', repeat: true })
    await fireEvent.keyUp(window, { key: 'Escape' })
    window.removeEventListener('keydown', listener)
    expect(listener).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    store.questions = [{ ...question }]
    await tick()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByLabelText('Question notification')).toBeTruthy()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await fireEvent(document, new Event('visibilitychange'))
    expect(screen.getByLabelText('Question notification')).toBeTruthy()
    await fireEvent.click(screen.getByLabelText('Dismiss question notification'))
    expect(screen.queryByLabelText('Question notification')).toBeNull()
    expect(store.questions).toHaveLength(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })
  it('renders the absolute server deadline and never submits anything from a browser timer', async () => {
    vi.useFakeTimers()
    render(QuestionDeadline, { props: { expiresAt: new Date(Date.now() + 5000).toISOString() } })
    expect(screen.getByText('Auto-skips in 5s')).toBeTruthy()
    await vi.advanceTimersByTimeAsync(5000)
    await tick()
    expect(screen.getByText('Skipping unanswered question…')).toBeTruthy()
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('surfaces a current-chat request when the desktop window loses focus', async () => {
    store.questions = [question]
    store.selectedId = 'worker'
    render(QuestionAttention)
    expect(screen.getByLabelText('Question notification')).toBeTruthy()
    await fireEvent(window, new Event('blur'))
    expect(screen.getByLabelText('Question notification')).toBeTruthy()
    await fireEvent(window, new Event('focus'))
    expect(screen.getByLabelText('Question notification')).toBeTruthy()
    expect(store.questions).toHaveLength(1)
  })
  it('answers through the popup and removes it only after authoritative success', async () => {
    const answer = vi.spyOn(api, 'answerQuestion').mockResolvedValue({ ok: true })
    store.selectedId = 'worker'; store.questions = [question]
    render(QuestionAttention)
    await fireEvent.input(screen.getByLabelText('Answer'), { target: { value: 'operator choice' } })
    await fireEvent.click(screen.getByText('Submit answers'))
    expect(answer).toHaveBeenCalledWith('q1', { q: 'operator choice' })
    expect(store.questions).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('retains the popup and an error when a decision fails; closing never skips', async () => {
    vi.spyOn(api, 'answerQuestion').mockResolvedValue({ error: 'temporarily unavailable' })
    vi.spyOn(store, 'refreshSideData').mockResolvedValue(undefined)
    const skip = vi.spyOn(api, 'cancelQuestion')
    store.selectedId = 'worker'; store.questions = [question]
    render(QuestionAttention)
    await fireEvent.input(screen.getByLabelText('Answer'), { target: { value: 'choice' } })
    await fireEvent.click(screen.getByText('Submit answers'))
    expect((await screen.findByRole('alert')).textContent).toContain('temporarily unavailable')
    await fireEvent.click(screen.getByLabelText('Close question without answering'))
    expect(skip).not.toHaveBeenCalled()
    expect(store.questions).toHaveLength(1)
  })
})
