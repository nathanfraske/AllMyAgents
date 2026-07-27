import http from 'node:http'
import type { FleetMember } from './meshSite.js'

/**
 * Unified-across-mesh fleet view — FIRST CUT (read-only roster, badged by machine).
 * See docs/mesh-unified-fleet.md "First-cut path (S–M)".
 *
 * `buildFleet` turns the node's fleet directory into the list `GET /api/fleet` returns: always THIS
 * hub as a `local:true` entry, plus each co-owned peer whose hub the node can map, with `online` set
 * by a `/api/health` probe. It's a pure function over injected deps (roster/siteMap/probeHealth) so
 * the discovery logic is unit-tested without a node or the network (see fleet.test.ts). The concrete
 * node calls live on MeshSite (`ownedRoster`/`siteMap`); the concrete probe is `probeHubHealth`.
 */

export interface FleetSite {
  /**
   * Stable id for this site. The local hub's `tcp:<port>` siteId, or a peer's canonical node id.
   * The web client prefixes each project/session id it pulls from a site with `${siteId}:` — for
   * origin attribution (which machine a row is on) and, later, mutation routing to the owning hub.
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
  /** `site_map(node, port)` → local loopback port, or null when the node won't map it (incl. self / offline peer). */
  siteMap: (node: string, port: number) => Promise<number | null>
  /** `GET <baseUrl>/api/health` → true when a hub answered. */
  probeHealth: (baseUrl: string) => Promise<boolean>
  /** Well-known peer hub port (default 7777). */
  hubPort?: number
  /**
   * EXTRA remote ports to try when the well-known one finds nothing.
   *
   * 7777 being "the" hub port is an assumption that breaks the moment a machine already has something
   * on it — including a second AllMyAgents — because that hub binds a different port and then no amount
   * of correctly exposing its site makes it discoverable here. Observed directly: a peer with a live hub
   * and a correctly exposed site stayed invisible because discovery only ever asked for 7777.
   *
   * We cannot enumerate a peer's exposed sites to find out: `site_remote_list` answers with an async
   * `allmystuff://node-sites` EVENT rather than a reply frame, and the control socket's round-trip only
   * returns the first reply (see meshSite.siteMap's note). Until that event can be captured, the honest
   * fallback is to let the operator name the ports their other machines actually use.
   */
  extraPorts?: readonly number[]
}

/**
 * Build the fleet roster. Always returns at least the local entry; remote entries are the co-owned
 * members the node could map a loopback port to (self is dropped because `site_map` returns null for
 * "that's this device"), each with `online` from the health probe. Members are mapped + probed
 * concurrently so the endpoint stays fast; every step is failure-isolated per member.
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

  // Try the well-known port first, then any operator-configured extras. Deduped and ordered so the
  // common single-port case does exactly one map + probe, exactly as before.
  const ports = [...new Set([deps.hubPort ?? 7777, ...(deps.extraPorts ?? [])])]
  const remotes = await Promise.all(
    members.map(async (m): Promise<FleetSite | null> => {
      let firstMapped: string | null = null
      for (const port of ports) {
        const localPort = await deps.siteMap(m.device, port).catch(() => null)
        // No map = the node refused (this very device), the peer is offline, or there's no node.
        if (localPort == null) continue
        const baseUrl = `http://localhost:${localPort}`
        if (firstMapped === null) firstMapped = baseUrl
        const online = await deps.probeHealth(baseUrl).catch(() => false)
        // A HUB ANSWERED — stop here. Keep probing on failure, because a mapped-but-silent port proves
        // nothing: the tunnel binds locally whether or not anything serves on the far side.
        if (online) {
          return { siteId: m.device, label: m.label || m.device.slice(0, 8), local: false, baseUrl, online: true }
        }
      }
      // Nothing answered on any candidate. Still list the peer when at least one port mapped: it IS a
      // co-owned machine the node can reach, just without a hub we could find — and a peer that silently
      // vanishes from the roster is indistinguishable from one that was never paired, which is the more
      // confusing failure. Dropping only the unmappable ones preserves the previous behaviour for those.
      if (firstMapped === null) return null
      return { siteId: m.device, label: m.label || m.device.slice(0, 8), local: false, baseUrl: firstMapped, online: false }
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
