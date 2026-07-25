import { describe, expect, it } from 'vitest'
import { buildFleet, type BuildFleetDeps } from './fleet.js'
import type { FleetMember } from './meshSite.js'

// A deps builder with sensible fakes; each test overrides just what it exercises. No node, no
// network — the roster/siteMap/probeHealth seams are injected, exactly how the /api/fleet route
// wires them to MeshSite + probeHubHealth in production.
function deps(over: Partial<BuildFleetDeps> = {}): BuildFleetDeps {
  return {
    localSiteId: 'tcp:7777',
    localLabel: 'AllMyAgents',
    localBaseUrl: 'http://127.0.0.1:7777',
    roster: async () => [],
    siteMap: async () => null,
    probeHealth: async () => false,
    ...over,
  }
}

const member = (device: string, label = ''): FleetMember => ({ device, label })

describe('buildFleet (unified-across-mesh roster, first cut)', () => {
  it('no node / empty roster → just this hub as the local entry (single-machine case)', async () => {
    const out = await buildFleet(deps())
    expect(out).toEqual([
      { siteId: 'tcp:7777', label: 'AllMyAgents', local: true, baseUrl: 'http://127.0.0.1:7777', online: true },
    ])
  })

  it('a roster read that throws is swallowed → local-only (never throws into the request path)', async () => {
    const out = await buildFleet(
      deps({
        roster: async () => {
          throw new Error('control-socket timeout')
        },
      })
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.local).toBe(true)
  })

  it('maps each member on the well-known hub port (7777) and probes /api/health for online', async () => {
    const mapped: Array<[string, number]> = []
    const out = await buildFleet(
      deps({
        roster: async () => [member('nodeB', 'Workstation')],
        siteMap: async (node, port) => {
          mapped.push([node, port])
          return 41000
        },
        probeHealth: async (base) => base === 'http://localhost:41000',
      })
    )
    expect(mapped).toEqual([['nodeB', 7777]])
    expect(out).toEqual([
      { siteId: 'tcp:7777', label: 'AllMyAgents', local: true, baseUrl: 'http://127.0.0.1:7777', online: true },
      { siteId: 'nodeB', label: 'Workstation', local: false, baseUrl: 'http://localhost:41000', online: true },
    ])
  })

  it('a member whose map fails (self → "that\'s this device", or an offline peer) is dropped', async () => {
    // Node returns null for self and for the unreachable peer, a port for the good one.
    const ports: Record<string, number | null> = { self: null, dead: null, good: 42000 }
    const out = await buildFleet(
      deps({
        roster: async () => [member('self', 'This PC'), member('dead', 'Laptop'), member('good', 'NAS')],
        siteMap: async (node) => ports[node] ?? null,
        probeHealth: async () => true,
      })
    )
    expect(out.map((s) => s.siteId)).toEqual(['tcp:7777', 'good'])
  })

  it('a mapped peer that does NOT answer /api/health is listed but online:false (client skips polling it)', async () => {
    const out = await buildFleet(
      deps({
        roster: async () => [member('nodeC', 'Media box')],
        siteMap: async () => 43000,
        probeHealth: async () => false, // mapped a port, but no hub answered
      })
    )
    expect(out[1]).toEqual({ siteId: 'nodeC', label: 'Media box', local: false, baseUrl: 'http://localhost:43000', online: false })
  })

  it('falls back to a short node-id label when the member label is empty', async () => {
    const out = await buildFleet(
      deps({
        roster: async () => [member('abcdef0123456789', '')],
        siteMap: async () => 44000,
        probeHealth: async () => true,
      })
    )
    expect(out[1]?.label).toBe('abcdef01')
  })

  it('a per-member map error is isolated — other members still resolve', async () => {
    const out = await buildFleet(
      deps({
        roster: async () => [member('boom', 'Boom'), member('ok', 'Ok')],
        siteMap: async (node) => {
          if (node === 'boom') throw new Error('map exploded')
          return 45000
        },
        probeHealth: async () => true,
      })
    )
    expect(out.map((s) => s.siteId)).toEqual(['tcp:7777', 'ok'])
  })

  it('the local entry is always present and first, even with remotes', async () => {
    const out = await buildFleet(
      deps({
        roster: async () => [member('n1', 'One'), member('n2', 'Two')],
        siteMap: async () => 46000,
        probeHealth: async () => true,
      })
    )
    expect(out[0]?.local).toBe(true)
    expect(out.filter((s) => s.local)).toHaveLength(1)
  })
})
