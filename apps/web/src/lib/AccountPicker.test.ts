import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import AccountPicker from './AccountPicker.svelte'
import { store, type SessionView } from './store.svelte'
import type { SessionRecord } from './api'

vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: new Proxy({} as Record<string, unknown>, { get: () => () => Promise.resolve([]) }),
  }
})

const importedView: SessionView = {
  record: {
    id: 'imported-1',
    profileId: 'claude-default',
    provider: 'claude',
    cwd: 'C:/work',
    status: 'idle',
    imported: true,
    createdAt: '2026-07-27T00:00:00.000Z',
  } as SessionRecord,
  items: [],
  lastActivity: '2026-07-27T00:00:00.000Z',
  sawReasoning: false,
}

beforeEach(() => {
  store.profiles = []
  store.projects = []
  store.settingsOpen = false
})

afterEach(() => cleanup())

describe('AccountPicker first run', () => {
  it('explains how to add the first account without presenting a vendor home as one', async () => {
    render(AccountPicker, { props: { view: importedView } })

    expect(screen.getByRole('button', { name: /add account/i })).toBeDefined()
    expect(screen.queryByText('claude-default')).toBeNull()

    await fireEvent.click(screen.getByRole('button', { name: /add account/i }))
    expect(screen.getByText(/no accounts yet/i)).toBeDefined()

    await fireEvent.click(screen.getByRole('button', { name: /open settings/i }))
    expect(store.settingsOpen).toBe(true)
  })

  it('explains why a live manager account cannot be silently ported from its embedded project view', async () => {
    store.profiles = [
      { id: 'claude-default', provider: 'claude' },
      { id: 'claude-other', provider: 'claude' },
    ]
    const managerView: SessionView = {
      ...importedView,
      record: { ...importedView.record, imported: false, isProjectManager: true },
    }
    const useAccount = vi.spyOn(store, 'useAccount')

    render(AccountPicker, { props: { view: managerView } })
    await fireEvent.click(screen.getByRole('button', { name: /claude-default/i }))

    expect(screen.getByText('Account locked')).toBeTruthy()
    expect(screen.getByText(/transfer its live role and team.*preserving this vendor thread as a snapshot/i)).toBeTruthy()
    expect(screen.queryByText('claude-other')).toBeNull()
    expect(useAccount).not.toHaveBeenCalled()
    useAccount.mockRestore()
  })

  it('shows a remote account name and hub label instead of its fleet transport id', async () => {
    const siteId = 'qgn6mgozk2d52l2ftnxmchyoaz6oubynxsnvwjwzueckpy5gj27g'
    store.profiles = [{
      id: `${siteId}:codex-b`,
      provider: 'codex',
      siteId,
      siteLabel: 'gdual',
    }]
    store.projects = [{
      id: `${siteId}:project-1`,
      name: 'Remote Project',
      path: 'C:/remote/project',
      createdAt: '2026-08-08T12:00:00.000Z',
      siteId,
      siteLabel: 'gdual',
    }]
    const remoteView: SessionView = {
      ...importedView,
      record: {
        ...importedView.record,
        id: `${siteId}:session-1`,
        profileId: `${siteId}:codex-b`,
        provider: 'codex',
        projectId: `${siteId}:project-1`,
        siteId,
        siteLabel: 'gdual',
      },
    }

    render(AccountPicker, { props: { view: remoteView } })

    const trigger = screen.getByRole('button', { name: /codex-b/i })
    expect(trigger.textContent).toContain('codex-b')
    expect(trigger.textContent).not.toContain(siteId)

    await fireEvent.click(trigger)
    expect(screen.getByText('codex · gdual')).toBeTruthy()
  })
})
