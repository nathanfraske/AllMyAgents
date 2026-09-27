import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ModelPicker from './ModelPicker.svelte'
afterEach(() => { cleanup(); vi.useRealTimers() })
const model = { slug: 'gpt-future', name: 'Future GPT', supportedEfforts: [], serviceTiers: [], releasedAt: '2026-09-22' }
const blue = { ...model, slug: 'gpt-daybreak-blue-latest', name: 'Daybreak Blue' }

it('selects refreshed GPT-6 Sol/Luna with account Daybreak metadata and disables unsupported models', async () => {
  const onselect = vi.fn(), onrefresh = vi.fn(async () => {})
  const sol = { ...model, slug: 'gpt-6-sol', name: 'GPT-6 Sol', cyberAccessPrograms: ['standard', 'daybreakBlue'] as ('standard' | 'daybreakBlue')[] }
  const luna = { ...sol, slug: 'gpt-6-luna', name: 'GPT-6 Luna' }
  const unavailable = { ...sol, slug: 'gpt-6-astra', name: 'GPT-6 Astra', cyberAccessPrograms: ['standard'] as 'standard'[] }
  const rendered = render(ModelPicker, { provider: 'codex', model: model.slug, availableModels: [model], onselect, onrefresh })
  await fireEvent.click(screen.getByTitle('Model: Future GPT'))
  await fireEvent.click(screen.getByText('Refresh models'))
  await waitFor(() => expect(onrefresh).toHaveBeenCalledTimes(1))
  await rendered.rerender({ availableModels: [sol, luna, unavailable], model: sol.slug })
  expect(onselect).not.toHaveBeenCalled()
  await fireEvent.click(screen.getByRole('switch', { name: 'Daybreak' }))
  expect(onselect).toHaveBeenLastCalledWith(sol.slug, 'daybreakBlue')
  await rendered.rerender({ cyberAccessProgram: 'daybreakBlue' })
  expect(screen.getByRole('button', { name: /GPT-6 Astra/ }).hasAttribute('disabled')).toBe(true)
  await fireEvent.click(screen.getByRole('button', { name: /GPT-6 Luna/ }))
  expect(onselect).toHaveBeenLastCalledWith(luna.slug, 'daybreakBlue')
  await rendered.rerender({ model: luna.slug })
  await fireEvent.click(screen.getByTitle('Model: GPT-6 Luna'))
  await fireEvent.click(screen.getByRole('switch'))
  expect(onselect).toHaveBeenLastCalledWith(luna.slug, 'standard')
})

it('separates the Daybreak switch, ordinary models and recommended alias', async () => {
  const onselect = vi.fn()
  const rendered = render(ModelPicker, { provider: 'codex', model: model.slug, availableModels: [model, blue], onselect })
  await fireEvent.click(screen.getByTitle('Model: Future GPT'))
  expect(screen.queryByRole('button', { name: /Daybreak Blue/ })).toBeNull()
  await fireEvent.click(screen.getByRole('switch', { name: 'Daybreak' }))
  expect(onselect).toHaveBeenLastCalledWith(model.slug, 'daybreakBlue')
  await rendered.rerender({ cyberAccessProgram: 'daybreakBlue' })
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  await fireEvent.click(screen.getByRole('button', { name: /Default Recommended/ }))
  expect(onselect).toHaveBeenLastCalledWith(blue.slug, 'daybreakBlue')
  await rendered.rerender({ model: blue.slug })
  await fireEvent.click(screen.getByTitle('Model: Daybreak Blue'))
  await fireEvent.click(screen.getByRole('switch'))
  expect(onselect).toHaveBeenLastCalledWith(model.slug, 'standard')
})

it('offers no Daybreak in the fallback or another account and never carries catalog options across accounts', async () => {
  const rendered = render(ModelPicker, { provider: 'codex', model: model.slug, availableModels: [model, blue], onselect: vi.fn(), catalogKey: 'a' })
  await fireEvent.click(screen.getByTitle('Model: Future GPT'))
  expect(screen.getByRole('switch')).toBeTruthy()
  await rendered.rerender({ availableModels: [model], catalogKey: 'b' })
  expect(screen.queryByRole('switch')).toBeNull()
  await rendered.rerender({ availableModels: undefined })
  expect(screen.queryByRole('switch')).toBeNull()
})

it('keeps a revoked selection visible with an off escape hatch instead of silently downgrading', async () => {
  const onselect = vi.fn()
  render(ModelPicker, { provider: 'codex', model: model.slug, cyberAccessProgram: 'daybreakBlue', availableModels: [model], onselect })
  await fireEvent.click(screen.getByTitle('Model: Future GPT'))
  expect(screen.getByRole('alert').textContent).toContain('no longer advertised')
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText('Future GPT', { selector: '.name' }).closest('button')?.disabled).toBe(true)
  expect(onselect).not.toHaveBeenCalled()
  await fireEvent.click(screen.getByRole('switch'))
  expect(onselect).toHaveBeenCalledWith(model.slug, 'standard')
})

it('recognizes an existing alias without a stored flag and blocks rapid writes while saving', async () => {
  const onselect = vi.fn()
  render(ModelPicker, { provider: 'codex', model: blue.slug, availableModels: [model, blue], onselect, disabled: true })
  await fireEvent.click(screen.getByTitle('Model: Daybreak Blue'))
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
  await fireEvent.click(screen.getByRole('switch'))
  expect(onselect).not.toHaveBeenCalled()
})

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
