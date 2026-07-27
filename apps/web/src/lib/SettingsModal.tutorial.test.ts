import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsModal from './SettingsModal.svelte'

vi.mock('./externalUrl', () => ({
  prepareExternalTarget: () => null,
  closePreparedTarget: () => {},
  openExternalUrl: () => Promise.resolve(true),
}))

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  const fallback = () => Promise.resolve([])
  return {
    ...actual,
    api: new Proxy({} as typeof actual.api, {
      get: (_target, property) => {
        if (property === 'login') return () => new Promise(() => {})
        if (property === 'cancelLogin') return () => Promise.resolve({ ok: true })
        if (property === 'mesh') {
          return () => Promise.resolve({
            enabled: false,
            available: false,
            online: false,
            ips: [],
            requireToken: false,
          })
        }
        if (property === 'danger') {
          return () => Promise.resolve({
            disableWorktreeCollisionWarnings: false,
            busCanUseRiskyTools: false,
            autoApprovePractices: false,
            autoApproveRestart: false,
            enableClaudeConnectors: false,
            fullAccessAnyOrigin: false,
          })
        }
        return fallback
      },
    }),
  }
})

afterEach(() => cleanup())

describe('tutorial account waiting integration', () => {
  it('offers Cancel before the hub has returned a browser URL', async () => {
    render(SettingsModal, {
      props: {
        onclose: () => {},
        initialTab: 'accounts',
      },
    })

    await fireEvent.input(screen.getByPlaceholderText('profile name (e.g. claude-work)'), {
      target: { value: 'codex-tutorial-test' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    expect(screen.getByRole('button', { name: 'waiting…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Sign-in cancelled. No account was added.')).toBeTruthy()
  })

  it('offers deliberate replay actions from Settings', async () => {
    const replayFirst = vi.fn()
    const replayProject = vi.fn()
    render(SettingsModal, {
      props: {
        onclose: () => {},
        initialTab: 'system',
        onreplayfirst: replayFirst,
        onreplayproject: replayProject,
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Show getting started tutorial' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Explain New Project' }))

    expect(replayFirst).toHaveBeenCalledOnce()
    expect(replayProject).toHaveBeenCalledOnce()
  })
})
