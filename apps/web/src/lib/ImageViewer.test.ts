import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import MessageAttachments from './MessageAttachments.svelte'

const image = (id: string) => ({ id, name: `${id}.png`, mime: 'image/png', kind: 'image' as const, size: 100 })
beforeEach(() => {
  // jsdom has the element but does not implement modal/top-layer APIs.
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(() => { cleanup(); window.dispatchEvent(new KeyboardEvent('keyup', {key: 'Escape'})); vi.restoreAllMocks() })

describe('full-window chat image viewer', () => {
  it('browses images across messages in one loaded conversation, not other chats or files', async () => {
    const log = document.createElement('div'); log.setAttribute('role', 'log'); document.body.append(log)
    const renderAt = (sessionId: string, attachments: ReturnType<typeof image>[]) => {
      const target = document.createElement('div'); log.append(target)
      return render(MessageAttachments, {target, props: {sessionId, attachments}})
    }
    renderAt('chat', [image('one')])
    // Lookalike model HTML does not enter the trusted attachment registry.
    const fake = document.createElement('button'); fake.dataset.chatImage = 'https://evil.example/pixel'; log.append(fake)
    renderAt('other', [image('private')])
    renderAt('chat', [image('two'), image('three')])
    await fireEvent.click(screen.getByRole('button', {name: 'Open two.png in image viewer'}))
    const viewer = screen.getByRole('dialog')
    expect(viewer.parentElement).toBe(document.body)
    expect(within(viewer).getByRole('img').getAttribute('alt')).toBe('two.png')
    expect(within(viewer).getByText('2 / 3')).toBeTruthy()
    const background = vi.fn(); window.addEventListener('keydown', background)
    try {
      await fireEvent.keyDown(window, {key: 'ArrowRight'})
      expect(within(viewer).getByRole('img').getAttribute('alt')).toBe('three.png')
      await fireEvent.keyDown(window, {key: 'ArrowRight'})
      expect(within(viewer).getByRole('img').getAttribute('alt')).toBe('one.png')
      await fireEvent.keyDown(window, {key: 'ArrowLeft'})
      expect(within(viewer).getByRole('img').getAttribute('alt')).toBe('three.png')
      expect(background).not.toHaveBeenCalled()
    } finally { window.removeEventListener('keydown', background); cleanup(); log.remove() }
  })
  it('consumes Escape, its held repeats and keyup; restores focus/overflow without scrolling', async () => {
    document.body.style.overflow = 'clip'
    render(MessageAttachments, {sessionId:'chat', attachments:[image('one')]})
    const trigger = screen.getByRole('button', {name:'Open one.png in image viewer'}); trigger.focus()
    await fireEvent.click(trigger)
    expect(document.body.style.overflow).toBe('hidden')
    const bubble = vi.fn(); window.addEventListener('keydown', bubble); window.addEventListener('keyup', bubble)
    try {
      const escape = new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true})
      await fireEvent(window, escape)
      expect(escape.defaultPrevented).toBe(true)
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
      expect(document.body.style.overflow).toBe('clip')
      await fireEvent.keyDown(window, {key:'Escape',repeat:true})
      await fireEvent.keyDown(window, {key:'a'})
      await fireEvent.keyUp(window, {key:'Escape'})
      expect(bubble.mock.calls.map(([event]) => event.key)).toEqual(['a'])
      await fireEvent.keyDown(window, {key:'Escape'})
      expect(bubble).toHaveBeenCalledTimes(2)
    } finally { window.removeEventListener('keydown', bubble); window.removeEventListener('keyup', bubble); document.body.style.overflow = '' }
  })
  it('keeps keyboard ownership after app focus changes, and cleans up when its chat unmounts', async () => {
    const app = render(MessageAttachments, {sessionId:'chat',attachments:[image('one')]})
    await fireEvent.click(screen.getByRole('button', {name:'Open one.png in image viewer'}))
    await fireEvent.blur(window); await fireEvent.focus(window)
    const event = new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true,cancelable:true})
    await fireEvent(window,event); expect(event.defaultPrevented).toBe(true)
    expect(screen.queryByRole('button', {name:'Next image'})).toBeNull()
    await app.unmount()
    const after = new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true})
    await fireEvent(window,after); expect(after.defaultPrevented).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('shows an explicit failed-image retry while keeping navigation and close available', async () => {
    render(MessageAttachments, {sessionId:'chat', attachments:[image('one'),image('two')]})
    await fireEvent.click(screen.getByRole('button', {name:'Open one.png in image viewer'}))
    const viewer = screen.getByRole('dialog')
    await fireEvent.error(within(viewer).getByRole('img'))
    await fireEvent.click(within(viewer).getByRole('button', {name:'Retry image'}))
    expect(within(viewer).getByRole('img').getAttribute('src')).toContain('viewerRetry=1')
    await fireEvent.click(within(viewer).getByRole('button', {name:'Next image'}))
    expect(within(viewer).getByRole('img').getAttribute('alt')).toBe('two.png')
    await fireEvent.click(within(viewer).getByRole('button', {name:'Close image viewer'}))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
