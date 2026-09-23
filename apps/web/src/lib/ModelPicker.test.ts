import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ModelPicker from './ModelPicker.svelte'
afterEach(() => { cleanup(); vi.useRealTimers() })
const model = { slug: 'gpt-future', name: 'Future GPT', supportedEfforts: [], serviceTiers: [], releasedAt: '2026-09-22' }

it('refreshes without selecting a different model and keeps the menu open', async () => {
  const onselect = vi.fn(), onrefresh = vi.fn(async () => {})
  render(ModelPicker, { provider: 'codex', model: model.slug, availableModels: [model], onselect, onrefresh, catalogKey: 'a' })
  await fireEvent.click(screen.getByTitle('Model: Future GPT'))
  await fireEvent.click(screen.getByText('Refresh models'))
  await waitFor(() => expect(onrefresh).toHaveBeenCalledTimes(1))
  expect(onselect).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'close' })).toBeTruthy()
  expect(screen.getAllByText('Future GPT')).toHaveLength(2)
})
it('keeps the catalog and renders a retryable refresh error', async () => {
  render(ModelPicker, { provider: 'codex', availableModels: [model], onselect: vi.fn(), onrefresh: async () => { throw Error('Provider offline') } })
  await fireEvent.click(screen.getByTitle('Model: Future GPT'))
  await fireEvent.click(screen.getByText('Refresh models'))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Provider offline'))
  expect(screen.getByText('Refresh models')).toBeTruthy()
  expect(screen.getAllByText('Future GPT').length).toBeGreaterThan(0)
})
it('keeps a removed model visible as the selection without offering it in the refreshed list', async () => {
  const onselect = vi.fn()
  const rendered = render(ModelPicker, { provider: 'codex', model: model.slug, availableModels: [model], onselect })
  await rendered.rerender({ availableModels: [{ ...model, slug: 'replacement', name: 'Replacement', isDefault: true }] })
  await fireEvent.click(screen.getByTitle(`Model: ${model.slug}`))
  expect(screen.getByText(model.slug)).toBeTruthy()
  expect(screen.getByText('Replacement').closest('button')?.classList.contains('sel')).toBe(false)
  expect(onselect).not.toHaveBeenCalled()
})
it('does not copy a late failure to a newly selected account', async () => {
  let reject!: (error: Error) => void
  const rendered = render(ModelPicker, { provider: 'codex', availableModels: [model], onselect: vi.fn(), catalogKey: 'a',
    onrefresh: () => new Promise<void>((_, r) => { reject = r }) })
  await fireEvent.click(screen.getByTitle('Model: Future GPT'))
  await fireEvent.click(screen.getByText('Refresh models'))
  await rendered.rerender({ catalogKey: 'b' })
  reject(Error('Account A offline'))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})
