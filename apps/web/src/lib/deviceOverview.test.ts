import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import type { DeviceExecutorCapabilities, FleetSite, RemoteDeviceCatalogEntry } from './api'
import { buildDeviceOverview, formatMemory, formatPlatform } from './deviceOverview'
import DeviceOverview from './DeviceOverview.svelte'

const localCaps: DeviceExecutorCapabilities = {
  enabled: true,
  platform: 'win32',
  arch: 'x64',
  hostname: 'desktop',
  cpuCount: 16,
  totalMemoryBytes: 32 * 1024 ** 3,
  environments: [{ id: 'host', kind: 'host', label: 'Windows host', platform: 'win32', arch: 'x64', shell: 'powershell' }],
  roots: [{ id: 'root', label: 'repo', path: 'C:/repo', read: true, write: true, terminal: true }],
}

describe('device overview', () => {
  it('merges a paired executor into its fleet hub while keeping lightweight nodes separate', () => {
    const fleet: FleetSite[] = [
      { siteId: 'local', label: 'Desktop', local: true, baseUrl: 'http://127.0.0.1:7777', online: true },
      { siteId: 'laptop', label: 'Laptop', local: false, baseUrl: '', online: false, directOnline: true, directRttMs: 14 },
    ]
    const catalog: RemoteDeviceCatalogEntry[] = [
      { siteId: 'laptop', label: 'Laptop executor', paired: true, updatedAt: 'now', connected: true, capabilities: { ...localCaps, hostname: 'laptop' } },
      {
        siteId: 'arm-node', label: 'ARM test rig', paired: true, updatedAt: 'now', connected: true,
        capabilities: { ...localCaps, hostname: 'arm-node', arch: 'arm64', nodeKind: 'lightweight-testbed' },
      },
    ]

    const overview = buildDeviceOverview(fleet, localCaps, catalog)

    expect(overview).toHaveLength(3)
    expect(overview[0]).toMatchObject({ siteId: 'local', local: true, roles: ['hub', 'testbed'] })
    expect(overview.find((device) => device.siteId === 'laptop')).toMatchObject({
      label: 'Laptop', roles: ['hub', 'testbed'], hubOnline: true, testbedOnline: true, directRttMs: 14,
    })
    expect(overview.find((device) => device.siteId === 'arm-node')).toMatchObject({ roles: ['testbed'], online: true })
  })

  it('keeps an unlinked hub visible and formats bounded hardware facts', () => {
    const overview = buildDeviceOverview([
      { siteId: 'remote', label: 'Sleeping hub', local: false, baseUrl: '', online: false, routeError: 'route unavailable' },
    ], null, [])
    expect(overview[0]).toMatchObject({ roles: ['hub'], online: false, error: 'route unavailable' })
    expect(formatPlatform('linux', 'riscv64')).toBe('Linux · riscv64')
    expect(formatMemory(8 * 1024 ** 3)).toBe('8 GB RAM')
    expect(formatMemory(undefined)).toBeNull()
  })

  it('treats a disabled executor that answered as reachable policy state, not an error', () => {
    const overview = buildDeviceOverview([], null, [{
      siteId: 'node',
      label: 'Disabled node',
      paired: true,
      updatedAt: 'now',
      connected: false,
      error: 'Testbed access is disabled on this device.',
      capabilities: { ...localCaps, enabled: false, nodeKind: 'lightweight-testbed', roots: [] },
    }])
    expect(overview[0]).toMatchObject({ online: true, testbedOnline: false, roles: ['testbed'] })
    expect(overview[0]?.error).toBeUndefined()
  })

  it('keeps this machine visible while the fleet roster is still loading', () => {
    expect(buildDeviceOverview([], localCaps, [])).toEqual([
      expect.objectContaining({ siteId: '__local__', label: 'desktop', local: true, online: true, roles: ['hub', 'testbed'] }),
    ])
  })

  it('fails soft when an older or malformed peer omits optional collection fields', () => {
    const partial = {
      enabled: false,
      platform: 'linux',
      arch: 'arm64',
      hostname: 'legacy-node',
    } as DeviceExecutorCapabilities
    expect(() => buildDeviceOverview([], partial, [])).not.toThrow()
    expect(buildDeviceOverview([], partial, [
      { siteId: 'legacy-peer', label: 'Legacy peer', paired: true, updatedAt: 'now', connected: false, capabilities: partial },
    ])).toHaveLength(2)
  })

  it('renders roles and readable hardware facts without exposing a full opaque id', () => {
    render(DeviceOverview, {
      props: {
        fleet: [{ siteId: 'opaque-id-that-should-not-be-rendered-in-full', label: 'Build workstation', local: true, baseUrl: '', online: true }],
        localCapabilities: localCaps,
      },
    })
    expect(screen.getByText('Build workstation')).toBeTruthy()
    expect(screen.getByText('Hub')).toBeTruthy()
    expect(screen.getByText('Testbed')).toBeTruthy()
    expect(screen.getByText('Windows · x64')).toBeTruthy()
    expect(screen.getByText('16 logical CPUs')).toBeTruthy()
    expect(screen.getByText('32 GB RAM')).toBeTruthy()
    expect(screen.queryByText('opaque-id-that-should-not-be-rendered-in-full')).toBeNull()
    cleanup()
  })
})
