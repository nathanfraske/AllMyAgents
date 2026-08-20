import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * meshSite — exposes the loopback hub as an AllMyStuff "site" so other PCs on the owner's mesh
 * can reach it, without Tailscale or any routable port.
 *
 * How it works (verified against AllMyStuff `node/src/sites.rs` + `node/src/node_control.rs`):
 *  - AllMyStuff "sites" is a transparent layer-4 (raw TCP) tunnel over the mesh — no HTTP
 *    parsing, no idle timeout, full-duplex — so this hub's WebSocket stream on 127.0.0.1:7777
 *    tunnels end-to-end. WebSocket/SSE/keep-alive are explicitly supported.
 *  - We register by talking to the running node's app control socket and calling `site_set_exposed`
 *    with `{ "tcp:<port>": "<label>" }`. The node then advertises the site; the owner's other
 *    devices (same fleet key → no grant needed) discover it and map it to their own localhost.
 *  - The hub NEVER binds anything but 127.0.0.1. The node connects to loopback and carries bytes.
 *
 * Play-nice-by-construction: if no node socket is present we do nothing (hub stays local-only).
 * We never spawn or fork a node, and `site_set_exposed` REPLACES the whole exposed map, so we
 * always read the current map first and merge — never clobbering other exposed ports.
 */

// Control-socket frame tags (node/src/node_control.rs).
const TAG_JSON = 0
const MAX_AUTO_HUB_ROUTES = 64

export interface WireResponse {
  ok: boolean
  result?: unknown
  error?: string
}

export type MeshControlRequest = (cmd: string, args: unknown, timeoutMs: number) => Promise<WireResponse>

/**
 * One co-owned machine in the owner's fleet, as the node's `owned_roster` reports it
 * (node/src/mesh.rs `fleet_roster_value` :9667 → `OwnedMember` in
 * crates/allmystuff-protocol/src/app.rs:402). `device` is the canonical node id that
 * `site_map`/`site_unmap` key on; `label` is a cosmetic display name (may be empty).
 */
export interface FleetMember {
  device: string
  label: string
  /** Governance role projection ('owner' | 'controller' | 'member') when the roster carries one. */
  role?: string
}

/** One site a peer advertises in its presence profile (`NodeProfile.sites`). */
export interface PeerSiteAdvert {
  id: string
  label: string
  port: number
  scheme?: string
  loopback?: boolean
}

/** The advertised site allow-list cached for one peer by the local node. */
export interface PeerSites {
  device: string
  sites: PeerSiteAdvert[]
}

export interface MeshStatus {
  /** Runtime toggle — whether we're trying to expose at all. */
  enabled: boolean
  /** Whether the AllMyStuff node control socket answered (a node is running here). */
  nodePresent: boolean
  /** Whether our site id is in the node's exposed map. */
  exposed: boolean
  port: number
  label: string
  /** The site id the node keys on, `tcp:<port>`. */
  siteId: string
  socketPath: string
  /** What a fleet peer opens after mapping — direct same-number when the port is free there. */
  peerUrl: string
  error?: string
  checkedAt?: string
}

/** Where the AllMyStuff *app* control socket lives (NOT the MyOwnMesh mesh daemon socket). */
function defaultSocketPath(): string {
  // Explicit escape hatch first, for non-standard installs.
  if (process.env.AMST_NODE_SOCKET) return process.env.AMST_NODE_SOCKET
  if (process.platform === 'win32') return '\\\\.\\pipe\\allmystuff-node'
  const base = process.env.MYOWNMESH_HOME || os.homedir()
  return path.join(base, '.myownmesh', 'allmystuff-node.sock')
}

/**
 * One request → one response over the node control socket. Mirrors NodeClient::round_trip:
 * connect, write a single length-prefixed JSON frame, read the first JSON reply frame, close.
 * Frame = [u32 BE length][1 tag byte][payload], where length INCLUDES the tag byte.
 */
function roundTrip(socketPath: string, cmd: string, args: unknown, timeoutMs: number): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const dbg = process.env.MESH_DEBUG ? (m: string) => console.log(`[mesh:rt:${cmd}] +${Date.now() - t0}ms ${m}`) : undefined
    const sock = net.connect(socketPath)
    dbg?.('connecting')
    let settled = false
    let buf = Buffer.alloc(0)

    const finish = (err: Error | null, value?: WireResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      if (err) reject(err)
      else resolve(value as WireResponse)
    }
    const timer = setTimeout(() => {
      dbg?.('TIMEOUT')
      finish(new Error('mesh: control-socket timeout'))
    }, timeoutMs)

    sock.on('connect', () => {
      dbg?.('connected; writing request')
      const payload = Buffer.from(JSON.stringify({ cmd, args: args ?? {} }), 'utf8')
      const frame = Buffer.allocUnsafe(4 + 1 + payload.length)
      frame.writeUInt32BE(payload.length + 1, 0) // length counts the tag byte
      frame.writeUInt8(TAG_JSON, 4)
      payload.copy(frame, 5)
      sock.write(frame)
    })
    sock.on('data', (chunk: Buffer) => {
      dbg?.(`data +${chunk.length}b`)
      buf = Buffer.concat([buf, chunk])
      // Drain whole frames; resolve on the first JSON frame, skip any pushed event/restart frames.
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0)
        if (buf.length < 4 + len) break
        const tag = buf.readUInt8(4)
        const body = buf.subarray(5, 4 + len)
        buf = buf.subarray(4 + len)
        if (tag === TAG_JSON) {
          try {
            finish(null, JSON.parse(body.toString('utf8')) as WireResponse)
          } catch (e) {
            finish(e instanceof Error ? e : new Error(String(e)))
          }
          return
        }
        // tag 2 (event) / 3 (restart) — ignore, keep draining for the response frame.
      }
    })
    sock.on('error', (err) => {
      dbg?.(`error ${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}`)
      finish(err)
    })
    sock.on('close', () => {
      dbg?.('close before response')
      finish(new Error('mesh: control socket closed before a response'))
    })
  })
}

/** Map a connect failure to a friendly, non-alarming reason (absent node is the normal case). */
function describe(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ECONNREFUSED') return 'no AllMyStuff node running here (hub is local-only)'
  // EPERM/EACCES is NOT "no node" — the pipe is right there and refusing us. On Windows a named pipe
  // carries an ACL, so this almost always means the node and this hub are running at different privilege
  // levels (typically the node elevated or as a service, the hub as the ordinary user). The raw
  // "connect EPERM \\.\pipe\allmystuff-node" is technically accurate and tells an operator nothing about
  // what to change, and it cost a long diagnosis once — the hub looked simply un-exposed, and the actual
  // cause was one word in an error string nobody surfaced.
  if (code === 'EPERM' || code === 'EACCES') {
    return 'the AllMyStuff node control pipe denied this user read/write access (EPERM). The service owner must grant the interactive console user full-duplex access to the pipe; running AllMyAgents elevated is not a durable repair.'
  }
  return e instanceof Error ? e.message : String(e)
}

export class MeshSite {
  private readonly port: number
  private readonly label: string
  private enabled: boolean
  private readonly socketPath: string
  private readonly request: MeshControlRequest
  private last: MeshStatus
  private autoTimer: ReturnType<typeof setInterval> | undefined
  /** Last presence-derived sites per canonical device, retained across a peer's transient absence. */
  private readonly peerSitesCache = new Map<string, PeerSites>()
  /** Silent tunnel failures do not emit a Reject. Bound explicit unmap/remap recovery per site. */
  private readonly siteRecoveryAt = new Map<string, number>()
  private readonly siteRecoveryInFlight = new Map<string, Promise<number | null>>()
  /** Automatic mapping is idempotent, but never let overlapping upkeep ticks multiply IPC work. */
  private routeWarmupInFlight: Promise<number> | null = null
  /** Registration may cross a slow node inventory/restamp boundary; every caller shares one attempt. */
  private registerInFlight: Promise<MeshStatus> | null = null

  constructor(opts: {
    port: number
    label?: string
    enable?: boolean
    socketPath?: string
    /** Test seam for the local node protocol; production always uses the framed socket client. */
    controlRequest?: MeshControlRequest
  }) {
    this.port = opts.port
    this.label = opts.label ?? 'AllMyAgents'
    this.enabled = opts.enable ?? false
    this.socketPath = opts.socketPath ?? defaultSocketPath()
    this.request = opts.controlRequest ?? ((cmd, args, timeoutMs) => roundTrip(this.socketPath, cmd, args, timeoutMs))
    this.last = {
      enabled: this.enabled,
      nodePresent: false,
      exposed: false,
      port: this.port,
      label: this.label,
      siteId: `tcp:${this.port}`,
      socketPath: this.socketPath,
      peerUrl: `http://localhost:${this.port}`,
    }
  }

  status(): MeshStatus {
    return this.last
  }

  private siteId(): string {
    return `tcp:${this.port}`
  }

  /**
   * Keep the protocol-visible advert machine-identifiable even when the operator gives this hub a
   * custom display label. Existing/default labels remain byte-for-byte unchanged.
   */
  private advertisedLabel(): string {
    const label = this.label.trim()
    if (/^allmyagents(?:\b|$)/i.test(label)) return label
    return label ? `AllMyAgents — ${label}` : 'AllMyAgents'
  }

  private update(patch: Partial<MeshStatus>): MeshStatus {
    this.last = { ...this.last, ...patch, enabled: this.enabled, checkedAt: new Date().toISOString() }
    return this.last
  }

  /**
   * Read the node's current exposed map, merge in our port (never replacing others), write it back.
   * No-ops cleanly (nodePresent:false) when no node socket is reachable.
   */
  async register(): Promise<MeshStatus> {
    if (this.registerInFlight) return this.registerInFlight
    const pending = this.registerOnce()
    this.registerInFlight = pending
    try {
      return await pending
    } finally {
      if (this.registerInFlight === pending) this.registerInFlight = null
    }
  }

  private async registerOnce(): Promise<MeshStatus> {
    if (!this.enabled) return this.update({ nodePresent: false, exposed: false, error: 'mesh exposure disabled' })
    const siteId = this.siteId()
    const desiredLabel = this.advertisedLabel()
    // Retry with backoff: a freshly-started hub can be busy enough (restoring sessions, spawning
    // vendor children) that the first control-socket round-trip times out even though the node is
    // healthy — the pipe answers in ~1ms once the hub settles. A few attempts with a generous
    // timeout makes auto-exposure reliable on a cold start.
    let lastErr = 'unknown'
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const cur = await this.request('site_exposed', {}, 10000)
        if (!cur.ok) {
          lastErr = cur.error ?? 'site_exposed failed'
          break // the node answered but refused — retrying won't help
        }
        const exposed: Record<string, string> = { ...((cur.result as Record<string, string>) ?? {}) }
        // `site_set_exposed` is not a cheap idempotent setter: AllMyStuff persists the map, restamps
        // its profile, and refreshes backend inventory even when every byte is unchanged. The 30-second
        // presence check therefore MUST stop here in steady state. Write only on an actual transition.
        if (exposed[siteId] === desiredLabel) {
          return this.update({ nodePresent: true, exposed: true, error: undefined })
        }
        exposed[siteId] = desiredLabel
        const set = await this.request('site_set_exposed', { exposed }, 10000)
        if (!set.ok) {
          lastErr = set.error ?? 'site_set_exposed failed'
          break
        }
        const now = (set.result as Record<string, string>) ?? exposed
        return this.update({ nodePresent: true, exposed: this.siteId() in now, error: undefined })
      } catch (e) {
        lastErr = describe(e)
        // A definitive "no node here" — don't retry or spawn one.
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ECONNREFUSED') {
          return this.update({ nodePresent: false, exposed: false, error: lastErr })
        }
        // `site_set_exposed` updates the persisted allow-list before it awaits the blocking inventory
        // scan + presence restamp. That tail can outlive our response deadline even though the write
        // succeeded. Confirm authoritative state before retrying: otherwise one slow restamp causes
        // four identical writes, ~40 seconds of delay, and a false "node absent" status.
        try {
          const confirm = await this.request('site_exposed', {}, 2000)
          const confirmed = (confirm.result as Record<string, string> | undefined) ?? {}
          if (confirm.ok && confirmed[siteId] === desiredLabel) {
            return this.update({ nodePresent: true, exposed: true, error: undefined })
          }
        } catch {
          // The original error remains the useful diagnostic; continue the bounded retry policy.
        }
        if (attempt < 4) await new Promise((r) => setTimeout(r, 750 * attempt))
      }
    }
    return this.update({ nodePresent: false, exposed: false, error: lastErr })
  }

  /** Best-effort removal of our port from the exposed map (on shutdown or disable). */
  async deregister(): Promise<void> {
    try {
      const cur = await this.request('site_exposed', {}, 2000)
      if (!cur.ok) return
      const exposed: Record<string, string> = { ...((cur.result as Record<string, string>) ?? {}) }
      if (!(this.siteId() in exposed)) return
      delete exposed[this.siteId()]
      await this.request('site_set_exposed', { exposed }, 2000)
    } catch {
      /* node already gone — nothing to clean up */
    }
  }

  /** Runtime toggle for the UI panel. Registers or deregisters to match. */
  async setEnabled(on: boolean): Promise<MeshStatus> {
    this.enabled = on
    if (on) return this.register()
    await this.deregister()
    return this.update({ exposed: false, error: undefined })
  }

  /**
   * KEEP TRYING TO ATTACH, instead of deciding once at boot that there is no mesh.
   *
   * `register()` runs at startup and returns immediately on ENOENT/ECONNREFUSED — correct for that call
   * ("no node here, don't retry or spawn one") and wrong as the whole policy, because it was the only
   * call. A hub that starts before the AllMyStuff node — the normal order when both launch at login, and
   * the certain order when the node is started by hand afterwards — decides there is no mesh and never
   * looks again. The hub is then invisible to the fleet until someone restarts it, with nothing in the UI
   * suggesting a restart would help.
   *
   * That is the same shape as the supervisor bug we fixed earlier tonight: a one-shot attempt at something
   * that becomes possible later, with giving-up as the permanent outcome.
   *
   * Cheap to poll: when no node is present the connect fails with ENOENT in microseconds, and when we are
   * already exposed this does nothing at all. Only transitions are reported, so a machine that never runs
   * a node stays silent forever rather than logging every interval.
   */
  startAutoRegister(intervalMs = 30_000, onChange?: (s: MeshStatus) => void): void {
    if (this.autoTimer) return
    let wasExposed = this.last.exposed
    const tick = async (): Promise<void> => {
      if (!this.enabled) return
      // Already advertised — nothing to do. This is the steady state, and it costs one field read.
      if (this.last.exposed) {
        // Confirm periodically that we are still in the node's map: a node restart, or another app
        // calling site_set_exposed with a stale map, drops us silently. Re-registering is idempotent.
        const cur = await this.register()
        if (cur.nodePresent) await this.warmPeerHubRoutes()
        if (!cur.exposed && wasExposed) {
          wasExposed = false
          onChange?.(cur)
        }
        return
      }
      const s = await this.register()
      if (s.nodePresent) await this.warmPeerHubRoutes()
      if (s.exposed && !wasExposed) {
        wasExposed = true
        onChange?.(s)
      }
    }
    this.autoTimer = setInterval(() => void tick().catch(() => undefined), intervalMs)
    // `register()` has already run before this loop starts in production. Warm routes immediately so
    // opening the Remote panel is never the action that makes an incoming Hub become reachable.
    if (this.last.nodePresent) void this.warmPeerHubRoutes().catch(() => undefined)
    // Never hold the process open for this — it is background upkeep, not work.
    this.autoTimer.unref?.()
  }

  /** Stop the auto-attach loop (shutdown, or when the site is disabled for good). */
  stopAutoRegister(): void {
    if (!this.autoTimer) return
    clearInterval(this.autoTimer)
    this.autoTimer = undefined
  }

  // --- Fleet discovery + routing ---------------------------------------------------------------
  // These call the SAME node control socket + framing `register()` uses, just pointed at the
  // directory/routing commands the node already exposes (docs/mesh-unified-fleet.md §1). All are
  // Ordinary fleet discovery remains fail-soft: no node here, or any error, yields empty/null so a
  // single-machine hub behaves exactly as before. Authority-sensitive remote/testbed callers use
  // ownedRosterRequired() so a degraded control plane is not misreported as an empty fleet.

  /**
   * The fleet directory: every co-owned machine (node id + label) as `owned_roster` reports it
   * (node_control.rs:1668 → mesh.rs `fleet_roster_value` :9667; reply envelope `{ ok, result }` per
   * node_control.rs `WireResponse::ok` :642). `result.members` is `[{ device, label, role }]`, or
   * absent/`[]` when this node isn't in a fleet (`empty_owned()` mesh.rs:17586). The required form
   * preserves control-plane failures; ownedRoster() remains the fail-soft discovery wrapper.
   */
  async ownedRosterRequired(timeoutMs = 4000): Promise<FleetMember[]> {
    let r: WireResponse
    try {
      r = await this.request('owned_roster', {}, timeoutMs)
    } catch (error) {
      throw new Error(`AllMyStuff fleet roster is unavailable: ${describe(error)}`, { cause: error })
    }
    if (!r.ok) {
      throw new Error(`AllMyStuff refused the fleet roster request: ${(r.error ?? 'unknown error').slice(0, 2_000)}`)
    }
    const members = (r.result as { members?: unknown } | undefined)?.members
    if (!Array.isArray(members)) return []
    const out: FleetMember[] = []
    for (const raw of members) {
      const m = raw as { device?: unknown; label?: unknown; role?: unknown }
      if (typeof m.device !== 'string' || m.device.length === 0) continue
      out.push({
        device: m.device,
        label: typeof m.label === 'string' ? m.label : '',
        role: typeof m.role === 'string' ? m.role : undefined,
      })
    }
    return out
  }

  async ownedRoster(timeoutMs = 4000): Promise<FleetMember[]> {
    return this.ownedRosterRequired(timeoutMs).catch(() => [])
  }

  /**
   * Read the peer profiles the node already learned through normal presence.
   *
   * `NodeProfile.sites` is the peer's exhaustive advertised allow-list (protocol/app.rs:300-308);
   * `session_snapshot` returns those profiles synchronously in `result.peers` (mesh.rs:7828-7855,
   * node_control.rs:1646). This is the exact, quiet discovery API: unlike `site_remote_list`, it
   * neither scans the remote machine nor waits for a separately streamed event.
   *
   * Profiles that arrive update the cache even when their site list becomes empty (a deliberate
   * unexpose). Profiles absent from one snapshot remain cached so a known hub stays attributable
   * while its machine sleeps; `owned_roster` remains the authority for whether it is still paired.
   */
  async peerSites(timeoutMs = 4000): Promise<PeerSites[]> {
    try {
      const r = await this.request('session_snapshot', {}, timeoutMs)
      if (!r.ok) return [...this.peerSitesCache.values()]
      const peers = (r.result as { peers?: unknown } | undefined)?.peers
      if (!Array.isArray(peers)) return [...this.peerSitesCache.values()]
      for (const raw of peers) {
        const profile = raw as { node?: unknown; sites?: unknown }
        if (typeof profile.node !== 'string' || profile.node.length === 0) continue
        const sites: PeerSiteAdvert[] = []
        if (Array.isArray(profile.sites)) {
          for (const candidate of profile.sites) {
            const site = candidate as {
              id?: unknown
              label?: unknown
              port?: unknown
              scheme?: unknown
              loopback?: unknown
            }
            if (
              typeof site.id !== 'string' ||
              typeof site.label !== 'string' ||
              typeof site.port !== 'number' ||
              !Number.isInteger(site.port) ||
              site.port <= 0 ||
              site.port > 65_535
            ) {
              continue
            }
            sites.push({
              id: site.id,
              label: site.label,
              port: site.port,
              scheme: typeof site.scheme === 'string' ? site.scheme : undefined,
              loopback: typeof site.loopback === 'boolean' ? site.loopback : undefined,
            })
          }
        }
        const canonical = profile.node.split('-', 1)[0]!.toLowerCase()
        this.peerSitesCache.set(canonical, { device: profile.node, sites })
      }
    } catch {
      // A node restart or temporary socket loss must not make a known sleeping hub vanish.
    }
    return [...this.peerSitesCache.values()]
  }

  /**
   * Idempotently pre-map every presence-advertised AllMyAgents Hub owned by this fleet. The web client
   * still probes `/api/health` before trusting a route, but it no longer has to open the Remote panel (or
   * wait for its fleet poll) to cause the underlying mesh tunnel to exist.
   */
  async warmPeerHubRoutes(timeoutMs = 4000): Promise<number> {
    if (this.routeWarmupInFlight) return this.routeWarmupInFlight
    const warmup = (async (): Promise<number> => {
      const [members, peers] = await Promise.all([this.ownedRoster(timeoutMs), this.peerSites(timeoutMs)])
      const owned = new Set(members.map((member) => member.device.split('-', 1)[0]!.toLowerCase()))
      const routes: Array<{ node: string; port: number }> = []
      const seen = new Set<string>()
      for (const peer of peers) {
        const canonical = peer.device.split('-', 1)[0]!.toLowerCase()
        if (!owned.has(canonical)) continue
        for (const site of peer.sites) {
          if (!/^allmyagents(?:\b|$)/i.test(site.label.trim())) continue
          const key = `${canonical}:${site.port}`
          if (seen.has(key)) continue
          seen.add(key)
          routes.push({ node: peer.device, port: site.port })
          if (routes.length >= MAX_AUTO_HUB_ROUTES) break
        }
        if (routes.length >= MAX_AUTO_HUB_ROUTES) break
      }
      const mapped = await Promise.all(routes.map(({ node, port }) => this.siteMap(node, port, timeoutMs)))
      return mapped.filter((port): port is number => port !== null).length
    })()
    this.routeWarmupInFlight = warmup
    try {
      return await warmup
    } finally {
      if (this.routeWarmupInFlight === warmup) this.routeWarmupInFlight = null
    }
  }

  /**
   * Bind (idempotently) a local loopback port that tunnels to `node`'s hub on `port` — so
   * `http://localhost:<localPort>` is that peer's hub (node_control.rs:1612 → mesh.rs `site_map`
   * :14618; success reply `{ localPort }`). Returns null when the node refuses (its own device →
   * "that's this device", so self is naturally excluded), the peer is offline/unreachable, or no
   * node is running here. Default `port` is the well-known hub port 7777.
   *
   * Discovery gets the actual port from `peerSites()` before calling this. The health probe remains
   * necessary because a local mapping can bind while its peer is offline.
   */
  async siteMap(node: string, port = 7777, timeoutMs = 4000): Promise<number | null> {
    try {
      const r = await this.request('site_map', { node, port }, timeoutMs)
      if (!r.ok) return null
      const lp = (r.result as { localPort?: unknown } | undefined)?.localPort
      return typeof lp === 'number' ? lp : null
    } catch {
      return null
    }
  }

  /**
   * Replace a mapped-but-byte-dead tunnel. The node's `site_map` is idempotent, so calling it alone
   * returns the same poisoned listener forever; an explicit unmap is the required invalidation.
   * Recovery is single-flight and rate-limited because an actually offline peer is not an error loop.
   */
  async recoverSiteMap(node: string, port = 7777, cooldownMs = 60_000): Promise<number | null> {
    const key = `${node.split('-', 1)[0]!.toLowerCase()}:${port}`
    const active = this.siteRecoveryInFlight.get(key)
    if (active) return active
    const now = Date.now()
    if (now - (this.siteRecoveryAt.get(key) ?? 0) < cooldownMs) return null
    this.siteRecoveryAt.set(key, now)
    const recovery = (async (): Promise<number | null> => {
      try {
        await this.request('site_unmap', { node, port }, 4000).catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, 250))
        return await this.siteMap(node, port, 6000)
      } finally {
        this.siteRecoveryInFlight.delete(key)
      }
    })()
    this.siteRecoveryInFlight.set(key, recovery)
    return recovery
  }
}
