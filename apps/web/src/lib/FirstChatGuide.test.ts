import { cleanup, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FirstChatGuide from './FirstChatGuide.svelte'
import ThreadView from './ThreadView.svelte'
import { store, type SessionView } from './store.svelte'
import type { SessionRecord } from './api'

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy({} as Record<string, unknown>, {
      get: () => () => Promise.resolve([]),
    }),
  }
})

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

const createdAt = '2026-07-27T00:00:00.000Z'

function view(id: string, draft: boolean): SessionView {
  const record = {
    id,
    profileId: 'claude-a',
    provider: 'claude',
    cwd: '',
    status: 'idle',
    createdAt,
  } as SessionRecord
  return {
    record,
    items: [],
    lastActivity: createdAt,
    sawReasoning: false,
    draft,
    draftUseWorktree: false,
  }
}

beforeEach(() => {
  store.sessions = {}
  store.selectedId = null
  store.projects = []
  store.approvals = []
  store.usage = []
})

afterEach(() => cleanup())

describe('first-chat guide visibility', () => {
  it('does not render for a hub that already has a real chat', () => {
    const draft = view('draft:new', true)
    store.sessions = {
      [draft.record.id]: draft,
      existing: view('existing', false),
    }
    store.selectedId = draft.record.id

    render(ThreadView, { props: { sessionId: draft.record.id } })

    expect(screen.queryByText('YOUR FIRST CHAT')).toBeNull()
  })

  it('keeps the useful steps on a genuinely fresh draft', () => {
    const draft = view('draft:new', true)
    store.sessions = { [draft.record.id]: draft }
    store.selectedId = draft.record.id

    render(ThreadView, { props: { sessionId: draft.record.id } })

    expect(screen.getByText('YOUR FIRST CHAT')).toBeTruthy()
    expect(screen.getByText('Check where it will work.')).toBeTruthy()
    expect(screen.getByText('Choose the controls below.')).toBeTruthy()
    expect(screen.getByText('Describe one concrete task.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Working directory not set')
  })
})

describe('first-chat guide language', () => {
  it('explains the outcome without setup implementation jargon or an unresolved path', () => {
    render(FirstChatGuide, {
      props: {
        provider: 'claude',
        projectName: 'Unfiled',
        workingDirectory: 'Working directory not set',
        permissionMode: 'safe',
      },
    })

    const copy = document.body.textContent ?? ''
    expect(copy).not.toContain('Working directory not set')
    expect(copy).not.toMatch(/\b(?:npm|dependencies|hub|CLI)\b/i)
    expect(copy).toContain('prepares Claude Code and Codex')
    expect(copy).toContain('internet connection')
  })
})
