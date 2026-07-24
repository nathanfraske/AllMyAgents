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

  constructor(opts: { port: number; label?: string; enable?: boolean; socketPath?: string }) {
    this.port = opts.port
    this.label = opts.label ?? 'CEC AiMesh Hub'
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
        exposed[this.siteId()] = this.label
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
}
