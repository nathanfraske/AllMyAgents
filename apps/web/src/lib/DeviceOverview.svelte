<script lang="ts">
  import type { DeviceExecutorCapabilities, FleetSite, RemoteDeviceCatalogEntry } from './api'
  import { buildDeviceOverview, formatMemory, formatPlatform } from './deviceOverview'
  import Icon from './Icon.svelte'

  let {
    fleet = [],
    localCapabilities = null,
    remoteCatalog = [],
    loading = false,
  }: {
    fleet?: FleetSite[]
    localCapabilities?: DeviceExecutorCapabilities | null
    remoteCatalog?: RemoteDeviceCatalogEntry[]
    loading?: boolean
  } = $props()

  const devices = $derived(buildDeviceOverview(fleet, localCapabilities, remoteCatalog))

  function deploymentLabel(capabilities: DeviceExecutorCapabilities): string | null {
    if (capabilities.deploymentProfile === 'scoped') return 'Scoped node'
    if (capabilities.deploymentProfile === 'full-machine') return 'Full-machine node'
    if (capabilities.deploymentProfile === 'elevated-machine') return 'Elevated node'
    if (capabilities.deploymentProfile === 'linux-sudo-machine') return 'Passwordless sudo'
    return capabilities.elevated ? 'Elevated' : null
  }

  function environmentSummary(capabilities: DeviceExecutorCapabilities): string {
    const values = [...new Set((capabilities.environments ?? []).map((environment) =>
      environment.kind === 'wsl' ? environment.label : 'Host'))]
    if (values.length === 0) return 'Host'
    if (values.length <= 3) return values.join(' · ')
    return `${values.slice(0, 2).join(' · ')} · +${values.length - 2} more`
  }
</script>

<div class="overview" aria-label="Connected device overview">
  <div class="overview-summary">
    <div>
      <strong>{devices.length} {devices.length === 1 ? 'device' : 'devices'}</strong>
      <span>{devices.filter((device) => device.online).length} reachable now</span>
    </div>
    <div class="summary-roles">
      <span>{devices.filter((device) => device.roles.includes('hub')).length} hubs</span>
      <span>{devices.filter((device) => device.roles.includes('testbed')).length} testbeds</span>
    </div>
  </div>

  {#if loading && devices.length === 0}
    <div class="empty">Discovering hubs and testbeds…</div>
  {:else if devices.length === 0}
    <div class="empty">No devices have been discovered yet.</div>
  {:else}
    <div class="device-grid">
      {#each devices as device (device.siteId)}
        {@const capabilities = device.capabilities}
        {@const platform = formatPlatform(capabilities?.platform, capabilities?.arch)}
        {@const memory = formatMemory(capabilities?.totalMemoryBytes)}
        {@const deployment = capabilities ? deploymentLabel(capabilities) : null}
        <article class="device-card" class:offline={!device.online}>
          <header>
            <span class="device-icon"><Icon name={device.local ? 'monitor' : 'server'} size={17} /></span>
            <span class="identity">
              <strong>{device.label}</strong>
              <small>{device.local ? `This machine${capabilities?.hostname ? ` · ${capabilities.hostname}` : ''}` : capabilities?.hostname || device.siteId.slice(0, 12)}</small>
            </span>
            <span class="reachability" class:online={device.online}>{device.online ? 'online' : 'offline'}</span>
          </header>

          <div class="roles">
            {#each device.roles as role}
              <span class="role" class:testbed={role === 'testbed'}>{role === 'hub' ? 'Hub' : 'Testbed'}</span>
            {/each}
            {#if device.roles.length === 0}<span class="role unknown">Role unavailable</span>{/if}
            {#if deployment}<span class="role elevated">{deployment}</span>{/if}
          </div>

          <div class="facts">
            {#if platform}<span>{platform}</span>{/if}
            {#if capabilities?.cpuCount}<span>{capabilities.cpuCount} logical CPUs</span>{/if}
            {#if memory}<span>{memory}</span>{/if}
            {#if device.directRttMs !== undefined}<span>{device.directRttMs} ms route</span>{/if}
          </div>

          {#if capabilities}
            <div class="availability">
              {#if device.roles.includes('testbed')}
                <span class:available={capabilities.enabled}>
                  Testbed {capabilities.enabled ? 'ready' : 'disabled'}
                </span>
              {/if}
              <span>{capabilities.roots?.length ?? 0} authorized {(capabilities.roots?.length ?? 0) === 1 ? 'root' : 'roots'}</span>
              <span>{environmentSummary(capabilities)}</span>
            </div>
          {:else if device.roles.includes('hub') && !device.local}
            <div class="availability"><span>Link this Hub to inspect its testbed hardware and policy.</span></div>
          {/if}

          {#if device.error}<p class="device-error">{device.error}</p>{/if}
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .overview { display: grid; gap: var(--space-3); }
  .overview-summary { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .overview-summary > div { display: flex; align-items: baseline; gap: var(--space-2); }
  .overview-summary strong { font-size: var(--text-sm); }
  .overview-summary span { color: var(--muted); font-size: var(--text-xs); }
  .summary-roles { flex-wrap: wrap; justify-content: flex-end; }
  .device-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr)); gap: var(--space-3); }
  .device-card { min-width: 0; border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--space-3); background: var(--surface-1); box-shadow: var(--edge-hi); }
  .device-card.offline { opacity: .72; }
  header { display: flex; align-items: center; gap: var(--space-2); }
  .device-icon { display: inline-grid; place-items: center; width: 2rem; height: 2rem; flex: 0 0 auto; border-radius: var(--r-md); color: var(--cyan); background: color-mix(in srgb, var(--cyan) 10%, transparent); }
  .identity { display: flex; flex-direction: column; min-width: 0; }
  .identity strong, .identity small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .identity strong { font-size: var(--text-sm); }
  .identity small { color: var(--muted); font-family: var(--mono); font-size: var(--text-2xs); }
  .reachability { margin-left: auto; color: var(--muted); font-size: var(--text-2xs); }
  .reachability::before { content: ''; display: inline-block; width: .42rem; height: .42rem; margin-right: var(--space-1); border-radius: 50%; background: currentColor; }
  .reachability.online { color: var(--ok); }
  .roles, .facts, .availability { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-2); }
  .roles { margin-top: var(--space-3); }
  .role { border: 1px solid color-mix(in srgb, var(--cyan) 35%, var(--border)); border-radius: 999px; padding: .08rem .42rem; color: var(--cyan); font-size: var(--text-2xs); }
  .role.testbed { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 38%, var(--border)); }
  .role.elevated { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 38%, var(--border)); }
  .role.unknown { color: var(--muted); border-color: var(--border); }
  .facts { margin-top: var(--space-3); color: var(--text); font-size: var(--text-xs); }
  .facts span:not(:last-child)::after { content: '·'; margin-left: var(--space-2); color: var(--muted); }
  .availability { margin-top: var(--space-2); color: var(--muted); font-size: var(--text-2xs); line-height: 1.45; }
  .availability .available { color: var(--ok); }
  .device-error { margin: var(--space-2) 0 0; color: var(--bad-text); font-size: var(--text-2xs); line-height: 1.4; }
  .empty { padding: var(--space-4); border: 1px dashed var(--border); border-radius: var(--r-lg); color: var(--muted); font-size: var(--text-xs); text-align: center; }
  @media (max-width: 560px) {
    .overview-summary { align-items: flex-start; }
    .overview-summary, .overview-summary > div { flex-direction: column; }
    .summary-roles { align-items: flex-end; }
  }
</style>
