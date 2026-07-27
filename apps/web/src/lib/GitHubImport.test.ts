import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GitHubImport from './GitHubImport.svelte'
import type { GitHubCloneJob, GitHubRepository, ProjectInfo } from './api'

const apiMock = vi.hoisted(() => ({
  githubCapability: vi.fn(),
  githubRepositories: vi.fn(),
  startGitHubClone: vi.fn(),
  githubClone: vi.fn(),
}))

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, api: apiMock }
})

const repository: GitHubRepository = {
  nameWithOwner: 'octo/example',
  name: 'example',
  description: 'A useful repository',
  private: true,
  archived: false,
  defaultBranch: 'main',
  updatedAt: '2026-07-27T12:00:00Z',
  supported: true,
}

const cloning: GitHubCloneJob = {
  id: 'job-1',
  repository: { nameWithOwner: repository.nameWithOwner, name: repository.name, private: true },
  status: 'cloning',
  progress: { stage: 'cloning', percent: 42, message: 'Receiving 42%' },
  createdAt: '2026-07-27T12:00:00Z',
  updatedAt: '2026-07-27T12:00:01Z',
}

beforeEach(() => {
  for (const mock of Object.values(apiMock)) mock.mockReset()
})

afterEach(() => cleanup())

describe('GitHubImport', () => {
  it('does not request repositories when GitHub is unavailable and keeps the local path available', async () => {
    apiMock.githubCapability.mockResolvedValue({
      available: false,
      reason: 'GitHub import is not available because GitHub CLI is not installed.',
    })

    render(GitHubImport, { props: { onImported: vi.fn(), onClose: vi.fn() } })

    expect(await screen.findByText(/GitHub CLI is not installed/)).toBeTruthy()
    expect(screen.getByText(/still add any local folder above/)).toBeTruthy()
    expect(apiMock.githubRepositories).not.toHaveBeenCalled()
  })

  it('shows clone progress and hands the completed project back to the project flow', async () => {
    const project: ProjectInfo = {
      id: 'project-1',
      name: 'example',
      path: 'C:/AllMyAgents/repositories/octo/example',
      createdAt: '2026-07-27T12:00:02Z',
    }
    const onImported = vi.fn()
    apiMock.githubCapability.mockResolvedValue({ available: true })
    apiMock.githubRepositories.mockResolvedValue([repository])
    apiMock.startGitHubClone.mockResolvedValue(cloning)
    apiMock.githubClone.mockResolvedValue({
      ...cloning,
      status: 'complete',
      progress: { stage: 'complete', percent: 100, message: 'Repository ready.' },
      project,
    })

    render(GitHubImport, { props: { onImported, onClose: vi.fn() } })
    await fireEvent.click(await screen.findByTitle('Clone octo/example'))

    expect(await screen.findByText('Receiving 42%')).toBeTruthy()
    await vi.waitFor(() => expect(onImported).toHaveBeenCalledWith(project), { timeout: 1500 })
  })

  it('surfaces a failed clone and never reports a project', async () => {
    const onImported = vi.fn()
    apiMock.githubCapability.mockResolvedValue({ available: true })
    apiMock.githubRepositories.mockResolvedValue([repository])
    apiMock.startGitHubClone.mockResolvedValue(cloning)
    apiMock.githubClone.mockResolvedValue({
      ...cloning,
      status: 'failed',
      error: 'network connection was interrupted',
    })

    render(GitHubImport, { props: { onImported, onClose: vi.fn() } })
    await fireEvent.click(await screen.findByTitle('Clone octo/example'))

    expect(await screen.findByText('network connection was interrupted', {}, { timeout: 1500 })).toBeTruthy()
    expect(onImported).not.toHaveBeenCalled()
  })
})
