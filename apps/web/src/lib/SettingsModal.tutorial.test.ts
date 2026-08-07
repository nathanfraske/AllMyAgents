import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverseerStatus } from './api'
import SettingsModal from './SettingsModal.svelte'
import { store } from './store.svelte'
import { TutorialController } from './tutorialState.svelte'

const loginMocks = vi.hoisted(() => ({
  login: vi.fn(() => new Promise(() => {})),
  loginStatus: vi.fn(),
  loginForProfile: vi.fn(),
  cancelLogin: vi.fn(() => Promise.resolve({ ok: true, status: 'settling' })),
  rescanProfiles: vi.fn((): Promise<unknown> => Promise.resolve([])),
  renameProfile: vi.fn(),
  overseer: vi.fn(() => Promise.resolve({ configured: false, available: false } as OverseerStatus)),
  configureOverseer: vi.fn(),
  setOverseerMode: vi.fn(),
  openExternalUrl: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('./externalUrl', () => ({
  prepareExternalTarget: () => ({ popup: null }),
  closePreparedTarget: () => {},
  openExternalUrl: loginMocks.openExternalUrl,
}))

// Exercise the desktop branch. The regression existed only in Tauri: the web fallback opened the URL,
// while the desktop path incorrectly assumed the piped Codex CLI had already done so.
vi.mock('./window', () => ({ inTauri: true }))

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
        if (property === 'setOverseerMode') return loginMocks.setOverseerMode
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
  loginMocks.setOverseerMode.mockReset()
  loginMocks.openExternalUrl.mockReset()
  loginMocks.openExternalUrl.mockResolvedValue(true)
})

describe('tutorial account waiting integration', () => {
  it('persists a reusable Tokenmaxxing policy and reports immediate injection', async () => {
    loginMocks.overseer.mockResolvedValue({
      configured: true,
      available: true,
      sessionId: 'overseer',
      operatingMode: 'standard',
      modePolicies: {},
    })
    loginMocks.setOverseerMode.mockResolvedValue({
      configured: true,
      available: true,
      sessionId: 'overseer',
      operatingMode: 'tokenmaxxing',
      policy: {
        guidance: 'Use capacity resetting soon.',
        ideaPool: ['Audit recovery', 'Review permissions'],
        maxParallelAgents: 9,
        preferredEffort: 'high',
      },
      modePolicies: {
        tokenmaxxing: {
          guidance: 'Use capacity resetting soon.',
          ideaPool: ['Audit recovery', 'Review permissions'],
          maxParallelAgents: 9,
          preferredEffort: 'high',
        },
      },
    })
    render(SettingsModal, { props: { onclose: () => {}, initialTab: 'system' } })

    const modeGroup = await screen.findByRole('group', { name: 'Operating mode' })
    await fireEvent.change(within(modeGroup).getByLabelText('Mode'), { target: { value: 'tokenmaxxing' } })
    await fireEvent.input(within(modeGroup).getByLabelText('Maximum parallel agents'), { target: { value: '9' } })
    await fireEvent.input(within(modeGroup).getByLabelText('Your definition of this mode'), {
      target: { value: 'Use capacity resetting soon.' },
    })
    await fireEvent.input(within(modeGroup).getByLabelText(/Preset idea pool/), {
      target: { value: 'Audit recovery\nReview permissions' },
    })
    await fireEvent.click(within(modeGroup).getByRole('button', { name: 'Save operating mode' }))

    expect(loginMocks.setOverseerMode).toHaveBeenCalledWith({
      operatingMode: 'tokenmaxxing',
      guidance: 'Use capacity resetting soon.',
      ideaPool: ['Audit recovery', 'Review permissions'],
      maxParallelAgents: 9,
      preferredEffort: 'high',
    })
    expect(await screen.findByText('Mode saved and injected into the current Overseer.')).toBeTruthy()
  })

  it('mirrors a rendered sign-in into tutorial state without recursively retriggering its effect', async () => {
    const tutorial = new TutorialController(null)
    const mirrored: string[] = []

    render(SettingsModal, {
      props: {
        onclose: () => {},
        initialTab: 'accounts',
        onloginstate: (view) => {
          mirrored.push(view.status)
          // Fail quickly and legibly if the self-triggering effect ever returns instead of allowing the
          // test renderer to spin until Vitest's global timeout.
          if (mirrored.length > 20) throw new Error('tutorial login mirror did not converge')
          tutorial.setLogin(view)
        },
      },
    })
    await fireEvent.input(screen.getByPlaceholderText('profile name (e.g. claude-work)'), {
      target: { value: 'claude-render-loop-regression' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    await vi.waitFor(() => expect(tutorial.login.status).toBe('waiting'))
    await tick()
    const convergedAt = mirrored.length
    await tick()

    expect(mirrored.length).toBe(convergedAt)
    expect(mirrored).toContain('waiting')
    expect(convergedAt).toBeLessThan(20)
  })

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
      'browser',
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

  it('defaults Codex to browser sign-in and unlocks immediately after a failed device attempt', async () => {
    loginMocks.login
      .mockResolvedValueOnce({
        ok: false,
        loginId: 'public-device-failed',
        profileId: 'codex-login-method',
        provider: 'codex',
        authMode: 'device',
        status: 'failed',
        error: 'Enable device code authorization in ChatGPT Security Settings.',
      })
      .mockResolvedValueOnce({
        ok: true,
        loginId: 'public-browser-complete',
        profileId: 'codex-login-method',
        provider: 'codex',
        authMode: 'browser',
        status: 'complete',
        added: 'codex-login-method',
      })

    render(SettingsModal, {
      props: { onclose: () => {}, initialTab: 'accounts' },
    })
    await fireEvent.change(screen.getByRole('combobox', { name: 'Account provider' }), {
      target: { value: 'codex' },
    })
    const method = screen.getByRole('combobox', { name: 'Codex sign-in method' })
    expect((method as HTMLSelectElement).value).toBe('browser')
    await fireEvent.change(method, { target: { value: 'device' } })
    await fireEvent.input(screen.getByRole('textbox', { name: 'Profile name' }), {
      target: { value: 'codex-login-method' },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByText(/Enable device code authorization/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Log in' }).hasAttribute('disabled')).toBe(false)

    await fireEvent.change(method, { target: { value: 'browser' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByText(/Added codex-login-method/)).toBeTruthy()
    expect(loginMocks.login.mock.calls[0]?.slice(0, 5)).toEqual([
      'codex',
      'codex-login-method',
      false,
      expect.any(String),
      'device',
    ])
    expect(loginMocks.login.mock.calls[1]?.slice(0, 5)).toEqual([
      'codex',
      'codex-login-method',
      false,
      expect.any(String),
      'browser',
    ])
  })

  it('opens a captured Codex browser OAuth URL through the desktop opener', async () => {
    loginMocks.login.mockResolvedValue({
      ok: true,
      loginId: 'public-browser-waiting',
      profileId: 'codex-browser-open',
      provider: 'codex',
      authMode: 'browser',
      status: 'waiting',
      url: 'https://auth.openai.com/oauth/authorize?client_id=ama-test',
    })
    loginMocks.loginStatus.mockImplementation(() => new Promise(() => {}))

    render(SettingsModal, {
      props: { onclose: () => {}, initialTab: 'accounts' },
    })
    await fireEvent.change(screen.getByRole('combobox', { name: 'Account provider' }), {
      target: { value: 'codex' },
    })
    await fireEvent.input(screen.getByRole('textbox', { name: 'Profile name' }), {
      target: { value: 'codex-browser-open' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    await vi.waitFor(() => {
      expect(loginMocks.openExternalUrl).toHaveBeenCalledWith(
        'https://auth.openai.com/oauth/authorize?client_id=ama-test',
        { popup: null },
      )
    })
    expect(await screen.findByText(/Waiting for you to finish in the browser/)).toBeTruthy()
  })

  it('uses browser OAuth for one-click Codex re-auth even after device mode was selected', async () => {
    store.profiles = [
      { id: 'codex-reauth', provider: 'codex', available: true, authStatus: 'signed_in' },
    ]
    loginMocks.login.mockResolvedValue({
      ok: false,
      loginId: 'public-reauth-failed',
      profileId: 'codex-reauth',
      provider: 'codex',
      authMode: 'browser',
      status: 'failed',
      error: 'test terminal state',
    })

    render(SettingsModal, {
      props: { onclose: () => {}, initialTab: 'accounts' },
    })
    await fireEvent.change(screen.getByRole('combobox', { name: 'Account provider' }), {
      target: { value: 'codex' },
    })
    await fireEvent.change(screen.getByRole('combobox', { name: 'Codex sign-in method' }), {
      target: { value: 'device' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate codex-reauth' }))

    expect(loginMocks.login).toHaveBeenCalledWith(
      'codex',
      'codex-reauth',
      true,
      expect.any(String),
      'browser',
      expect.anything(),
    )
  })

  it('shows the Codex device code in the app with an explicit copy action', async () => {
    loginMocks.login.mockResolvedValue({
      ok: true,
      loginId: 'public-device-waiting',
      profileId: 'codex-device-code',
      provider: 'codex',
      authMode: 'device',
      status: 'waiting',
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-EFGHJ',
    })
    loginMocks.loginStatus.mockImplementation(() => new Promise(() => {}))

    render(SettingsModal, {
      props: { onclose: () => {}, initialTab: 'accounts' },
    })
    await fireEvent.change(screen.getByRole('combobox', { name: 'Account provider' }), {
      target: { value: 'codex' },
    })
    await fireEvent.change(screen.getByRole('combobox', { name: 'Codex sign-in method' }), {
      target: { value: 'device' },
    })
    await fireEvent.input(screen.getByRole('textbox', { name: 'Profile name' }), {
      target: { value: 'codex-device-code' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    expect(await screen.findByText('ABCD-EFGHJ')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open sign-in page' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy Codex device code' })).toBeTruthy()
    expect(screen.getByText(/not entered in a terminal or chat/i)).toBeTruthy()
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
