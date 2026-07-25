/**
 * workerTransport — the wire between the hub and the long-lived agent worker
 * (docs/agent-worker-impl.md §2). A **length-prefixed, bidirectional, multiplexed,
 * auto-reconnecting** channel over one local socket (`HUB_WORKER_SOCKET`).
 *
 * It reuses meshSite's frame codec verbatim (`meshSite.ts:88-115`) —
 * `[u32 BE length][1 tag byte][payload]`, `length` counts the tag byte, `TAG_JSON=0`,
 * drain whole frames from a growing `Buffer` — but wraps it in a durable, long-lived
 * channel instead of meshSite's one-shot `roundTrip`.
 *
 * Four layers, smallest first:
 *   1. Codec        — `encodeFrame` + the stateful `FrameDecoder` (unit-testable in isolation).
 *   2. `WorkerFrameChannel` — one class both sides use over a connected `net.Socket`.
 *   3. `WorkerServer` — the WORKER side: one hub connection at a time, a fresh hub REPLACES the
 *      current channel (guarded by a monotonic `attachEpoch`); outbound messages that can't be
 *      sent live queue in two lanes — the EVENT lane (pluggable wseqBuffer, drop-oldest replay)
 *      and the RELAY lane (bounded pending map, never drop-oldest, terminal → HubUnavailableError).
 *   4. `WorkerClient` — the HUB side: `net.connect`, `hello`, auto-reconnect every
 *      HUB_RECONNECT_INTERVAL_MS, `call()` correlated by `reqId`, and worker→hub stream subscriptions.
 *
 * This module owns the transport ONLY. Event retention/replay is the caller's `wseqBuffer`
 * (agentWorker) reached through the EVENT-lane hook + the `attach` command — the transport never
 * imports or hard-depends on `wseqBuffer.ts` (§2.3).
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  HUB_RECONNECT_INTERVAL_MS,
  HUB_RELAY_TIMEOUT_MS,
  HubUnavailableError,
  RELAY_QUEUE_MAX,
  type HubToWorker,
  type WorkerToHub,
} from './workerProtocol.js'
import type { DangerFlags } from './types.js'

// --- Frame layout (identical to meshSite.ts:88-115) --------------------------------------------

/** The one payload tag we speak — a UTF-8 JSON body. Any other tag byte is dropped (§2.2). */
const TAG_JSON = 0
/** Bytes of the `u32 BE length` header that precede every frame's tag byte. */
const LEN_BYTES = 4
/**
 * Sanity ceiling on a decoded frame's declared length. A frame bigger than this is treated as
 * framing corruption (a lie about where the next frame starts), not a real message — see
 * `FrameDecoder.push`. Generous: real event payloads are small; this only trips on a garbage stream.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

const EMPTY = Buffer.alloc(0)

const DEBUG = !!process.env.WORKER_TRANSPORT_DEBUG
function debug(msg: string): void {
  if (DEBUG) console.log(`[worker-transport] ${msg}`)
}
function warn(msg: string): void {
  console.warn(`[worker-transport] ${msg}`)
}

/**
 * Encode any JSON-serializable value into one wire frame: `[u32 BE len][TAG_JSON][utf8 JSON]`,
 * where `len` counts the tag byte plus the payload (mirrors `meshSite.ts:88-93`). Pure + total —
 * a value that stringifies to `undefined` (a bare `undefined`/function) is encoded as `null`
 * rather than throwing, keeping the encode path total.
 */
export function encodeFrame(obj: unknown): Buffer {
  const json = JSON.stringify(obj)
  const payload = Buffer.from(json ?? 'null', 'utf8')
  const frame = Buffer.allocUnsafe(LEN_BYTES + 1 + payload.length)
  frame.writeUInt32BE(payload.length + 1, 0) // length counts the tag byte
  frame.writeUInt8(TAG_JSON, LEN_BYTES)
  payload.copy(frame, LEN_BYTES + 1)
  return frame
}

/**
 * The streaming counterpart to {@link encodeFrame}: buffer partial socket reads and hand back every
 * COMPLETE decoded message, in order, per `push(chunk)`. Mirrors meshSite's drain loop
 * (`meshSite.ts:95-115`) but is a reusable, stateful object rather than an inline `while`.
 *
 * Never throws out of the data path (§2.2). Two distinct corruption modes are handled differently:
 *   - **Content corruption** (a valid frame boundary, but a non-JSON / non-object body, or an unknown
 *     tag): the length is honest, so drop exactly that one frame and RESYNC — later frames still decode.
 *   - **Framing corruption** (an implausible length: `< 1` or `> MAX_FRAME_BYTES`): the boundary itself
 *     is a lie, so the stream is unrecoverable — drop the whole buffer and reset. Any real frames that
 *     followed the bad length are unreachable regardless, so this loses nothing recoverable.
 * Both log a warning; neither throws and neither hangs (a bad length can't wedge the buffer forever).
 */
export class FrameDecoder {
  private buf: Buffer = EMPTY

  push(chunk: Buffer): object[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: object[] = []

    while (this.buf.length >= LEN_BYTES) {
      const len = this.buf.readUInt32BE(0)

      // Framing corruption: an implausible length. `len` must cover at least the tag byte, and a
      // sane frame never exceeds the ceiling. We cannot trust the boundary, so reset rather than
      // buffer unbounded (which would also hang, re-reading the same bad header on every push).
      if (len < 1 || len > MAX_FRAME_BYTES) {
        warn(`framing corrupt: implausible frame length ${len}; resetting decoder`)
        this.buf = EMPTY
        break
      }

      // Partial frame: the body has not fully arrived yet. Keep it buffered and wait for more.
      if (this.buf.length < LEN_BYTES + len) break

      const tag = this.buf.readUInt8(LEN_BYTES)
      const body = this.buf.subarray(LEN_BYTES + 1, LEN_BYTES + len)
      this.buf = this.buf.subarray(LEN_BYTES + len)

      if (tag !== TAG_JSON) {
        warn(`dropping frame: unknown tag ${tag}`)
        continue
      }
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'))
        if (parsed !== null && typeof parsed === 'object') out.push(parsed)
        else warn('dropping frame: JSON payload is not an object')
      } catch {
        warn('dropping frame: payload is not valid JSON')
      }
    }
    return out
  }
}

// --- WorkerFrameChannel (shared) ---------------------------------------------------------------

/**
 * One connected `net.Socket` wrapped as a message channel (§2.2). `send(obj)` encodes + writes;
 * inbound bytes are decoded and each complete message emitted as `'message'`. Any socket close or
 * error collapses to a single `'closed'` emission (never an EventEmitter `'error'`, which would
 * throw with no listener). Both sides — {@link WorkerServer} and {@link WorkerClient} — use this.
 */
export class WorkerFrameChannel extends EventEmitter {
  private readonly decoder = new FrameDecoder()
  private closed = false

  constructor(private readonly socket: net.Socket) {
    super()
    socket.on('data', (chunk: Buffer) => {
      for (const msg of this.decoder.push(chunk)) this.emit('message', msg)
    })
    socket.on('close', () => this.markClosed())
    socket.on('error', (err: Error) => {
      warn(`socket error: ${err.message}`)
      this.markClosed()
    })
  }

  /** Encode `obj` and write it. A write after close (or a write that throws) is a no-op that closes. */
  send(obj: unknown): void {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(obj))
    } catch (err) {
      warn(`write failed: ${err instanceof Error ? err.message : String(err)}`)
      this.markClosed()
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Force the underlying socket down; `'closed'` follows. */
  destroy(): void {
    this.socket.destroy()
    this.markClosed()
  }

  private markClosed(): void {
    if (this.closed) return
    this.closed = true
    this.emit('closed')
  }
}

// --- Lane message classification ---------------------------------------------------------------

/** The wseq-tagged vendor stream (worker→hub). Retention/replay lives in the caller's wseqBuffer. */
type EventLaneMsg = Extract<WorkerToHub, { t: 'event' | 'turnStarted' | 'turnCompleted' | 'turnError' }>
/** Self-gating tool-handler relays — each has an awaiting caller and a correlated reply. */
type RelayLaneMsg = Extract<WorkerToHub, { t: 'rpc' | 'approvalRequest' }>
/** The hub→worker replies that resolve a {@link RelayLaneMsg}. */
type RelayReply = Extract<HubToWorker, { t: 'rpcResult' | 'approvalResolved' }>

function isEventLane(msg: WorkerToHub): msg is EventLaneMsg {
  return msg.t === 'event' || msg.t === 'turnStarted' || msg.t === 'turnCompleted' || msg.t === 'turnError'
}
function isRelayLane(msg: WorkerToHub): msg is RelayLaneMsg {
  return msg.t === 'rpc' || msg.t === 'approvalRequest'
}

/** Namespaced correlation key so a `callId` and an `approvalId` can never collide in the pending map. */
function relayKey(msg: RelayLaneMsg): string {
  return msg.t === 'rpc' ? `rpc:${msg.callId}` : `ap:${msg.approvalId}`
}
function replyKey(msg: RelayReply): string {
  return msg.t === 'rpcResult' ? `rpc:${msg.callId}` : `ap:${msg.approvalId}`
}

interface PendingRelay {
  readonly key: string
  readonly msg: RelayLaneMsg
  readonly resolve: (reply: RelayReply) => void
  readonly reject: (err: Error) => void
  /** The transient→terminal timer, armed ONLY while waiting for a hub to attach (cleared once delivered). */
  timer: ReturnType<typeof setTimeout> | undefined
}

// --- WorkerServer (the worker side) ------------------------------------------------------------

export interface WorkerServerHandlers {
  /** Every hub→worker command/push that isn't transport-internal (i.e. not hello/draining and not a relay reply). */
  onMessage?: (msg: HubToWorker) => void
  /** A fresh hub won the epoch guard and is now THE channel — carries its `hello` (attachEpoch + danger). */
  onAttach?: (info: { attachEpoch: number; danger: DangerFlags }) => void
  /**
   * EVENT-lane hook (§2.3): an event/lifecycle message that could not be sent live (no channel, or the
   * channel is draining). The caller wires its per-session wseqBuffer here for drop-oldest retention;
   * replay itself is driven later by the hub's `attach(since)` command (handled via `onMessage`), so this
   * is a pure observability sink — the transport never depends on a wseqBuffer being present.
   */
  onBufferedEvent?: (msg: EventLaneMsg) => void
}

/**
 * The worker's listener (§2.3). `agentWorker.ts` constructs one. It accepts ONE hub connection at a
 * time; a NEW connection with a `hello.attachEpoch >= ` the current one REPLACES the channel (a fresh
 * hub re-attaching after its predecessor died) while the worker keeps running throughout. A `hello`
 * with a stale (lower) epoch is refused so a late frame from a retiring channel can't clobber its
 * successor.
 *
 * Outbound `send`/`relay` address "the current hub channel". When none is attached (or it is draining,
 * §8.4) messages queue:
 *   - EVENT lane  → handed to `onBufferedEvent` (the caller's wseqBuffer owns drop-oldest replay).
 *   - RELAY lane  → a bounded pending map (`RELAY_QUEUE_MAX`), NEVER drop-oldest; each entry's Promise
 *                   stays pending until the reply arrives, or is rejected with `HubUnavailableError`
 *                   once `HUB_RELAY_TIMEOUT_MS` elapses with no attach (the only terminal path, §8.3).
 * On each attach the whole relay lane is re-flushed in insertion order (idempotent by stable id, §8.2).
 *
 * Binding is explicit via {@link listen} so the queue lanes are usable (and unit-testable) with no socket.
 */
export class WorkerServer {
  private server: net.Server | undefined
  private current: WorkerFrameChannel | undefined
  /** Highest `attachEpoch` promoted so far; a `hello` below this is refused (§2.3). */
  private currentEpoch = Number.NEGATIVE_INFINITY
  /** Pre-flip hold: the current channel is about to drop, so new sends queue instead of racing it (§8.4). */
  private draining = false
  /** RELAY lane. Insertion order == flush order (Map preserves it). Keyed by {@link relayKey}. */
  private readonly pendingRelays = new Map<string, PendingRelay>()

  constructor(
    private readonly socketPath: string,
    private readonly handlers: WorkerServerHandlers = {}
  ) {}

  /**
   * Bind the listener. On a unix domain socket, unlink a stale socket file first (a previous worker
   * that didn't clean up); Windows named pipes need no cleanup. Resolves once listening.
   */
  listen(): Promise<void> {
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.socketPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          warn(`could not unlink stale socket ${this.socketPath}: ${(err as Error).message}`)
        }
      }
    }
    const server = net.createServer((socket) => this.onConnection(socket))
    this.server = server
    return new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.off('error', reject)
        debug(`listening on ${this.socketPath}`)
        resolve()
      })
    })
  }

  /**
   * Send a worker→hub message. EVENT-lane + best-effort replies go here; the correlated RELAY lane
   * goes through {@link relay} (which returns a Promise). A relay-lane message passed to `send` is
   * routed to `relay` defensively and its Promise swallowed, so it is never silently un-tracked.
   */
  send(msg: WorkerToHub): void {
    if (isRelayLane(msg)) {
      void this.relay(msg).catch(() => {})
      return
    }
    if (isEventLane(msg)) {
      if (this.channelReady()) this.write(msg)
      else this.handlers.onBufferedEvent?.(msg)
      return
    }
    // Best-effort: a command ack/reply or a fire-and-forget push (restartRequest). Its awaiting hub is
    // the one that just vanished; a fresh hub re-issues its command, so dropping when unattached is safe.
    if (this.channelReady()) this.write(msg)
    else debug(`dropping best-effort ${msg.t} — no hub attached`)
  }

  /**
   * Send a RELAY-lane message and resolve with the hub's matching reply. The Promise:
   *   - resolves when the correlated `rpcResult` / `approvalResolved` arrives (possibly against a
   *     SUCCESSOR hub after a flip — the relay is re-flushed on attach);
   *   - rejects with `HubUnavailableError` if the lane is full (`RELAY_QUEUE_MAX`, never drop-oldest)
   *     or if `HUB_RELAY_TIMEOUT_MS` elapses with no hub attached to take it (§8.3).
   * It never resolves to a falsy "denied"-shaped value on a gap — the caller maps the terminal error to
   * the retryable `HUB_UNAVAILABLE_TEXT` shape (§8.3).
   */
  relay(msg: RelayLaneMsg): Promise<RelayReply> {
    return new Promise<RelayReply>((resolve, reject) => {
      // Overflow is terminal for the NEWCOMER — never evict an in-flight relay that has an awaiting caller.
      if (this.pendingRelays.size >= RELAY_QUEUE_MAX) {
        reject(new HubUnavailableError())
        return
      }
      const entry: PendingRelay = { key: relayKey(msg), msg, resolve, reject, timer: undefined }
      this.pendingRelays.set(entry.key, entry)
      if (this.channelReady()) {
        // Delivered to a live hub; await the reply (which may take up to the hub's own timeout — e.g. an
        // approval waits on a human). No transient timer while delivered: the 45s bound governs REACHING
        // a hub, not the reply latency (§8.3).
        this.write(msg)
      } else {
        this.armTimer(entry)
      }
    })
  }

  /**
   * Handle one hub→worker message, channel-agnostically (the public entry from §2.3). Transport-internal
   * kinds (`draining`, relay replies) are consumed here; everything else is forwarded to the caller.
   * `hello`/attach promotion needs the physical channel and is handled by the connection path, not here.
   */
  onHub(msg: HubToWorker): void {
    switch (msg.t) {
      case 'draining':
        this.setDraining()
        return
      case 'rpcResult':
      case 'approvalResolved':
        this.resolveRelay(msg)
        return
      case 'hello':
        // A hello only means something with a physical connection behind it (see onConnection); ignore
        // it on the channel-agnostic path.
        return
      default:
        this.handlers.onMessage?.(msg)
    }
  }

  /** Number of relays awaiting a reply (in-flight + queued). Exposed for tests / diagnostics. */
  get pendingRelayCount(): number {
    return this.pendingRelays.size
  }

  /** Whether a hub channel is currently attached and accepting live writes. */
  get attached(): boolean {
    return this.channelReady()
  }

  /**
   * Stop the listener and fail every pending relay retryably (a worker shutdown — rare, hubctl-driven).
   * Clears all timers so nothing dangles.
   */
  async close(): Promise<void> {
    for (const entry of [...this.pendingRelays.values()]) {
      this.clearTimer(entry)
      this.pendingRelays.delete(entry.key)
      entry.reject(new HubUnavailableError())
    }
    this.current?.destroy()
    this.current = undefined
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // --- internals ---

  private onConnection(socket: net.Socket): void {
    const channel = new WorkerFrameChannel(socket)
    // A connection is not promoted until its `hello` clears the epoch guard.
    channel.on('message', (msg: unknown) => this.dispatch(msg as HubToWorker, channel))
    channel.on('closed', () => this.onChannelClosed(channel))
    debug('hub connection opened (awaiting hello)')
  }

  /** The connection-path dispatcher: it knows which physical channel a frame arrived on (unlike onHub). */
  private dispatch(msg: HubToWorker, channel: WorkerFrameChannel): void {
    if (msg.t === 'hello') {
      this.attach(channel, msg)
      return
    }
    // A late frame from a retiring channel must not act on behalf of the live one. Replies are the
    // exception — resolving a pending relay by id is idempotent and safe from any channel.
    if (this.current && channel !== this.current && msg.t !== 'rpcResult' && msg.t !== 'approvalResolved') {
      debug(`ignoring ${msg.t} from a non-current channel`)
      return
    }
    this.onHub(msg)
  }

  private attach(channel: WorkerFrameChannel, hello: Extract<HubToWorker, { t: 'hello' }>): void {
    if (hello.attachEpoch < this.currentEpoch) {
      warn(`refusing stale hello epoch ${hello.attachEpoch} < ${this.currentEpoch}`)
      channel.destroy()
      return
    }
    const prev = this.current
    this.current = channel
    this.currentEpoch = hello.attachEpoch
    this.draining = false
    if (prev && prev !== channel) prev.destroy() // retire the predecessor's channel
    debug(`hub attached at epoch ${hello.attachEpoch}; flushing ${this.pendingRelays.size} relay(s)`)
    this.handlers.onAttach?.({ attachEpoch: hello.attachEpoch, danger: hello.danger })
    this.flushRelays()
  }

  private onChannelClosed(channel: WorkerFrameChannel): void {
    if (channel !== this.current) return // a retired channel finally closing — nothing to do
    this.current = undefined
    this.detach()
  }

  private setDraining(): void {
    this.draining = true
    // The channel is still physically up but about to drop; hold like a detach so in-flight relays are
    // re-armed and re-flushed to the successor rather than lost on the dying socket (§8.4).
    this.detach()
  }

  /** No live hub for now: re-arm the transient timer on every pending relay (they await a fresh attach). */
  private detach(): void {
    for (const entry of this.pendingRelays.values()) this.armTimer(entry)
  }

  private flushRelays(): void {
    for (const entry of this.pendingRelays.values()) {
      this.clearTimer(entry) // delivered to the fresh hub; stop counting against the reach-a-hub bound
      this.write(entry.msg)
    }
  }

  private resolveRelay(msg: RelayReply): void {
    const entry = this.pendingRelays.get(replyKey(msg))
    if (!entry) return // unknown or already-resolved (a re-delivered reply after a flush) — safe no-op
    this.pendingRelays.delete(entry.key)
    this.clearTimer(entry)
    entry.resolve(msg)
  }

  private armTimer(entry: PendingRelay): void {
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      if (this.pendingRelays.delete(entry.key)) entry.reject(new HubUnavailableError())
    }, HUB_RELAY_TIMEOUT_MS)
  }

  private clearTimer(entry: PendingRelay): void {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  private channelReady(): boolean {
    return !!this.current && !this.draining && !this.current.isClosed
  }

  private write(msg: WorkerToHub): void {
    this.current?.send(msg)
  }
}

// --- WorkerClient (the hub side, auto-reconnecting) --------------------------------------------

/** A hub→worker command carries a `reqId`; `call()` accepts exactly these and resolves on the reply. */
type HubCommand = Extract<HubToWorker, { reqId: string }>
/** The worker→hub replies that resolve a {@link HubCommand}, matched by `reqId`. */
type CommandReply = Extract<WorkerToHub, { t: 'ack' | 'threadStarted' | 'codexLimits' | 'live' }>

export interface WorkerClientOptions {
  /**
   * The monotonic attach epoch this hub announces in every `hello` (§2.3). A later-started hub (green)
   * must present a higher epoch than its predecessor (blue) so the worker promotes the successor.
   * Defaults to `Date.now()` at construction — a hub spawned later naturally gets a higher value.
   */
  attachEpoch?: number
  /** Current Danger Zone flags, read fresh on each (re)connect so `hello` carries live danger. */
  danger?: () => DangerFlags
}

const SAFE_DANGER: DangerFlags = {
  busCanUseRiskyTools: false,
  autoApprovePractices: false,
  autoApproveRestart: false,
}

interface PendingCall {
  readonly resolve: (reply: CommandReply) => void
  readonly reject: (err: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * The hub's end of the wire (§2.4). `sessions.ts` / `WorkerExecutor` holds one. It connects to the
 * still-listening worker, announces itself with a `hello`, and AUTO-RECONNECTS every
 * HUB_RECONNECT_INTERVAL_MS (unbounded) — the crux of re-attach: a fresh hub started by hubctl finds
 * the same worker and re-subscribes to live turns, prompting the worker to flush its queued lanes.
 *
 * Emits: `'attached'` on each successful connect (the hub's `attachWorker()` hook, §6), `'detached'`
 * on a drop. Worker→hub streams are exposed as `onEvent` / `onTurnLifecycle` / `onRelay` /
 * `onRestartRequest`. Never emits `'error'` (which would throw without a listener) — failures fold into
 * reconnect + retryable call rejections.
 */
export class WorkerClient extends EventEmitter {
  private socket: net.Socket | undefined
  private channel: WorkerFrameChannel | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private readonly pending = new Map<string, PendingCall>()
  private readonly attachEpoch: number
  private readonly dangerOf: () => DangerFlags

  constructor(
    private readonly socketPath: string,
    opts: WorkerClientOptions = {}
  ) {
    super()
    this.attachEpoch = opts.attachEpoch ?? Date.now()
    this.dangerOf = opts.danger ?? (() => SAFE_DANGER)
  }

  /** Open (or re-open) the connection. Idempotent while a live socket exists. */
  connect(): void {
    if (this.stopped) return
    if (this.socket && !this.socket.destroyed) return
    this.clearReconnect()

    const socket = net.connect(this.socketPath)
    this.socket = socket
    let connected = false

    socket.on('connect', () => {
      connected = true
      const channel = new WorkerFrameChannel(socket)
      this.channel = channel
      channel.on('message', (msg: unknown) => this.onWorker(msg as WorkerToHub))
      channel.send({ t: 'hello', attachEpoch: this.attachEpoch, danger: this.dangerOf() })
      debug(`attached to worker at epoch ${this.attachEpoch}`)
      this.emit('attached')
    })
    socket.on('error', (err: Error) => {
      // A pre-connect ENOENT/ECONNREFUSED is the normal "worker not up yet" case; 'close' follows and
      // schedules the retry. Nothing to do here but note it.
      debug(`socket error: ${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}`)
    })
    socket.on('close', () => {
      this.channel = undefined
      this.socket = undefined
      // In-flight commands can no longer be answered on this connection → reject retryably (§8, §9.2).
      this.failPending()
      if (connected) this.emit('detached')
      this.scheduleReconnect()
    })
  }

  /**
   * Issue a request/reply command and resolve with the worker's correlated reply frame. Rejects with
   * `HubUnavailableError` (retryable) when the worker is unreachable — not attached now, or the
   * connection drops before the reply — and, as a bound so it can never hang, if no reply arrives
   * within HUB_RELAY_TIMEOUT_MS.
   */
  call<T extends CommandReply = CommandReply>(msg: HubCommand): Promise<T> {
    if (!this.isAttached()) return Promise.reject(new HubUnavailableError())
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(msg.reqId)) reject(new HubUnavailableError())
      }, HUB_RELAY_TIMEOUT_MS)
      this.pending.set(msg.reqId, { resolve: resolve as (r: CommandReply) => void, reject, timer })
      this.rawSend(msg)
    })
  }

  /** Fire-and-forget push (`dangerUpdate` / `approvalResolved` / `rpcResult`). Dropped if unattached. */
  send(msg: HubToWorker): void {
    if (this.isAttached()) this.rawSend(msg)
    else debug(`dropping ${msg.t} — worker not attached`)
  }

  /** Pre-flip signal (blue's `drain()`, §8.4): the worker holds relays before this socket drops. */
  signalDraining(): void {
    this.send({ t: 'draining' })
  }

  onEvent(cb: (msg: Extract<WorkerToHub, { t: 'event' }>) => void): void {
    this.on('event', cb)
  }
  onTurnLifecycle(cb: (msg: Extract<WorkerToHub, { t: 'turnStarted' | 'turnCompleted' | 'turnError' }>) => void): void {
    this.on('turnLifecycle', cb)
  }
  onRelay(cb: (msg: Extract<WorkerToHub, { t: 'approvalRequest' | 'rpc' }>) => void): void {
    this.on('relay', cb)
  }
  onRestartRequest(cb: (msg: Extract<WorkerToHub, { t: 'restartRequest' }>) => void): void {
    this.on('restartRequest', cb)
  }

  /** Whether a live channel is currently attached. */
  isAttached(): boolean {
    return !!this.channel && !this.channel.isClosed
  }

  /** Stop for good: no more reconnects, tear down the socket, reject anything in flight. */
  close(): void {
    this.stopped = true
    this.clearReconnect()
    this.failPending()
    this.channel?.destroy()
    this.channel = undefined
    this.socket?.destroy()
    this.socket = undefined
  }

  // --- internals ---

  private onWorker(msg: WorkerToHub): void {
    switch (msg.t) {
      case 'ack':
      case 'threadStarted':
      case 'codexLimits':
      case 'live':
        this.resolveCall(msg)
        return
      case 'event':
        this.emit('event', msg)
        return
      case 'turnStarted':
      case 'turnCompleted':
      case 'turnError':
        this.emit('turnLifecycle', msg)
        return
      case 'approvalRequest':
      case 'rpc':
        this.emit('relay', msg)
        return
      case 'restartRequest':
        this.emit('restartRequest', msg)
        return
      default:
        debug(`unhandled worker message ${(msg as { t: string }).t}`)
    }
  }

  private resolveCall(msg: CommandReply): void {
    const entry = this.pending.get(msg.reqId)
    if (!entry) return // unknown/duplicate reqId — safe no-op
    clearTimeout(entry.timer)
    this.pending.delete(msg.reqId)
    entry.resolve(msg)
  }

  private failPending(): void {
    for (const [reqId, entry] of [...this.pending]) {
      clearTimeout(entry.timer)
      this.pending.delete(reqId)
      entry.reject(new HubUnavailableError())
    }
  }

  private rawSend(msg: HubToWorker): void {
    this.channel?.send(msg)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, HUB_RECONNECT_INTERVAL_MS)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }
}

// --- Endpoint ----------------------------------------------------------------------------------

/**
 * The worker socket both sides use (§2.1). hubctl computes this once and injects it as
 * `HUB_WORKER_SOCKET` into the worker (to listen) and every hub (to connect); its presence in a hub's
 * env is the Phase-2 feature flag. Mirrors `meshSite.defaultSocketPath()`.
 */
export function defaultWorkerSocket(dataDir: string): string {
  if (process.env.HUB_WORKER_SOCKET) return process.env.HUB_WORKER_SOCKET
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\allmyagents-worker' // Windows named pipe (no filesystem cleanup needed)
    : path.join(dataDir, 'worker.sock') // unix domain socket under data/
}
