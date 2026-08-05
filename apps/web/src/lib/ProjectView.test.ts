import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ProjectView from './ProjectView.svelte'
import { store, type SessionView, type ThreadItem } from './store.svelte'
import type { ProjectInfo, SessionRecord, WorktreeProjectActivity } from './api'

const apiMock = vi.hoisted(() => ({
  projectActivity: vi.fn(),
  send: vi.fn(),
  updateProject: vi.fn(),
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
    worktree: `C:/worktrees/${id}`,
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
      agentId: 'manager',
      sessionId: 'manager',
      label: 'Manager',
      managerSessionId: null,
      teamId: null,
      teamName: null,
      branch: 'agent/manager',
      worktree: 'C:/worktrees/manager',
      files: [{ file: 'apps/manager.ts', kind: 'uncommitted' }],
      commits: [],
      baseCommit: 'a'.repeat(40),
      mainCommit: 'a'.repeat(40),
      commitsBehind: 0,
      diverged: false,
    },
    {
      agentId: 'worker',
      sessionId: 'worker',
      label: 'Worker',
      managerSessionId: 'manager',
      teamId: 'team-a',
      teamName: 'Core team',
      branch: 'agent/worker',
      worktree: 'C:/worktrees/worker',
      files: [{ file: 'apps/shared.ts', kind: 'uncommitted' }],
      commits: [{ hash: 'b'.repeat(40), subject: 'Implement shared worker path' }],
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
  apiMock.send.mockReset().mockResolvedValue({ ok: true })
  apiMock.updateProject.mockReset().mockImplementation(async (_id: string, patch: { name: string }) => ({
    ...project,
    name: patch.name,
  }))
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
  const managerReply: ThreadItem = {
    key: 'manager-reply',
    kind: 'assistant',
    ts: now,
    text: 'I am coordinating the launch.',
  }
  const earlyManagerReply: ThreadItem = {
    key: 'manager-early',
    kind: 'assistant',
    ts: now,
    text: 'This is older manager history.',
  }
  const middleManagerReplies: ThreadItem[] = ['one', 'two'].map((suffix) => ({
    key: `manager-middle-${suffix}`,
    kind: 'assistant',
    ts: now,
    text: `Manager checkpoint ${suffix}.`,
  }))
  store.projects = [project]
  const nameless = session('nameless', '', 'idle')
  store.sessions = {
    manager: session(
      'manager',
      'Noether',
      'active',
      {
        isProjectManager: true,
        role: 'Project manager',
        managerTeams: [{ id: 'team-a', name: 'Core team', createdAt: now, activatedAt: now }],
        managerActiveTeamId: 'team-a',
      },
      [earlyManagerReply, ...middleManagerReplies, plan, managerReply],
    ),
    worker: session('worker', 'Bose', 'idle', {
      parentSessionId: 'manager',
      managerTeamId: 'team-a',
      managerTeamName: 'Core team',
      role: 'Collision writer',
      lastTurnOk: true,
    }, [sentTool, sent]),
    reviewer: session('reviewer', 'Reviewer', 'error', { lastTurnOk: false }),
    blocked: session('blocked', 'Blocked', 'idle'),
    nameless,
  }
  store.approvals = [
    { id: 'approval-1', sessionId: 'blocked', kind: 'claude/tool', payload: {}, status: 'pending', createdAt: now },
  ]
  store.projectViewId = project.id
  store.projectViewMode = null
})

afterEach(cleanup)

describe('ProjectView', () => {
  it('shows lifecycle status, manager grouping, files, taskboards, collisions, and project bus traffic', async () => {
    render(ProjectView, { props: { projectId: project.id } })

    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeTruthy()
    expect(screen.getAllByText('working').length).toBeGreaterThan(0)
    expect(screen.getByText('done')).toBeTruthy()
    expect(screen.getByText('failed')).toBeTruthy()
    expect(screen.getByText('blocked on approval')).toBeTruthy()
    expect(screen.getAllByText('Project manager')).toHaveLength(1)
    expect(screen.getByText('Bose')).toBeTruthy()
    expect(screen.getByText('Collision writer')).toBeTruthy()
    expect(screen.getByText('Core team · active')).toBeTruthy()
    expect(screen.getAllByText('ID worker').length).toBeGreaterThan(0)
    expect(screen.getByText('Claude agent')).toBeTruthy()
    expect(screen.getByText(/2\/2 done/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('apps/manager.ts')).toBeTruthy())
    expect(screen.getByText('1 attributable commit')).toBeTruthy()
    await fireEvent.click(screen.getByText('1 attributable commit').closest('summary')!)
    expect(screen.getByText('Implement shared worker path')).toBeTruthy()
    expect(screen.getByText('1 file collision')).toBeTruthy()
    expect(screen.getAllByText('apps/shared.ts').length).toBeGreaterThan(0)
    expect(screen.getByText(/Bose → Reviewer/)).toBeTruthy()
    expect(screen.getByText('Please review the patch.')).toBeTruthy()
    expect(screen.getAllByText(/Bose → Reviewer/)).toHaveLength(1)
  })

  it('collapses pair-wise collision noise into counted per-file groups ranked by severity', async () => {
    const pair = (file: string, left: string, right: string): WorktreeProjectActivity['risks'][number] => ({
      risk: 'concurrent-write',
      file,
      sessionIds: [left, right],
      commitsBehind: 0,
      mainAdvance: [],
    })
    apiMock.projectActivity.mockResolvedValue({
      ...activity,
      agents: activity.agents.map((agent) =>
        agent.sessionId === 'manager'
          ? {
              ...agent,
              files: [
                { file: 'apps/hub/src/server.ts', kind: 'uncommitted' as const },
                { file: 'apps/hub/src/projectManager.test.ts', kind: 'uncommitted' as const },
                { file: 'apps/web/src/lib/api.ts', kind: 'uncommitted' as const },
                { file: 'apps/web/src/lib/api.test.ts', kind: 'uncommitted' as const },
              ],
            }
          : agent,
      ),
      risks: [
        pair('apps/hub/src/server.ts', 'manager', 'worker'),
        pair('apps/hub/src/server.ts', 'manager', 'reviewer'),
        pair('apps/hub/src/server.ts', 'manager', 'blocked'),
        pair('apps/hub/src/server.ts', 'worker', 'reviewer'),
        pair('apps/hub/src/server.ts', 'worker', 'blocked'),
        pair('apps/hub/src/server.ts', 'reviewer', 'blocked'),
        pair('apps/hub/src/projectManager.test.ts', 'manager', 'worker'),
        pair('apps/hub/src/projectManager.test.ts', 'manager', 'reviewer'),
        pair('apps/hub/src/projectManager.test.ts', 'worker', 'reviewer'),
        pair('apps/web/src/lib/api.test.ts', 'manager', 'worker'),
        pair('apps/web/src/lib/api.ts', 'manager', 'worker'),
      ],
    })

    render(ProjectView, { props: { projectId: project.id } })

    const collisionSummary = await screen.findByText('4 file collisions')
    const collisionDetails = collisionSummary.closest('details')
    expect(collisionDetails?.hasAttribute('open')).toBe(false)
    expect(collisionDetails?.textContent).toMatch(/worst.*4 agents/i)

    await fireEvent.click(collisionSummary.closest('summary')!)
    expect(collisionDetails?.hasAttribute('open')).toBe(true)
    const rankedFiles = Array.from(collisionDetails!.querySelectorAll('.risk-file')).map(
      (node) => node.textContent,
    )
    expect(rankedFiles).toEqual([
      'apps/hub/src/server.ts',
      'apps/hub/src/projectManager.test.ts',
      'apps/web/src/lib/api.ts',
      'apps/web/src/lib/api.test.ts',
    ])
    expect(collisionDetails?.querySelectorAll('.risk')).toHaveLength(4)
    expect(collisionDetails?.textContent).toMatch(/Noether/)
    expect(collisionDetails?.textContent).toMatch(/Bose/)
    expect(collisionDetails?.textContent).toMatch(/Reviewer/)
    expect(collisionDetails?.textContent).toMatch(/Blocked/)

    const filesSummary = screen.getByText('4 files being worked on')
    const filesDetails = filesSummary.closest('details')
    expect(filesDetails?.hasAttribute('open')).toBe(false)
    await fireEvent.click(filesSummary.closest('summary')!)
    expect(filesDetails?.hasAttribute('open')).toBe(true)
    expect(filesDetails?.querySelectorAll('.file')).toHaveLength(4)
  })

  it('drills through to a chat and leaves the project dashboard', async () => {
    render(ProjectView, { props: { projectId: project.id } })

    await fireEvent.click(screen.getByRole('button', { name: /Open Bose chat/ }))

    expect(store.selectedId).toBe('worker')
    expect(store.projectViewId).toBeNull()
  })

  it('switches between overview and the full manager conversation and remembers the choice', async () => {
    const view = render(ProjectView, { props: { projectId: project.id } })

    expect(screen.getByRole('button', { name: 'Overview' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('I am coordinating the launch.')).toBeTruthy()
    expect(screen.queryByText('This is older manager history.')).toBeNull()

    await fireEvent.click(screen.getByRole('button', { name: 'Manager' }))

    expect(screen.getByRole('button', { name: 'Manager' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('I am coordinating the launch.')).toBeTruthy()
    expect(screen.getByText('This is older manager history.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Team' })).toBeNull()

    view.unmount()
    render(ProjectView, { props: { projectId: project.id } })
    expect(screen.getByRole('button', { name: 'Manager' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('I am coordinating the launch.')).toBeTruthy()
  })

  it('opens project-local project and manager editing without entering the manager chat', async () => {
    render(ProjectView, { props: { projectId: project.id } })

    await fireEvent.click(screen.getByRole('button', { name: /edit project & manager/i }))
    expect(screen.getByRole('dialog', { name: 'Edit project and manager' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit manager settings' })).toBeTruthy()

    const name = screen.getByRole('textbox', { name: 'Project name' })
    await fireEvent.input(name, { target: { value: 'Alpha renamed' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save project settings' }))

    await waitFor(() => expect(apiMock.updateProject).toHaveBeenCalledWith(project.id, { name: 'Alpha renamed' }))
    expect(store.projects[0]?.name).toBe('Alpha renamed')
    expect(store.projectViewId).toBe(project.id)
  })

  it('honors direct manager entry and hydrates it through the normal chat history path', async () => {
    const ensureHistory = vi.spyOn(store, 'ensureHistory').mockResolvedValue()
    store.openProjectView(project.id, 'manager')

    render(ProjectView, { props: { projectId: project.id } })

    expect(screen.getByRole('button', { name: 'Manager' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('heading', { name: 'Team' })).toBeNull()
    await waitFor(() => expect(ensureHistory).toHaveBeenCalledWith('manager'))
    ensureHistory.mockRestore()
  })

  it("renders the manager record's account, model, effort, and permission instead of profile defaults", async () => {
    store.profiles = [
      { id: 'default-claude', provider: 'claude' },
      { id: 'codex-manager-record', provider: 'codex' },
    ]
    store.lastProfileId = 'default-claude'
    store.sessions.manager = {
      ...store.sessions.manager!,
      record: {
        ...store.sessions.manager!.record,
        profileId: 'codex-manager-record',
        provider: 'codex',
        model: 'gpt-5.6-terra',
        effort: 'ultra',
        serviceTier: 'priority',
        permissionMode: 'edits',
      },
    }

    render(ProjectView, { props: { projectId: project.id } })
    await fireEvent.click(screen.getByRole('button', { name: 'Manager' }))

    expect(screen.getByTitle('Account: codex-manager-record')).toBeTruthy()
    expect(screen.getAllByTitle('Model: GPT-5.6 Terra')).toHaveLength(2)
    expect(screen.getByTitle('Model options: Ultra · Fast')).toBeTruthy()
    expect(screen.getByTitle('Permission mode: edits')).toBeTruthy()
    expect(screen.queryByTitle('Account: default-claude')).toBeNull()
  })

  it('shows a live bounded manager transcript peek and remembers when it is collapsed', async () => {
    const view = render(ProjectView, { props: { projectId: project.id } })

    const hide = screen.getByRole('button', { name: 'Hide recent manager activity' })
    expect(hide.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('I am coordinating the launch.')).toBeTruthy()
    expect(screen.queryByText('This is older manager history.')).toBeNull()

    const next: ThreadItem = {
      key: 'manager-live',
      kind: 'assistant',
      ts: '2026-07-27T12:01:00.000Z',
      text: 'A live manager update arrived.',
    }
    store.sessions = {
      ...store.sessions,
      manager: {
        ...store.sessions.manager!,
        items: [...store.sessions.manager!.items, next],
      },
    }
    await waitFor(() => expect(screen.getByText('A live manager update arrived.')).toBeTruthy())

    await fireEvent.click(hide)
    expect(screen.queryByText('A live manager update arrived.')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message Noether' })).toBeTruthy()

    view.unmount()
    render(ProjectView, { props: { projectId: project.id } })
    const show = screen.getByRole('button', { name: 'Show recent manager activity' })
    expect(show.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('A live manager update arrived.')).toBeNull()
  })

  it('steers the named manager from the overview through the shared composer', async () => {
    render(ProjectView, { props: { projectId: project.id } })

    const composer = screen.getByRole('textbox', { name: 'Message Noether' })
    await fireEvent.input(composer, { target: { value: 'Check the release risk now.' } })
    await fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() =>
      expect(apiMock.send).toHaveBeenCalledWith(
        'manager',
        'Check the release risk now.',
        expect.objectContaining({ attachments: undefined }),
      ),
    )
  })

  it('does not show a manager view or overview composer for an independent team', () => {
    store.sessions = Object.fromEntries(
      Object.entries(store.sessions).filter(([id]) => id !== 'manager'),
    )

    render(ProjectView, { props: { projectId: project.id } })

    expect(screen.queryByRole('button', { name: 'Manager' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Message/ })).toBeNull()
  })

  it('explains the worktree-only monitor once without calling direct-project work unavailable', async () => {
    store.sessions.manager = {
      ...store.sessions.manager!,
      record: {
        ...store.sessions.manager!.record,
        cwd: project.path,
        worktree: undefined,
      },
    }
    apiMock.projectActivity.mockResolvedValue({
      ...activity,
      agents: activity.agents.filter((agent) => agent.sessionId !== 'manager'),
    })

    render(ProjectView, { props: { projectId: project.id } })

    await waitFor(() => expect(apiMock.projectActivity).toHaveBeenCalled())
    expect(screen.getAllByText(/shared-checkout edits cannot be attributed/i)).toHaveLength(1)
    expect(screen.getByText('Works directly in the project')).toBeTruthy()
    expect(screen.queryByText(/file monitor unavailable/i)).toBeNull()
    expect(screen.queryByText(/file monitoring is unavailable/i)).toBeNull()
  })
})
