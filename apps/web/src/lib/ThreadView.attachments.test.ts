import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ThreadView from './ThreadView.svelte'
import { store, type SessionView } from './store.svelte'
import type { SessionRecord } from './api'

const apiMock = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  send: vi.fn(),
  steer: vi.fn(),
  spawn: vi.fn(),
  deleteSession: vi.fn(),
})) as Record<string, ReturnType<typeof vi.fn>>

vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy(apiMock, {
      get: (target, prop: string) => (prop in target ? target[prop] : () => Promise.resolve([])),
    }),
  }
})

window.matchMedia = (() => ({
  matches: false,
  media: '',
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

function seed(provider: 'claude' | 'codex' = 'claude', status = 'idle'): void {
  const record = {
    id: 's1',
    profileId: 'p1',
    provider,
    cwd: 'C:/work',
    status,
    createdAt: '2026-07-27T00:00:00.000Z',
  } as SessionRecord
  const view: SessionView = { record, items: [], lastActivity: record.createdAt, sawReasoning: false }
  store.sessions = { s1: view }
  store.selectedId = 's1'
}

function seedDraft(provider: 'claude' | 'codex' = 'claude'): void {
  const record = {
    id: 'draft:1',
    profileId: 'p1',
    provider,
    cwd: '',
    status: 'idle',
    createdAt: '2026-07-27T00:00:00.000Z',
  } as SessionRecord
  store.sessions = {
    'draft:1': {
      record,
      items: [],
      lastActivity: record.createdAt,
      sawReasoning: false,
      draft: true,
      draftUseWorktree: false,
    },
  }
  store.selectedId = 'draft:1'
}

function clipboardPaste(el: Element, files: File[], text = ''): void {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
  Object.defineProperty(event, 'clipboardData', {
    value: { files, getData: (kind: string) => (kind === 'text/plain' ? text : '') },
  })
  el.dispatchEvent(event)
}

function dropFiles(el: Element, files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown }
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } })
  el.dispatchEvent(event)
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset()
  apiMock.send.mockResolvedValue({ ok: true })
  apiMock.steer.mockResolvedValue({ ok: true })
  apiMock.spawn.mockResolvedValue({
    id: 'real-1',
    profileId: 'p1',
    provider: 'claude',
    cwd: 'C:/work',
    status: 'idle',
    createdAt: '2026-07-27T00:00:01.000Z',
  })
  apiMock.deleteSession.mockResolvedValue({ ok: true })
  apiMock.uploadAttachment.mockImplementation(async (_sessionId: string, file: File) => ({
    id: `att-${file.name}`,
    name: file.name,
    mime: file.type,
    size: file.size,
  }))
  store.sessions = {}
  store.queues = {}
  store.selectedId = null
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('attachment composer front door', () => {
  it('opens a picker, stages its file, uploads it, and passes the attachment id on send', async () => {
    seed('claude')
    render(ThreadView, { props: { sessionId: 's1' } })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()
    const open = vi.spyOn(input, 'click')
    await fireEvent.click(screen.getByTitle('Attach files'))
    expect(open).toHaveBeenCalledTimes(1)

    const file = new File(['png'], 'picker.png', { type: 'image/png' })
    await fireEvent.change(input, { target: { files: [file] } })
    expect(screen.getByText('picker.png')).toBeTruthy()

    await fireEvent.input(document.querySelector('.composer textarea')!, { target: { value: 'look at this' } })
    await fireEvent.click(screen.getByTitle('send'))

    expect(apiMock.uploadAttachment).toHaveBeenCalledWith('s1', file)
    expect(apiMock.send).toHaveBeenCalledWith(
      's1',
      'look at this',
      expect.objectContaining({ attachments: ['att-picker.png'] }),
    )
  })

  it('stages files dropped on the composer and images pasted into the textarea', async () => {
    seed('codex')
    render(ThreadView, { props: { sessionId: 's1' } })
    const composer = document.querySelector('.composer')!
    const textarea = document.querySelector('.composer textarea')!

    dropFiles(composer, [new File(['pdf'], 'drop.pdf', { type: 'application/pdf' })])
    clipboardPaste(textarea, [new File(['png'], 'paste.png', { type: 'image/png' })])
    await Promise.resolve()

    expect(screen.getByText('drop.pdf')).toBeTruthy()
    expect(screen.getByText('paste.png')).toBeTruthy()
  })

  it('surfaces a resolved upload error at the composer and keeps the message and file staged', async () => {
    apiMock.uploadAttachment.mockResolvedValue({ error: 'disk full' })
    seed('claude')
    render(ThreadView, { props: { sessionId: 's1' } })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const textarea = document.querySelector('.composer textarea') as HTMLTextAreaElement
    const file = new File(['png'], 'kept.png', { type: 'image/png' })

    await fireEvent.change(input, { target: { files: [file] } })
    await fireEvent.input(textarea, { target: { value: 'do not lose me' } })
    await fireEvent.click(screen.getByTitle('send'))

    expect(await screen.findByText(/kept\.png.*disk full/i)).toBeTruthy()
    expect(textarea.value).toBe('do not lose me')
    expect(screen.getByText('kept.png')).toBeTruthy()
    expect(apiMock.send).not.toHaveBeenCalled()
  })

  it('uploads before steering and passes ids to the Codex steer request', async () => {
    seed('codex', 'active')
    render(ThreadView, { props: { sessionId: 's1' } })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['png'], 'steer.png', { type: 'image/png' })
    await fireEvent.change(input, { target: { files: [file] } })
    await fireEvent.input(document.querySelector('.composer textarea')!, { target: { value: 'inspect' } })
    await fireEvent.click(screen.getByTitle('steer into the running turn'))

    expect(apiMock.steer).toHaveBeenCalledWith('s1', 'inspect', ['att-steer.png'])
  })

  it('starts an attachment-bearing draft empty, then uploads and sends against the real id', async () => {
    seedDraft('claude')
    render(ThreadView, { props: { sessionId: 'draft:1' } })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['png'], 'first.png', { type: 'image/png' })
    await fireEvent.change(input, { target: { files: [file] } })
    await fireEvent.input(document.querySelector('.composer textarea')!, { target: { value: 'first turn' } })
    await fireEvent.click(screen.getByTitle('start this chat'))
    await waitFor(() => expect(apiMock.send).toHaveBeenCalledTimes(1))

    expect(apiMock.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ prompt: expect.anything() }))
    expect(apiMock.uploadAttachment).toHaveBeenCalledWith('real-1', file)
    expect(apiMock.send).toHaveBeenCalledWith(
      'real-1',
      'first turn',
      expect.objectContaining({ attachments: ['att-first.png'] }),
    )
    expect(apiMock.deleteSession).not.toHaveBeenCalled()
  })
})
