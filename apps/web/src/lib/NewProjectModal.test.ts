import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NewProjectModal from './NewProjectModal.svelte'
import { store } from './store.svelte'
import type { ProjectInfo, SessionRecord } from './api'

const apiMock = vi.hoisted(() => ({
  createProject: vi.fn(),
  pickFolder: vi.fn(),
  spawn: vi.fn(),
  rename: vi.fn(),
  setMode: vi.fn(),
  setSettings: vi.fn(),
  configureProjectManager: vi.fn(),
  send: vi.fn(),
  githubCapability: vi.fn(),
  githubRepositories: vi.fn(),
  startGitHubClone: vi.fn(),
  githubClone: vi.fn(),
}))
const scrollIntoView = vi.fn()

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: scrollIntoView,
})

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

const project: ProjectInfo = {
  id: 'project-42',
  name: 'Control room',
  path: 'C:/work/control-room',
  createdAt: '2026-07-27T12:00:00.000Z',
}

function record(id: string, profileId = 'codex-main'): SessionRecord {
  return {
    id,
    profileId,
    provider: profileId.startsWith('claude') ? 'claude' : 'codex',
    projectId: project.id,
    cwd: project.path,
    status: 'starting',
    createdAt: '2026-07-27T12:01:00.000Z',
  }
}

async function createLocalProject(): Promise<void> {
  await fireEvent.input(screen.getByLabelText('Project name'), { target: { value: project.name } })
  await fireEvent.input(screen.getByLabelText('Working directory'), { target: { value: project.path } })
  await fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
  expect(await screen.findByText('2. The team')).toBeTruthy()
}

beforeEach(() => {
  vi.clearAllMocks()
  scrollIntoView.mockClear()
  store.projects = []
  store.profiles = [
    { id: 'codex-main', provider: 'codex' },
    { id: 'claude-review', provider: 'claude' },
  ]
  apiMock.createProject.mockResolvedValue(project)
  apiMock.pickFolder.mockResolvedValue({ path: project.path })
  apiMock.rename.mockResolvedValue({ ok: true })
  apiMock.setMode.mockResolvedValue({ ok: true })
  apiMock.setSettings.mockResolvedValue(record('manager-session'))
  apiMock.send.mockResolvedValue({ ok: true })
})

afterEach(() => cleanup())

describe('New project pipeline', () => {
  it('creates a local project, keeps its completed summary visible, and advances to the team', async () => {
    render(NewProjectModal, {
      onclose: vi.fn(),
      onlaunched: vi.fn(),
    })

    await createLocalProject()

    expect(apiMock.createProject).toHaveBeenCalledWith(project.name, project.path)
    expect(screen.getByText(project.path)).toBeTruthy()
    expect(screen.getByText('Project ready')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add starting agent' })).toBeTruthy()
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('reuses the GitHub import surface instead of presenting a second clone flow', async () => {
    apiMock.githubCapability.mockResolvedValue({
      available: false,
      reason: 'GitHub CLI is not signed in.',
    })

    render(NewProjectModal, {
      onclose: vi.fn(),
      onlaunched: vi.fn(),
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Clone a GitHub repository' }))

    expect(await screen.findByText(/GitHub CLI is not signed in/)).toBeTruthy()
    expect(screen.getByText(/still add any local folder above/i)).toBeTruthy()
  })

  it('separates manager-owned children from independently launched agents', async () => {
    render(NewProjectModal, { onclose: vi.fn(), onlaunched: vi.fn() })
    await createLocalProject()

    expect(screen.getByRole('heading', { name: 'With a manager' })).toBeTruthy()
    expect(screen.getByText(/children it spawns answer to it/i)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Independent agents' })).toBeTruthy()
    expect(screen.getByText(/do not answer to the manager/i)).toBeTruthy()
    expect(screen.getByText(/use either category, both, or neither/i)).toBeTruthy()
  })

  it('launches every configured agent concurrently, reports a partial failure, and retries only the failure', async () => {
    const onlaunched = vi.fn()
    render(NewProjectModal, {
      onclose: vi.fn(),
      onlaunched,
    })
    await createLocalProject()

    await fireEvent.click(screen.getByRole('button', { name: 'Add starting agent' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Add starting agent' }))
    const prompts = screen.getAllByLabelText(/Starting prompt/)
    const scopes = screen.getAllByLabelText(/Scope/)
    await fireEvent.input(prompts[0]!, { target: { value: 'Build the feature.' } })
    await fireEvent.input(scopes[0]!, { target: { value: 'Implementation' } })
    await fireEvent.input(prompts[1]!, { target: { value: 'Review the result.' } })
    await fireEvent.input(scopes[1]!, { target: { value: 'Independent review' } })
    const accounts = screen.getAllByLabelText(/Account/)
    await fireEvent.change(accounts[1]!, { target: { value: 'claude-review' } })

    await fireEvent.click(screen.getByRole('button', { name: 'Review and finalize' }))
    let finishFirst!: (value: SessionRecord) => void
    apiMock.spawn
      .mockImplementationOnce(() => new Promise<SessionRecord>((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce({ error: 'Claude sign-in expired' })

    await fireEvent.click(screen.getByRole('button', { name: 'Launch project with team' }))

    // The second request is in flight before the first one settles: launch is genuinely concurrent.
    await vi.waitFor(() => expect(apiMock.spawn).toHaveBeenCalledTimes(2))
    finishFirst(record('session-1'))
    expect(apiMock.spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({
      projectId: project.id,
      profileId: 'codex-main',
      prompt: expect.stringContaining('Scope: Implementation'),
      role: 'Implementation',
    }))
    expect(apiMock.spawn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      projectId: project.id,
      profileId: 'claude-review',
      prompt: expect.stringContaining('Review the result.'),
    }))
    expect(await screen.findByText(/1 team member started; 1 did not/)).toBeTruthy()
    expect(screen.getByText(/Claude sign-in expired/)).toBeTruthy()
    expect(onlaunched).toHaveBeenCalledWith(expect.objectContaining({
      project,
      started: [expect.objectContaining({ sessionId: 'session-1' })],
      failed: [expect.objectContaining({ error: 'Claude sign-in expired' })],
    }))

    apiMock.spawn.mockResolvedValueOnce(record('session-2', 'claude-review'))
    await fireEvent.click(screen.getByRole('button', { name: 'Retry failed team member' }))

    await vi.waitFor(() => expect(apiMock.spawn).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('All 2 team members started.')).toBeTruthy()
    expect(onlaunched).toHaveBeenLastCalledWith(expect.objectContaining({
      project,
      failed: [],
      started: expect.arrayContaining([
        expect.objectContaining({ sessionId: 'session-1' }),
        expect.objectContaining({ sessionId: 'session-2' }),
      ]),
    }))
  })

  it('keeps manager setup inside the one project dialog and still allows a project with no agents', async () => {
    const onlaunched = vi.fn()
    render(NewProjectModal, { onclose: vi.fn(), onlaunched })
    await createLocalProject()

    await fireEvent.click(screen.getByRole('button', { name: 'Configure a project manager' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'New project' }).contains(
      screen.getByLabelText('Manager account'),
    )).toBe(true)

    await fireEvent.click(screen.getByRole('button', { name: 'Review and finalize' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Create project without agents' }))

    expect(apiMock.spawn).not.toHaveBeenCalled()
    expect(onlaunched).toHaveBeenCalledWith({ project, started: [], failed: [] })
  })

  it('defers the embedded manager until Launch and retries configuration without spawning a duplicate', async () => {
    const onlaunched = vi.fn()
    render(NewProjectModal, { onclose: vi.fn(), onlaunched })
    await createLocalProject()

    await fireEvent.click(screen.getByRole('button', { name: 'Configure a project manager' }))
    expect(apiMock.spawn).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Add to project launch' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Review and finalize' }))

    const manager = { ...record('manager-session'), title: `${project.name} manager` }
    const configured = { ...manager, isProjectManager: true }
    apiMock.spawn.mockResolvedValueOnce(manager)
    apiMock.configureProjectManager
      .mockResolvedValueOnce({ error: 'Manager policy could not be saved' })
      .mockResolvedValueOnce(configured)

    await fireEvent.click(screen.getByRole('button', { name: 'Launch project with team' }))

    expect(await screen.findByText(/0 team members started; 1 did not/)).toBeTruthy()
    expect(apiMock.spawn).toHaveBeenCalledTimes(1)
    expect(apiMock.configureProjectManager).toHaveBeenCalledWith(
      'manager-session',
      expect.objectContaining({
        enabled: true,
        startingPrompt: expect.stringMatching(/Control room/i),
      }),
    )
    expect(onlaunched).toHaveBeenLastCalledWith(expect.objectContaining({
      project,
      failed: [expect.objectContaining({ agentId: 'project-manager' })],
    }))

    await fireEvent.click(screen.getByRole('button', { name: 'Retry failed team member' }))

    expect(await screen.findByText('All 1 team member started.')).toBeTruthy()
    expect(apiMock.spawn).toHaveBeenCalledTimes(1)
    expect(apiMock.send).toHaveBeenCalledWith('manager-session', expect.stringMatching(/Control room/i))
    expect(onlaunched).toHaveBeenLastCalledWith(expect.objectContaining({
      project,
      failed: [],
      started: [expect.objectContaining({ agentId: 'project-manager', sessionId: 'manager-session' })],
    }))
  })

  it('allows a managed team and an independent batch together without parenting the batch to the manager', async () => {
    const onlaunched = vi.fn()
    render(NewProjectModal, { onclose: vi.fn(), onlaunched })
    await createLocalProject()

    await fireEvent.click(screen.getByRole('button', { name: 'Configure a project manager' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Add to project launch' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Add starting agent' }))
    await fireEvent.input(screen.getByLabelText('Starting prompt 1'), {
      target: { value: 'Run this independent task.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Review and finalize' }))

    expect(screen.getByText(/WITH A MANAGER · DELEGATED TEAM/)).toBeTruthy()
    expect(screen.getByText(/INDEPENDENT AGENTS · NO MANAGER/)).toBeTruthy()

    const independent = record('independent-session')
    const manager = { ...record('manager-session'), title: `${project.name} manager` }
    const configuredManager = { ...manager, isProjectManager: true }
    apiMock.spawn.mockImplementation((body: Record<string, unknown>) =>
      Promise.resolve(body.prompt ? independent : manager))
    apiMock.configureProjectManager.mockResolvedValue(configuredManager)

    await fireEvent.click(screen.getByRole('button', { name: 'Launch project with team' }))

    await vi.waitFor(() => expect(apiMock.spawn).toHaveBeenCalledTimes(2))
    const independentCall = apiMock.spawn.mock.calls.find(([body]) => body.prompt)?.[0]
    const managerCall = apiMock.spawn.mock.calls.find(([body]) => !body.prompt)?.[0]
    expect(independentCall).toEqual(expect.objectContaining({
      projectId: project.id,
      prompt: 'Run this independent task.',
    }))
    expect(independentCall).not.toHaveProperty('parentSessionId')
    expect(managerCall).toEqual(expect.objectContaining({
      projectId: project.id,
      useWorktree: false,
    }))
    expect(managerCall).not.toHaveProperty('parentSessionId')
    await vi.waitFor(() =>
      expect(onlaunched).toHaveBeenLastCalledWith(expect.objectContaining({
        failed: [],
        started: expect.arrayContaining([
          expect.objectContaining({ sessionId: 'independent-session' }),
          expect.objectContaining({ agentId: 'project-manager', sessionId: 'manager-session' }),
        ]),
      })))
  })

  it('collapses completed steps into editable summaries without losing team input', async () => {
    render(NewProjectModal, { onclose: vi.fn(), onlaunched: vi.fn() })
    await createLocalProject()

    await fireEvent.click(screen.getByRole('button', { name: 'Add starting agent' }))
    await fireEvent.input(screen.getByLabelText('Starting prompt 1'), {
      target: { value: 'Keep this task when I review the plan.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Review and finalize' }))

    const prompt = screen.getByLabelText('Starting prompt 1') as HTMLTextAreaElement
    expect(prompt.closest('.team-content')?.hasAttribute('hidden')).toBe(true)
    expect(screen.getByText(/1 independent agent/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Edit team setup' }))
    expect(prompt.closest('.team-content')?.hasAttribute('hidden')).toBe(false)
    expect(prompt.value).toBe('Keep this task when I review the plan.')
  })
})
