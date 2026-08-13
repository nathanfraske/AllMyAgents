import type {
  DeviceExecutorCapabilities,
  FleetSite,
  RemoteDeviceCatalogEntry,
} from './api'

export type DeviceRole = 'hub' | 'testbed'

export interface DeviceOverviewEntry {
  siteId: string
  label: string
  local: boolean
  roles: DeviceRole[]
  online: boolean
  hubOnline?: boolean
  directOnline?: boolean
  directRttMs?: number
  testbedOnline?: boolean
  capabilities?: DeviceExecutorCapabilities
  error?: string
}

function addRole(roles: DeviceRole[], role: DeviceRole): DeviceRole[] {
  return roles.includes(role) ? roles : [...roles, role]
}

/**
 * Join the hub roster and paired executor catalog by their durable site id. A full hub may also be
 * an authorized testbed, while a lightweight node intentionally appears only as a testbed.
 */
export function buildDeviceOverview(
  fleet: readonly FleetSite[],
  localCapabilities: DeviceExecutorCapabilities | null,
  remoteCatalog: readonly RemoteDeviceCatalogEntry[],
): DeviceOverviewEntry[] {
  const entries = new Map<string, DeviceOverviewEntry>()

  for (const site of fleet) {
    entries.set(site.siteId, {
      siteId: site.siteId,
      label: site.label,
      local: site.local,
      roles: ['hub'],
      online: site.local || site.online || site.directOnline === true,
      hubOnline: site.local || site.online || site.directOnline === true,
      directOnline: site.directOnline,
      directRttMs: site.directRttMs,
      error: site.routeError,
    })
  }

  const local = fleet.find((site) => site.local)
  if (local && localCapabilities) {
    const current = entries.get(local.siteId)!
    entries.set(local.siteId, {
      ...current,
      roles: localCapabilities.enabled || (localCapabilities.roots?.length ?? 0) > 0
        ? addRole(current.roles, 'testbed')
        : current.roles,
      testbedOnline: localCapabilities.enabled,
      capabilities: localCapabilities,
    })
  } else if (!local && localCapabilities) {
    // Settings may render before the asynchronous fleet roster arrives. The local capability endpoint is
    // itself authoritative enough to keep this machine visible rather than flashing an empty inventory.
    entries.set('__local__', {
      siteId: '__local__',
      label: localCapabilities.hostname || 'This machine',
      local: true,
      roles: localCapabilities.enabled || (localCapabilities.roots?.length ?? 0) > 0 ? ['hub', 'testbed'] : ['hub'],
      online: true,
      hubOnline: true,
      testbedOnline: localCapabilities.enabled,
      capabilities: localCapabilities,
    })
  }

  for (const device of remoteCatalog) {
    const current = entries.get(device.siteId)
    const capabilities = device.capabilities
    // Receiving capabilities proves the control route answered even when the operator deliberately
    // disabled execution. `connected` remains the narrower "usable as a testbed now" signal.
    const reachable = capabilities !== undefined
    const isLightweight = capabilities?.nodeKind === 'lightweight-testbed'
    let roles = current?.roles ?? []
    if (!isLightweight) roles = addRole(roles, 'hub')
    if (isLightweight || capabilities?.enabled || (capabilities?.roots?.length ?? 0) > 0) {
      roles = addRole(roles, 'testbed')
    }
    entries.set(device.siteId, {
      siteId: device.siteId,
      label: current?.label ?? device.label,
      local: current?.local ?? false,
      roles,
      online: current?.online === true || reachable,
      hubOnline: current?.hubOnline,
      directOnline: current?.directOnline,
      directRttMs: current?.directRttMs,
      testbedOnline: device.connected,
      capabilities,
      // A successful capability response with execution disabled is policy state, not a connection
      // error. The card reports it as "Testbed disabled" instead of alarming the operator.
      error: reachable ? current?.error : (device.error ?? current?.error),
    })
  }

  return [...entries.values()].sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1
    if (a.online !== b.online) return a.online ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}

export function formatMemory(bytes?: number): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null
  const gibibytes = bytes / (1024 ** 3)
  return `${gibibytes >= 10 ? Math.round(gibibytes) : Math.round(gibibytes * 10) / 10} GB RAM`
}

export function formatPlatform(platform?: string, arch?: string): string | null {
  if (!platform && !arch) return null
  const names: Record<string, string> = {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux',
  }
  const platformLabel = platform ? (names[platform] ?? platform) : ''
  return [platformLabel, arch].filter(Boolean).join(' · ')
}
