import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsModal from './SettingsModal.svelte'
import { store } from './store.svelte'

const loginMocks = vi.hoisted(() => ({
  login: vi.fn(() => new Promise(() => {})),
  loginStatus: vi.fn(),
  loginForProfile: vi.fn(),
  cancelLogin: vi.fn(() => Promise.resolve({ ok: true, status: 'settling' })),
  rescanProfiles: vi.fn((): Promise<unknown> => Promise.resolve([])),
  renameProfile: vi.fn(),
  overseer: vi.fn(() => Promise.resolve({ configured: false, available: false })),
  configureOverseer: vi.fn(),
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
        if (property === 'rescanProfiles') return loginMocks.rescanProfiles
        if (property === 'renameProfile') return loginMocks.renameProfile
        if (property === 'overseer') return loginMocks.overseer
        if (property === 'configureOverseer') return loginMocks.configureOverseer
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
  vi.useRealTimers()
  cleanup()
  store.profiles = []
  loginMocks.login.mockReset()
  loginMocks.login.mockImplementation(() => new Promise(() => {}))
  loginMocks.loginStatus.mockReset()
  loginMocks.loginForProfile.mockReset()
  loginMocks.cancelLogin.mockReset()
  loginMocks.cancelLogin.mockResolvedValue({ ok: true, status: 'settling' })
  loginMocks.rescanProfiles.mockReset()
  loginMocks.rescanProfiles.mockResolvedValue([])
  loginMocks.renameProfile.mockReset()
  loginMocks.overseer.mockReset()
  loginMocks.overseer.mockResolvedValue({ configured: false, available: false })
  loginMocks.configureOverseer.mockReset()
})

describe('tutorial account waiting integration', () => {
  it('renames only the account display label and keeps the immutable id visible', async () => {
    store.profiles = [
      { id: 'claude-a', displayName: 'Old name', provider: 'claude', available: true, authStatus: 'signed_in' },
    ]
    loginMocks.renameProfile.mockResolvedValue({
      id: 'claude-a',
      displayName: 'Research Claude',
      provider: 'claude',
      available: true,
      authStatus: 'signed_in',
    })
    render(SettingsModal, {
      props: { onclose: () => {}, initialTab: 'accounts' },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Rename Old name' }))
    const input = screen.getByRole('textbox', { name: 'Account display name for claude-a' })
    await fireEvent.input(input, { target: { value: 'Research Claude' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save account name' }))

    expect(loginMocks.renameProfile).toHaveBeenCalledWith('claude-a', 'Research Claude')
    expect(screen.getByText('Research Claude')).toBeTruthy()
    expect(screen.getByText('ID: claude-a')).toBeTruthy()
    expect(store.profiles[0]).toMatchObject({ id: 'claude-a', displayName: 'Research Claude' })
  })

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
      expect.anything(),
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

  it('keeps the whole-attempt deadline active while cancellation is settling', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'))
    loginMocks.login.mockResolvedValue({
      ok: true,
      loginId: 'public-cancel-timeout',
      profileId: 'claude-cancel-timeout',
      provider: 'claude',
      status: 'capturing',
    })
    loginMocks.loginStatus.mockResolvedValue({
      ok: true,
      loginId: 'public-cancel-timeout',
      profileId: 'claude-cancel-timeout',
      provider: 'claude',
      status: 'settling',
    })
    render(SettingsModal, {
      props: {
        onclose: () => {},
        initialTab: 'accounts',
      },
    })
    await fireEvent.input(screen.getByPlaceholderText('profile name (e.g. claude-work)'), {
      target: { value: 'claude-cancel-timeout' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    vi.setSystemTime(new Date('2026-07-31T12:10:01.000Z'))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(
      screen.getByText('Sign-in timed out and cancellation was requested. Retry when you are ready.'),
    ).toBeTruthy()
  })

  it('finishes a durable login even when the bounded account refresh fails', async () => {
    loginMocks.login.mockResolvedValue({
      ok: true,
      loginId: 'public-complete',
      profileId: 'codex-bounded',
      provider: 'codex',
      status: 'complete',
      added: 'codex-bounded',
    })
    loginMocks.rescanProfiles.mockResolvedValue({ error: 'request timed out' })
    render(SettingsModal, {
      props: {
        onclose: () => {},
        initialTab: 'accounts',
      },
    })
    await fireEvent.input(screen.getByPlaceholderText('profile name (e.g. claude-work)'), {
      target: { value: 'codex-bounded' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    expect(
      await screen.findByText('Added codex-bounded. The account list will refresh automatically.'),
    ).toBeTruthy()
  })

  it('unblocks a completed login even if account presentation never returns', async () => {
    loginMocks.login.mockResolvedValue({
      ok: true,
      loginId: 'public-complete-pending-scan',
      profileId: 'claude-responsive',
      provider: 'claude',
      status: 'complete',
      added: 'claude-responsive',
    })
    loginMocks.rescanProfiles.mockImplementation(() => new Promise(() => {}))
    render(SettingsModal, {
      props: {
        onclose: () => {},
        initialTab: 'accounts',
      },
    })
    await fireEvent.input(screen.getByPlaceholderText('profile name (e.g. claude-work)'), {
      target: { value: 'claude-responsive' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    expect(
      await screen.findByText('Added claude-responsive. It now appears in your accounts.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'waiting…' })).toBeNull()
  })

  it('offers deliberate replay actions from Settings', async () => {
    const replayFirst = vi.fn()
    const replayApp = vi.fn()
    const replayProject = vi.fn()
    render(SettingsModal, {
      props: {
        onclose: () => {},
        initialTab: 'system',
        onreplayfirst: replayFirst,
        onreplayapptour: replayApp,
        onreplayproject: replayProject,
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Set up account + Overseer' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Explore the app tour' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Explain New Project' }))

    expect(replayFirst).toHaveBeenCalledOnce()
    expect(replayApp).toHaveBeenCalledOnce()
    expect(replayProject).toHaveBeenCalledOnce()
  })

  it('finishes short onboarding only after the selected Overseer is created', async () => {
    store.profiles = [
      { id: 'claude-guide', provider: 'claude', available: true, authStatus: 'signed_in' },
    ]
    loginMocks.configureOverseer.mockResolvedValue({
      configured: true,
      profileId: 'claude-guide',
      sessionId: 'overseer-guide',
      available: true,
    })
    const configured = vi.fn()
    const close = vi.fn()
    render(SettingsModal, {
      props: {
        onclose: close,
        initialTab: 'system',
        onoverseerconfigured: configured,
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Create Overseer' }))

    expect(loginMocks.configureOverseer).toHaveBeenCalledWith('claude-guide')
    expect(configured).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})
