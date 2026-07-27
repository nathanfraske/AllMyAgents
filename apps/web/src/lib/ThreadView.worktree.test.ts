import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function seed(recordPatch: Partial<SessionRecord>, draft = false, draftUseWorktree = true): SessionView {
  const record = {
    id: draft ? 'draft:s1' : 's1',
    profileId: 'p1',
    provider: 'claude',
    projectId: 'project-1',
    cwd: draft ? '' : 'C:/repo',
    status: draft ? 'idle' : 'active',
    createdAt,
    ...recordPatch,
  } as SessionRecord
  const view: SessionView = {
    record,
    items: [],
    lastActivity: createdAt,
    sawReasoning: false,
    draft,
    draftUseWorktree,
  }
  store.sessions = { [record.id]: view }
  store.selectedId = record.id
  return view
}

beforeEach(() => {
  store.sessions = {}
  store.selectedId = null
  store.approvals = []
  store.usage = []
})

afterEach(() => cleanup())

describe('worktree intent and outcome', () => {
  it('shows both draft choices, their meaning, and which one will happen', async () => {
    const view = seed({}, true, true)
    render(ThreadView, { props: { sessionId: view.record.id } })

    const picker = screen.getByRole('group', { name: 'Where this chat will work' })
    const worktree = within(picker).getByRole('button', { name: /Worktree/ })
    const project = within(picker).getByRole('button', { name: /Project/ })
    expect(worktree.getAttribute('aria-pressed')).toBe('true')
    expect(project.getAttribute('aria-pressed')).toBe('false')
    expect(picker.textContent).toContain('isolated copy, your project is untouched')
    expect(screen.queryByText('Project folder')).toBeNull()

    await fireEvent.click(project)
    expect(store.sessions[view.record.id]?.draftUseWorktree).toBe(false)
    expect(project.getAttribute('aria-pressed')).toBe('true')
    expect(picker.textContent).toContain('works directly in the project folder')
  })

  it('does not misreport Project as the choice when a requested worktree was overridden', () => {
    const view = seed({
      worktreeRequested: true,
      worktreeFallbackReason:
        'An explicit working directory (C:/repo) overrode isolated worktree creation.',
    } as Partial<SessionRecord>)
    render(ThreadView, { props: { sessionId: view.record.id } })

    const warning = screen.getByRole('alert')
    expect(warning.textContent).toContain('Worktree was requested')
    expect(warning.textContent).toContain('this chat is working directly in the project folder')
    expect(warning.textContent).toContain('explicit working directory')
  })

  it('shows spawned state as read-only and selects the checkout that actually exists', () => {
    const view = seed({
      cwd: 'C:/data/worktrees/37fa1798',
      worktree: 'C:/data/worktrees/37fa1798',
      branch: 'agent/37fa1798',
      worktreeRequested: true,
    } as Partial<SessionRecord>)
    render(ThreadView, { props: { sessionId: view.record.id } })

    const picker = screen.getByRole('group', { name: 'Where this chat works' })
    const worktree = within(picker).getByRole('button', { name: /Worktree/ })
    const project = within(picker).getByRole('button', { name: /Project/ })
    expect(worktree.getAttribute('aria-pressed')).toBe('true')
    expect(worktree).toHaveProperty('disabled', true)
    expect(project).toHaveProperty('disabled', true)
    expect(worktree.title).toContain('C:/data/worktrees/37fa1798')
  })
})
