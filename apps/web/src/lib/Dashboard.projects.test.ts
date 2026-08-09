import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard.svelte'
import { store, type SessionView } from './store.svelte'
import { settings } from './settings.svelte'
import type { ProjectInfo, SessionRecord, WorktreeProjectActivity } from './api'

const apiMock = vi.hoisted(() => ({
  stats: vi.fn(),
  projectActivity: vi.fn(),
}))

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy(apiMock, {
      get: (target, property: string) =>
        property in target ? target[property as keyof typeof target] : () => Promise.resolve([]),
    }),
  }
})

window.matchMedia = ((query: string) => ({
  matches: query.includes('prefers-reduced-motion'),
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
})) as unknown as typeof window.matchMedia

const now = '2026-07-27T12:00:00.000Z'
const projects: ProjectInfo[] = [
  { id: 'quiet', name: 'Quiet project', path: 'C:/quiet', createdAt: now },
  { id: 'risk', name: 'Risk project', path: 'C:/risk', createdAt: now },
  { id: 'empty', name: 'Empty project', path: 'C:/empty', createdAt: now },
]

function session(
  id: string,
  projectId: string,
  status: string,
  lastActivity: string,
  lastTurnOk?: boolean,
): SessionView {
  const record: SessionRecord = {
    id,
    projectId,
    profileId: `${id}-profile`,
    provider: 'claude',
    cwd: `C:/${projectId}/${id}`,
    status,
    createdAt: lastActivity,
    title: id,
  }
  return { record, items: [], lastActivity, sawReasoning: false, lastTurnOk }
}

function activity(projectId: string, risks = 0): WorktreeProjectActivity {
  return {
    projectId,
    observedAt: now,
    agents: [],
    risks: Array.from({ length: risks }, (_, index) => ({
      risk: 'concurrent-write',
      file: `shared-${index}.ts`,
      sessionIds: ['one', 'two'],
      commitsBehind: 0,
      mainAdvance: [],
    })),
  }
}

beforeEach(() => {
  apiMock.stats.mockReset().mockResolvedValue({
    days: [],
    totalTurns: 0,
    totalApiEquivalentCostUsd: 0,
    totalSessions: 0,
  })
  apiMock.projectActivity.mockReset().mockImplementation((projectId: string) =>
    Promise.resolve(activity(projectId, projectId === 'risk' ? 2 : 0)),
  )
  store.projects = projects
  store.sessions = {
    quiet1: session('quiet1', 'quiet', 'active', '2026-07-27T11:55:00.000Z'),
    quiet2: session('quiet2', 'quiet', 'idle', '2026-07-27T11:54:00.000Z', true),
    risk1: session('risk1', 'risk', 'error', '2026-07-27T10:00:00.000Z', false),
    risk2: session('risk2', 'risk', 'idle', '2026-07-27T09:00:00.000Z'),
  }
  store.approvals = [
    { id: 'approval-1', sessionId: 'risk2', kind: 'claude/tool', payload: {}, status: 'pending', createdAt: now },
  ]
  store.selectedId = null
  store.projectViewId = null
  store.splitPanes = []
  store.lastLayout = null
  store.restorableLayout = null
  store.profiles = [{ id: 'claude-main', provider: 'claude' }]
  store.lastProfileId = null
  settings.detachedDefaultProjectId = null
  settings.showSpend = false
})

afterEach(() => {
  cleanup()
  settings.detachedDefaultProjectId = null
  settings.showSpend = false
})

describe('Dashboard project launchpad', () => {
  it('uses relative heat intensity and only shows clearly-labelled API-equivalent estimates when enabled', async () => {
    settings.showSpend = true
    apiMock.stats.mockResolvedValue({
      days: [
        {
          date: '2026-07-26',
          turns: 5,
          apiEquivalentCostUsd: 1.25,
          projects: { 'Quiet project': { turns: 5, apiEquivalentCostUsd: 1.25 } },
        },
        {
          date: '2026-07-27',
          turns: 20,
          apiEquivalentCostUsd: 12.5,
          projects: { 'Risk project': { turns: 20, apiEquivalentCostUsd: 12.5 } },
        },
      ],
      totalTurns: 25,
      totalApiEquivalentCostUsd: 13.75,
      totalSessions: 4,
    })

    render(Dashboard, { onnewproject: vi.fn() })

    expect(await screen.findByText('API-equivalent (past yr)')).toBeTruthy()
    expect(screen.getByText('~$13.8')).toBeTruthy()
    expect(screen.queryByText('spend (past yr)')).toBeNull()
    expect(screen.getByRole('button', { name: '2026-07-26: 5 turns, 25% of busiest day' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '2026-07-27: 20 turns, 100% of busiest day' })).toBeTruthy()
  })

  it('shows every project, opens ProjectView in one click, and summarizes the cheap roster signals', async () => {
    const retired = session('retired', 'risk', 'active', '2026-07-27T11:59:00.000Z')
    retired.record.managerRetiredAt = '2026-07-27T12:00:00.000Z'
    store.sessions.retired = retired
    const { container } = render(Dashboard, { onnewproject: vi.fn() })

    expect(container.querySelector('.tiles .tile .num')?.textContent).toBe('4')
    const quiet = screen.getByRole('button', { name: 'Open Quiet project project' })
    expect(within(quiet).getByText('2 agents')).toBeTruthy()
    expect(within(quiet).getByText('1 working')).toBeTruthy()
    expect(within(quiet).getByText(/ago$/)).toBeTruthy()

    const risk = screen.getByRole('button', { name: 'Open Risk project project' })
    expect(within(risk).getByText('2 agents')).toBeTruthy()
    expect(within(risk).queryByText(/working$/)).toBeNull()
    expect(within(risk).getByText('1 needs approval')).toBeTruthy()
    expect(within(risk).getByText('1 failed')).toBeTruthy()

    const empty = screen.getByRole('button', { name: 'Open Empty project project' })
    expect(within(empty).getByText('0 agents')).toBeTruthy()
    expect(within(empty).getByText('No activity yet')).toBeTruthy()

    await waitFor(() => expect(within(risk).getByText('2 worktree risks')).toBeTruthy())
    expect([...container.querySelectorAll('.project-launch h4')].map((node) => node.textContent)).toEqual([
      'Risk project',
      'Quiet project',
      'Empty project',
    ])
    expect(apiMock.projectActivity).toHaveBeenCalledTimes(projects.length)

    await fireEvent.click(quiet)
    expect(store.projectViewId).toBe('quiet')
  })

  it('invites an operator with no projects into the New Project flow', async () => {
    store.projects = []
    store.sessions = {}
    const onnewproject = vi.fn()

    render(Dashboard, { onnewproject })

    const create = screen.getByRole('button', { name: 'New Project' })
    expect(screen.getByText(/Create your first project/)).toBeTruthy()
    await fireEvent.click(create)
    expect(onnewproject).toHaveBeenCalledOnce()
    expect(apiMock.projectActivity).not.toHaveBeenCalled()
  })

  it('starts a truly unfiled scratchpad even when detached chats default into a project', async () => {
    settings.detachedDefaultProjectId = projects[0]!.id
    render(Dashboard, { onnewproject: vi.fn() })

    const scratchpad = screen.getByRole('button', {
      name: 'New Scratchpad — no project, isolated workspace, start typing',
    })
    expect(within(scratchpad).getByText('New Scratchpad')).toBeTruthy()
    expect(within(scratchpad).getByText('No project · own space · type now')).toBeTruthy()

    await fireEvent.click(scratchpad)

    expect(store.selectedId).toMatch(/^draft:/)
    expect(store.sessions[store.selectedId!]?.draft).toBe(true)
    expect(store.sessions[store.selectedId!]?.record.projectId).toBeUndefined()
  })
})
