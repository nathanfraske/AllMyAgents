<script lang="ts">
  import { api } from './api'
  import { confirmDialog } from './dialog.svelte'
  import Icon from './Icon.svelte'

  let {
    sessionId,
    agentLabel,
    initialEnabled = false,
  }: {
    sessionId: string
    agentLabel: string
    initialEnabled?: boolean
  } = $props()

  let open = $state(false)
  let enabled = $state(false)
  let available = $state<boolean | null>(null)
  let reason = $state<string | null>(null)
  let busy = $state(false)
  let retainedProfile = $state(false)
  let publicOriginGrants = $state<string[]>([])
  let localNetworkEnabled = $state(false)
  let tabsEnabled = $state(false)
  let downloadsEnabled = $state(false)

  $effect(() => {
    enabled = initialEnabled
  })

  const warning = $derived(
    `This browser belongs only to ${agentLabel}. It does not use your normal browser logins. If you sign in here, this agent can read pages available to that signed-in session until you clear its browser data.`,
  )

  async function refresh(): Promise<void> {
    try {
      const state = await api.browserStatus(sessionId)
      enabled = state.enabled
      available = state.available
      reason = state.reason ?? null
      retainedProfile = state.retainedProfile
      publicOriginGrants = state.publicOriginGrants
      localNetworkEnabled = state.localNetworkEnabled
      tabsEnabled = state.tabsEnabled
      downloadsEnabled = state.downloadsEnabled
    } catch (error) {
      available = false
      reason = error instanceof Error ? error.message : 'Could not reach the browser broker.'
    }
  }

  async function toggle(): Promise<void> {
    busy = true
    reason = null
    const next = !enabled
    const result = await api.setBrowserEnabled(sessionId, next)
    if ('error' in result) {
      reason = result.error
    } else {
      enabled = result.enabled
      available = result.available
      reason = result.reason ?? null
      retainedProfile = result.retainedProfile
      publicOriginGrants = result.publicOriginGrants
      localNetworkEnabled = result.localNetworkEnabled
      tabsEnabled = result.tabsEnabled
      downloadsEnabled = result.downloadsEnabled
    }
    busy = false
  }

  async function show(): Promise<void> {
    busy = true
    const result = await api.showBrowser(sessionId)
    reason = result.error ?? null
    busy = false
  }

  async function clearData(): Promise<void> {
    if (!await confirmDialog(
      `Clear all cookies, site data, and logins for ${agentLabel}'s isolated browser?`,
      { confirmLabel: 'Clear browser data', danger: true },
    )) return
    busy = true
    const result = await api.clearBrowser(sessionId)
    reason = result.error ?? (result.ok ? 'Browser data cleared.' : 'Could not clear browser data.')
    busy = false
    if (result.ok) retainedProfile = false
  }

  async function setLocalNetwork(): Promise<void> {
    busy = true
    const result = await api.setBrowserLocalNetwork(sessionId, !localNetworkEnabled)
    if ('error' in result) reason = result.error
    else {
      localNetworkEnabled = result.localNetworkEnabled
      reason = result.reason ?? null
    }
    busy = false
  }

  async function revokeOrigin(origin: string): Promise<void> {
    busy = true
    const result = await api.revokeBrowserOrigin(sessionId, origin)
    if ('error' in result) reason = result.error
    else publicOriginGrants = result.publicOriginGrants
    busy = false
  }

  async function setTabs(): Promise<void> {
    busy = true
    const result = await api.setBrowserTabs(sessionId, !tabsEnabled)
    if ('error' in result) reason = result.error
    else {
      tabsEnabled = result.tabsEnabled
      reason = result.reason ?? null
    }
    busy = false
  }

  async function setDownloads(): Promise<void> {
    busy = true
    const result = await api.setBrowserDownloads(sessionId, !downloadsEnabled)
    if ('error' in result) reason = result.error
    else {
      downloadsEnabled = result.downloadsEnabled
      reason = result.reason ?? null
    }
    busy = false
  }

  function openMenu(): void {
    open = !open
    if (open) void refresh()
  }
</script>

<div class="wrap">
  <button
    class="pill-btn"
    class:on={enabled}
    class:open
    onclick={openMenu}
    title={enabled ? 'Isolated browser enabled for this chat' : 'Browser off for this chat'}
  >
    <span class="lead"><Icon name="globe" size={13} /></span>
    <span class="pill-label">Browser {enabled ? 'on' : 'off'}</span>
    <span class="chev"><Icon name="chevron-down" size={12} /></span>
  </button>

  {#if open}
    <button class="scrim" onclick={() => (open = false)} aria-label="close browser controls"></button>
    <div class="menu">
      <div class="head">
        <span class="warnicon"><Icon name="alert-triangle" size={15} /></span>
        <span>Isolated agent browser</span>
      </div>
      <p class="warning">{warning}</p>
      <button class="toggle" class:on={enabled} onclick={toggle} disabled={busy}>
        <span>{enabled ? 'Enabled for this chat' : 'Off for this chat'}</span>
        <span class="switch" aria-hidden="true"><span></span></span>
      </button>
      {#if enabled}
        <button class="network" class:on={localNetworkEnabled} onclick={setLocalNetwork} disabled={busy}>
          <span><b>Local network &amp; dev servers</b><small>Loopback, private, and link-local sites</small></span>
          <span>{localNetworkEnabled ? 'on' : 'off'}</span>
        </button>
        <button class="network" class:on={tabsEnabled} onclick={setTabs} disabled={busy}>
          <span><b>Additional tabs</b><small>Each new tab needs a one-use operator approval</small></span>
          <span>{tabsEnabled ? 'on' : 'off'}</span>
        </button>
        <button class="network" class:on={downloadsEnabled} onclick={setDownloads} disabled={busy}>
          <span><b>Downloads</b><small>Inert, quota-bound files owned only by this chat</small></span>
          <span>{downloadsEnabled ? 'on' : 'off'}</span>
        </button>
        {#if publicOriginGrants.length}
          <div class="grants">
            <span class="granthead">Approved public origins</span>
            {#each publicOriginGrants as origin (origin)}
              <div class="grant"><span>{origin}</span><button onclick={() => revokeOrigin(origin)} disabled={busy}>Revoke</button></div>
            {/each}
          </div>
        {/if}
        <div class="actions">
          <button onclick={show} disabled={busy || available === false}>Show browser</button>
          <button class="clear" onclick={clearData} disabled={busy || available === false}>Clear browser data</button>
        </div>
      {/if}
      {#if retainedProfile}<p class="retained">Isolated login data is retained for this agent, even while Browser is off.</p>{/if}
      {#if available === false && reason}<p class="reason bad">{reason}</p>
      {:else if reason}<p class="reason">{reason}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; min-width: 0; }
  .pill-btn.on { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
  .lead, .chev { display: inline-grid; }
  .lead { color: inherit; }
  .chev { opacity: 0.6; }
  .pill-label { white-space: nowrap; }
  .scrim { position: fixed; inset: 0; border: 0; background: transparent; z-index: 10; }
  .menu {
    position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; width: min(360px, 82vw);
    background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-lg);
    padding: var(--space-3); box-shadow: var(--shadow-3), var(--edge-hi);
  }
  .head { display: flex; gap: var(--space-2); align-items: center; font-size: var(--text-sm); font-weight: var(--fw-medium); }
  .warnicon { color: var(--warn); display: inline-grid; }
  .warning { color: var(--muted); font-size: var(--text-xs); line-height: 1.45; margin: var(--space-2) 0 var(--space-3); }
  .toggle { width: 100%; display: flex; justify-content: space-between; align-items: center; padding: var(--space-2); border-radius: var(--r-md); background: var(--surface-3); font-size: var(--text-sm); }
  .switch { width: 30px; height: 17px; border-radius: 99px; padding: 2px; background: var(--border-strong); }
  .switch span { display: block; width: 13px; height: 13px; border-radius: 50%; background: var(--muted); transition: transform var(--dur-fast) var(--ease); }
  .toggle.on .switch { background: color-mix(in srgb, var(--warn) 55%, var(--surface-3)); }
  .toggle.on .switch span { transform: translateX(13px); background: var(--text); }
  .actions { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
  .actions button { padding: var(--space-2); border: 1px solid var(--border); border-radius: var(--r-md); font-size: var(--text-xs); }
  .actions button:hover:not(:disabled) { background: var(--surface-3); }
  .actions .clear { color: var(--bad-text); margin-left: auto; }
  .reason { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--muted); overflow-wrap: anywhere; }
  .reason.bad { color: var(--bad-text); }
  .network { margin-top: var(--space-2); width: 100%; display: flex; justify-content: space-between; align-items: center; text-align: left; padding: var(--space-2); border: 1px solid var(--border); border-radius: var(--r-md); color: var(--muted); font-size: var(--text-xs); }
  .network.on { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
  .network span:first-child { display: flex; flex-direction: column; }
  .network small { color: var(--muted); font-size: 0.68rem; }
  .grants { margin-top: var(--space-2); border-top: 1px solid var(--border); padding-top: var(--space-2); }
  .granthead, .retained { color: var(--muted); font-size: var(--text-xs); }
  .grant { display: flex; gap: var(--space-2); align-items: center; font-size: var(--text-xs); padding-top: var(--space-1); }
  .grant span { overflow: hidden; text-overflow: ellipsis; }
  .grant button { margin-left: auto; color: var(--bad-text); }
  .retained { margin: var(--space-2) 0 0; }
</style>
