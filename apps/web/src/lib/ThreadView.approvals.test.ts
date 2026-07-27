import { cleanup, render, screen, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ThreadView from './ThreadView.svelte'
import { store, type SessionView } from './store.svelte'
import type { ApprovalRecord, SessionRecord } from './api'

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

function approval(id: string, kind: string, payload: unknown): ApprovalRecord {
  return { id, sessionId: 's1', kind, payload, status: 'pending', createdAt }
}

function seed(approvals: ApprovalRecord[]): void {
  const record: SessionRecord = {
    id: 's1',
    profileId: 'p1',
    provider: 'claude',
    cwd: 'C:/work',
    status: 'active',
    createdAt,
  }
  const view: SessionView = { record, items: [], lastActivity: createdAt, sawReasoning: false }
  store.sessions = { s1: view }
  store.selectedId = 's1'
  store.approvals = approvals
}

beforeEach(() => {
  store.sessions = {}
  store.selectedId = null
  store.approvals = []
  store.usage = []
})

afterEach(() => cleanup())

function card(id: string): HTMLElement {
  return screen.getByTestId(`approval-${id}`)
}

describe('pending approval cards describe the action being approved', () => {
  it('shows a Claude Bash description and the actual command', () => {
    seed([
      approval('claude-bash', 'claude/tool', {
        toolName: 'Bash',
        input: { command: 'pnpm --filter web test', description: 'Run the web tests' },
      }),
    ])
    render(ThreadView, { props: { sessionId: 's1' } })

    expect(within(card('claude-bash')).getByText('Run the web tests')).toBeTruthy()
    expect(within(card('claude-bash')).getByText('pnpm --filter web test')).toBeTruthy()
  })

  it('shows the full path for a Claude file write', () => {
    seed([
      approval('claude-write', 'claude/tool', {
        toolName: 'Write',
        input: { file_path: 'C:/work/apps/web/src/lib/Sidebar.svelte', content: '<omitted>' },
      }),
    ])
    render(ThreadView, { props: { sessionId: 's1' } })

    expect(within(card('claude-write')).getByText('Sidebar.svelte')).toBeTruthy()
    expect(within(card('claude-write')).getByText('C:/work/apps/web/src/lib/Sidebar.svelte')).toBeTruthy()
  })

  it('renders the real Codex command payload instead of the nonexistent Claude input field', () => {
    seed([
      approval('codex-command', 'codex/item/commandExecution/requestApproval', {
        threadId: 'thread-1',
        itemId: 'call-1',
        command: 'pnpm --filter hub typecheck',
        cwd: 'C:/work',
        toolName: 'commandExecution',
      }),
    ])
    render(ThreadView, { props: { sessionId: 's1' } })

    const pending = card('codex-command')
    expect(within(pending).getByText('pnpm --filter hub typecheck')).toBeTruthy()
    expect(pending.textContent).not.toContain('{}')
  })

  it('names a Codex file change and shows the request fields when the request has no path', () => {
    seed([
      approval('codex-write', 'codex/item/fileChange/requestApproval', {
        itemId: 'call-file-1',
        reason: 'apply the prepared patch',
        toolName: 'fileChange',
      }),
    ])
    render(ThreadView, { props: { sessionId: 's1' } })

    const pending = card('codex-write')
    expect(pending.textContent).toContain('fileChange')
    expect(pending.textContent).toContain('itemId: call-file-1')
    expect(pending.textContent).toContain('reason: apply the prepared patch')
    expect(pending.textContent).not.toContain('{}')
  })

  it('shows the scope, title, and body for agent-tool practice approvals', () => {
    seed([
      approval('practice', 'practice/write', {
        scope: 'project:proj-1',
        title: 'Run focused tests',
        body: 'Run the smallest relevant test before the full suite.',
      }),
    ])
    render(ThreadView, { props: { sessionId: 's1' } })

    const pending = card('practice')
    expect(pending.textContent).toContain('practice/write')
    expect(pending.textContent).toContain('scope: project:proj-1')
    expect(pending.textContent).toContain('title: Run focused tests')
    expect(pending.textContent).toContain('body: Run the smallest relevant test before the full suite.')
  })
})
