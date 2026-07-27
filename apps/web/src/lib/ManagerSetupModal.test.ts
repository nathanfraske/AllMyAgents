import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/svelte'
import ManagerSetupModal from './ManagerSetupModal.svelte'
import { store, type SessionView } from './store.svelte'
import type { SessionRecord } from './api'

const { configureProjectManager, spawn } = vi.hoisted(() => ({
  configureProjectManager: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      configureProjectManager,
      spawn,
      rename: vi.fn(async () => ({ ok: true })),
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
  store.projects = [{ id: 'project-1', name: 'Demo project', path: 'C:/repo', createdAt: '2026-07-27T00:00:00.000Z' }]
  store.profiles = [
    { id: 'codex-a', provider: 'codex' },
    { id: 'claude-a', provider: 'claude' },
  ]
  store.sessions = { existing: session('existing', 'Existing chat') }
  store.managerSetupSessionId = 'existing'
})

describe('Manager setup', () => {
  it('explains the role, required scope, and own-child visibility before granting', () => {
    const { getByText, getAllByText } = render(ManagerSetupModal, { onclose: vi.fn() })
    expect(getByText(/spawns and oversees other agents on your behalf/i)).toBeTruthy()
    expect(getAllByText('Project')).toHaveLength(2)
    expect(getByText('Worker accounts & models')).toBeTruthy()
    expect(getByText('Live child limit')).toBeTruthy()
    expect(getByText(/its own children, and only those/i)).toBeTruthy()
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
})
