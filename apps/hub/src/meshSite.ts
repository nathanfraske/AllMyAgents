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

interface WireResponse {
  ok: boolean
  result?: unknown
  error?: string
}

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
  return e instanceof Error ? e.message : String(e)
}

export class MeshSite {
  private readonly port: number
  private readonly label: string
  private enabled: boolean
  private readonly socketPath: string
  private last: MeshStatus
  private autoTimer: ReturnType<typeof setInterval> | undefined
  /** Last presence-derived sites per canonical device, retained across a peer's transient absence. */
  private readonly peerSitesCache = new Map<string, PeerSites>()

  constructor(opts: { port: number; label?: string; enable?: boolean; socketPath?: string }) {
    this.port = opts.port
    this.label = opts.label ?? 'AllMyAgents'
    this.enabled = opts.enable ?? false
    this.socketPath = opts.socketPath ?? defaultSocketPath()
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
    if (!this.enabled) return this.update({ nodePresent: false, exposed: false, error: 'mesh exposure disabled' })
    // Retry with backoff: a freshly-started hub can be busy enough (restoring sessions, spawning
    // vendor children) that the first control-socket round-trip times out even though the node is
    // healthy — the pipe answers in ~1ms once the hub settles. A few attempts with a generous
    // timeout makes auto-exposure reliable on a cold start.
    let lastErr = 'unknown'
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const cur = await roundTrip(this.socketPath, 'site_exposed', {}, 10000)
        if (!cur.ok) {
          lastErr = cur.error ?? 'site_exposed failed'
          break // the node answered but refused — retrying won't help
        }
        const exposed: Record<string, string> = { ...((cur.result as Record<string, string>) ?? {}) }
        exposed[this.siteId()] = this.advertisedLabel()
        const set = await roundTrip(this.socketPath, 'site_set_exposed', { exposed }, 10000)
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
        if (attempt < 4) await new Promise((r) => setTimeout(r, 750 * attempt))
      }
    }
    return this.update({ nodePresent: false, exposed: false, error: lastErr })
  }

  /** Best-effort removal of our port from the exposed map (on shutdown or disable). */
  async deregister(): Promise<void> {
    try {
      const cur = await roundTrip(this.socketPath, 'site_exposed', {}, 2000)
      if (!cur.ok) return
      const exposed: Record<string, string> = { ...((cur.result as Record<string, string>) ?? {}) }
      if (!(this.siteId() in exposed)) return
      delete exposed[this.siteId()]
      await roundTrip(this.socketPath, 'site_set_exposed', { exposed }, 2000)
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
        if (!cur.exposed && wasExposed) {
          wasExposed = false
          onChange?.(cur)
        }
        return
      }
      const s = await this.register()
      if (s.exposed && !wasExposed) {
        wasExposed = true
        onChange?.(s)
      }
    }
    this.autoTimer = setInterval(() => void tick().catch(() => undefined), intervalMs)
    // Never hold the process open for this — it is background upkeep, not work.
    this.autoTimer.unref?.()
  }

  /** Stop the auto-attach loop (shutdown, or when the site is disabled for good). */
  stopAutoRegister(): void {
    if (!this.autoTimer) return
    clearInterval(this.autoTimer)
    this.autoTimer = undefined
  }

  // --- Fleet discovery + routing (unified-across-mesh view, first cut) --------------------------
  // These call the SAME node control socket + framing `register()` uses, just pointed at the
  // directory/routing commands the node already exposes (docs/mesh-unified-fleet.md §1). All are
  // fail-soft: no node here, or any error, yields empty/null — never a throw into the request path,
  // so a single-machine hub with no node behaves exactly as before (owned_roster fails fast with
  // ENOENT/ECONNREFUSED → []).

  /**
   * The fleet directory: every co-owned machine (node id + label) as `owned_roster` reports it
   * (node_control.rs:1668 → mesh.rs `fleet_roster_value` :9667; reply envelope `{ ok, result }` per
   * node_control.rs `WireResponse::ok` :642). `result.members` is `[{ device, label, role }]`, or
   * absent/`[]` when this node isn't in a fleet (`empty_owned()` mesh.rs:17586). Returns [] on any
   * error or when no node is running here.
   */
  async ownedRoster(timeoutMs = 4000): Promise<FleetMember[]> {
    try {
      const r = await roundTrip(this.socketPath, 'owned_roster', {}, timeoutMs)
      if (!r.ok) return []
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
    } catch {
      return []
    }
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
      const r = await roundTrip(this.socketPath, 'session_snapshot', {}, timeoutMs)
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
      const r = await roundTrip(this.socketPath, 'site_map', { node, port }, timeoutMs)
      if (!r.ok) return null
      const lp = (r.result as { localPort?: unknown } | undefined)?.localPort
      return typeof lp === 'number' ? lp : null
    } catch {
      return null
    }
  }
}
