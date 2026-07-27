import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ProjectView from './ProjectView.svelte'
import { store, type SessionView, type ThreadItem } from './store.svelte'
import type { ProjectInfo, SessionRecord, WorktreeProjectActivity } from './api'

const apiMock = vi.hoisted(() => ({
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

const now = '2026-07-27T12:00:00.000Z'
const project: ProjectInfo = {
  id: 'project-1',
  name: 'Alpha',
  path: 'C:/work/alpha',
  createdAt: now,
}

function session(
  id: string,
  title: string,
  status: string,
  extra: Partial<SessionRecord & SessionView> = {},
  items: ThreadItem[] = [],
): SessionView {
  const record: SessionRecord = {
    id,
    title,
    profileId: `${id}-profile`,
    provider: id === 'reviewer' ? 'codex' : 'claude',
    projectId: project.id,
    cwd: `C:/worktrees/${id}`,
    status,
    createdAt: now,
    ...extra,
  }
  return {
    record,
    items,
    lastActivity: now,
    sawReasoning: false,
    lastTurnOk: extra.lastTurnOk,
  }
}

const activity: WorktreeProjectActivity = {
  projectId: project.id,
  observedAt: now,
  agents: [
    {
      sessionId: 'manager',
      label: 'Manager',
      branch: 'agent/manager',
      worktree: 'C:/worktrees/manager',
      files: [{ file: 'apps/manager.ts', kind: 'uncommitted' }],
      baseCommit: 'a'.repeat(40),
      mainCommit: 'a'.repeat(40),
      commitsBehind: 0,
      diverged: false,
    },
    {
      sessionId: 'worker',
      label: 'Worker',
      branch: 'agent/worker',
      worktree: 'C:/worktrees/worker',
      files: [{ file: 'apps/shared.ts', kind: 'uncommitted' }],
      baseCommit: 'a'.repeat(40),
      mainCommit: 'a'.repeat(40),
      commitsBehind: 0,
      diverged: false,
    },
  ],
  risks: [
    {
      risk: 'concurrent-write',
      file: 'apps/shared.ts',
      sessionIds: ['worker', 'reviewer'],
      commitsBehind: 0,
      mainAdvance: [],
    },
  ],
}

beforeEach(() => {
  localStorage.clear()
  apiMock.projectActivity.mockReset().mockResolvedValue(activity)
  const plan: ThreadItem = {
    key: 'plan',
    kind: 'tool',
    ts: now,
    toolName: 'update_plan',
    toolInput: {
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Ship', status: 'completed' },
      ],
    },
  }
  const sent: ThreadItem = {
    key: 'bus',
    kind: 'bus',
    ts: now,
    busDir: 'sent',
    busPeer: 'agent reviewer',
    busPeerId: 'reviewer',
    busSubject: 'handoff',
    text: 'Please review the patch.',
  }
  const sentTool: ThreadItem = {
    key: 'bus-tool',
    kind: 'tool',
    ts: now,
    toolName: 'mcp__allmyagents__send_message',
    toolInput: {
      to_session: 'reviewer',
      subject: 'handoff',
      body: 'Please review the patch.',
    },
  }
  store.projects = [project]
  const nameless = session('nameless', '', 'idle')
  store.sessions = {
    manager: session('manager', 'Project manager', 'active', { isProjectManager: true }, [plan]),
    worker: session('worker', 'Bose', 'idle', { parentSessionId: 'manager', role: 'Collision writer', lastTurnOk: true }, [sentTool, sent]),
    reviewer: session('reviewer', 'Reviewer', 'error', { lastTurnOk: false }),
    blocked: session('blocked', 'Blocked', 'idle'),
    nameless,
  }
  store.approvals = [
    { id: 'approval-1', sessionId: 'blocked', kind: 'claude/tool', payload: {}, status: 'pending', createdAt: now },
  ]
  store.projectViewId = project.id
})

afterEach(cleanup)

describe('ProjectView', () => {
  it('shows lifecycle status, manager grouping, files, taskboards, collisions, and project bus traffic', async () => {
    render(ProjectView, { props: { projectId: project.id } })

    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeTruthy()
    expect(screen.getByText('working')).toBeTruthy()
    expect(screen.getByText('done')).toBeTruthy()
    expect(screen.getByText('failed')).toBeTruthy()
    expect(screen.getByText('blocked on approval')).toBeTruthy()
    expect(screen.getAllByText('Project manager')).toHaveLength(1)
    expect(screen.getByText('Bose')).toBeTruthy()
    expect(screen.getByText('Collision writer')).toBeTruthy()
    expect(screen.getByText('Claude agent')).toBeTruthy()
    expect(screen.getByText(/2\/2 done/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('apps/manager.ts')).toBeTruthy())
    expect(screen.getByText('Collision')).toBeTruthy()
    expect(screen.getAllByText('apps/shared.ts').length).toBeGreaterThan(0)
    expect(screen.getByText(/Bose → Reviewer/)).toBeTruthy()
    expect(screen.getByText('Please review the patch.')).toBeTruthy()
    expect(screen.getAllByText(/Bose → Reviewer/)).toHaveLength(1)
  })

  it('drills through to a chat and leaves the project dashboard', async () => {
    render(ProjectView, { props: { projectId: project.id } })

    await fireEvent.click(screen.getByRole('button', { name: /Open Bose chat/ }))

    expect(store.selectedId).toBe('worker')
    expect(store.projectViewId).toBeNull()
  })
})
