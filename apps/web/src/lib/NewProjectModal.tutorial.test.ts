import { cleanup, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NewProjectModal from './NewProjectModal.svelte'
import { store } from './store.svelte'

const apiMock = vi.hoisted(() => ({
  validateProject: vi.fn(),
  createProject: vi.fn(),
  createManagedProject: vi.fn(),
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

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
})

beforeEach(() => {
  vi.clearAllMocks()
  store.projects = []
  store.profiles = [
    { id: 'codex-main', provider: 'codex' },
    { id: 'claude-review', provider: 'claude' },
  ]
})

afterEach(() => cleanup())

describe('New Project tutorial dry run', () => {
  it('walks the actual pipeline fields without materializing anything', async () => {
    const onclose = vi.fn()
    const onlaunched = vi.fn()
    const view = render(NewProjectModal, {
      onclose,
      onlaunched,
      tutorialStep: 0,
    })

    expect(screen.getByLabelText('Project name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clone a GitHub repository' })).toBeTruthy()

    await view.rerender({ onclose, onlaunched, tutorialStep: 2 })
    expect((await screen.findByLabelText('Starting prompt 1') as HTMLTextAreaElement).value).toBe(
      'Investigate the first task and report what you find.',
    )
    expect((screen.getByLabelText('Scope 1') as HTMLTextAreaElement).value).toBe(
      'A focused part of the project',
    )
    expect(screen.getByText('Use a worktree')).toBeTruthy()

    await view.rerender({ onclose, onlaunched, tutorialStep: 4 })
    expect((await screen.findByLabelText('Enable a project manager') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Manager permission level')).toBeTruthy()
    expect(screen.getByText('Live child limit')).toBeTruthy()
    expect(screen.getByText('Agent types')).toBeTruthy()

    await view.rerender({ onclose, onlaunched, tutorialStep: 5 })
    expect(await screen.findByRole('heading', { name: 'Finalize' })).toBeTruthy()
    expect(screen.getByText(/Project manager · codex-main/)).toBeTruthy()
    expect(screen.getByText(/INDEPENDENT AGENTS · NO MANAGER/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Dry run complete — nothing created' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    await view.rerender({ onclose, onlaunched, tutorialStep: undefined })
    expect((await screen.findByLabelText('Project name') as HTMLInputElement).value).toBe('')
    expect(screen.queryByLabelText('Starting prompt 1')).toBeNull()

    expect(apiMock.validateProject).not.toHaveBeenCalled()
    expect(apiMock.createProject).not.toHaveBeenCalled()
    expect(apiMock.createManagedProject).not.toHaveBeenCalled()
    expect(apiMock.startGitHubClone).not.toHaveBeenCalled()
    expect(apiMock.spawn).not.toHaveBeenCalled()
    expect(apiMock.configureProjectManager).not.toHaveBeenCalled()
    expect(onlaunched).not.toHaveBeenCalled()
  })
})
