import http from 'node:http'
import type { FleetMember, PeerSites } from './meshSite.js'

/**
 * Unified-across-mesh fleet discovery and route health.
 *
 * `buildFleet` turns the node's fleet directory + cached presence adverts into the list
 * `GET /api/fleet` returns: always THIS hub as a `local:true` entry, plus each co-owned peer that
 * advertises an AllMyAgents site. Presence carries the peer's actual port, so a hub displaced from
 * 7777 is found without a sweep. It's pure over injected deps so discovery is unit-tested without a
 * node or network (see fleet.test.ts).
 */

export interface FleetSite {
  /**
   * Stable id for this site. The local hub's `tcp:<port>` siteId, or a peer's canonical node id.
   * The web client prefixes each project/session id it pulls from a site with `${siteId}:` — for
   * origin attribution and mutation routing to the owning hub.
   */
  siteId: string
  /** Human label to badge rows with (the fleet member's label, or the local hub's mesh label). */
  label: string
  /** True for THIS hub — the client keeps driving it over its existing base + live WS, unbadged. */
  local: boolean
  /** `http://127.0.0.1:<port>` for local; `http://localhost:<localPort>` for a mapped peer. */
  baseUrl: string
  /** Whether a hub answered `/api/health` here. The client polls only remote + online sites. */
  online: boolean
  /** Bounded operator-facing diagnosis when presence/mapping succeeded but hub health did not. */
  routeError?: string
  /** A site-free MyOwnMesh RPC control lane is active even if the TCP Site tunnel is not. */
  directOnline?: boolean
  directStatus?: string
  directRttMs?: number
}

export interface BuildFleetDeps {
  /** THIS hub's site id (`mesh.status().siteId`, i.e. `tcp:<port>`). */
  localSiteId: string
  /** THIS hub's label (`mesh.status().label`). */
  localLabel: string
  /** THIS hub's own origin (`http://127.0.0.1:<port>`) — informational; the client ignores it for local. */
  localBaseUrl: string
  /** `owned_roster` members (node id + label); [] when there's no node here / not in a fleet. */
  roster: () => Promise<FleetMember[]>
  /**
   * Peer profiles from the node's synchronous `session_snapshot`. Each profile's `sites` is the
   * exhaustive exposed allow-list it advertised through presence.
   */
  peerSites: () => Promise<PeerSites[]>
  /** `site_map(node, port)` → local loopback port, or null when the node won't map it (incl. self / offline peer). */
  siteMap: (node: string, port: number) => Promise<number | null>
  /** Replace a mapped-but-unresponsive route (explicit unmap/remap), with rate limiting in the caller. */
  recoverSiteMap?: (node: string, port: number) => Promise<number | null>
  /** `GET <baseUrl>/api/health` → true when a hub answered. */
  probeHealth: (baseUrl: string) => Promise<boolean>
  /** Explicit legacy candidate, when a caller has one. Omitted by the automatic path. */
  hubPort?: number
  /**
   * Operator-configured fallback ports. These remain useful for an old/mislabelled peer that does not
   * advertise an identifiable AllMyAgents site. Unlike the default path, explicit overrides are tried
   * across roster members because the operator deliberately named them.
   */
  extraPorts?: readonly number[]
}

function canonicalDevice(id: string): string {
  return id.split('-', 1)[0]!.toLowerCase()
}

function isHubLabel(label: string): boolean {
  return /^allmyagents(?:\b|$)/i.test(label.trim())
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535
}

/**
 * Build the fleet roster. Always returns at least the local entry; remote entries are the co-owned
 * members that advertise an AllMyAgents hub (plus explicitly configured fallback ports), each with
 * `online` from the health probe. Machines with no hub advert receive zero maps and zero HTTP probes.
 * Members are resolved concurrently; every step is failure-isolated per member.
 *
 * The no-peer / no-node case returns exactly `[local]` — nothing to merge, so the single-machine UI
 * is unchanged.
 */
export async function buildFleet(deps: BuildFleetDeps): Promise<FleetSite[]> {
  const local: FleetSite = {
    siteId: deps.localSiteId,
    label: deps.localLabel,
    local: true,
    baseUrl: deps.localBaseUrl,
    online: true,
  }
  let members: FleetMember[] = []
  try {
    members = await deps.roster()
  } catch {
    members = []
  }
  if (members.length === 0) return [local]

  let advertised: PeerSites[] = []
  try {
    advertised = await deps.peerSites()
  } catch {
    advertised = []
  }
  const discovered = new Map<string, number[]>()
  for (const peer of advertised) {
    const ports = peer.sites.filter((site) => isHubLabel(site.label) && validPort(site.port)).map((site) => site.port)
    discovered.set(canonicalDevice(peer.device), [...new Set(ports)])
  }
  const overridePorts = [
    ...(deps.hubPort == null ? [] : [deps.hubPort]),
    ...(deps.extraPorts ?? []),
  ].filter(validPort)

  const remotes = await Promise.all(
    members.map(async (m): Promise<FleetSite | null> => {
      // Presence is exact and quiet: only a peer that explicitly advertises an AllMyAgents-labelled
      // allow-list entry gets mapped. Explicit peerPorts remain the opt-in escape hatch for old peers.
      const ports = [...new Set([...(discovered.get(canonicalDevice(m.device)) ?? []), ...overridePorts])]
      if (ports.length === 0) return null
      let firstMapped: string | null = null
      for (const port of ports) {
        const localPort = await deps.siteMap(m.device, port).catch(() => null)
        // No map = the node refused (this very device), the peer is offline, or there's no node.
        if (localPort == null) continue
        const baseUrl = `http://localhost:${localPort}`
        if (firstMapped === null) firstMapped = baseUrl
        let online = await deps.probeHealth(baseUrl).catch(() => false)
        let recoveredBaseUrl = baseUrl
        // A site mapping may remain marked active while its byte path is dead. `site_map` alone is
        // idempotent and hands back that same listener, so replace it once before declaring the hub
        // offline. MeshSite owns the cooldown/single-flight guard for genuinely absent peers.
        if (!online && deps.recoverSiteMap) {
          const recoveredPort = await deps.recoverSiteMap(m.device, port).catch(() => null)
          if (recoveredPort != null) {
            recoveredBaseUrl = `http://localhost:${recoveredPort}`
            if (firstMapped === baseUrl) firstMapped = recoveredBaseUrl
            online = await deps.probeHealth(recoveredBaseUrl).catch(() => false)
          }
        }
        // A HUB ANSWERED — stop here. Keep probing on failure, because a mapped-but-silent port proves
        // nothing: the tunnel binds locally whether or not anything serves on the far side.
        if (online) {
          return { siteId: m.device, label: m.label || m.device.slice(0, 8), local: false, baseUrl: recoveredBaseUrl, online: true }
        }
      }
      // Nothing answered on any candidate. Still list the peer when at least one port mapped: it IS a
      // co-owned machine the node can reach, just without a hub we could find — and a peer that silently
      // vanishes from the roster is indistinguishable from one that was never paired, which is the more
      // confusing failure. Dropping only the unmappable ones preserves the previous behaviour for those.
      if (firstMapped === null) return null
      return {
        siteId: m.device,
        label: m.label || m.device.slice(0, 8),
        local: false,
        baseUrl: firstMapped,
        online: false,
        routeError:
          'This peer advertises an AllMyAgents hub and a local mesh tunnel was mapped, but /api/health did not answer after route recovery.',
      }
    })
  )
  return [local, ...remotes.filter((s): s is FleetSite => s !== null)]
}

/**
 * Probe a (mapped) hub's `/api/health`. Any 2xx answer → true; any error, non-2xx, or timeout →
 * false. This is the reliable "is there a hub here" signal after `site_map`: the mesh tunnel only
 * fails when a connection is actually attempted against an unexposed/absent service (a mapped local
 * port always binds), so the map succeeding doesn't prove a hub — the probe does.
 * (docs/mesh-unified-fleet.md §1, sites.rs:12-16 host-side per-connection allow-list re-check.)
 */
export function probeHubHealth(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      resolve(ok)
    }
    try {
      const u = new URL('/api/health', baseUrl)
      const req = http.get(u, { timeout: timeoutMs }, (res) => {
        const ok = typeof res.statusCode === 'number' && res.statusCode >= 200 && res.statusCode < 300
        res.resume() // drain so the socket frees
        finish(ok)
      })
      req.on('timeout', () => {
        req.destroy()
        finish(false)
      })
      req.on('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
}
