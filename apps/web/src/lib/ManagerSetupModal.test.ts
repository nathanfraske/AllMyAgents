import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/svelte'
import ManagerSetupModal from './ManagerSetupModal.svelte'
import { store, type SessionView } from './store.svelte'
import type { SessionRecord } from './api'

const { configureProjectManager, spawn, send, setMode, setSettings, rename } = vi.hoisted(() => ({
  configureProjectManager: vi.fn(),
  spawn: vi.fn(),
  send: vi.fn(),
  setMode: vi.fn(),
  setSettings: vi.fn(),
  rename: vi.fn(),
}))

vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      configureProjectManager,
      spawn,
      send,
      setMode,
      setSettings,
      rename,
    },
  }
})

function session(id: string, title: string, projectId = 'project-1'): SessionView {
  const record = {
    id,
    title,
    projectId,
    profileId: 'codex-a',
    provider: 'codex',
    cwd: 'C:/repo',
    status: 'idle',
    createdAt: '2026-07-27T00:00:00.000Z',
  } as SessionRecord
  return { record, items: [], lastActivity: record.createdAt, sawReasoning: false }
}

beforeEach(() => {
  vi.clearAllMocks()
  setMode.mockResolvedValue({ ok: true })
  setSettings.mockResolvedValue(session('settings', 'Settings').record)
  send.mockResolvedValue({ ok: true })
  rename.mockResolvedValue({ ok: true })
  store.projects = [{ id: 'project-1', name: 'Demo project', path: 'C:/repo', createdAt: '2026-07-27T00:00:00.000Z' }]
  store.profiles = [
    { id: 'codex-a', provider: 'codex' },
    { id: 'claude-a', provider: 'claude' },
  ]
  store.sessions = { existing: session('existing', 'Existing chat') }
  store.managerSetupSessionId = 'existing'
  store.projectViewId = 'project-1'
})

describe('Manager setup', () => {
  it('explains the role, required scope, and managed-hierarchy visibility before granting', () => {
    const { getByText, getAllByText } = render(ManagerSetupModal, { onclose: vi.fn() })
    expect(getByText(/spawns and oversees other agents on your behalf/i)).toBeTruthy()
    expect(getAllByText('Project')).toHaveLength(2)
    expect(getByText('Worker accounts & models')).toBeTruthy()
    expect(getByText('Live child limit')).toBeTruthy()
    expect(getByText(/its own managed hierarchy, and only that hierarchy/i)).toBeTruthy()
  })

  it('makes promotion and creation two clear choices in one flow', () => {
    const { getByRole } = render(ManagerSetupModal, { onclose: vi.fn() })
    expect(getByRole('button', { name: /promote existing chat/i })).toBeTruthy()
    expect(getByRole('button', { name: /create new manager/i })).toBeTruthy()
  })

  it('shows one readable grant summary and an obvious revoke action for a manager', async () => {
    store.sessions.existing!.record = {
      ...store.sessions.existing!.record,
      isProjectManager: true,
      managerMaxLiveChildren: 3,
      managerAllowedProfiles: ['codex-a'],
      managerAllowedModels: { 'codex-a': ['gpt-5.6-sol'] },
      managerDelegation: ['commit'],
      managerAllowedTools: ['Bash'],
    }
    configureProjectManager.mockResolvedValue({
      ...store.sessions.existing!.record,
      isProjectManager: false,
    })
    const { getByText, getByRole } = render(ManagerSetupModal, { onclose: vi.fn() })
    expect(getByText(/3 live children/i)).toBeTruthy()
    expect(getByText(/commit only/i)).toBeTruthy()
    expect(getByRole('button', { name: /revoke manager role/i })).toBeTruthy()
    await fireEvent.click(getByRole('button', { name: /revoke manager role/i }))
    expect(configureProjectManager).toHaveBeenCalledWith(
      'existing',
      expect.objectContaining({ enabled: false }),
    )
  })

  it('makes worker Git delegation and exact approval/tool ceilings unambiguous on Windows too', () => {
    const { getByText, getAllByText, getByLabelText } = render(ManagerSetupModal, { onclose: vi.fn() })
    expect(getByText('Git actions the manager may grant or approve once')).toBeTruthy()
    expect(getByText(/no worker can be granted commit or push/i)).toBeTruthy()
    expect(getByText(/requests outside this exact list go to the operator or overseer/i)).toBeTruthy()
    expect(getByText(/choose common tools below/i)).toBeTruthy()
    expect(getAllByText('Read').length).toBeGreaterThan(0)
    expect(getAllByText('PowerShell').length).toBeGreaterThan(0)
    expect(getByLabelText(/custom exact tool name/i)).toBeTruthy()
  })

  it('configures named agent types with purpose, fixed model and effort, or usage-aware selection', async () => {
    const { getByRole, getByLabelText, getByText } = render(ManagerSetupModal, { onclose: vi.fn() })
    expect(getByText('Agent types')).toBeTruthy()
    await fireEvent.click(getByRole('button', { name: /add agent type/i }))
    expect(getByLabelText(/agent type name/i)).toBeTruthy()
    expect(getByLabelText(/what is this agent for/i)).toBeTruthy()
    expect(getByLabelText(/worker model/i)).toBeTruthy()
    expect(getByLabelText(/^reasoning \/ effort$/i)).toBeTruthy()
    expect(getByRole('button', { name: /let manager choose using usage limits/i })).toBeTruthy()
  })

  it('shows only the operator task by default and keeps the editable full brief collapsed', () => {
    store.managerSetupSessionId = null
    const { getByLabelText, getByText } = render(ManagerSetupModal, { onclose: vi.fn() })
    expect(getByLabelText(/operator task/i)).toBeTruthy()
    const details = getByText(/edit the full brief/i).closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(getByLabelText(/manager orientation brief/i)).toBeTruthy()
    expect(getByLabelText(/standing manager rules/i)).toBeTruthy()
  })

  it('launches only after persisting scope, with the editable task and chosen permission mode', async () => {
    store.managerSetupSessionId = null
    spawn.mockResolvedValue(session('manager', 'Demo project manager').record)
    configureProjectManager.mockImplementation(async (id: string) => ({
      ...session(id, 'Demo project manager').record,
      isProjectManager: true,
    }))
    send.mockResolvedValue({ ok: true })
    const { getByRole, getByLabelText } = render(ManagerSetupModal, { onclose: vi.fn() })
    const task = getByLabelText(/operator task/i) as HTMLTextAreaElement
    expect(task.value).toBe('')
    await fireEvent.input(task, { target: { value: 'Coordinate the release now.' } })
    await fireEvent.change(getByLabelText(/manager permission level/i), { target: { value: 'edits' } })
    await fireEvent.change(getByLabelText(/maximum child permission level/i), { target: { value: 'full' } })
    await fireEvent.click(getByRole('button', { name: /^create and launch manager$/i }))

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'edits' }))
    await waitFor(() => expect(configureProjectManager).toHaveBeenCalled())
    expect(configureProjectManager).toHaveBeenCalledWith(
      'manager',
      expect.objectContaining({
        operatorTask: 'Coordinate the release now.',
        permissionMode: 'edits',
        maxChildPermissionMode: 'full',
        standingInstructions: expect.stringMatching(/delegate.*AllMyAgents workers/is),
      }),
    )
    expect(setMode).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'manager',
      expect.stringMatching(/list_agents.*child_status.*Coordinate the release now\./is),
    )
    expect(configureProjectManager.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!)
  })

  it('launches without a task as a tooling self-test that halts and asks the operator', async () => {
    store.managerSetupSessionId = null
    spawn.mockResolvedValue(session('manager', 'Demo project manager').record)
    configureProjectManager.mockImplementation(async (id: string) => ({
      ...session(id, 'Demo project manager').record,
      isProjectManager: true,
    }))
    const { getByRole } = render(ManagerSetupModal, { onclose: vi.fn() })
    await fireEvent.click(getByRole('button', { name: /^create and launch manager$/i }))
    await waitFor(() => expect(send).toHaveBeenCalled())
    const sent = send.mock.calls[0]?.[1] as string
    expect(sent).toMatch(/call list_agents and child_status/i)
    expect(sent).toMatch(/no task.*stop.*ask the operator/is)
    expect(sent).toMatch(/do not invent/i)
  })

  it('orients a fresh manager to the AllMyAgents layer, its real tools, project, and ceiling', () => {
    store.managerSetupSessionId = null
    const { getByLabelText } = render(ManagerSetupModal, { onclose: vi.fn() })
    const prompt = (getByLabelText(/manager orientation brief/i) as HTMLTextAreaElement).value
    expect(prompt).toMatch(/project manager in AllMyAgents/i)
    expect(prompt).toContain('Demo project')
    expect(prompt).toContain('C:/repo')
    expect(prompt).toMatch(/spawn_agent.*isolated.*worktree/is)
    expect(prompt).toMatch(/manage_child.*retire.*preserv.*live-child slot/is)
    expect(prompt).toMatch(/child_status.*peek_agent.*set_child_authority.*decide_child_approval/is)
    expect(prompt).toMatch(/send_message.*direct.*broadcast/is)
    expect(prompt).toMatch(/practice.*memory/is)
    expect(prompt).toMatch(/native.*spawn_agent.*not.*AllMyAgents/is)
    expect(prompt).toMatch(/mcp__allmyagents(?:__|\.)spawn_agent/i)
    expect(prompt).toMatch(/never.*collaboration\.spawn_agent/is)
    expect(prompt).toMatch(/cannot grant.*does not hold/i)
    expect(prompt).toMatch(/profile_id.*codex-a/i)
    expect(prompt).toMatch(/stalls.*blocks.*errors/is)
    expect(prompt).toMatch(/verify.*transcript.*worktree/is)
    expect(prompt).toMatch(/state.*exact granted tools.*redirect.*granted alternative/is)
    expect(prompt).toMatch(/final status.*files.*commits/is)

    const standing = (getByLabelText(/standing manager rules/i) as HTMLTextAreaElement).value
    expect(standing).toMatch(/mcp__allmyagents(?:__|\.)spawn_agent/i)
    expect(standing).toMatch(/never.*collaboration\.spawn_agent/is)
    expect(standing).toMatch(/manage_child.*retire.*releases capacity/is)
  })

  it('offers Lane O project creation inline and returns a deferred embedded launch config', async () => {
    store.managerSetupSessionId = null
    const onCreateProject = vi.fn()
    const onConfigured = vi.fn()
    const { getByRole, getByLabelText, queryByRole } = render(ManagerSetupModal, {
      onclose: vi.fn(),
      embedded: true,
      deferLaunch: true,
      initialProjectId: 'project-1',
      onCreateProject,
      onConfigured,
    })
    expect((getByLabelText(/manager may answer its workers’ approvals/i) as HTMLInputElement).checked).toBe(true)
    await fireEvent.click(getByRole('button', { name: /create a new project/i }))
    expect(onCreateProject).toHaveBeenCalledOnce()
    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        permissionMode: expect.any(String),
        startingPrompt: expect.stringMatching(/Demo project/i),
        operatorTask: '',
        standingInstructions: expect.stringMatching(/real chat.*sidebar/is),
        canApproveChildren: true,
        agentTypes: expect.any(Array),
      }),
    ))
    expect(queryByRole('button', { name: /add to project launch/i })).toBeNull()
    expect(onConfigured.mock.calls[0]?.[0].standingInstructions).toMatch(/worktree/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('edits an existing manager in project context without navigating into its chat or widening an override', async () => {
    store.sessions.existing!.record = {
      ...store.sessions.existing!.record,
      isProjectManager: true,
      model: 'gpt-5.6-terra',
      effort: 'high',
      permissionMode: 'full',
      permissionModeOperatorOverride: true,
      permissionModeOperatorOverrideCeiling: 'full',
      managerPermissionModeCeiling: 'safe',
      managerMaxChildPermissionMode: 'edits',
      managerAllowedProfiles: ['codex-a'],
      managerAllowedModels: { 'codex-a': ['gpt-5.6-terra'] },
    }
    configureProjectManager.mockImplementation(async (id: string, config: Record<string, unknown>) => ({
      ...store.sessions[id]!.record,
      title: 'Release manager',
      permissionMode: config.permissionMode,
      managerPermissionModeCeiling: config.permissionMode,
    }))
    const onSaved = vi.fn()
    const { getByRole, getByLabelText, getByText } = render(ManagerSetupModal, {
      embedded: true,
      stayInProject: true,
      initialProjectId: 'project-1',
      initialManagerId: 'existing',
      onSaved,
    })

    expect(getByText('Editing existing manager')).toBeTruthy()
    expect(getByText(/account owns this live vendor thread/i)).toBeTruthy()
    expect((getByLabelText('Manager permission level') as HTMLSelectElement).value).toBe('safe')
    await fireEvent.input(getByLabelText('Manager display name'), { target: { value: 'Release manager' } })
    await fireEvent.click(getByRole('button', { name: 'Save manager settings' }))

    await waitFor(() => expect(configureProjectManager).toHaveBeenCalled())
    expect(rename).toHaveBeenCalledWith('existing', 'Release manager')
    expect(configureProjectManager).toHaveBeenCalledWith(
      'existing',
      expect.objectContaining({ permissionMode: 'safe', maxChildPermissionMode: 'edits' }),
    )
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'existing' }))
    expect(store.projectViewId).toBe('project-1')
    expect(send).not.toHaveBeenCalled()
  })
})
