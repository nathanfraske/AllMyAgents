import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsModal from './SettingsModal.svelte'
import { store } from './store.svelte'

const loginMocks = vi.hoisted(() => ({
  login: vi.fn(() => new Promise(() => {})),
  loginStatus: vi.fn(),
  loginForProfile: vi.fn(),
  cancelLogin: vi.fn(() => Promise.resolve({ ok: true, status: 'settling' })),
}))

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
        if (property === 'login') return loginMocks.login
        if (property === 'loginStatus') return loginMocks.loginStatus
        if (property === 'loginForProfile') return loginMocks.loginForProfile
        if (property === 'cancelLogin') return loginMocks.cancelLogin
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

afterEach(() => {
  cleanup()
  store.profiles = []
  loginMocks.login.mockReset()
  loginMocks.login.mockImplementation(() => new Promise(() => {}))
  loginMocks.loginStatus.mockReset()
  loginMocks.loginForProfile.mockReset()
  loginMocks.cancelLogin.mockReset()
  loginMocks.cancelLogin.mockResolvedValue({ ok: true, status: 'settling' })
})

describe('tutorial account waiting integration', () => {
  it('offers a clickable re-authentication action before failure for every account', async () => {
    store.profiles = [
      { id: 'claude-signed-out', provider: 'claude', available: true, authStatus: 'signed_out' },
      { id: 'codex-healthy', provider: 'codex', available: true, authStatus: 'signed_in' },
    ]
    render(SettingsModal, {
      props: {
        onclose: () => {},
        initialTab: 'accounts',
      },
    })

    const signedOut = screen.getByRole('button', { name: 'Sign in again' })
    expect(signedOut).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Re-authenticate codex-healthy' })).toBeTruthy()

    await fireEvent.click(signedOut)
    expect(loginMocks.login).toHaveBeenCalledWith(
      'claude',
      'claude-signed-out',
      true,
      expect.any(String),
    )
  })

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
    expect(
      screen.getByText(
        'Cancelling as soon as the durable sign-in attempt is confirmed…',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/Sign-in cancelled/)).toBeNull()
  })

  it('accepts capturing without a URL, shows settling, and waits for terminal cancellation truth', async () => {
    loginMocks.login.mockResolvedValue({
      ok: true,
      loginId: 'public-1',
      profileId: 'claude-capturing',
      provider: 'claude',
      status: 'capturing',
    })
    loginMocks.loginStatus.mockResolvedValue({
      ok: false,
      loginId: 'public-1',
      profileId: 'claude-capturing',
      provider: 'claude',
      status: 'cancelled',
      error: 'Prior credential restored.',
    })
    loginMocks.loginForProfile.mockResolvedValue({
      ok: false,
      loginId: 'public-1',
      profileId: 'claude-capturing',
      provider: 'claude',
      status: 'cancelled',
      error: 'Prior credential restored.',
    })
    render(SettingsModal, {
      props: {
        onclose: () => {},
        initialTab: 'accounts',
      },
    })
    await fireEvent.input(screen.getByPlaceholderText('profile name (e.g. claude-work)'), {
      target: { value: 'claude-capturing' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    expect(
      await screen.findByText('Waiting for the sign-in page from the provider…'),
    ).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open sign-in page' })).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.getByText('Cancelling sign-in and restoring credential state safely…'),
    ).toBeTruthy()
    expect(loginMocks.cancelLogin).toHaveBeenCalledWith('public-1')

    expect(await screen.findByText('Prior credential restored.', {}, { timeout: 2_000 })).toBeTruthy()
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
