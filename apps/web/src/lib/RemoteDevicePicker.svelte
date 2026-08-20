<script lang="ts">
  import { api, type RemoteDeviceCapability, type RemoteDeviceCatalogEntry, type RemoteDeviceGrant, type SessionRecord } from './api'
  import Icon from './Icon.svelte'

  let {
    sessionId,
    grants = [],
    onchange,
  }: {
    sessionId: string
    grants?: RemoteDeviceGrant[]
    onchange?: (record: SessionRecord) => void
  } = $props()

  let open = $state(false)
  let loading = $state(false)
  let saving = $state(false)
  let authorizing = $state('')
  let error = $state('')
  let catalog = $state<RemoteDeviceCatalogEntry[]>([])
  let selected = $state<Record<string, RemoteDeviceCapability[]>>({})

  const keyOf = (siteId: string, rootId: string): string => `${siteId}\u0000${rootId}`
  const grantCount = $derived(Object.values(selected).filter((capabilities) => capabilities.length > 0).length)

  $effect(() => {
    const next: Record<string, RemoteDeviceCapability[]> = {}
    for (const grant of grants) {
      for (const rootId of grant.rootIds) {
        const key = keyOf(grant.siteId, rootId)
        next[key] = [...new Set([...(next[key] ?? []), ...grant.capabilities])]
      }
    }
    selected = next
  })

  async function show(): Promise<void> {
    open = true
    loading = true
    error = ''
    catalog = []
    try {
      const value = await api.remoteDeviceCatalog(sessionId)
      if (!Array.isArray(value)) {
        error = (value as { error?: string }).error ?? 'Could not load paired testbeds.'
        return
      }
      catalog = value
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading = false
    }
  }

  function has(siteId: string, rootId: string, capability: RemoteDeviceCapability): boolean {
    return selected[keyOf(siteId, rootId)]?.includes(capability) === true
  }

  function toggle(siteId: string, rootId: string, capability: RemoteDeviceCapability, enabled: boolean): void {
    const key = keyOf(siteId, rootId)
    const values = new Set(selected[key] ?? [])
    if (enabled) values.add(capability)
    else values.delete(capability)
    selected = { ...selected, [key]: [...values] }
  }

  function hasDeviceGrant(siteId: string): boolean {
    return grants.some((grant) => grant.siteId === siteId)
  }

  async function authorize(device: RemoteDeviceCatalogEntry): Promise<void> {
    authorizing = device.siteId
    error = ''
    try {
      const result = await api.authorizeRemoteDevice(sessionId, device.siteId)
      if ('error' in result) {
        error = result.error
        return
      }
      onchange?.(result)
      open = false
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      authorizing = ''
    }
  }

  async function revokeDevice(siteId: string): Promise<void> {
    saving = true
    error = ''
    try {
      const result = await api.setRemoteDeviceGrants(sessionId, grants.filter((grant) => grant.siteId !== siteId))
      if ('error' in result) {
        error = result.error
        return
      }
      onchange?.(result)
      open = false
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      saving = false
    }
  }

  async function save(clear = false): Promise<void> {
    saving = true
    error = ''
    const next: RemoteDeviceGrant[] = []
    if (!clear) {
      for (const device of catalog) {
        if (!device.capabilities) {
          next.push(...grants.filter((grant) => grant.siteId === device.siteId))
          continue
        }
        for (const root of device.capabilities?.roots ?? []) {
          const capabilities = selected[keyOf(device.siteId, root.id)] ?? []
          if (capabilities.length) next.push({ siteId: device.siteId, rootIds: [root.id], capabilities })
        }
      }
    }
    try {
      const result = await api.setRemoteDeviceGrants(sessionId, next)
      if ('error' in result) {
        error = result.error
        return
      }
      onchange?.(result)
      selected = clear ? {} : selected
      open = false
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      saving = false
    }
  }
</script>

<div class="wrap">
  <button class="pill-btn" class:granted={grantCount > 0} title="Remote testbed access" onclick={() => open ? (open = false) : void show()}>
    <span class="lead"><Icon name="server" size={13} /></span>
    <span class="pill-label">Devices{grantCount ? ` ${grantCount}` : ''}</span>
    <span class="chev"><Icon name="chevron-down" size={12} /></span>
  </button>
  {#if open}
    <button class="scrim" onclick={() => (open = false)} aria-label="close"></button>
    <div class="menu">
      <div class="heading">Remote testbeds</div>
      <p class="note">Authorize a testbed once to grant this chat every root and operation that device exposes. Project chats prepare and keep an app-owned checkout at the published primary revision automatically.</p>
      {#if loading}
        <div class="empty">Checking paired machines...</div>
      {:else if !catalog.length}
        <div class="empty">No testbeds are paired with this hub. Pair and authorize one in Settings / Remote access.</div>
      {:else}
        <div class="devices">
          {#each catalog as device (device.siteId)}
            <div class="device">
              <div class="device-head">
                <span>
                  {device.label}
                  {#if device.capabilities?.nodeKind === 'lightweight-testbed'}
                    <small>{device.capabilities.elevated ? 'elevated node' : 'testbed node'}</small>
                  {/if}
                </span>
                <span class:online={device.connected} class="state">{device.connected ? 'online' : 'unavailable'}</span>
              </div>
              {#if device.error}<div class="device-error">{device.error}</div>{/if}
              <div class="authorize-row">
                {#if hasDeviceGrant(device.siteId)}
                  <span>Full testbed access is saved for this chat.</span>
                  <button class="revoke" disabled={saving || authorizing !== ''} onclick={() => revokeDevice(device.siteId)}>Revoke</button>
                {:else}
                  <span>All advertised host and WSL roots · read, write, and terminal where supported.</span>
                  <button class="authorize" disabled={!device.connected || authorizing !== ''} onclick={() => authorize(device)}>
                    {authorizing === device.siteId ? 'Authorizing…' : 'Authorize testbed'}
                  </button>
                {/if}
              </div>
              <details class="advanced">
                <summary>Advanced root controls</summary>
                {#each device.capabilities?.roots ?? [] as root (root.id)}
                  <div class="root">
                    <div class="root-name" title={root.path}>{root.label}<span>{root.environment?.kind === 'wsl' ? `WSL ${root.environment.distro} · ${root.path}` : `host · ${root.path}`}</span></div>
                    <div class="caps">
                      {#each ['read', 'write', 'terminal'] as capability}
                        {@const cap = capability as RemoteDeviceCapability}
                        <label class:disabled={!root[cap]}>
                          <input type="checkbox" disabled={!device.connected || !root[cap]} checked={has(device.siteId, root.id, cap)} onchange={(event) => toggle(device.siteId, root.id, cap, (event.target as HTMLInputElement).checked)} />
                          {cap}
                        </label>
                      {/each}
                    </div>
                  </div>
                {/each}
              </details>
            </div>
          {/each}
        </div>
      {/if}
      {#if error}<div class="error" role="alert">{error}</div>{/if}
      <div class="actions">
        {#if grants.length}<button class="revoke" disabled={saving || authorizing !== ''} onclick={() => save(true)}>Revoke all</button>{/if}
        <button class="save" disabled={saving || authorizing !== '' || loading || !catalog.length} onclick={() => save(false)}>{saving ? 'Saving...' : 'Save advanced changes'}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; min-width: 0; }
  .pill-btn.granted { color: var(--cyan); border-color: color-mix(in srgb, var(--cyan) 45%, transparent); }
  .pill-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lead, .chev { display: inline-grid; }
  .chev { opacity: .6; }
  .scrim { position: fixed; inset: 0; border: 0; background: transparent; z-index: 20; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 21; width: min(440px, calc(100vw - 2rem)); max-height: min(540px, 72vh); overflow: auto; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-lg); box-shadow: var(--shadow-3), var(--edge-hi); padding: var(--space-3); }
  .heading { font-weight: var(--fw-medium); font-size: var(--text-sm); }
  .note, .empty { color: var(--muted); font-size: var(--text-xs); line-height: 1.45; }
  .note { margin: var(--space-1) 0 var(--space-3); }
  .devices { display: grid; gap: var(--space-3); }
  .device { border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; }
  .device-head { display: flex; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-3); background: var(--surface-3); font-size: var(--text-sm); }
  .device-head > span:first-child { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  .device-head small { color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 5px; font-size: var(--text-2xs); white-space: nowrap; }
  .state { color: var(--muted); font-size: var(--text-2xs); }
  .state.online { color: var(--ok); }
  .device-error, .error { color: var(--bad-text); font-size: var(--text-xs); padding: var(--space-2) var(--space-3); }
  .authorize-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3); color: var(--muted); font-size: var(--text-xs); }
  .authorize-row button { flex: none; border: 1px solid var(--border); border-radius: var(--r-sm); padding: var(--space-1) var(--space-3); }
  .authorize { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)) !important; }
  .advanced { border-top: 1px solid var(--border-subtle); }
  .advanced summary { cursor: pointer; padding: var(--space-2) var(--space-3); color: var(--muted); font-size: var(--text-2xs); }
  .root { padding: var(--space-3); border-top: 1px solid var(--border-subtle); }
  .root-name { display: flex; flex-direction: column; font-size: var(--text-xs); }
  .root-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-family: var(--mono); font-size: var(--text-2xs); }
  .caps { display: flex; gap: var(--space-3); margin-top: var(--space-2); }
  .caps label { display: flex; align-items: center; gap: var(--space-1); font-size: var(--text-xs); }
  .caps label.disabled { opacity: .4; }
  .actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
  .actions button { border: 1px solid var(--border); border-radius: var(--r-sm); padding: var(--space-1) var(--space-3); font-size: var(--text-xs); }
  .save { color: var(--accent); }
  .revoke { margin-right: auto; color: var(--bad-text); }
</style>
