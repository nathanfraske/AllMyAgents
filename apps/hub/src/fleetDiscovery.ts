import type { FleetDiscoveryIssue, FleetSite } from './fleet.js'
import type { PeerSites } from './meshSite.js'
import type { DirectMeshPeer, DirectMeshStatus } from './myOwnMeshRpc.js'

const canonical = (id: string): string => id.split('-', 1)[0]!.trim().toLowerCase()

/** Display-only union. Presence can add a diagnostic row, never a route, trust or authority. */
export function addFleetDiscovery(
  sites: readonly FleetSite[],
  presence: readonly PeerSites[],
  directPeers: readonly DirectMeshPeer[],
  directStatus?: DirectMeshStatus,
  failures: readonly FleetDiscoveryIssue[] = [],
): FleetSite[] {
  const result = sites.map(site => ({ ...site }))
  const issues = [...failures]
  if (directStatus && !directStatus.available) {
    const denied = directStatus.reason === 'permission-denied'
    issues.push({
      source: 'myownmesh', code: directStatus.reason ?? 'control-error',
      message: denied
        ? 'Headless device discovery is blocked on this PC: the MyOwnMesh control pipe denied access. AllMyStuff may still show the device through its separate connection. The service owner must configure access for this Windows user; a pairing code cannot repair this connection.'
        : `Headless device discovery is unavailable: ${(directStatus.error || directStatus.reason || 'direct MyOwnMesh control is unavailable').slice(0, 2_000)}. A missing device is not evidence that the remote installation failed.`,
    })
  }
  const local = result.find(site => site.local)
  if (local && issues.length) local.discoveryIssues = issues
  const known = new Map(result.map(site => [canonical(site.siteId), site]))
  for (const peer of directPeers) {
    const online = peer.online && directStatus?.available !== false
    const id = canonical(peer.siteId)
    const existing = known.get(id)
    if (existing?.local) continue
    if (existing) {
      existing.directOnline = online
      existing.directStatus = peer.status
      if (peer.rttMs !== undefined) existing.directRttMs = peer.rttMs
      continue
    }
    const site: FleetSite = {
      siteId: peer.siteId, label: peer.label, local: false, baseUrl: '', online: false,
      directOnline: online, directStatus: peer.status,
      ...(peer.rttMs === undefined ? {} : { directRttMs: peer.rttMs }),
      routeError: directStatus && !directStatus.available
        ? issues.find(issue => issue.source === 'myownmesh')!.message
        : online
        ? 'The direct MyOwnMesh control channel is live. Pairing and testbed operations do not require a TCP Site route.'
        : `MyOwnMesh peer state is ${peer.status}; direct control is not active.`,
    }
    known.set(id, site)
    result.push(site)
  }
  // Bound diagnostic-only rows even if presence has accumulated a large historical directory.
  for (const peer of presence.slice(0, 256)) {
    const id = canonical(peer.device)
    if (!id || known.has(id)) continue
    const site: FleetSite = {
      siteId: id, label: peer.label || id.slice(0, 12), local: false,
      baseUrl: '', online: false, directOnline: false, discoveryOnly: true,
      routeCode: directStatus && !directStatus.available ? 'discovery-unavailable' : 'application-unconfirmed',
      routeError: directStatus && !directStatus.available
        ? issues.find(issue => issue.source === 'myownmesh')!.message
        : 'Seen in AllMyStuff presence (which may be cached), but no active AllMyAgents control route is confirmed. Check the remote allmyagents-testbed service and its MyOwnMesh socket access, then refresh. Visibility alone does not grant access.',
    }
    known.set(id, site)
    result.push(site)
  }
  return result
}
