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
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  HUB_RECONNECT_INTERVAL_MS,
  HUB_RELAY_DELIVERED_BACKSTOP_MS,
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
  /** The Promise handed to the caller — reused to COALESCE a duplicate/re-issued relay (same stable key)
   *  onto the in-flight one instead of overwriting + orphaning it (H1). */
  readonly promise: Promise<RelayReply>
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
  /** Every accepted channel not yet closed — the current one, a retiring predecessor mid-swap, and any
   *  connection still awaiting its `hello`. Tracked so `close()` can destroy EVERY socket, not just the
   *  current one, and never leak an accepted-but-unpromoted connection (L4). */
  private readonly channels = new Set<WorkerFrameChannel>()
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
        // Keep a PERMANENT error listener so a post-listen server error (accept failure, fd exhaustion,
        // a late pipe error) is logged, never an unhandled 'error' that crashes the immortal worker (M3).
        server.on('error', (e) => warn(`worker server error: ${e instanceof Error ? e.message : String(e)}`))
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
    const key = relayKey(msg)
    // Coalesce a duplicate/re-issued relay onto the in-flight one. The key is a STABLE per-logical-call
    // id (a re-send after a reconnect, or the same tool call twice, is the SAME call), so returning the
    // existing Promise instead of overwriting the map avoids orphaning the prior entry — the H1 hang +
    // timer leak + queue-accounting break.
    const existing = this.pendingRelays.get(key)
    if (existing) return existing.promise
    let resolve!: (reply: RelayReply) => void
    let reject!: (err: Error) => void
    const promise = new Promise<RelayReply>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Overflow is terminal for the NEWCOMER — never evict an in-flight relay that has an awaiting caller.
    if (this.pendingRelays.size >= RELAY_QUEUE_MAX) {
      reject(new HubUnavailableError())
      return promise
    }
    const entry: PendingRelay = { key, msg, resolve, reject, promise, timer: undefined }
    this.pendingRelays.set(key, entry)
    if (this.channelReady()) {
      // Delivered to a live hub; await the reply. No reach-a-hub timer while delivered: the 45s bound governs
      // REACHING a hub, not the reply latency — an approval legitimately waits on a human (§8.3). L6 arms a
      // generous rpc-only backstop so a wedged hub that never replies still can't hang the tool forever.
      this.write(msg)
      this.armDeliveredBackstop(entry)
    } else {
      this.armTimer(entry, HUB_RELAY_TIMEOUT_MS)
    }
    return promise
  }

  /**
   * Handle one hub→worker message, channel-agnostically (the public entry from §2.3). Transport-internal
   * kinds (`draining`, relay replies) are consumed here; everything else is forwarded to the caller.
   * `hello`/attach promotion needs the physical channel and is handled by the connection path, not here.
   */
  onHub(msg: HubToWorker): void {
    switch (msg.t) {
      case 'draining':
        // on:false is the RELEASE — a rolled-back flip un-drains so the held relays flow again (§8.4, M2).
        if (msg.on === false) this.release()
        else this.setDraining()
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
    // L4: destroy EVERY accepted channel — the current one, a retiring predecessor, and any connection still
    // awaiting its hello — so a worker shutdown never leaks a socket. Each destroy() fires 'closed', which
    // removes it from the set; snapshot first so we don't mutate the set mid-iteration.
    for (const channel of [...this.channels]) channel.destroy()
    this.channels.clear()
    this.current = undefined
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // --- internals ---

  private onConnection(socket: net.Socket): void {
    const channel = new WorkerFrameChannel(socket)
    this.channels.add(channel) // L4: track from accept, before its hello — removed when it closes
    // A connection is not promoted until its `hello` clears the epoch guard.
    channel.on('message', (msg: unknown) => this.dispatch(msg as HubToWorker, channel))
    channel.on('closed', () => {
      this.channels.delete(channel)
      this.onChannelClosed(channel)
    })
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

  /**
   * Un-drain (§8.4, the M2 correctness item): a rolled-back flip means blue stays live, so clear the
   * pre-flip hold and resume delivering. If our channel is still current, flush the relays we held during
   * the drain window straight back to it — WITHOUT this, a rollback would leave every held relay pending
   * until it wrongly timed out to HubUnavailableError even though the hub never actually went away. If no
   * channel is attached (blue's was displaced by a booted-then-dead green), the next hello's attach() does
   * the flush instead; either way the held relays flow again rather than sitting stuck rejecting.
   */
  private release(): void {
    this.draining = false
    if (this.channelReady()) this.flushRelays()
  }

  /** No live hub for now: switch every pending relay to the reach-a-hub bound (dropping any delivered-rpc
   *  backstop) — they await a fresh attach that will re-flush them. */
  private detach(): void {
    for (const entry of this.pendingRelays.values()) {
      this.clearTimer(entry)
      this.armTimer(entry, HUB_RELAY_TIMEOUT_MS)
    }
  }

  private flushRelays(): void {
    for (const entry of this.pendingRelays.values()) {
      this.clearTimer(entry) // delivered to the fresh hub; stop counting against the reach-a-hub bound
      this.write(entry.msg)
      this.armDeliveredBackstop(entry) // L6: a generous backstop on the re-delivered rpc
    }
  }

  private resolveRelay(msg: RelayReply): void {
    const entry = this.pendingRelays.get(replyKey(msg))
    if (!entry) return // unknown or already-resolved (a re-delivered reply after a flush) — safe no-op
    this.pendingRelays.delete(entry.key)
    this.clearTimer(entry)
    entry.resolve(msg)
  }

  /**
   * L6: arm a generous backstop on a DELIVERED relay so a wedged hub that accepts the frame but never replies
   * can't hang the tool forever. Only rpc(bus/memory/practices) gets it — an approvalRequest legitimately
   * blocks on a human up to the hub's own 10-min ApprovalService timeout (which always replies), so a
   * backstop there would wrongly time out a slow-but-valid approval. The terminal shape is the same retryable
   * HubUnavailableError, mapped to HUB_UNAVAILABLE_TEXT at the tool boundary (§8.3).
   */
  private armDeliveredBackstop(entry: PendingRelay): void {
    if (entry.msg.t === 'rpc') this.armTimer(entry, HUB_RELAY_DELIVERED_BACKSTOP_MS)
  }

  private armTimer(entry: PendingRelay, ms: number): void {
    if (entry.timer) return
    const timer = setTimeout(() => {
      // Identity guard: only settle if THIS entry still owns its slot. Coalescing means it always does,
      // but this keeps a stale timer from ever cross-evicting a live entry under future refactors.
      if (this.pendingRelays.get(entry.key) === entry) {
        this.pendingRelays.delete(entry.key)
        entry.reject(new HubUnavailableError())
      }
    }, ms)
    timer.unref?.() // L8: a relay bound must never keep the (immortal) worker's event loop alive on its own
    entry.timer = timer
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
  // Mutable: normally fixed at construction, but the RELEASE path (signalDraining(false)) bumps it so a
  // fresh hello can reclaim the channel from a displaced-then-dead green whose higher epoch would otherwise
  // refuse blue's reconnect forever (§8.4, M2).
  private attachEpoch: number
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
      timer.unref?.() // L8: a pending command must not keep the hub's event loop alive on its own
      this.pending.set(msg.reqId, { resolve: resolve as (r: CommandReply) => void, reject, timer })
      this.rawSend(msg)
    })
  }

  /** Fire-and-forget push (`dangerUpdate` / `approvalResolved` / `rpcResult`). Dropped if unattached. */
  send(msg: HubToWorker): void {
    if (this.isAttached()) this.rawSend(msg)
    else debug(`dropping ${msg.t} — worker not attached`)
  }

  /**
   * Pre-flip drain signal (`draining=true`, blue's `drain()`) and its RELEASE (`draining=false`, blue's
   * `abort()` on a rolled-back flip), §8.4:
   *   - DRAIN: the worker holds new relays before this socket drops, so a planned flip has zero failed
   *     in-flight sends.
   *   - RELEASE (the M2 correctness item): un-drain so the held relays flow again rather than sit until they
   *     wrongly time out. If our channel is still current, an un-drain push clears the worker's hold + flushes
   *     in place. If our channel was displaced (a booted-then-dead green replaced it and bumped the worker's
   *     epoch past ours, so our plain reconnect would be refused forever), bump to a FRESH, higher epoch so
   *     the next (already-scheduled) reconnect's hello reclaims the channel — whose attach() clears the hold
   *     and flushes.
   */
  signalDraining(draining = true): void {
    if (draining) {
      this.send({ t: 'draining' })
      return
    }
    if (this.isAttached()) {
      this.rawSend({ t: 'draining', on: false })
      return
    }
    this.attachEpoch = Math.max(this.attachEpoch + 1, Date.now())
    this.connect() // idempotent; if a socket already exists the scheduled reconnect carries the fresh epoch
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
  /** The attached worker's generation handshake (`welcome`), fired on every (re)attach. The WorkerExecutor
   *  uses it to invalidate its served-write cache across a worker respawn but keep it on a flap (§8.2 / F1). */
  onWelcome(cb: (msg: Extract<WorkerToHub, { t: 'welcome' }>) => void): void {
    this.on('welcome', cb)
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
      case 'welcome':
        this.emit('welcome', msg)
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
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, HUB_RECONNECT_INTERVAL_MS)
    timer.unref?.() // L8: the reconnect loop must not keep the hub's event loop alive on its own
    this.reconnectTimer = timer
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
  if (process.platform === 'win32') {
    // KEYED BY DATA DIR, because a Windows named pipe lives in a GLOBAL namespace rather than the
    // filesystem. A fixed name meant every hub on the machine shared one endpoint no matter what
    // HUB_DATA_DIR said — so an "isolated" instance (a test harness, an acceptance run, a second
    // checkout) would silently attach to the LIVE worker and drive the operator's real agents. Isolating
    // the port and the database was not enough on Windows, and the failure is invisible: everything
    // connects and looks healthy while two hubs share one worker.
    //
    // POSIX never had this — its socket is a real file under the data dir, so isolation came for free,
    // which is exactly why the Windows case went unnoticed. Hashed rather than embedded because the pipe
    // name has a length limit and a data dir can be arbitrarily long; lowercased first because Windows
    // paths are case-insensitive and the hub and worker must derive the SAME endpoint independently.
    const key = crypto.createHash('sha1').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\allmyagents-worker-${key}` // named pipe: no fs cleanup
  }

  // POSIX: a unix domain socket under data/, so it is co-located with the rest of the hub's state and
  // scoped to the invoking user by that directory's permissions.
  //
  // macOS/BSD gotcha: `sockaddr_un.sun_path` is only 104 bytes (Linux gives 108), and bind() fails
  // with ENAMETOOLONG — not a clear error — past it. An installed macOS build's data dir is
  // `~/Library/Application Support/AllMyAgents/data`, already ~55 chars before the home prefix, and a
  // deep dev checkout can be worse. So when the natural path won't fit, fall back to a short,
  // per-user path under the OS temp dir. Deterministic (uid-keyed, not random) because the hub and
  // every worker/hub process must independently compute the SAME endpoint.
  const natural = path.join(dataDir, 'worker.sock')
  if (Buffer.byteLength(natural) < 100) return natural
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return path.join(os.tmpdir(), `ama-worker-${uid}.sock`)
}
