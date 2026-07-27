import { afterEach, describe, expect, it } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { HubStore } from './store.svelte'
import type { HubEvent, SessionRecord } from './api'
import MessageAttachments from './MessageAttachments.svelte'
import { attachmentUrl } from './attachmentUrl'

// THE case that breaks in most implementations: an attachment sent in a PRIOR session must render after a
// reload, when the composer's object URL is long dead. Staging and rendering share a code path during
// development and diverge the instant the page reloads. So this test reconstructs the message purely from
// a journaled `session/input` event (the exact replay path `apply()` runs on reconnect) — no composer, no
// blob ever created — and asserts the transcript renders from the hub URL, never a `blob:`.

afterEach(() => cleanup())

const rec = (id: string): SessionRecord =>
  ({ id, profileId: 'p', provider: 'claude', cwd: 'C:/w', status: 'idle', createdAt: '2026-07-26T00:00:00.000Z' }) as SessionRecord

function apply(store: HubStore, event: HubEvent): void {
  ;(store as unknown as { apply(e: HubEvent): void }).apply(event)
}

describe('attachment survives a journal reload', () => {
  it('reconstructs metadata-only from session/input and renders from the hub URL, not a blob', () => {
    const store = new HubStore()
    store.sessions['s1'] = { record: rec('s1'), items: [], lastActivity: '2026-07-26T00:00:00.000Z', sawReasoning: false }

    // Exactly what the hub journals: text + attachment METADATA + a hub-side path. No bytes.
    apply(store, {
      seq: 1,
      ts: '2026-07-26T00:00:01.000Z',
      sessionId: 's1',
      kind: 'session/input',
      payload: {
        text: 'what is this?',
        attachments: [{ id: 'att1', name: 'screenshot.png', mime: 'image/png', size: 40000, path: 'C:/w/.allmyagents/uploads/att1.png' }],
      },
    } as HubEvent)

    const userItem = store.sessions['s1']!.items.find((i) => i.kind === 'user')
    expect(userItem?.attachments).toEqual([
      { id: 'att1', name: 'screenshot.png', mime: 'image/png', size: 40000, kind: 'image' },
    ])
    // The reconstructed item carries NO path and NO blob — only what the hub URL is built from.
    expect(JSON.stringify(userItem)).not.toContain('blob:')
    expect(JSON.stringify(userItem)).not.toContain('.allmyagents')

    // The transcript renders the image from the hub URL.
    const { container } = render(MessageAttachments, { props: { sessionId: 's1', attachments: userItem!.attachments! } })
    const img = container.querySelector('img')
    const src = img?.getAttribute('src') ?? ''
    expect(src).toBe(attachmentUrl('s1', 'att1'))
    expect(src).toContain('/api/sessions/s1/attachments/att1')
    expect(src.startsWith('blob:')).toBe(false)
  })
})
