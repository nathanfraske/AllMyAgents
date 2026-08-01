<script lang="ts">
  import { api } from './api'
  import { confirmDialog } from './dialog.svelte'
  import Icon from './Icon.svelte'

  let {
    sessionId,
    agentLabel,
    initialEnabled = false,
    open = false,
    onopen = () => {},
    onclose = () => {},
  }: {
    sessionId: string
    agentLabel: string
    initialEnabled?: boolean
    open?: boolean
    onopen?: () => void
    onclose?: () => void
  } = $props()

  let enabled = $state(false)
  let available = $state<boolean | null>(null)
  let reason = $state<string | null>(null)
  let busy = $state(false)
  let retainedProfile = $state(false)
  let publicOriginGrants = $state<string[]>([])
  let localNetworkEnabled = $state(false)
  let tabsEnabled = $state(false)
  let downloadsEnabled = $state(false)
  let refreshedFor = $state('')

  const warning = $derived(
    `This browser belongs only to ${agentLabel}. It does not use your normal browser logins. If you sign in here, this agent can read pages available to that signed-in session until you clear its browser data.`,
  )

  $effect(() => {
    enabled = initialEnabled
  })

  $effect(() => {
    if (!open) {
      refreshedFor = ''
      return
    }
    if (refreshedFor === sessionId) return
    refreshedFor = sessionId
    void refresh()
  })

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true
    try {
      await action()
    } catch (error) {
      reason = errorMessage(error)
    } finally {
      busy = false
    }
  }

  function applyState(state: {
    enabled: boolean
    available: boolean
    reason?: string
    retainedProfile: boolean
    publicOriginGrants: string[]
    localNetworkEnabled: boolean
    tabsEnabled: boolean
    downloadsEnabled: boolean
  }): void {
    enabled = state.enabled
    available = state.available
    reason = state.reason ?? null
    retainedProfile = state.retainedProfile
    publicOriginGrants = state.publicOriginGrants
    localNetworkEnabled = state.localNetworkEnabled
    tabsEnabled = state.tabsEnabled
    downloadsEnabled = state.downloadsEnabled
  }

  async function refresh(): Promise<void> {
    try {
      applyState(await api.browserStatus(sessionId))
    } catch (error) {
      available = false
      reason = error instanceof Error ? error.message : 'Could not reach the browser broker.'
    }
  }

  async function toggle(): Promise<void> {
    reason = null
    await run(async () => {
      const result = await api.setBrowserEnabled(sessionId, !enabled)
      if ('error' in result) reason = result.error
      else applyState(result)
    })
  }

  async function show(): Promise<void> {
    await run(async () => {
      const result = await api.showBrowser(sessionId)
      reason = result.error ?? null
    })
  }

  async function clearData(): Promise<void> {
    if (!await confirmDialog(
      `Clear all cookies, site data, and logins for ${agentLabel}'s isolated browser?`,
      { confirmLabel: 'Clear browser data', danger: true },
    )) return
    await run(async () => {
      const result = await api.clearBrowser(sessionId)
      reason = result.error ?? (result.ok ? 'Browser data cleared.' : 'Could not clear browser data.')
      if (result.ok) retainedProfile = false
    })
  }

  async function setLocalNetwork(): Promise<void> {
    await run(async () => {
      const result = await api.setBrowserLocalNetwork(sessionId, !localNetworkEnabled)
      if ('error' in result) reason = result.error
      else {
        localNetworkEnabled = result.localNetworkEnabled
        reason = result.reason ?? null
      }
    })
  }

  async function setTabs(): Promise<void> {
    await run(async () => {
      const result = await api.setBrowserTabs(sessionId, !tabsEnabled)
      if ('error' in result) reason = result.error
      else {
        tabsEnabled = result.tabsEnabled
        reason = result.reason ?? null
      }
    })
  }

  async function setDownloads(): Promise<void> {
    await run(async () => {
      const result = await api.setBrowserDownloads(sessionId, !downloadsEnabled)
      if ('error' in result) reason = result.error
      else {
        downloadsEnabled = result.downloadsEnabled
        reason = result.reason ?? null
      }
    })
  }

  async function revokeOrigin(origin: string): Promise<void> {
    await run(async () => {
      const result = await api.revokeBrowserOrigin(sessionId, origin)
      if ('error' in result) reason = result.error
      else publicOriginGrants = result.publicOriginGrants
    })
  }
</script>

{#if !open}
  <button class="tab" class:on={enabled} onclick={onopen} title="Open isolated browser controls">
    <Icon name="globe" size={13} />
    Browser {enabled ? 'on' : 'off'}
  </button>
{:else}
  <aside class="panel" aria-label="Browser">
    <header>
      <span class="title"><Icon name="globe" size={14} /> Browser</span>
      <span class="state" class:on={enabled}>{enabled ? 'enabled' : 'off'}</span>
      <button class="close" onclick={onclose} title="Close" aria-label="Close Browser panel">✕</button>
    </header>
    <div class="body scroll">
      <p class="warning">{warning}</p>
      <button class="toggle" class:on={enabled} onclick={toggle} disabled={busy}>
        <span>{enabled ? 'Enabled for this chat' : 'Off for this chat'}</span>
        <span class="switch" aria-hidden="true"><span></span></span>
      </button>
      {#if enabled}
        <button class="capability" class:on={localNetworkEnabled} onclick={setLocalNetwork} disabled={busy}>
          <span><b>Local network &amp; dev servers</b><small>Loopback, private, and link-local sites</small></span>
          <span>{localNetworkEnabled ? 'on' : 'off'}</span>
        </button>
        <button class="capability" class:on={tabsEnabled} onclick={setTabs} disabled={busy}>
          <span><b>Additional tabs</b><small>Each new tab needs a one-use operator approval</small></span>
          <span>{tabsEnabled ? 'on' : 'off'}</span>
        </button>
        <button class="capability" class:on={downloadsEnabled} onclick={setDownloads} disabled={busy}>
          <span><b>Downloads</b><small>Inert, quota-bound files owned only by this chat</small></span>
          <span>{downloadsEnabled ? 'on' : 'off'}</span>
        </button>
        {#if publicOriginGrants.length}
          <section class="grants">
            <span>Approved public origins</span>
            {#each publicOriginGrants as origin (origin)}
              <div><span title={origin}>{origin}</span><button onclick={() => revokeOrigin(origin)} disabled={busy}>Revoke</button></div>
            {/each}
          </section>
        {/if}
        <div class="actions">
          <button onclick={show} disabled={busy || available === false}>Show browser window</button>
          <button class="clear" onclick={clearData} disabled={busy || available === false}>Clear browser data</button>
        </div>
      {/if}
      {#if retainedProfile}<p class="note">Isolated login data is retained for this agent, even while Browser is off.</p>{/if}
      {#if available === false && reason}<p class="reason bad" role="alert">{reason}</p>
      {:else if reason}<p class="reason">{reason}</p>{/if}
    </div>
  </aside>
{/if}

<style>
  .tab { position: absolute; top: 5.45rem; right: 0; z-index: 5; display: flex; align-items: center; gap: .4rem;
    padding: .25rem .6rem .25rem .55rem; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong);
    border-right: 0; border-radius: 999px 0 0 999px; font-size: .74rem; }
  .tab:hover, .tab.on { border-color: var(--warn); }
  .tab.on { color: var(--warn); }
  .panel { position: relative; flex: 0 0 clamp(260px, 38%, 380px); width: clamp(260px, 38%, 380px); min-width: 0;
    min-height: 0; display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--border-strong); }
  header { display: flex; align-items: center; gap: .5rem; padding: .5rem .65rem; border-bottom: 1px solid var(--border); }
  .title { display: flex; align-items: center; gap: .4rem; font-size: .82rem; font-weight: 600; }
  .state { margin-left: auto; color: var(--dim); font-size: .68rem; text-transform: uppercase; }
  .state.on { color: var(--warn); }
  .close { padding: 0 .2rem; color: inherit; opacity: .7; }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: .7rem; }
  .warning, .note, .reason { margin: 0 0 .65rem; color: var(--muted); font-size: var(--text-xs); line-height: 1.45; }
  .toggle, .capability { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: .6rem;
    padding: .55rem; border: 1px solid var(--border); border-radius: var(--r-md); text-align: left; font-size: var(--text-xs); }
  .toggle { background: var(--surface-3); }
  .capability { margin-top: .5rem; color: var(--muted); }
  .capability.on { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
  .capability > span:first-child { display: flex; flex-direction: column; }
  .capability small { color: var(--muted); font-size: .68rem; }
  .switch { width: 30px; height: 17px; flex: none; padding: 2px; border-radius: 99px; background: var(--border-strong); }
  .switch span { display: block; width: 13px; height: 13px; border-radius: 50%; background: var(--muted); }
  .toggle.on .switch { background: color-mix(in srgb, var(--warn) 55%, var(--surface-3)); }
  .toggle.on .switch span { transform: translateX(13px); background: var(--text); }
  .grants { display: grid; gap: .35rem; margin-top: .7rem; padding-top: .6rem; border-top: 1px solid var(--border); color: var(--muted); font-size: var(--text-xs); }
  .grants div { display: flex; align-items: center; gap: .4rem; }
  .grants div span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .grants button { margin-left: auto; color: var(--bad-text); }
  .actions { display: grid; gap: .45rem; margin-top: .7rem; }
  .actions button { padding: .5rem; border: 1px solid var(--border); border-radius: var(--r-md); }
  .actions .clear { color: var(--bad-text); }
  .note, .reason { margin-top: .65rem; margin-bottom: 0; }
  .reason.bad { color: var(--bad-text); }
  @container thread-body (max-width: 620px) {
    .panel { flex: 0 0 clamp(190px, 42%, 320px); width: 100%; height: auto; border-left: 0; border-top: 1px solid var(--border-strong); }
  }
</style>
