import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/svelte'
import ThreadView from './ThreadView.svelte'
import { store, type SessionView } from './store.svelte'
import { settings } from './settings.svelte'
import type { SessionRecord } from './api'

// The test the operator cares most about: a large paste on a CODEX session must reach the vendor payload
// IN FULL. Codex takes text but NOT non-image files, so routing a paste through the attachment path would
// silently drop it here — the worst outcome. This proves the promoted paste is delivered as TEXT (the one
// path both vendors share). Failing today (naive attachment-path build) is the bug; passing is the feature.

const apiMock = vi.hoisted(() => ({
  send: vi.fn(),
  steer: vi.fn(),
})) as Record<string, ReturnType<typeof vi.fn>>
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy(apiMock, { get: (t, p: string) => (p in t ? t[p] : () => Promise.resolve([])) }),
  }
})

window.matchMedia = ((q: string) => ({
  matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

function seedCodex(status = 'idle'): void {
  const record = { id: 's1', profileId: 'p', provider: 'codex', cwd: 'C:/w', status, createdAt: '2026-07-26T00:00:00.000Z' } as SessionRecord
  const view: SessionView = { record, items: [], lastActivity: record.createdAt, sawReasoning: false }
  store.sessions = { s1: view }
  store.selectedId = 's1'
}

function pasteInto(el: Element, textData: string): void {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
  Object.defineProperty(e, 'clipboardData', { value: { getData: () => textData } })
  el.dispatchEvent(e)
}

const BIG = 'ERROR line with detail\n'.repeat(3000) // ~66 KB — well over the default 10k-char threshold

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset()
  apiMock.send.mockResolvedValue({ ok: true })
  apiMock.steer.mockResolvedValue({ ok: true })
  store.sessions = {}
  store.selectedId = null
  settings.pasteAsTextThreshold = 10000
})
afterEach(() => cleanup())

describe('large paste on a Codex session reaches the vendor payload', () => {
  it('promotes to a chip (not dumped in the box) and delivers the FULL content via api.send', async () => {
    apiMock.send.mockResolvedValue({ ok: true })
    seedCodex('idle')
    render(ThreadView, { props: { sessionId: 's1' } })
    const ta = document.querySelector('.composer textarea') as HTMLTextAreaElement

    pasteInto(ta, BIG)
    await Promise.resolve()

    // Promoted: the wall did NOT go into the textarea; a chip appeared instead.
    expect(ta.value).toBe('')
    expect(screen.getByText(/Pasted text ·/)).toBeTruthy()

    // Send (send button is enabled even with an empty textbox because a paste is staged).
    await fireEvent.click(screen.getByTitle('send'))

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    const sentText = apiMock.send.mock.calls[0][1] as string
    // The FULL pasted content reached the (Codex) vendor payload — not truncated, not dropped.
    expect(sentText).toContain(BIG)
    expect(sentText.length).toBeGreaterThanOrEqual(BIG.length)
  })

  it('small pastes are unaffected — they go straight into the textarea, no chip', async () => {
    seedCodex('idle')
    render(ThreadView, { props: { sessionId: 's1' } })
    const ta = document.querySelector('.composer textarea') as HTMLTextAreaElement
    // jsdom paste does not mutate the value, so emulate the browser default insert for the small case.
    pasteInto(ta, 'just a short note')
    await Promise.resolve()
    expect(screen.queryByText(/Pasted text ·/)).toBeNull()
  })
})
