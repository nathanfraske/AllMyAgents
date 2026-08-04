<script lang="ts">
  import { store } from './store.svelte'
  import { settings } from './settings.svelte'
  import { api, getFleetSiteToken, type DeviceExecutorCapabilities, type DeviceRootPolicy, type MeshStatus, type Instruction, type Practice, type DangerFlags, type HubPrefs, type OverseerStatus } from './api'
  import ProviderLogo from './ProviderLogo.svelte'
  import Icon from './Icon.svelte'
  import { modelsFor } from './catalog'
  import { updater, updatesSupported } from './updater.svelte'
  import { countLiveUpdateTurns } from './updateSafety'
  import {
    closePreparedTarget,
    openExternalUrl,
    prepareExternalTarget,
    type PreparedExternalTarget,
  } from './externalUrl'
  import { inTauri } from './window'
  import type { AccountLoginView } from './tutorialState.svelte'
  import { profileLabel, profileOptionLabel } from './profileLabel'
  import {
    loadSettingsTab,
    saveSettingsTab,
    settingsTabHasSection,
    SETTINGS_TABS,
    type SettingsTabId,
  } from './settingsSections'

  let {
    onclose,
    initialTab,
    onloginstate = () => {},
    onoverseerconfigured = () => {},
    onreplayfirst = () => {},
    onreplayapptour = () => {},
    onreplayproject = () => {},
  }: {
    onclose: () => void
    initialTab?: SettingsTabId
    onloginstate?: (view: AccountLoginView) => void
    onoverseerconfigured?: () => void
    onreplayfirst?: () => void
    onreplayapptour?: () => void
    onreplayproject?: () => void
  } = $props()
  let writeError = $state('')
  let activeTab = $state<SettingsTabId>(loadSettingsTab())
  const localProfiles = $derived(store.profiles.filter((profile) => !profile.siteId))
  const localProjects = $derived(store.projects.filter((project) => !project.siteId))
  const updateLiveTurns = $derived(countLiveUpdateTurns(store.sessions))
  let waitForUpdateIdle = $state(false)
  let overseerStatus = $state<OverseerStatus | null>(null)
  let overseerProfileId = $state('')
  let overseerBusy = $state(false)
  let overseerError = $state('')

  $effect(() => {
    void api.overseer().then((value) => {
      overseerStatus = value
      if (value.profileId) overseerProfileId = value.profileId
    }).catch((error) => (overseerError = error instanceof Error ? error.message : String(error)))
  })
  $effect(() => {
    if (!overseerProfileId) overseerProfileId = localProfiles.find((profile) => profile.available !== false && profile.authStatus !== 'signed_out')?.id ?? ''
  })

  async function configureOverseer(): Promise<void> {
    if (!overseerProfileId) return
    overseerBusy = true
    overseerError = ''
    try {
      const value = await api.configureOverseer(overseerProfileId)
      if ('error' in value) {
        overseerError = value.error
        return
      }
      overseerStatus = value
      if (value.sessionId) {
        onoverseerconfigured()
        onclose()
        store.select(value.sessionId)
      }
    } catch (error) {
      overseerError = error instanceof Error ? error.message : String(error)
    } finally {
      overseerBusy = false
    }
  }

  $effect(() => {
    if (waitForUpdateIdle && updateLiveTurns === 0 && !updater.busy) {
      waitForUpdateIdle = false
      void updater.install()
    }
  })

  $effect(() => {
    if (initialTab) activeTab = initialTab
  })

  function selectTab(tabId: SettingsTabId): void {
    activeTab = tabId
    saveSettingsTab(tabId)
  }

  // Mesh remote-access status (loaded once; refreshed after a toggle).
  let mesh = $state<MeshStatus | null>(null)
  let meshBusy = $state(false)
  $effect(() => {
    void api.mesh().then((m) => (mesh = m))
  })
  async function toggleMesh(on: boolean): Promise<void> {
    meshBusy = true
    try {
      const result = await api.setMesh(on)
      if ('enabled' in result) {
        mesh = result
        writeError = ''
      } else writeError = result.error
    } finally {
      meshBusy = false
    }
  }
  let fleetTokenDrafts = $state<Record<string, string>>({})
  let fleetPairBusy = $state('')
  let fleetPairError = $state<Record<string, string>>({})
  async function pairFleetSite(siteId: string): Promise<void> {
    fleetPairBusy = siteId
    const ok = await store.pairFleetSite(siteId, fleetTokenDrafts[siteId] ?? '')
    fleetPairError = { ...fleetPairError, [siteId]: ok ? '' : 'Pairing failed. Create a fresh pairing code on that machine, or use its legacy device token.' }
    if (ok) fleetTokenDrafts = { ...fleetTokenDrafts, [siteId]: '' }
    fleetPairBusy = ''
  }

  // Target-side testbed policy. Pairing never enables this: the operator must select exact local roots
  // and capabilities here before any approved chat on another hub can use them.
  let deviceExecutor = $state<DeviceExecutorCapabilities | null>(null)
  let deviceRoots = $state<DeviceRootPolicy[]>([])
  let deviceEnabled = $state(false)
  let deviceBusy = $state(false)
  let deviceError = $state('')
  let deviceSaved = $state(false)
  let deviceWslDistro = $state('')
  let deviceWslPath = $state('/home')
  $effect(() => {
    void api.deviceExecutor().then((value) => {
      deviceExecutor = value
      deviceEnabled = value.enabled
      deviceRoots = value.roots
      if (!deviceWslDistro) deviceWslDistro = value.environments?.find((environment) => environment.kind === 'wsl')?.distro ?? ''
    }).catch((error) => (deviceError = error instanceof Error ? error.message : String(error)))
  })
  async function addDeviceRoot(): Promise<void> {
    const picked = await api.pickFolder()
    if (!picked?.path) return
    const label = picked.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? picked.path
    if (deviceRoots.some((root) => root.path.toLocaleLowerCase() === picked.path.toLocaleLowerCase())) return
    deviceRoots = [...deviceRoots, { id: '', label, path: picked.path, read: true, write: false, terminal: false }]
  }
  function addDeviceWslRoot(): void {
    const distro = deviceWslDistro.trim()
    const linuxPath = deviceWslPath.trim()
    if (!distro || !linuxPath.startsWith('/')) {
      deviceError = 'Choose a WSL distro and enter an absolute Linux path.'
      return
    }
    if (deviceRoots.some((root) => root.environment?.kind === 'wsl' && root.environment.distro === distro && root.path === linuxPath)) return
    const label = linuxPath.split('/').filter(Boolean).at(-1) ?? `${distro} root`
    deviceRoots = [...deviceRoots, {
      id: '', label: `${label} (${distro})`, path: linuxPath, environment: { kind: 'wsl', distro },
      read: true, write: false, terminal: false,
    }]
    deviceError = ''
  }
  function patchDeviceRoot(index: number, patch: Partial<DeviceRootPolicy>): void {
    deviceRoots = deviceRoots.map((root, rootIndex) => rootIndex === index ? { ...root, ...patch } : root)
  }
  async function saveDevicePolicy(): Promise<void> {
    deviceBusy = true
    deviceError = ''
    try {
      const value = await api.setDeviceExecutor(deviceEnabled, deviceRoots)
      if ('error' in value) {
        deviceError = value.error
        return
      }
      deviceExecutor = value
      deviceEnabled = value.enabled
      deviceRoots = value.roots
      deviceSaved = true
      setTimeout(() => (deviceSaved = false), 1400)
    } catch (error) {
      deviceError = error instanceof Error ? error.message : String(error)
    } finally {
      deviceBusy = false
    }
  }

  // Operator profile + scoped instructions.
  let instructions = $state<Instruction[]>([])
  let instrScope = $state('global')
  let instrContent = $state('')
  let instrSaved = $state(false)
  $effect(() => {
    void api.instructions().then((list) => (instructions = list))
  })
  $effect(() => {
    const scope = instrScope
    instrContent = instructions.find((i) => i.scope === scope)?.content ?? ''
  })
  async function saveInstructions(): Promise<void> {
    const result = await api.setInstructions(instrScope, instrContent)
    if ('error' in result) {
      writeError = result.error
      return
    }
    instructions = result
    writeError = ''
    instrSaved = true
    setTimeout(() => (instrSaved = false), 1400)
  }

  // Danger Zone — safe-default guardrail toggles + the agent-authored practices review list. Kept
  // collapsed behind an explicit reveal so it's never flipped by accident. Both toggles default OFF.
  let dangerRevealed = $state(false)
  let danger = $state<DangerFlags>({ disableWorktreeCollisionWarnings: false, busCanUseRiskyTools: false, autoApprovePractices: false, autoApproveRestart: false, enableClaudeConnectors: false, fullAccessAnyOrigin: false })
  let practices = $state<Practice[]>([])
  $effect(() => {
    void api.danger().then((d) => (danger = d))
  })
  $effect(() => {
    void api.practices().then((p) => (practices = p)).catch(() => (practices = []))
  })
  async function setDanger(patch: Partial<DangerFlags>): Promise<void> {
    const result = await api.setDanger(patch)
    if ('error' in result) writeError = result.error
    else {
      danger = result
      writeError = ''
    }
  }
  async function revokePractice(id: string): Promise<void> {
    await api.revokePractice(id)
    // jget throws on a hub error now, and this runs after a revoke — a failed refresh must not take the
    // whole Settings modal down with it; the list simply stays as it was.
    practices = await api.practices().catch(() => practices)
  }
  function practiceProvenance(p: Practice): string {
    const bits: string[] = []
    if (p.fromProfile) bits.push(p.fromProfile)
    if (p.fromSession) bits.push(`session ${p.fromSession.slice(0, 8)}`)
    bits.push(new Date(p.updatedAt).toLocaleDateString())
    return bits.join(' · ')
  }

  // Operator "Restart hub" (Maintenance). The authenticated operator action IS its own approval, so
  // no danger gate. Happy path returns 202 {accepted}; the hub blue-green flips in ~1s and the web
  // client auto-reconnects, so no reload. Unsupervised (plain) hubs return 503 {error}.
  let restartState = $state<'idle' | 'restarting' | 'error'>('idle')
  let restartMsg = $state('')
  async function restartHub(): Promise<void> {
    restartState = 'restarting'
    restartMsg = 'restarting… (the app reconnects automatically)'
    const r = await api.restartHub()
    if ('error' in r) {
      restartState = 'error'
      restartMsg = r.error
    } else {
      // Accepted — hold the inline notice ~3s while the flip + auto-reconnect happen, then clear.
      setTimeout(() => {
        if (restartState === 'restarting') {
          restartState = 'idle'
          restartMsg = ''
        }
      }, 3000)
    }
  }

  let uninstallBusy = $state(false)
  let uninstallError = $state('')
  let removeUserData = $state(false)
  async function uninstallMac(): Promise<void> {
    const consequence = removeUserData
      ? 'This removes the app, all chats and settings, and every saved Claude and Codex login. This cannot be undone.'
      : 'This removes the app and its regenerable hub files. Your chats, settings, and saved Claude and Codex logins will be kept.'
    if (!confirm(`${consequence}\n\nContinue?`)) return
    const invoke = (globalThis as { __TAURI__?: { core?: { invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> } } }).__TAURI__?.core?.invoke
    if (!invoke) return
    uninstallBusy = true
    uninstallError = ''
    try {
      await invoke<void>('uninstall_macos', { removeUserData })
    } catch (error) {
      uninstallError = error instanceof Error ? error.message : String(error)
      uninstallBusy = false
    }
  }

  let revealToken = $state(false)
  let revealedToken = $state('')
  let copied = $state(false)
  let pairingCode = $state('')
  let pairingExpiresAt = $state('')
  let pairingBusy = $state(false)
  let pairingError = $state('')
  let pairingCopied = $state(false)
  async function issuePairingCode(): Promise<void> {
    pairingBusy = true
    pairingError = ''
    try {
      const result = await api.issuePairingCode()
      if (result.error || !result.code || !result.expiresAt) {
        pairingError = result.error || 'Could not create a pairing code'
        return
      }
      pairingCode = result.code
      pairingExpiresAt = result.expiresAt
      const issuedCode = result.code
      const remainingMs = Math.max(0, Date.parse(result.expiresAt) - Date.now())
      setTimeout(() => {
        if (pairingCode !== issuedCode) return
        pairingCode = ''
        pairingExpiresAt = ''
      }, remainingMs)
    } catch (error) {
      pairingError = error instanceof Error ? error.message : String(error)
    } finally {
      pairingBusy = false
    }
  }
  async function copyPairingCode(): Promise<void> {
    if (!pairingCode) return
    try {
      await navigator.clipboard.writeText(pairingCode)
      pairingCopied = true
      setTimeout(() => (pairingCopied = false), 1400)
    } catch {
      /* ignore */
    }
  }
  async function loadDeviceToken(): Promise<string> {
    if (revealedToken) return revealedToken
    const result = await api.revealDeviceToken()
    if ('error' in result || !result.token) {
      writeError =
        ('error' in result && result.error) || 'Could not reveal device token'
      return ''
    }
    revealedToken = result.token
    writeError = ''
    return revealedToken
  }
  async function toggleTokenReveal(): Promise<void> {
    if (revealToken) {
      revealToken = false
      return
    }
    revealToken = Boolean(await loadDeviceToken())
  }
  async function copyToken(t: string | undefined): Promise<void> {
    if (!t) return
    try {
      await navigator.clipboard.writeText(t)
      copied = true
      setTimeout(() => (copied = false), 1400)
    } catch {
      /* ignore */
    }
  }

  let addProvider = $state<'claude' | 'codex'>('claude')
  let addName = $state('')
  let rescanning = $state(false)
  let renamingProfileId = $state('')
  let profileNameDraft = $state('')
  let profileNameBusy = $state(false)
  let profileNameError = $state('')

  function beginProfileRename(profileId: string): void {
    const profile = store.profiles.find((candidate) => candidate.id === profileId)
    if (!profile) return
    renamingProfileId = profileId
    profileNameDraft = profile.displayName ?? profile.id
    profileNameError = ''
  }

  function cancelProfileRename(): void {
    renamingProfileId = ''
    profileNameDraft = ''
    profileNameError = ''
  }

  async function saveProfileName(profileId: string, reset = false): Promise<void> {
    profileNameBusy = true
    profileNameError = ''
    try {
      const result = await api.renameProfile(profileId, reset ? '' : profileNameDraft)
      if ('error' in result) {
        profileNameError = result.error
        return
      }
      store.profiles = store.profiles.map((profile) =>
        profile.id === result.id ? { ...profile, ...result } : profile,
      )
      cancelProfileRename()
    } catch (error) {
      profileNameError = error instanceof Error ? error.message : String(error)
    } finally {
      profileNameBusy = false
    }
  }

  type LoginUiState =
    | 'idle'
    | 'capturing'
    | 'waiting'
    | 'settling'
    | 'done'
    | 'error'
    | 'cancelled'
  let loginState = $state<LoginUiState>('idle')
  let loginMsg = $state('')
  let loginId = $state('')
  let loginRequestKey = $state('')
  let loginUrl = $state('')
  let loginCode = $state('')
  let loginStartedAt = $state<number | undefined>()
  let loginRequestCancelled = false
  let loginCancelSent = false
  let loginAttemptController: AbortController | undefined

  // OAuth itself may legitimately take a while, but the UI must never poll forever. Per-request calls
  // remain bounded to eight seconds; this is the independent ceiling for the complete attempt.
  const LOGIN_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000

  const loginActive = (): boolean =>
    loginState === 'capturing' ||
    loginState === 'waiting' ||
    loginState === 'settling'

  function tutorialLoginStatus(): AccountLoginView['status'] {
    if (
      loginState === 'capturing' ||
      loginState === 'waiting' ||
      loginState === 'settling'
    ) {
      return 'waiting'
    }
    return loginState
  }

  $effect(() => {
    onloginstate({
      status: tutorialLoginStatus(),
      provider: addProvider,
      startedAt: loginStartedAt,
      message: loginMsg,
    })
  })

  async function rescan(): Promise<void> {
    rescanning = true
    const result = await store.rescanProfiles()
    if (result.error) {
      loginState = 'error'
      loginMsg = result.error
    } else {
      writeError = ''
    }
    rescanning = false
  }

  async function setPrefs(patch: Partial<HubPrefs>): Promise<void> {
    const result = await store.setPrefs(patch)
    writeError = result.error ?? ''
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  function createLoginRequestKey(): string {
    return (
      globalThis.crypto?.randomUUID?.() ??
      `web-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
  }

  async function openLoginUrl(
    result: Awaited<ReturnType<typeof api.loginStatus>>,
    target: PreparedExternalTarget,
  ): Promise<void> {
    if (!result.url || result.url === loginUrl) return
    loginUrl = result.url
    loginCode = result.code ?? ''
    // Claude 2.1.218 has no no-browser flag and opens the captured URL itself. In the local desktop
    // shell, opening it again would create two tabs; remote/plain-browser clients still use the app
    // opener because the hub-side browser may not exist or may be on another machine.
    const opened =
      addProvider === 'claude' && inTauri
        ? true
        : await openExternalUrl(result.url, target)
    loginMsg = opened
      ? 'Waiting for you to finish in the browser…'
      : 'The browser could not be opened automatically. Use “Open sign-in page” below, then finish there.'
  }

  async function finishLogin(
    initial: Awaited<ReturnType<typeof api.login>>,
    name: string,
    requestKey: string,
    target: PreparedExternalTarget,
    signal: AbortSignal,
  ): Promise<void> {
    let result = initial
    const id = result.loginId
    if (!id) return
    loginId = id
    while (loginId === id) {
      if (loginStartedAt && Date.now() - loginStartedAt >= LOGIN_ATTEMPT_TIMEOUT_MS) {
        loginRequestCancelled = true
        if (!loginCancelSent) {
          loginCancelSent = true
          await api.cancelLogin(id)
        }
        closePreparedTarget(target)
        loginState = 'error'
        loginStartedAt = undefined
        loginMsg = 'Sign-in timed out and cancellation was requested. Retry when you are ready.'
        loginId = ''
        loginRequestKey = ''
        return
      }
      // Cancellation is a lifecycle transition, not a property of the provider's current branch.
      // Check it before dispatching on status so complete/error races cannot strand a dead Cancel button.
      if (loginRequestCancelled && !loginCancelSent) {
        loginCancelSent = true
        result = await api.cancelLogin(id)
        continue
      }
      if (
        result.status === 'capturing' ||
        result.status === 'waiting' ||
        result.status === 'settling'
      ) {
        loginState = result.status
        if (result.status === 'capturing') {
          loginMsg = 'Waiting for the sign-in page from the provider…'
        } else if (result.status === 'settling') {
          loginMsg = loginRequestCancelled
            ? 'Cancelling sign-in and restoring the prior credential safely…'
            : 'Finishing credential recovery safely…'
        }
        await openLoginUrl(result, target)
        await delay(1_000)
        result = await api.loginStatus(id, signal)
        if (!result || 'error' in result) {
          const recovered = await api.loginForProfile(name, requestKey, signal)
          if (!recovered || 'error' in recovered) {
            loginMsg =
              'The hub is reconnecting. This sign-in attempt is still tracked and will be recovered automatically.'
            continue
          }
          result = recovered
        }
        continue
      }
      if (result.status === 'complete' && result.ok) {
        // The credential is already durable. Roster presentation is best-effort: ProfileRuntime also
        // publishes profiles/added on the live stream, so an HTTP refresh failure must not turn a
        // successful login into an endless spinner or a false "signed out" state. Complete the modal
        // FIRST and refresh in the background: the old awaited rescan left the blocking account UI in
        // "waiting" even after the provider and hub had both finished successfully.
        loginState = 'done'
        loginStartedAt = undefined
        loginMsg = `Added ${result.added ?? name}. It now appears in your accounts.`
        loginId = ''
        loginRequestKey = ''
        loginUrl = ''
        loginCode = ''
        addName = ''
        queueMicrotask(() => {
          void store.rescanProfiles().then((scan) => {
            if (scan.error) {
              loginMsg = `Added ${result.added ?? name}. The account list will refresh automatically.`
            }
          }).catch(() => {
            loginMsg = `Added ${result.added ?? name}. The account list will refresh automatically.`
          })
        })
        return
      }
      loginState = result.status === 'cancelled' ? 'cancelled' : 'error'
      loginStartedAt = undefined
      loginMsg =
        result.error ??
        (result.status === 'cancelled'
          ? 'Sign-in was cancelled after the prior credential was restored.'
          : 'Sign-in ended before the account was added. Retry or use Rescan accounts.')
      loginId = ''
      loginRequestKey = ''
      return
    }
  }

  // The hub captures OAuth while the desktop shell owns opening the browser. A plain browser reserves
  // a tab synchronously so popup blocking cannot turn the delayed URL handoff into a silent no-op.
  async function login(reauth = false): Promise<void> {
    const name = addName.trim()
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      loginState = 'error'
      loginMsg = 'Enter a profile name first (letters, numbers, dashes or underscores).'
      return
    }
    const target = prepareExternalTarget()
    loginRequestCancelled = false
    loginCancelSent = false
    loginAttemptController?.abort()
    loginAttemptController = new AbortController()
    const signal = loginAttemptController.signal
    loginState = 'settling'
    loginStartedAt = Date.now()
    loginMsg = `Preparing ${addProvider === 'claude' ? 'Claude' : 'Codex'} sign-in safely…`
    loginId = ''
    loginRequestKey = createLoginRequestKey()
    loginUrl = ''
    loginCode = ''
    try {
      let r = await api.login(addProvider, name, reauth, loginRequestKey, signal)
      if (!r.loginId) {
        const recovered = await api.loginForProfile(name, loginRequestKey, signal)
        if (recovered.loginId) r = recovered
      }
      if (!r.loginId) {
        closePreparedTarget(target)
        loginState = 'error'
        loginMsg =
          r.error ??
          'The hub could not confirm a durable sign-in attempt. No successful sign-in was assumed.'
        return
      }
      await finishLogin(r, name, loginRequestKey, target, signal)
    } catch (e) {
      closePreparedTarget(target)
      loginState = 'error'
      loginStartedAt = undefined
      loginMsg =
        e instanceof Error
          ? e.message
          : 'Sign-in status could not be verified. No successful sign-in or cancellation was assumed.'
      loginId = ''
    }
  }

  function reauthenticate(profile: (typeof store.profiles)[number]): void {
    addProvider = profile.provider
    addName = profile.id
    void login(true)
  }

  async function cancelActiveLogin(): Promise<void> {
    loginRequestCancelled = true
    const id = loginId
    loginState = 'settling'
    // Keep the original whole-attempt clock alive while cancellation settles. Clearing it here made a
    // provider that never acknowledged cancellation poll forever—the exact terminal branch Cancel is
    // supposed to escape.
    loginMsg = id
      ? 'Cancelling sign-in and restoring credential state safely…'
      : 'Cancelling as soon as the durable sign-in attempt is confirmed…'
    if (id && !loginCancelSent) {
      loginCancelSent = true
      await api.cancelLogin(id)
    }
  }

  function closeModal(): void {
    loginRequestCancelled = true
    loginAttemptController?.abort()
    if (loginId) void api.cancelLogin(loginId)
    onclose()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') closeModal()
  }

  // --- Auto monthly budget from subscription level -------------------------------------
  // Monthly USD budget per known subscription tier. Deliberately simple, documented anchors
  // (edit to taste): the entry "Pro" / "Plus" tier ≈ $20, Claude Max 5× ≈ $100, Max 20× ≈ $200.
  // Keyed by the tier string (normalised to lowercase alphanumerics) as it appears in the live
  // usage snapshot. The Max* keys are only reachable if a usage source ever reports such a tier
  // string — Claude accounts today expose only session/week percentages, no dollar tier.
  const PLAN_BUDGETS: Record<string, number> = {
    free: 0,
    plus: 20, // ChatGPT Plus
    pro: 20, // Claude Pro / ChatGPT entry "Pro"
    team: 30,
    business: 30,
    enterprise: 60,
    max: 100, max5: 100, max5x: 100, // Claude Max 5×
    max20: 200, max20x: 200, // Claude Max 20×
  }
  // When a tier can't be read (Claude, or an unknown Codex plan), assume the entry tier and flag it.
  const FALLBACK_USD = 20
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

  let autoResult = $state<{ total: number; lines: string[]; assumed: number } | null>(null)

  // Sum a monthly budget across the user's accounts from live usage data — entirely client-side.
  // Codex accounts carry `codex.planType` (e.g. "pro"); Claude accounts have no dollar tier.
  function autoDetectBudget(): void {
    if (localProfiles.length === 0) {
      autoResult = { total: 0, lines: ['No accounts detected yet — add one above, then try again.'], assumed: 0 }
      return
    }
    let total = 0
    let assumed = 0
    const lines: string[] = []
    for (const p of localProfiles) {
      const snap = store.usage.find((u) => u.profileId === p.id)
      // `planType` is present on Codex snapshots but isn't in the web UsageSnapshot type — read it safely.
      const planType = (snap?.codex as { planType?: string } | undefined)?.planType
      if (p.provider === 'codex' && planType && norm(planType) in PLAN_BUDGETS) {
        const usd = PLAN_BUDGETS[norm(planType)]!
        total += usd
        lines.push(`${profileLabel(p)}: ${planType} → $${usd}/mo`)
      } else {
        total += FALLBACK_USD
        assumed++
        const why = p.provider === 'claude' ? 'Claude tier not in usage data' : planType ? `unknown plan "${planType}"` : 'no usage data yet'
        lines.push(`${profileLabel(p)}: ${why} → assumed $${FALLBACK_USD}/mo`)
      }
    }
    settings.setBudget(total || null)
    autoResult = { total, lines, assumed }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="button" tabindex="-1" onclick={closeModal} onkeydown={() => {}}></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="Settings">
  <div class="head">
    <h2>Settings</h2>
    <button class="btn-icon" onclick={closeModal} aria-label="close"><Icon name="x" size={17} /></button>
  </div>

  <div class="settings-layout">
    <div class="tabs" role="tablist" aria-label="Settings areas" aria-orientation="vertical">
      {#each SETTINGS_TABS as tab (tab.id)}
        <button
          class="tab"
          class:active={activeTab === tab.id}
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls="settings-pane"
          onclick={() => selectTab(tab.id)}
        >{tab.label}</button>
      {/each}
    </div>

    <div class="body" id="settings-pane" role="tabpanel">
    {#if writeError}<p class="status error write-error">{writeError}</p>{/if}
    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Accounts')} data-overseer-anchor="accounts">
      <h3>Accounts</h3>
      <div class="accounts">
        {#each localProfiles as p (p.id)}
          <div class="account-wrap">
            <div class="acct" class:signed-out={p.authStatus === 'signed_out'} class:unavailable={p.available === false}>
              <ProviderLogo provider={p.provider} size={14} />
              <span class="account-identity">
                <span class="aid">{profileLabel(p)}</span>
                {#if p.displayName}<span class="profile-id dim">ID: {p.id}</span>{/if}
              </span>
              <span class="aprov dim">{p.provider}</span>
              {#if p.authStatus === 'signed_out'}
                <span class="status error" title={p.authError}>Signed out</span>
              {/if}
              {#if p.available === false}
                <span class="status error" title={p.unavailableReason}>
                  In use by another hub{p.ownerPort ? ` (port ${p.ownerPort})` : ''}
                </span>
              {/if}
              <button class="btn" aria-label={`Rename ${profileLabel(p)}`} onclick={() => beginProfileRename(p.id)}>Rename</button>
              <button
                class="btn"
                class:btn-primary={p.authStatus === 'signed_out'}
                aria-label={p.authStatus === 'signed_out' ? 'Sign in again' : `Re-authenticate ${profileLabel(p)}`}
                onclick={() => reauthenticate(p)}
                disabled={loginActive()}
              >{p.authStatus === 'signed_out' ? 'Sign in again' : 'Re-authenticate'}</button>
            </div>
            {#if renamingProfileId === p.id}
              <div class="rename-account">
                <label>
                  <span>Account display name</span>
                  <input aria-label={`Account display name for ${p.id}`} bind:value={profileNameDraft} maxlength="80" />
                </label>
                <button class="btn btn-primary" aria-label="Save account name" disabled={profileNameBusy || !profileNameDraft.trim()} onclick={() => saveProfileName(p.id)}>Save</button>
                {#if p.displayName}<button class="btn" disabled={profileNameBusy} onclick={() => saveProfileName(p.id, true)}>Use ID</button>{/if}
                <button class="btn" disabled={profileNameBusy} onclick={cancelProfileRename}>Cancel</button>
                {#if profileNameError}<p class="status error" role="alert">{profileNameError}</p>{/if}
                <p class="hint dim">Only the displayed name changes. The stable ID <code>{p.id}</code> continues to own credentials, chats, grants, usage, and instructions.</p>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <div class="add" data-tutorial-anchor="account-sign-in">
        <div class="add-row">
          <select bind:value={addProvider} disabled={loginActive()}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <input placeholder="profile name (e.g. claude-work)" bind:value={addName} disabled={loginActive()} />
          <button class="btn btn-primary" onclick={() => login(false)} disabled={loginActive()}>
            {loginActive() ? 'waiting…' : 'Log in'}
          </button>
        </div>
        {#if loginState !== 'idle'}
          <p class="status {loginState}">{loginMsg}</p>
        {/if}
        {#if loginUrl}
          <div class="login-actions">
            <a class="btn" href={loginUrl} target="_blank" rel="noopener noreferrer">Open sign-in page</a>
            {#if loginCode}<code class="login-code">{loginCode}</code>{/if}
          </div>
        {/if}
        {#if loginActive()}
          <button class="btn" onclick={cancelActiveLogin}>Cancel</button>
        {/if}
        <p class="hint dim">Sign-in runs inside the app with no terminal window. Keep this panel open while you finish in the browser.</p>
        <button class="btn" onclick={rescan} disabled={rescanning}>{rescanning ? 'rescanning…' : 'Rescan accounts'}</button>
      </div>
    </section>

    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Defaults for new chats')} data-overseer-anchor="chat_defaults">
      <h3>Defaults for new chats</h3>
      <label class="opt row2">Account
        <select value={settings.defaultAccount} onchange={(e) => settings.set('defaultAccount', (e.target as HTMLSelectElement).value)}>
          <option value="">last used</option>
          {#each localProfiles as p (p.id)}<option value={p.id}>{profileOptionLabel(p)} · {p.provider}</option>{/each}
        </select>
      </label>
      <label class="opt row2">Permission mode
        <select value={settings.defaultPermissionMode} onchange={(e) => settings.set('defaultPermissionMode', (e.target as HTMLSelectElement).value)}>
          <option value="safe">Safe (ask)</option>
          <option value="edits">Edits free</option>
          <option value="full">Full access</option>
        </select>
      </label>
      <label class="opt row2">Claude model
        <select value={settings.defaultClaudeModel} onchange={(e) => settings.set('defaultClaudeModel', (e.target as HTMLSelectElement).value)}>
          <option value="">catalog default</option>
          {#each modelsFor('claude') as m (m.slug)}<option value={m.slug}>{m.name}</option>{/each}
        </select>
      </label>
      <label class="opt row2">Codex model
        <select value={settings.defaultCodexModel} onchange={(e) => settings.set('defaultCodexModel', (e.target as HTMLSelectElement).value)}>
          <option value="">catalog default</option>
          {#each modelsFor('codex') as m (m.slug)}<option value={m.slug}>{m.name}</option>{/each}
        </select>
      </label>
      <label class="opt row2">Name new chats after
        <select value={store.prefs.chatNamePool} onchange={(e) => void setPrefs({ chatNamePool: (e.target as HTMLSelectElement).value as HubPrefs['chatNamePool'] })}>
          <option value="women">Women in computing and science</option>
          <option value="everyone">Everyone</option>
        </select>
      </label>
      <p class="hint dim">New chats get a scientist's surname (Hopper, Curie, Turing) drawn from the pool you pick here. Chats already named keep their names.</p>
      <label class="opt"><input type="checkbox" checked={store.prefs.steerMessagesAtToolBoundary} onchange={(e) => void setPrefs({ steerMessagesAtToolBoundary: (e.target as HTMLInputElement).checked })} /> Send new messages into a running turn at its next tool call</label>
      <label class="opt"><input type="checkbox" checked={settings.defaultUseWorktree} onchange={(e) => settings.set('defaultUseWorktree', (e.target as HTMLInputElement).checked)} /> New chats in a project use an isolated git worktree (off = work directly in the project folder)</label>
      <label class="opt"><input type="checkbox" checked={settings.autoSwitchToNewChat} onchange={(e) => settings.set('autoSwitchToNewChat', (e.target as HTMLInputElement).checked)} /> Switch to the new chat when you send its first message (off = stay on the chat you were viewing)</label>
      <label class="opt"><input type="checkbox" checked={settings.autoReopenLastChats} onchange={(e) => settings.set('autoReopenLastChats', (e.target as HTMLInputElement).checked)} /> Reopen the chats I had open when the app starts (off = show the home screen with a Reopen button)</label>
    </section>

    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Unfiled / detached chats')}>
      <h3>Unfiled / detached chats</h3>
      <label class="opt row2">Default destination
        <select value={settings.detachedDefaultProjectId ?? ''} onchange={(e) => settings.set('detachedDefaultProjectId', (e.target as HTMLSelectElement).value || null)}>
          <option value="">Unfiled (scratch)</option>
          {#each store.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
        </select>
      </label>
      <label class="opt row2">Permission level
        <select value={settings.detachedDefaultMode} onchange={(e) => settings.set('detachedDefaultMode', (e.target as HTMLSelectElement).value as 'safe' | 'edits' | 'full')}>
          <option value="safe">Safe (ask)</option>
          <option value="edits">Edits free</option>
          <option value="full">Full access (un-restricted)</option>
        </select>
      </label>
      <p class="hint dim">Applies to chats started outside any project — they land in "Unfiled" unless you pick a default destination above. Both settings are just defaults and can be overridden per chat; "Full access" un-restricts detached chats (no approvals).</p>
    </section>

    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Composer')}>
      <h3>Composer</h3>
      <label class="opt"><input type="checkbox" checked={settings.showTokenEstimate} onchange={() => settings.toggleTokenEstimate()} /> Show next-call token estimate under the chatbox</label>
      <label class="opt"><input type="checkbox" checked={settings.combineQueued} onchange={() => settings.toggleCombineQueued()} /> Auto-combine queued messages (before the model reads them)</label>
      <label class="opt">
        <input
          type="number"
          min="0"
          step="1000"
          style="width: 6rem"
          value={settings.pasteAsTextThreshold}
          onchange={(e) => settings.set('pasteAsTextThreshold', Math.max(0, Math.round(Number((e.target as HTMLInputElement).value) || 0)))}
        />
        Turn a paste this many characters or larger into a "pasted text" chip instead of a wall (0 = off). Its full content still reaches the agent.
      </label>
    </section>

    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'File-write display')}>
      <h3>File-write display</h3>
      <label class="opt row2">Default diff density
        <select value={store.prefs.fileWriteDiffDensity ?? 'minimal'} onchange={(e) => void setPrefs({ fileWriteDiffDensity: (e.target as HTMLSelectElement).value as HubPrefs['fileWriteDiffDensity'] })}>
          <option value="minimal">Minimal</option>
          <option value="summary">Summary</option>
          <option value="verbose">Verbose</option>
        </select>
      </label>
      <p class="hint dim">Minimal shows a one-line file summary; Summary shows the first 14 diff rows with context; Verbose starts fully expanded. Every diff can still be expanded or collapsed in place.</p>
    </section>

    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Usage')}>
      <h3>Usage</h3>
      <label class="opt"><input type="checkbox" checked={settings.showSpend} onchange={() => settings.toggleSpend()} /> Show accumulated spend</label>
      <label class="opt budget">Plan budget ($/month)
        <input type="number" min="0" placeholder="e.g. 100" value={settings.planBudgetUsd ?? ''}
          onchange={(e) => settings.setBudget(Number((e.target as HTMLInputElement).value) || null)} />
      </label>
      <div class="budget-auto">
        <button class="btn" onclick={autoDetectBudget}>Auto-detect from plan</button>
        <span class="hint dim">Sums a monthly budget from each account's detected subscription tier.</span>
      </div>
      {#if autoResult}
        <div class="auto-result">
          <div class="auto-total">Budget set to <b>${autoResult.total}/mo</b>{#if autoResult.assumed} · {autoResult.assumed} account{autoResult.assumed === 1 ? '' : 's'} fell back to an assumed tier{/if}</div>
          <ul class="auto-list">
            {#each autoResult.lines as l (l)}<li class="dim">{l}</li>{/each}
          </ul>
        </div>
      {/if}
      <p class="hint dim">Spend shows as a percent of the plan budget when set. Claude usage (session / week / model) is polled from the free <code>/usage</code> command — Claude has no dollar tier in the data, so those accounts fall back to the entry tier.</p>
    </section>

    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Remote access')} data-overseer-anchor="remote_access">
      <h3>Remote access (mesh)</h3>
      {#if mesh}
        <label class="opt"><input type="checkbox" checked={mesh.enabled} disabled={meshBusy} onchange={(e) => toggleMesh((e.target as HTMLInputElement).checked)} /> Expose this hub to my AllMyStuff fleet</label>
        <div class="mesh-status">
          {#if !mesh.nodePresent && mesh.enabled}
            <span class="mstate off">No AllMyStuff node detected on this PC — hub stays local-only.</span>
          {:else if mesh.exposed}
            <span class="mstate on">Live as "{mesh.label}" ({mesh.siteId}). On another fleet PC, open:</span>
            <code class="cmd">{mesh.peerUrl}</code>
          {:else if mesh.enabled}
            <span class="mstate warn">Enabled, but not exposed{mesh.error ? ` — ${mesh.error}` : ''}.</span>
          {:else}
            <span class="dim">Off — your hub stays bound to 127.0.0.1 only.</span>
          {/if}
        </div>
        <p class="hint dim">Rides your AllMyStuff mesh as a "site" (no Tailscale). The hub always stays on loopback — the local node tunnels it to your own devices, which need no grant.</p>
        <div class="token-row pairing-code-row">
          <span class="tlabel dim">Pairing code</span>
          <code class="cmd pairing-code">{pairingCode || '••••-••••'}</code>
          <button class="btn" disabled={pairingBusy} onclick={issuePairingCode}>{pairingBusy ? 'creating…' : pairingCode ? 'new code' : 'create code'}</button>
          <button class="btn" disabled={!pairingCode} onclick={copyPairingCode}>{pairingCopied ? 'copied' : 'copy'}</button>
        </div>
        <p class="hint dim">
          Enter this one-use code on another device. It expires {pairingExpiresAt ? `at ${new Date(pairingExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '10 minutes after creation'}.
        </p>
        {#if pairingError}<p class="hint warn">{pairingError}</p>{/if}
        <details class="legacy-token">
          <summary>Advanced: legacy device token</summary>
          <div class="token-row">
            <code class="cmd token">{revealToken ? revealedToken : '•'.repeat(28)}</code>
            <button class="btn" onclick={toggleTokenReveal}>{revealToken ? 'hide' : 'show'}</button>
            <button class="btn" onclick={async () => copyToken(await loadDeviceToken())}>{copied ? 'copied' : 'copy'}</button>
          </div>
          <p class="hint dim">The permanent token is retained for existing clients and recovery. Prefer a short-lived pairing code for new devices.</p>
        </details>
        {#if store.fleetSites.some((site) => !site.local)}
          <div class="fleet-pairing">
            <span class="tlabel">Fleet machines</span>
            {#each store.fleetSites.filter((site) => !site.local) as site (site.siteId)}
              <div class="fleet-peer">
                <div class="fleet-peer-head">
                  <span>{site.label}</span>
                  <span class="mstate" class:on={site.online && site.authState === 'paired'} class:warn={site.online && site.authState !== 'paired'} class:off={!site.online}>
                    {!site.online ? 'mesh offline' : site.authState === 'paired' ? 'paired · live' : 'pairing required'}
                  </span>
                </div>
                {#if site.authState === 'paired' && getFleetSiteToken(site.siteId)}
                  <div class="token-row">
                    <span class="hint dim">This browser can read and control that hub.</span>
                    <button class="btn" onclick={() => store.unpairFleetSite(site.siteId)}>forget token</button>
                  </div>
                {:else}
                  <div class="token-row">
                    <input
                      type="password"
                      autocomplete="off"
                      placeholder="Enter XXXX-XXXX pairing code"
                      value={fleetTokenDrafts[site.siteId] ?? ''}
                      oninput={(event) => (fleetTokenDrafts = { ...fleetTokenDrafts, [site.siteId]: (event.target as HTMLInputElement).value })}
                    />
                    <button class="btn" disabled={fleetPairBusy === site.siteId || !site.online} onclick={() => pairFleetSite(site.siteId)}>
                      {fleetPairBusy === site.siteId ? 'pairing…' : 'pair'}
                    </button>
                  </div>
                {/if}
                {#if fleetPairError[site.siteId] || site.authError}
                  <p class="hint warn">{fleetPairError[site.siteId] || site.authError}</p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        <p class="dim">Checking mesh…</p>
      {/if}

      <div class="testbed-policy">
        <div class="testbed-head">
          <div>
            <h4>Authorize this machine as a testbed</h4>
            <p class="hint dim">Off by default. Only the roots and operations below can be granted to individual chats on another paired hub.</p>
          </div>
          <label class="switch-label"><input type="checkbox" bind:checked={deviceEnabled} /> enabled</label>
        </div>
        {#if deviceExecutor}
          <p class="hint dim">{deviceExecutor.hostname} Â· {deviceExecutor.platform}/{deviceExecutor.arch}</p>
        {/if}
        <div class="device-roots">
          {#each deviceRoots as root, index (`${root.id}:${root.environment?.kind === 'wsl' ? root.environment.distro : 'host'}:${root.path}`)}
            <div class="device-root">
              <div class="device-root-main">
                <input aria-label="Root label" value={root.label} oninput={(event) => patchDeviceRoot(index, { label: (event.target as HTMLInputElement).value })} />
                <code title={root.path}>{root.environment?.kind === 'wsl' ? `WSL ${root.environment.distro} · ${root.path}` : `host · ${root.path}`}</code>
                <button class="btn" aria-label={`Remove ${root.label}`} onclick={() => (deviceRoots = deviceRoots.filter((_, rootIndex) => rootIndex !== index))}>remove</button>
              </div>
              <div class="device-capabilities">
                <label><input type="checkbox" checked={root.read} onchange={(event) => patchDeviceRoot(index, { read: (event.target as HTMLInputElement).checked })} /> read</label>
                <label><input type="checkbox" checked={root.write} onchange={(event) => patchDeviceRoot(index, { write: (event.target as HTMLInputElement).checked })} /> write</label>
                <label><input type="checkbox" checked={root.terminal} onchange={(event) => patchDeviceRoot(index, { terminal: (event.target as HTMLInputElement).checked })} /> terminal</label>
              </div>
            </div>
          {/each}
        </div>
        <div class="testbed-actions">
          <button class="btn" onclick={addDeviceRoot}>Add approved host folder</button>
          <button class="btn btn-primary" disabled={deviceBusy} onclick={saveDevicePolicy}>{deviceBusy ? 'savingâ€¦' : deviceSaved ? 'Saved âœ“' : 'Save testbed policy'}</button>
        </div>
        {#if deviceExecutor?.environments?.some((environment) => environment.kind === 'wsl')}
          <div class="wsl-root-add">
            <select aria-label="WSL distro" bind:value={deviceWslDistro}>
              {#each deviceExecutor.environments.filter((environment) => environment.kind === 'wsl') as environment (environment.id)}
                <option value={environment.distro}>{environment.label}{environment.state ? ` · ${environment.state}` : ''}</option>
              {/each}
            </select>
            <input aria-label="WSL approved path" bind:value={deviceWslPath} placeholder="/home/operator/project" />
            <button class="btn" onclick={addDeviceWslRoot}>Add approved WSL folder</button>
          </div>
        {/if}
        {#if deviceError}<p class="hint warn" role="alert">{deviceError}</p>{/if}
        <p class="hint dim">Terminal commands start in the selected root with bounded time and output, but the shell retains this OS account's normal machine access. Pairing a machine or selecting Full access in a chat does not grant this authority.</p>
      </div>
    </section>

    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Operator profile & instructions')}>
      <h3>Operator profile &amp; instructions</h3>
      <p class="hint dim">House rules loaded into every agent at spawn, through the vendor's own CLAUDE.md / AGENTS.md. Scopes stack general → specific (global → vendor → project → account). Existing chats pick up changes on their next spawn.</p>
      <label class="opt row2">Scope
        <select bind:value={instrScope}>
          <option value="global">Global — every agent</option>
          <option value="vendor:claude">All Claude</option>
          <option value="vendor:codex">All Codex</option>
          {#each localProjects as p (p.id)}<option value="project:{p.id}">Project · {p.name}</option>{/each}
          {#each localProfiles as pr (pr.id)}<option value="account:{pr.id}">Account · {profileOptionLabel(pr)}</option>{/each}
        </select>
      </label>
      <textarea class="instr" rows="6" bind:value={instrContent} placeholder="e.g. I'm the operator. Terse commits, no emoji. Prefer pnpm. Ask before anything destructive."></textarea>
      <button class="btn btn-primary" onclick={saveInstructions}>{instrSaved ? 'Saved ✓' : 'Save'}</button>
    </section>

    {#if updatesSupported}
      <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Updates')}>
        <h3>Updates</h3>
        <p class="hint dim">Updates are pulled from this project's GitHub releases and their signature is verified before anything is installed. An available update is only ever offered — it is never installed without you clicking Update now.</p>
        <label class="opt"><input type="checkbox" checked={settings.autoCheckUpdates} onchange={(e) => settings.set('autoCheckUpdates', (e.target as HTMLInputElement).checked)} /> Check for updates on launch</label>
        <div class="upd-row">
          <button class="btn" onclick={() => updater.check()} disabled={updater.busy}>{updater.busy ? 'Checking…' : 'Check for updates'}</button>
          {#if updater.info?.available}
            {#if waitForUpdateIdle}
              <button class="btn" onclick={() => (waitForUpdateIdle = false)}>Cancel waiting</button>
            {:else if updateLiveTurns > 0}
              <button class="btn" onclick={() => updater.install({ allowLiveTurns: true })} disabled={updater.busy}>Update anyway</button>
              <button class="btn btn-primary" onclick={() => (waitForUpdateIdle = true)} disabled={updater.busy}>Update when idle</button>
            {:else}
              <button class="btn btn-primary" onclick={() => updater.install()} disabled={updater.busy}>Update to {updater.info.version}</button>
            {/if}
          {/if}
        </div>
        {#if updater.info?.available && updateLiveTurns > 0}
          <p class="hint upd-warn">
            {updateLiveTurns} {updateLiveTurns === 1 ? 'chat is' : 'chats are'} mid-turn. Updating restarts everything,
            so that work would be lost.
          </p>
        {/if}
        {#if waitForUpdateIdle}
          <p class="hint upd-warn">Waiting for {updateLiveTurns} {updateLiveTurns === 1 ? 'turn' : 'turns'} to finish, then updating…</p>
        {/if}
        {#if updater.error}
          <p class="hint upd-err">{updater.error}</p>
        {:else if updater.info?.available}
          <p class="hint dim">Version {updater.info.version} is available (you're on {updater.info.currentVersion}).{updater.info.notes ? ` ${updater.info.notes}` : ''}</p>
        {:else if updater.checked && updater.info}
          <p class="hint dim">You're up to date — version {updater.info.currentVersion}.</p>
        {/if}
      </section>
    {/if}

    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Overseer')} data-tutorial-anchor="overseer-setup">
      <h3>Application Overseer</h3>
      <p class="hint dim">A dedicated, projectless control chat that runs from the app checkout with operator-level hub tools. Its account choice is stored outside the journal, while every live action is identity-checked and journaled.</p>
      <label class="opt row2">Default account
        <select bind:value={overseerProfileId}>
          <option value="" disabled>Choose an account</option>
          {#each localProfiles as profile (profile.id)}
            <option value={profile.id} disabled={profile.available === false || profile.authStatus === 'signed_out'}>{profileOptionLabel(profile)} · {profile.provider}</option>
          {/each}
        </select>
      </label>
      <div class="overseer-actions">
        <button class="btn btn-primary" disabled={!overseerProfileId || overseerBusy} onclick={configureOverseer}>
          {overseerBusy ? 'Preparing Overseer…' : overseerStatus?.sessionId ? 'Open / change Overseer' : 'Create Overseer'}
        </button>
        {#if overseerStatus?.sessionId}<span class="hint ok">Configured · {overseerStatus.available ? 'ready' : 'account unavailable'}</span>{/if}
      </div>
      {#if overseerError}<p class="hint warn" role="alert">{overseerError}</p>{/if}
      <p class="hint dim">If SQLite preflight fails, the vendor chat cannot run because chat state is journal-backed. The independent supervisor remains alive, records bounded diagnostics outside the database, and keeps recovery/restart authority. This UI does not blur those two failure boundaries.</p>
    </section>

    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Getting started')}>
      <h3>Getting started</h3>
      <p class="hint dim">The shortest path is one account, one Overseer, then a plain-language request. The visual tours remain available whenever you want them.</p>
      <div class="tutorial-actions">
        <button class="btn" onclick={onreplayfirst}>Set up account + Overseer</button>
        <button class="btn" onclick={onreplayapptour}>Explore the app tour</button>
        <button class="btn" onclick={onreplayproject}>Explain New Project</button>
      </div>
    </section>

    <section class:tab-hidden={!settingsTabHasSection(activeTab, 'Maintenance')}>
      <h3>Maintenance</h3>
      <div class="restart-row">
        <button class="btn" onclick={restartHub} disabled={restartState === 'restarting'}>
          {restartState === 'restarting' ? 'restarting…' : 'Restart hub'}
        </button>
        {#if restartState !== 'idle'}
          <span class="restart-msg {restartState}">{restartMsg}</span>
        {/if}
      </div>
      <p class="hint dim">Cleanly recycles the hub under the supervisor (blue-green flip — sub-second, running sessions restored). No approval needed; a plain hub with no supervisor can't self-restart.</p>
      {#if inTauri}
        <div class="uninstall-block">
          <h4>Uninstall AllMyAgents</h4>
          <p class="hint dim">Works even when the hub is down. By default it removes the app and regenerable hub files but keeps your chats, settings, and vendor credentials.</p>
          <label class="opt"><input type="checkbox" bind:checked={removeUserData} /> Also permanently delete chats, settings, and saved Claude/Codex logins</label>
          <button class="btn btn-danger" onclick={uninstallMac} disabled={uninstallBusy}>{uninstallBusy ? 'Uninstalling…' : 'Uninstall app'}</button>
          {#if uninstallError}<p class="hint upd-err">{uninstallError}</p>{/if}
        </div>
      {/if}
    </section>

    <section class="danger" class:tab-hidden={!settingsTabHasSection(activeTab, 'Danger Zone')} data-overseer-anchor="safety">
      <h3>Danger Zone</h3>
      {#if !dangerRevealed}
        <p class="hint dim">Guardrails are safe defaults you can loosen — this is your own self-hosted tool. Review agent-authored practices and relax the gates here.</p>
        <button class="btn danger-reveal" onclick={() => (dangerRevealed = true)}>I understand these reduce safety — show them</button>
      {:else}
        <div class="danger-body">
          <label class="opt"><input type="checkbox" checked={danger.disableWorktreeCollisionWarnings} onchange={(e) => setDanger({ disableWorktreeCollisionWarnings: (e.target as HTMLInputElement).checked })} /> Disable live worktree collision and staleness warnings</label>
          <p class="hint dim warnrow">Off (safe): agents get one high-priority steer when another active agent writes the same file, or when their base branch advances through a file they are changing. On: no collision/staleness checks or integration warnings run. Detection never rebases, pauses, or edits either worktree.</p>

          <label class="opt"><input type="checkbox" checked={danger.autoApprovePractices} onchange={(e) => setDanger({ autoApprovePractices: (e.target as HTMLInputElement).checked })} /> Auto-approve agent practices at project / global / fleet scope</label>
          <p class="hint dim warnrow">Off (safe): an agent recording a convention that affects teammates or the whole fleet waits for your approval. On: those writes apply immediately, no prompt. (Your own-account practices are always immediate either way.)</p>

          <label class="opt"><input type="checkbox" checked={danger.busCanUseRiskyTools} onchange={(e) => setDanger({ busCanUseRiskyTools: (e.target as HTMLInputElement).checked })} /> Let teammate-message (bus) turns use risky tools</label>
          <p class="hint dim warnrow">Off (safe): a turn triggered by another agent's message can't write practices at all. On: a semi-trusted teammate message can drive a practice write — a persistence vector.</p>

          <label class="opt"><input type="checkbox" checked={danger.fullAccessAnyOrigin} onchange={(e) => setDanger({ fullAccessAnyOrigin: (e.target as HTMLInputElement).checked })} /> Apply a chat's permission mode to turns it didn't start</label>
          <p class="hint dim warnrow">Off (safe): a turn started by a teammate's message runs at most "Edits" and still asks, even in a Full Access chat. On: the mode you picked applies to every turn in that chat — a teammate messaging it, a monitor firing — so it won't stall on a prompt while you're away. That also means a teammate agent that's mistaken or has been fed a malicious instruction gets the same free rein you granted yourself. Practice writes and permission-widening requests are gated separately and are unaffected by this.</p>

          <label class="opt"><input type="checkbox" checked={danger.autoApproveRestart} onchange={(e) => setDanger({ autoApproveRestart: (e.target as HTMLInputElement).checked })} /> Auto-approve agent hub restarts</label>
          <p class="hint dim warnrow">Default off — an agent's restart_hub tool waits on your approval; the operator action in System never needs it.</p>

          <label class="opt"><input type="checkbox" checked={danger.enableClaudeConnectors} onchange={(e) => setDanger({ enableClaudeConnectors: (e.target as HTMLInputElement).checked })} /> Enable claude.ai cloud connectors for Claude sessions</label>
          <p class="hint dim warnrow">Off (safe): the hub suppresses claude.ai cloud MCP connectors for managed Claude sessions — no data egress to vendor cloud connectors. On: they load as configured. Applies to managed profiles only, on the next turn.</p>

          <h4>Project managers</h4>
          <p class="hint dim">A project manager spawns and oversees other agents on your behalf. The manager flow collects its project, worker accounts and models, live-child bound, delegated actions, tools, and own-child visibility in one readable grant.</p>
          <button
            class="btn manager-open"
            onclick={() => {
              store.settingsOpen = false
              store.openManagerSetup()
            }}
          ><Icon name="flag" size={13} /> Open project managers</button>

          <h4>Agent-authored practices</h4>
          <p class="hint dim">Durable conventions agents recorded, materialized into future agents at spawn. Revoking one removes it from future spawns (running sessions are unaffected until respawn).</p>
          {#if practices.length === 0}
            <p class="hint dim empty">No agent-authored practices yet.</p>
          {:else}
            <ul class="prac-list">
              {#each practices as p (p.id)}
                <li class="prac">
                  <div class="prac-head">
                    <span class="prac-scope">{p.scope}</span>
                    <span class="prac-title">{p.title}</span>
                    <button class="btn btn-danger prac-revoke" onclick={() => revokePractice(p.id)}>Revoke</button>
                  </div>
                  <div class="prac-body dim">{p.body}</div>
                  <div class="prac-prov dim">{practiceProvenance(p)}</div>
                </li>
              {/each}
            </ul>
          {/if}

        </div>
      {/if}
    </section>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: color-mix(in srgb, var(--bg) 72%, transparent); backdrop-filter: blur(var(--space-2)); z-index: 40; }
  .modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 41;
    display: flex; flex-direction: column; width: min(64rem, 92vw); height: min(48rem, 84vh); overflow: hidden;
    background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-xl);
    box-shadow: var(--shadow-4), var(--edge-hi); }
  @keyframes modal-in { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: no-preference) {
    .backdrop { animation: modal-in var(--dur-fast) var(--ease); }
    .modal { animation: modal-in var(--dur) var(--ease); }
  }
  .head { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: var(--text-lg); }
  .settings-layout { min-height: 0; flex: 1; display: grid; grid-template-columns: calc(var(--space-8) + var(--space-8) + var(--space-8) + var(--space-8) + var(--space-8)) minmax(0, 1fr); }
  .tabs { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-4) var(--space-3); background: var(--surface-2); border-right: 1px solid var(--border); }
  .tab { width: 100%; padding: var(--space-3) var(--space-4); border: 0; border-left: var(--space-1) solid transparent; border-radius: var(--r-md); background: transparent; color: var(--muted); font-size: var(--text-sm); text-align: left; }
  .tab:hover { background: var(--surface-3); color: var(--text); }
  .tab.active { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface-3)); color: var(--text); }
  .body { min-width: 0; overflow-y: auto; padding: var(--space-5) var(--space-5) var(--space-6); display: flex; flex-direction: column; gap: var(--space-7); }
  .tab-hidden { display: none; }
  section h3 { margin: 0 0 var(--space-3); font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: var(--ls-label); color: var(--dim); }
  .accounts { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-4); }
  .account-wrap { display: flex; flex-direction: column; gap: var(--space-1); }
  .acct { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; padding: var(--space-2) var(--space-3); background: var(--surface-2); border-radius: var(--r-md); box-shadow: var(--edge-hi); }
  .account-identity { display: flex; flex-direction: column; min-width: 0; }
  .aid { font-weight: var(--fw-medium); }
  .profile-id { font-size: 0.66rem; }
  .aprov { font-size: var(--text-xs); margin-left: auto; }
  .rename-account { display: flex; align-items: end; gap: var(--space-2); flex-wrap: wrap; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-1); }
  .rename-account label { display: grid; gap: var(--space-1); flex: 1 1 240px; font-size: var(--text-xs); }
  .rename-account input { width: 100%; }
  .rename-account .hint, .rename-account .status { flex-basis: 100%; margin: 0; }
  .add { display: flex; flex-direction: column; gap: var(--space-3); }
  .add > .btn { align-self: flex-start; }
  .add-row { display: flex; gap: var(--space-2); }
  .add-row select { flex: none; }
  .add-row input { flex: 1; }
  .add-row .btn { flex: none; align-self: stretch; }
  .login-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .login-actions a { text-decoration: none; }
  .login-code { font-size: var(--text-sm); letter-spacing: 0.08em; user-select: all; }
  .cmd { display: block; background: var(--bg); border: 1px solid var(--border-subtle); border-radius: var(--r-md); padding: var(--space-3) var(--space-4); font-size: var(--text-xs); color: var(--cyan); }
  .status { font-size: var(--text-xs); line-height: 1.45; margin: 0.1rem 0 0.15rem; }
  .status.waiting { color: var(--warn); }
  .status.done { color: var(--ok); }
  .status.cancelled { color: var(--muted); }
  .status.error { color: var(--bad-text); }
  .write-error { margin: 0; }
  .opt { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
  .opt.budget { flex-wrap: wrap; }
  .opt.budget input { width: 6rem; margin-left: auto; }
  .opt.row2 { justify-content: space-between; }
  .opt.row2 select { min-width: 11rem; }
  .hint { font-size: var(--text-xs); line-height: 1.5; }
  .upd-row { display: flex; gap: var(--space-3); flex-wrap: wrap; margin: var(--space-3) 0 var(--space-2); }
  .upd-err { color: var(--bad); }
  .upd-warn { color: var(--warn-text, #d08700); }
  .hint code { background: var(--bg); padding: 0 0.25rem; border-radius: var(--r-xs); }
  .budget-auto { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; margin-bottom: var(--space-3); }
  .budget-auto .hint { flex: 1; min-width: 12rem; }
  .auto-result { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--space-3) var(--space-4); margin-bottom: var(--space-4); box-shadow: var(--edge-hi); }
  .auto-total { font-size: var(--text-sm); margin-bottom: var(--space-2); }
  .auto-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; }
  .auto-list li { font-size: var(--text-xs); font-family: var(--mono); }
  .mesh-status { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-3); }
  .mstate { font-size: var(--text-xs); line-height: 1.45; }
  .mstate.on { color: var(--ok); }
  .mstate.warn { color: var(--warn); }
  .mstate.off { color: var(--muted); }
  .token-row { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); flex-wrap: wrap; }
  .token-row input { flex: 1 1 16rem; min-width: 10rem; }
  .tlabel { font-size: var(--text-xs); }
  .token { flex: 1; min-width: 9rem; overflow: hidden; text-overflow: ellipsis; }
  .pairing-code { min-width: 8.5rem; letter-spacing: 0.12em; text-align: center; }
  .legacy-token { margin: var(--space-3) 0 var(--space-4); }
  .legacy-token summary { cursor: pointer; color: var(--muted); font-size: var(--text-xs); }
  .legacy-token .token-row { margin-top: var(--space-2); }
  .legacy-token p { margin: 0; }
  .fleet-pairing { display: grid; gap: var(--space-2); margin-top: var(--space-4); }
  .fleet-peer { border: 1px solid var(--border-subtle); border-radius: var(--r-md); padding: var(--space-3); background: var(--surface-1); }
  .fleet-peer-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-2); font-size: var(--text-sm); }
  .fleet-peer .hint { margin: 0; }
  .testbed-policy { margin-top: var(--space-5); padding-top: var(--space-5); border-top: 1px solid var(--border); }
  .testbed-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); }
  .testbed-head h4 { margin: 0 0 var(--space-1); font-size: var(--text-sm); }
  .testbed-head p { margin: 0; }
  .switch-label { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); }
  .device-roots { display: grid; gap: var(--space-2); margin: var(--space-3) 0; }
  .device-root { border: 1px solid var(--border-subtle); border-radius: var(--r-md); padding: var(--space-3); background: var(--surface-1); }
  .device-root-main { display: grid; grid-template-columns: minmax(7rem, .45fr) minmax(10rem, 1fr) auto; gap: var(--space-2); align-items: center; }
  .device-root-main code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: var(--text-xs); }
  .device-capabilities { display: flex; gap: var(--space-4); margin-top: var(--space-2); }
  .device-capabilities label { display: flex; align-items: center; gap: var(--space-1); font-size: var(--text-xs); }
  .testbed-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .wsl-root-add { display: grid; grid-template-columns: minmax(9rem, .6fr) minmax(12rem, 1fr) auto; gap: var(--space-2); margin-top: var(--space-2); }
  .overseer-actions { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .instr { width: 100%; font-family: var(--mono); font-size: var(--text-xs); resize: vertical; margin-bottom: var(--space-2); line-height: 1.5; }
  .danger h3 { color: var(--bad-text); }
  .danger-reveal { border-color: var(--bad); color: var(--bad-text); }
  .danger-body { display: flex; flex-direction: column; gap: var(--space-2); border: 1px solid var(--bad); border-radius: var(--r-lg); padding: var(--space-4); }
  .danger-body .warnrow { margin: 0 0 var(--space-3) calc(1rem + var(--space-3)); }
  .danger-body h4 { margin: var(--space-3) 0 var(--space-1); font-size: var(--text-xs); }
  .danger-body .empty { margin: 0; }
  .manager-open { display: inline-flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
  .prac-list { list-style: none; margin: var(--space-1) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
  .prac { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--space-3) var(--space-4); box-shadow: var(--edge-hi); }
  .prac-head { display: flex; align-items: center; gap: var(--space-3); }
  .prac-scope { font-family: var(--mono); font-size: var(--text-2xs); color: var(--cyan); background: var(--bg); padding: 0.05rem 0.35rem; border-radius: var(--r-xs); }
  .prac-title { font-weight: var(--fw-medium); font-size: var(--text-sm); }
  .prac-revoke { margin-left: auto; padding: 0.15rem 0.5rem; font-size: var(--text-2xs); }
  .prac-body { font-size: var(--text-xs); line-height: 1.5; margin-top: var(--space-2); white-space: pre-wrap; }
  .prac-prov { font-size: var(--text-2xs); font-family: var(--mono); margin-top: var(--space-2); }
  .tutorial-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .restart-row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .restart-msg { font-size: var(--text-xs); line-height: 1.45; }
  .restart-msg.restarting { color: var(--warn); }
  .restart-msg.error { color: var(--bad-text); }
</style>
