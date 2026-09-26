import { describe, expect, it } from 'vitest'
import { addFleetDiscovery } from './fleetDiscovery.js'
import type { FleetSite } from './fleet.js'
import type { DirectMeshPeer, DirectMeshStatus } from './myOwnMeshRpc.js'

const local: FleetSite = { siteId: 'local', label: 'Controller', local: true, baseUrl: 'http://127.0.0.1:7777', online: true }
const healthy: DirectMeshStatus = { available: true, method: 'allmyagents.hub.v1' }
const denied: DirectMeshStatus = { ...healthy, available: false, reason: 'permission-denied' }
const peer: DirectMeshPeer = { siteId: 'ubuntu', label: 'cec-kub', online: true, status: 'active' }
const presence = [{ device: 'ubuntu-SESSION', label: 'cec-kub', sites: [] }]

describe('fleet discovery diagnostics', () => {
  it.each(['not-started', 'connecting', 'no-daemon'] as const)('recovers when the service arrives after the hub (%s)', reason => {
    const down = addFleetDiscovery([local], presence, [], { ...healthy, available: false, reason })
    expect(down[0]?.discoveryIssues?.[0]?.code).toBe(reason)
    expect(down[1]?.discoveryOnly).toBe(true)
    const started = addFleetDiscovery([local], presence, [peer], healthy)
    const serviceFirst = addFleetDiscovery([local], presence, [peer], healthy)
    expect(started).toEqual(serviceFirst)
    expect(started[0]?.discoveryIssues).toBeUndefined()
    expect(started[1]?.directOnline).toBe(true)
  })

  it('distinguishes an empty healthy fleet from control-transport failure', () => {
    expect(addFleetDiscovery([local], [], [], healthy)).toEqual([local])
    expect(addFleetDiscovery([local], [], [], denied)[0]?.discoveryIssues).toEqual([
      expect.objectContaining({ source: 'myownmesh', code: 'permission-denied', message: expect.stringContaining('pairing code cannot repair') }),
    ])
    expect(local.discoveryIssues).toBeUndefined()
  })

  it('shows a shared presence-only machine without inventing a route or application identity', () => {
    const sites = addFleetDiscovery([local], presence, [], denied)
    expect(sites[1]).toMatchObject({ siteId: 'ubuntu', label: 'cec-kub', discoveryOnly: true, online: false, directOnline: false, baseUrl: '', routeCode: 'discovery-unavailable' })
    expect(sites[1]).not.toHaveProperty('authState')
    expect(addFleetDiscovery([local], presence, [], healthy)[1]).toMatchObject({ discoveryOnly: true, routeCode: 'application-unconfirmed' })
  })

  it('does not trust cached online peers when control is unavailable; recovery replaces the diagnostic row', () => {
    expect(addFleetDiscovery([local], presence, [peer], denied)[1]?.directOnline).toBe(false)
    const recovered = addFleetDiscovery([local], presence, [peer], healthy)
    expect(recovered).toHaveLength(2)
    expect(recovered[0]?.discoveryIssues).toBeUndefined()
    expect(recovered[1]).toMatchObject({ siteId: 'ubuntu', directOnline: true })
    expect(recovered[1]?.discoveryOnly).toBeUndefined()
    expect(addFleetDiscovery([local], presence, [{ ...peer, online: false, status: 'offline' }], healthy)[1]?.directOnline).toBe(false)
  })

  it('preserves a healthy owned Site lane when direct IPC fails and does not mutate its input', () => {
    const site: FleetSite = { ...peer, local: false, baseUrl: 'http://127.0.0.1:48123', online: true }
    const result = addFleetDiscovery([local, site], presence, [peer], denied)
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({ online: true, directOnline: false, baseUrl: site.baseUrl })
    expect(site.directOnline).toBeUndefined()
  })

  it('deduplicates canonical identities, ignores empty ones, and never overrides the local row', () => {
    const result = addFleetDiscovery([local], [...presence, { ...presence[0]!, device: 'UBUNTU-OTHER' }, { device: '-bad', sites: [] }], [{ ...peer, siteId: 'local', online: false }], healthy)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(local)
  })

  it('bounds diagnostic rows and retains independently failed discovery sources', () => {
    const failure = { source: 'allmystuff' as const, code: 'roster-unavailable', message: 'roster unavailable' }
    const result = addFleetDiscovery([local], Array.from({ length: 1_000 }, (_, i) => ({ device: `peer${i}`, sites: [] })), [], denied, [failure])
    expect(result).toHaveLength(257)
    expect(result[0]?.discoveryIssues).toHaveLength(2)
    expect(result[0]?.discoveryIssues?.[0]).toEqual(failure)
  })
})
