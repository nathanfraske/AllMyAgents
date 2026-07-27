import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NewProjectModal from './NewProjectModal.svelte'
import { store } from './store.svelte'
import type { ProjectInfo, SessionRecord } from './api'

const apiMock = vi.hoisted(() => ({
  createProject: vi.fn(),
  pickFolder: vi.fn(),
  spawn: vi.fn(),
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
})

afterEach(() => cleanup())

describe('New project pipeline', () => {
  it('creates a local project, keeps its completed summary visible, and advances to the team', async () => {
    render(NewProjectModal, {
      onclose: vi.fn(),
      onlaunched: vi.fn(),
      onconfiguremanager: vi.fn(),
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
      onconfiguremanager: vi.fn(),
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Clone a GitHub repository' }))

    expect(await screen.findByText(/GitHub CLI is not signed in/)).toBeTruthy()
    expect(screen.getByText(/still add any local folder above/i)).toBeTruthy()
  })

  it('launches every configured agent concurrently, reports a partial failure, and retries only the failure', async () => {
    const onlaunched = vi.fn()
    render(NewProjectModal, {
      onclose: vi.fn(),
      onlaunched,
      onconfiguremanager: vi.fn(),
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
    expect(await screen.findByText(/1 agent started; 1 did not/)).toBeTruthy()
    expect(screen.getByText(/Claude sign-in expired/)).toBeTruthy()
    expect(onlaunched).toHaveBeenCalledWith(expect.objectContaining({
      project,
      started: [expect.objectContaining({ sessionId: 'session-1' })],
      failed: [expect.objectContaining({ error: 'Claude sign-in expired' })],
    }))

    apiMock.spawn.mockResolvedValueOnce(record('session-2', 'claude-review'))
    await fireEvent.click(screen.getByRole('button', { name: 'Retry failed agent' }))

    await vi.waitFor(() => expect(apiMock.spawn).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('All 2 agents started.')).toBeTruthy()
    expect(onlaunched).toHaveBeenLastCalledWith(expect.objectContaining({
      project,
      failed: [],
      started: expect.arrayContaining([
        expect.objectContaining({ sessionId: 'session-1' }),
        expect.objectContaining({ sessionId: 'session-2' }),
      ]),
    }))
  })

  it('allows a project with no agents and hands manager setup the created project', async () => {
    const onlaunched = vi.fn()
    const onconfiguremanager = vi.fn()
    render(NewProjectModal, { onclose: vi.fn(), onlaunched, onconfiguremanager })
    await createLocalProject()

    await fireEvent.click(screen.getByRole('button', { name: 'Configure a project manager' }))
    expect(onconfiguremanager).toHaveBeenCalledWith(project)

    await fireEvent.click(screen.getByRole('button', { name: 'Review and finalize' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Create project without agents' }))

    expect(apiMock.spawn).not.toHaveBeenCalled()
    expect(onlaunched).toHaveBeenCalledWith({ project, started: [], failed: [] })
  })

  it('stays mounted but inert while the manager setup hand-off is on top', async () => {
    const onclose = vi.fn()
    render(NewProjectModal, {
      onclose,
      onlaunched: vi.fn(),
      onconfiguremanager: vi.fn(),
      suspended: true,
    })

    expect(document.querySelector('[role="dialog"][aria-label="New project"]')?.getAttribute('aria-hidden')).toBe('true')
    await fireEvent.keyDown(window, { key: 'Escape' })
    expect(onclose).not.toHaveBeenCalled()
  })
})
