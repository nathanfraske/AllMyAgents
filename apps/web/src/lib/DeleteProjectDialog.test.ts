import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import DeleteProjectDialog from './DeleteProjectDialog.svelte'
import type { ProjectDeletionInspection, ProjectInfo } from './api'

const apiMock = vi.hoisted(() => ({
  inspectProjectDeletion: vi.fn(),
}))

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

const project: ProjectInfo = {
  id: 'project-1',
  name: 'Alpha',
  path: 'C:/work/alpha',
  createdAt: '2026-07-27T12:00:00.000Z',
}

const inspection: ProjectDeletionInspection = {
  projectId: project.id,
  projectPath: project.path,
  sessions: [
    {
      id: 'session-1',
      title: 'Bose',
      status: 'idle',
      cwd: 'C:/worktrees/bose',
    },
  ],
  changes: [
    {
      kind: 'uncommitted',
      path: 'C:/work/alpha/src/changed.ts',
      checkoutPath: project.path,
    },
    {
      kind: 'untracked',
      path: 'C:/worktrees/bose/notes.txt',
      checkoutPath: 'C:/worktrees/bose',
      sessionId: 'session-1',
    },
  ],
  localCommits: [
    {
      hash: 'abcdef1234567890',
      subject: 'local agent result',
      checkoutPath: 'C:/worktrees/bose',
      sessionId: 'session-1',
    },
  ],
  worktrees: [
    {
      sessionId: 'session-1',
      title: 'Bose',
      path: 'C:/worktrees/bose',
      branch: 'agent/bose',
      status: 'idle',
    },
  ],
  inspectionErrors: [],
}

beforeEach(() => {
  apiMock.inspectProjectDeletion.mockReset().mockResolvedValue(inspection)
})

afterEach(() => cleanup())

describe('DeleteProjectDialog', () => {
  it('names recoverable work and makes record-only deletion the safe default', async () => {
    const ondelete = vi.fn(async () => ({ ok: true as const }))
    render(DeleteProjectDialog, { project, onclose: vi.fn(), ondelete })

    expect(await screen.findByText('C:/work/alpha/src/changed.ts')).toBeTruthy()
    expect(screen.getByText('C:/worktrees/bose/notes.txt')).toBeTruthy()
    expect(screen.getByText(/local agent result/)).toBeTruthy()
    expect(screen.getAllByText('C:/worktrees/bose')).toHaveLength(2)
    expect(screen.getByText(/keeps every file and worktree/i)).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Remove from AllMyAgents' }))
    await waitFor(() => expect(ondelete).toHaveBeenCalledWith(false))
  })

  it('requires a separate acknowledgement for destructive file deletion and surfaces refusal', async () => {
    const ondelete = vi.fn(async () => ({ ok: false as const, error: 'agent is still shutting down' }))
    render(DeleteProjectDialog, { project, onclose: vi.fn(), ondelete })
    await screen.findByText('C:/work/alpha/src/changed.ts')

    const destructive = screen.getByRole('button', { name: 'Delete project and files' })
    expect((destructive as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(screen.getByRole('checkbox'))
    expect((destructive as HTMLButtonElement).disabled).toBe(false)
    await fireEvent.click(destructive)

    expect(await screen.findByText(/agent is still shutting down/i)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(ondelete).toHaveBeenCalledWith(true)
  })
})
