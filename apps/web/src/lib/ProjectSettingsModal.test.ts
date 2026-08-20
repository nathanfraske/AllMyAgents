import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectSettingsModal from './ProjectSettingsModal.svelte'
import { store } from './store.svelte'

const apiMock = vi.hoisted(() => ({
  projectGitHubAutomation: vi.fn(),
  setProjectGitHubAutomation: vi.fn(),
  updateProject: vi.fn(),
}))

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})
beforeEach(() => {
  store.projects = [{
    id: 'project-1',
    name: 'Demo',
    path: 'C:/repo',
    createdAt: '2026-08-05T00:00:00.000Z',
  }]
  store.sessions = {}
  store.profiles = []
  apiMock.projectGitHubAutomation.mockReset().mockResolvedValue({
    scope: 'project',
    targetId: 'project-1',
    capabilities: ['pull_requests'],
    updatedAt: '2026-08-05T00:00:00.000Z',
  })
  apiMock.setProjectGitHubAutomation.mockReset().mockImplementation(
    async (id: string, capabilities: string[]) => ({
      scope: 'project', targetId: id, capabilities, updatedAt: '2026-08-05T01:00:00.000Z',
    }),
  )
  apiMock.updateProject.mockReset()
})

afterEach(cleanup)

describe('project GitHub automation settings', () => {
  it('shows the inherited team-wide policy and persists an explicit capability change', async () => {
    render(ProjectSettingsModal, { props: { projectId: 'project-1', onclose: vi.fn() } })
    await fireEvent.click(screen.getByRole('button', { name: 'Automation' }))

    const pullRequests = await screen.findByRole('checkbox', { name: /Pull-request work/i })
    expect((pullRequests as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/Generic shell commands/)).toBeTruthy()

    const workflows = screen.getByRole('checkbox', { name: /GitHub Actions runs/i })
    await fireEvent.click(workflows)
    await fireEvent.click(screen.getByRole('button', { name: 'Save GitHub automation' }))

    expect(apiMock.setProjectGitHubAutomation).toHaveBeenCalledWith(
      'project-1',
      ['pull_requests', 'workflow_runs'],
    )
    expect(await screen.findByText('GitHub automation policy saved.')).toBeTruthy()
  })

  it('grants every supported GitHub operation to the whole project team in one choice', async () => {
    apiMock.projectGitHubAutomation.mockResolvedValue({
      scope: 'project', targetId: 'project-1', capabilities: [], updatedAt: '',
    })
    render(ProjectSettingsModal, { props: { projectId: 'project-1', onclose: vi.fn() } })
    await fireEvent.click(screen.getByRole('button', { name: 'Automation' }))

    await fireEvent.click(await screen.findByRole('checkbox', { name: /All GitHub automation/i }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save GitHub automation' }))

    expect(apiMock.setProjectGitHubAutomation).toHaveBeenCalledWith('project-1', [
      'pull_requests',
      'pull_request_merges',
      'workflow_runs',
      'repository_pushes',
    ])
  })
})
