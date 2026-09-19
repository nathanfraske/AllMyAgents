import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import { renderMermaid } from './mermaidRenderer'
import Markdown from './Markdown.svelte'

vi.mock('./mermaidRenderer', () => ({ renderMermaid: vi.fn(async () => 'data:image/svg+xml,%3Csvg%2F%3E') }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(renderMermaid).mockReset(); vi.mocked(renderMermaid).mockResolvedValue('data:image/svg+xml,%3Csvg%2F%3E') })

it('renders completed Mermaid fences and exposes copyable source on demand', async () => {
  render(Markdown, { text: 'Diagram:\n```mermaid\ngraph TD\n A-->B\n```' })
  await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
  expect(renderMermaid).toHaveBeenCalledTimes(1)
  await fireEvent.click(screen.getByRole('button', { name: 'View source' }))
  expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
  expect(document.querySelector('pre code')?.textContent).toBe('graph TD\n A-->B')
})

it('does not render incomplete streamed fences, then renders the completed revision', async () => {
  const view = render(Markdown, { text: '```mermaid\ngraph TD\n A-->' })
  expect(screen.getByText('Waiting for the diagram to finish…')).toBeTruthy()
  expect(renderMermaid).not.toHaveBeenCalled()
  await view.rerender({ text: '```mermaid\ngraph TD\n A-->B\n```' })
  await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
  expect(renderMermaid).toHaveBeenCalledTimes(1)
})

it('shows errors and source, and allows a failed renderer to retry', async () => {
  vi.mocked(renderMermaid).mockRejectedValueOnce(new Error('Invalid syntax'))
  render(Markdown, { text: '```mermaid\ngraph TD\n A-->B\n```' })
  await waitFor(() => expect(screen.getByText(/Invalid syntax/)).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
})

it('cancels rendering when unmounted so late output cannot replace another chat', async () => {
  vi.mocked(renderMermaid).mockImplementationOnce(() => new Promise(() => {}))
  const view = render(Markdown, { text: '```mermaid\ngraph TD\n A-->B\n```' })
  await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1))
  const signal = vi.mocked(renderMermaid).mock.calls[0]![1]
  view.unmount()
  expect(signal.aborted).toBe(true)
})

it('is lazy offscreen but keeps a completed image and its height when scrolled away', async () => {
  let notify: IntersectionObserverCallback
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { notify = callback }
    observe() {}
    disconnect() {}
  })
  render(Markdown, { text: '```mermaid\ngraph TD\n A-->B\n```' })
  expect(renderMermaid).not.toHaveBeenCalled()
  notify!([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver)
  await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
  notify!([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver)
  await tick()
  expect(screen.getByRole('img')).toBeTruthy()
  notify!([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver)
  await tick()
  expect(renderMermaid).toHaveBeenCalledTimes(1)
})

it('ignores stale completion after a streaming revision replaces the source', async () => {
  let finishOld: (value: string) => void
  vi.mocked(renderMermaid).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  const view = render(Markdown, { text: '```mermaid\ngraph TD\n Old-->B\n```' })
  await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1))
  const oldSignal = vi.mocked(renderMermaid).mock.calls[0]![1]
  await view.rerender({ text: '```mermaid\ngraph TD\n New-->B\n```' })
  await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
  expect(oldSignal.aborted).toBe(true)
  finishOld!('data:image/svg+xml,stale')
  await tick()
  expect(screen.getByRole('img').getAttribute('src')).not.toContain('stale')
})
