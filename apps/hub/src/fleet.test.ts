import { describe, expect, it } from 'vitest'
import { buildFleet, rosterAuthorizesDevice, type BuildFleetDeps } from './fleet.js'
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
    peerSites: async () => [],
    siteMap: async () => null,
    probeHealth: async () => false,
    ...over,
  }
}

const member = (device: string, label = ''): FleetMember => ({ device, label })
const advertised = (device: string, port: number, label = 'AllMyAgents') => ({
  device,
  sites: [{ id: `tcp:${port}`, label, port }],
})

describe('signed fleet admission', () => {
  it('matches canonical device identity while refusing sighted identities absent from the roster', () => {
    const roster = [member('abcdef-AB123', 'Owned')]
    expect(rosterAuthorizesDevice(roster, 'ABCDEF-other')).toBe(true)
    expect(rosterAuthorizesDevice(roster, 'abcdef')).toBe(true)
    expect(rosterAuthorizesDevice(roster, 'sighted-peer')).toBe(false)
  })
})

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
        peerSites: async () => [advertised('nodeB', 7777)],
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
        peerSites: async () => [
          advertised('self', 7777),
          advertised('dead', 7777),
          advertised('good', 7777),
        ],
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
        peerSites: async () => [advertised('nodeC', 7777)],
        siteMap: async () => 43000,
        probeHealth: async () => false, // mapped a port, but no hub answered
      })
    )
    expect(out[1]).toEqual({
      siteId: 'nodeC',
      label: 'Media box',
      local: false,
      baseUrl: 'http://localhost:43000',
      online: false,
      routeError: expect.stringMatching(/advertises an AllMyAgents hub.*health did not answer/u),
    })
  })

  it('falls back to a short node-id label when the member label is empty', async () => {
    const out = await buildFleet(
      deps({
        roster: async () => [member('abcdef0123456789', '')],
        peerSites: async () => [advertised('abcdef0123456789', 7777)],
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
        peerSites: async () => [advertised('boom', 7777), advertised('ok', 7777)],
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
        peerSites: async () => [advertised('n1', 7777), advertised('n2', 7777)],
        siteMap: async () => 46000,
        probeHealth: async () => true,
      })
    )
    expect(out[0]?.local).toBe(true)
    expect(out.filter((s) => s.local)).toHaveLength(1)
  })

  it('discovers a hub on its advertised non-default port with no configured peerPorts', async () => {
    const mapped: Array<[string, number]> = []
    const out = await buildFleet(
      deps({
        roster: async () => [member('nodeB', 'Workstation')],
        peerSites: async () => [advertised('nodeB-AB123', 8123, 'AllMyAgents — editing rig')],
        siteMap: async (node, port) => {
          mapped.push([node, port])
          return 47001
        },
        probeHealth: async () => true,
      })
    )
    expect(mapped).toEqual([['nodeB', 8123]])
    expect(out[1]).toMatchObject({ siteId: 'nodeB', baseUrl: 'http://localhost:47001', online: true })
  })

  it('does not map or probe a fleet machine that advertises no AllMyAgents hub', async () => {
    const mapped: Array<[string, number]> = []
    const probed: string[] = []
    const out = await buildFleet(
      deps({
        roster: async () => [member('fileserver', 'File server')],
        peerSites: async () => [
          {
            device: 'fileserver-FFFFF',
            sites: [
              { id: 'tcp:8080', label: 'Grafana', port: 8080 },
              { id: 'tcp:5432', label: 'PostgreSQL', port: 5432 },
            ],
          },
        ],
        siteMap: async (node, port) => {
          mapped.push([node, port])
          return 47002
        },
        probeHealth: async (base) => {
          probed.push(base)
          return false
        },
      })
    )
    expect(out).toHaveLength(1)
    expect(mapped).toEqual([])
    expect(probed).toEqual([])
  })

  it('accepts the legacy "AllMyAgents hub" advert label', async () => {
    const mapped: number[] = []
    const out = await buildFleet(
      deps({
        roster: async () => [member('legacy')],
        peerSites: async () => [advertised('legacy-12345', 7999, 'AllMyAgents hub')],
        siteMap: async (_node, port) => {
          mapped.push(port)
          return 47003
        },
        probeHealth: async () => true,
      })
    )
    expect(mapped).toEqual([7999])
    expect(out[1]?.online).toBe(true)
  })

  it('keeps configured peerPorts as an explicit fallback when presence has no hub advert', async () => {
    const mapped: number[] = []
    const out = await buildFleet(
      deps({
        roster: async () => [member('old-node', 'Old node')],
        peerSites: async () => [],
        extraPorts: [7888, 7999, 7888],
        siteMap: async (_node, port) => {
          mapped.push(port)
          return port === 7999 ? 47004 : 47005
        },
        probeHealth: async (base) => base === 'http://localhost:47004',
      })
    )
    expect(mapped).toEqual([7888, 7999])
    expect(out[1]).toMatchObject({ baseUrl: 'http://localhost:47004', online: true })
  })

  it('discovers more than two hubs independently from their own adverts', async () => {
    const mapped: Array<[string, number]> = []
    const out = await buildFleet(
      deps({
        roster: async () => [member('one'), member('two'), member('three')],
        peerSites: async () => [
          advertised('one-A', 7777),
          advertised('two-B', 8123),
          advertised('three-C', 9000),
        ],
        siteMap: async (node, port) => {
          mapped.push([node, port])
          return 47_000 + port % 1000
        },
        probeHealth: async () => true,
      })
    )
    expect(mapped.sort()).toEqual([
      ['one', 7777],
      ['three', 9000],
      ['two', 8123],
    ])
    expect(out.filter((s) => !s.local && s.online)).toHaveLength(3)
  })

  it('keeps a known but unreachable hub listed offline and sees it on the next refresh when it returns', async () => {
    let online = false
    const shared = deps({
      roster: async () => [member('sleepy', 'Laptop')],
      peerSites: async () => [advertised('sleepy-ABCDE', 8111)],
      siteMap: async () => 47011,
      probeHealth: async () => online,
    })
    const asleep = await buildFleet(shared)
    expect(asleep[1]).toMatchObject({ siteId: 'sleepy', online: false })
    online = true
    const awake = await buildFleet(shared)
    expect(awake[1]).toMatchObject({ siteId: 'sleepy', online: true })
  })

  it('replaces a mapped-but-silent tunnel once and probes the replacement port', async () => {
    const probes: string[] = []
    const recovered: Array<[string, number]> = []
    const out = await buildFleet(deps({
      roster: async () => [member('peer', 'Remote PC')],
      peerSites: async () => [advertised('peer-AAAA', 7777)],
      siteMap: async () => 47020,
      recoverSiteMap: async (node, port) => {
        recovered.push([node, port])
        return 47021
      },
      probeHealth: async (base) => {
        probes.push(base)
        return base.endsWith(':47021')
      },
    }))

    expect(recovered).toEqual([['peer', 7777]])
    expect(probes).toEqual(['http://localhost:47020', 'http://localhost:47021'])
    expect(out[1]).toMatchObject({ baseUrl: 'http://localhost:47021', online: true })
  })
})
