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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function clipboardPaste(el: Element, files: File[], text = ''): void {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
  Object.defineProperty(event, 'clipboardData', {
    value: { files, getData: (kind: string) => (kind === 'text/plain' ? text : '') },
  })
  el.dispatchEvent(event)
}

function dropFiles(el: Element, files: File[], types = ['Files']): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown }
  Object.defineProperty(event, 'dataTransfer', { value: { files, types } })
  el.dispatchEvent(event)
  return event
}

function dragFilesOver(el: Element, files: File[]): Event {
  const event = new Event('dragenter', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown }
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } })
  el.dispatchEvent(event)
  return event
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

  it('stages a file dropped on the transcript and prevents the webview default', async () => {
    seed('codex')
    render(ThreadView, { props: { sessionId: 's1' } })
    const transcript = document.querySelector('.stream')!
    const dropped = new File(['png'], 'transcript.png', { type: 'image/png' })

    const event = dropFiles(transcript, [dropped])
    await Promise.resolve()

    expect(event.defaultPrevented).toBe(true)
    expect(screen.getByText('transcript.png')).toBeTruthy()
  })

  it('shows pane-wide feedback while a file is dragged over the transcript', async () => {
    seed('claude')
    render(ThreadView, { props: { sessionId: 's1' } })
    const transcript = document.querySelector('.stream')!

    const event = dragFilesOver(transcript, [new File(['png'], 'hover.png', { type: 'image/png' })])
    await Promise.resolve()

    expect(event.defaultPrevented).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Drop files to attach')
    expect(document.querySelector('.chat-drop-target')?.classList.contains('dragging-files')).toBe(true)
  })

  it('stages a composer drop exactly once and still stages pasted images', async () => {
    seed('codex')
    render(ThreadView, { props: { sessionId: 's1' } })
    const composer = document.querySelector('.composer')!
    const textarea = document.querySelector('.composer textarea')!

    const event = dropFiles(composer, [new File(['pdf'], 'drop.pdf', { type: 'application/pdf' })])
    clipboardPaste(textarea, [new File(['png'], 'paste.png', { type: 'image/png' })])
    await Promise.resolve()

    expect(event.defaultPrevented).toBe(true)
    expect(screen.getAllByText('drop.pdf')).toHaveLength(1)
    expect(screen.getByText('paste.png')).toBeTruthy()
  })

  it('prevents an otherwise unhandled pane drop from navigating the webview', async () => {
    seed('claude')
    render(ThreadView, { props: { sessionId: 's1' } })
    const header = document.querySelector('.head')!

    const event = dropFiles(header, [], [])

    expect(event.defaultPrevented).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stages multiple dropped files through the same single-error path as the picker', async () => {
    seed('claude')
    render(ThreadView, { props: { sessionId: 's1' } })
    const transcript = document.querySelector('.stream')!

    dropFiles(transcript, [
      new File(['png'], 'one.png', { type: 'image/png' }),
      new File(['binary'], 'unsupported.bin', { type: 'application/octet-stream' }),
      new File(['pdf'], 'two.pdf', { type: 'application/pdf' }),
    ])
    await Promise.resolve()

    expect(screen.getByText('one.png')).toBeTruthy()
    expect(screen.getByText('unsupported.bin')).toBeTruthy()
    expect(screen.getByText('two.pdf')).toBeTruthy()
    expect(screen.getAllByText(/Unsupported file/)).toHaveLength(1)
  })

  it('delivers a dropped markdown file as visible staged text, not a vendor attachment', async () => {
    seed('codex')
    render(ThreadView, { props: { sessionId: 's1' } })
    const transcript = document.querySelector('.stream')!
    const markdown = new File(['# plan\nfull details'], 'plan.md', { type: 'text/markdown' })
    Object.defineProperty(markdown, 'text', { value: async () => '# plan\nfull details' })

    dropFiles(transcript, [markdown])
    expect(await screen.findByText(/Pasted text/)).toBeTruthy()
    await fireEvent.click(screen.getByTitle('send'))

    expect(apiMock.uploadAttachment).not.toHaveBeenCalled()
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    expect(apiMock.send.mock.calls[0][1]).toContain('# plan\nfull details')
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

  it('replaces a stale upload error when staging changes, then clears the current error on remove and successful send', async () => {
    apiMock.uploadAttachment.mockResolvedValue({ error: 'disk full' })
    seed('claude')
    render(ThreadView, { props: { sessionId: 's1' } })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const textarea = document.querySelector('.composer textarea') as HTMLTextAreaElement

    await fireEvent.change(input, {
      target: { files: [new File(['png'], 'kept.png', { type: 'image/png' })] },
    })
    await fireEvent.input(textarea, { target: { value: 'retry me' } })
    await fireEvent.click(screen.getByTitle('send'))
    expect((await screen.findByRole('alert')).textContent).toContain('disk full')

    // A newly staged unsupported file owns the current error state. The previous upload failure must
    // disappear instead of rendering beside this item's policy warning.
    await fireEvent.change(input, {
      target: { files: [new File(['binary'], 'current.bin', { type: 'application/octet-stream' })] },
    })
    expect(screen.queryByText(/disk full/i)).toBeNull()
    expect(screen.getAllByText(/Unsupported file/i)).toHaveLength(1)

    await fireEvent.click(screen.getByRole('button', { name: 'Remove current.bin' }))
    expect(screen.queryByText(/Unsupported file/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    apiMock.uploadAttachment.mockImplementation(async (_sessionId: string, file: File) => ({
      id: `att-${file.name}`,
      name: file.name,
      mime: file.type,
      size: file.size,
    }))
    await fireEvent.click(screen.getByTitle('send'))
    await waitFor(() => expect(apiMock.send).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('kept.png')).toBeNull()
    expect(textarea.value).toBe('')
  })

  it('clears an attachment error and staged files when switching chats', async () => {
    apiMock.uploadAttachment.mockResolvedValue({ error: 'disk full' })
    seed('claude')
    const second = {
      ...store.sessions.s1!,
      record: { ...store.sessions.s1!.record, id: 's2' },
      items: [],
    }
    store.sessions = { ...store.sessions, s2: second }
    const view = render(ThreadView, { props: { sessionId: 's1' } })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement

    await fireEvent.change(input, {
      target: { files: [new File(['png'], 'old-chat.png', { type: 'image/png' })] },
    })
    await fireEvent.click(screen.getByTitle('send'))
    expect((await screen.findByRole('alert')).textContent).toContain('disk full')

    await view.rerender({ sessionId: 's2' })
    await waitFor(() => expect(screen.queryByText('old-chat.png')).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('uploads before steering and passes ids through the provider-neutral input route', async () => {
    seed('codex', 'active')
    render(ThreadView, { props: { sessionId: 's1' } })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['png'], 'steer.png', { type: 'image/png' })
    await fireEvent.change(input, { target: { files: [file] } })
    await fireEvent.input(document.querySelector('.composer textarea')!, { target: { value: 'inspect' } })
    await fireEvent.click(screen.getByTitle('steer into the running turn'))

    expect(apiMock.send).toHaveBeenCalledWith(
      's1',
      'inspect',
      { attachments: ['att-steer.png'], requestId: expect.any(String) },
    )
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

  it('carries new composer text across a delayed draft-to-real chat transition', async () => {
    const pending = deferred<SessionRecord>()
    apiMock.spawn.mockReturnValue(pending.promise)
    seedDraft('claude')
    const rendered = render(ThreadView, { props: { sessionId: 'draft:1' } })
    let textarea = rendered.container.querySelector('.composer textarea') as HTMLTextAreaElement

    await fireEvent.input(textarea, { target: { value: 'Start this chat.' } })
    await fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(apiMock.spawn).toHaveBeenCalledTimes(1))
    expect(textarea.value).toBe('')
    await fireEvent.input(textarea, { target: { value: 'Follow-up typed during startup.' } })

    pending.resolve({
      id: 'real-1',
      profileId: 'p1',
      provider: 'claude',
      cwd: 'C:/work',
      status: 'starting',
      createdAt: '2026-07-27T00:00:01.000Z',
    } as SessionRecord)
    await waitFor(() => expect(store.sessions['real-1']).toBeTruthy())
    await rendered.rerender({ sessionId: 'real-1' })
    textarea = rendered.container.querySelector('.composer textarea') as HTMLTextAreaElement

    await waitFor(() => expect(textarea.value).toBe('Follow-up typed during startup.'))
  })
})
