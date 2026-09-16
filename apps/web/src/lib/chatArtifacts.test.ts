import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { HubStore } from './store.svelte'
import type { HubEvent, SessionRecord } from './api'
import { reduceJournalHistory } from './journalHistoryReducer'
import ItemCard from './ItemCard.svelte'

afterEach(cleanup)
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(() => vi.restoreAllMocks())
const event: HubEvent = {
  seq: 42, sessionId: 'artifact-chat', ts: '2026-09-14T00:00:00Z', kind: 'session/artifact',
  payload: { text: 'Assembly preview', attachments: [{ id: 'preview-id', name: 'render.png', mime: 'image/png', size: 512 }], sha256: 'digest' },
}
describe('provider-neutral chat artifact display', () => {
  it.each(['codex', 'claude'] as const)('uses identical live and restored metadata for %s without fetching image bytes during reduction', provider => {
    const store = new HubStore()
    store.sessions['artifact-chat'] = { record: { id: 'artifact-chat', provider, profileId: 'p', cwd: 'C:/w', status: 'idle', createdAt: event.ts } as SessionRecord, items: [], lastActivity: event.ts, sawReasoning: false }
    ;(store as unknown as { apply(e: HubEvent): void }).apply(event)
    const live = store.sessions['artifact-chat']!.items[0]!
    const restored = reduceJournalHistory([event])[0]!
    expect(live).toMatchObject({ kind: 'assistant', text: 'Assembly preview', key: 'journal:42:0' })
    expect(restored).toMatchObject({ kind: live.kind, text: live.text, key: live.key, attachments: live.attachments })
    const { container } = render(ItemCard, { item: restored, sessionId: 'artifact-chat' })
    expect(screen.getByText('Assembly preview')).toBeTruthy()
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/api/sessions/artifact-chat/attachments/preview-id')
    expect(container.querySelector('img')?.getAttribute('loading')).toBe('lazy')
  })

  it('opens a full-window modal, offers download, and visibly retries a failed preview', async () => {
    const { container } = render(ItemCard, { item: reduceJournalHistory([event])[0]!, sessionId: 'artifact-chat' })
    await fireEvent.click(screen.getByRole('button', { name: 'Open render.png in image viewer' }))
    expect(screen.getByRole('dialog', { name: 'Image viewer' }).parentElement).toBe(document.body)
    await fireEvent.click(screen.getByRole('button', { name: 'Close image viewer' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('download')).toBe('render.png')
    await fireEvent.error(container.querySelector('img')!)
    expect(screen.getByText(/Preview unavailable for render.png/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }))
    expect(container.querySelector('img')?.getAttribute('src')).toContain('previewRetry=1')
  })

  it('renders CAD and other non-image outputs as downloadable chips, not embeds', () => {
    const file = { ...event, payload: { attachments: [{ id: 'step-id', name: 'Assembly.step', mime: 'application/octet-stream', size: 5000 }] } }
    const { container } = render(ItemCard, { item: reduceJournalHistory([file])[0]!, sessionId: 'artifact-chat' })
    const link = screen.getByRole('link', { name: /Assembly.step/ })
    expect(link.getAttribute('download')).toBe('Assembly.step')
    expect(link.getAttribute('href')).toContain('/api/sessions/artifact-chat/attachments/step-id')
    expect(container.querySelector('iframe, object, img')).toBeNull()
  })
})
