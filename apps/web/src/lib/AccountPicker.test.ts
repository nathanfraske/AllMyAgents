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
})
