import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HUB_RELAY_TIMEOUT_MS,
  HubUnavailableError,
  RELAY_QUEUE_MAX,
  type WorkerToHub,
} from './workerProtocol.js'
import { FrameDecoder, WorkerServer, defaultWorkerSocket, encodeFrame } from './workerTransport.js'

// --- Frame helpers -----------------------------------------------------------------------------

/** Build a raw wire frame with an arbitrary tag + body — mirrors the on-wire layout the codec expects. */
function frame(bodyStr: string, tag = 0): Buffer {
  const payload = Buffer.from(bodyStr, 'utf8')
  const f = Buffer.allocUnsafe(4 + 1 + payload.length)
  f.writeUInt32BE(payload.length + 1, 0) // length counts the tag byte
  f.writeUInt8(tag, 4)
  payload.copy(f, 5)
  return f
}

/** Drain a FrameDecoder over a single push and return the decoded messages. */
function decodeAll(...chunks: Buffer[]): object[] {
  const dec = new FrameDecoder()
  const out: object[] = []
  for (const c of chunks) out.push(...dec.push(c))
  return out
}

describe('encodeFrame — wire layout (identical to meshSite framing)', () => {
  it('prefixes a u32 BE length that counts the tag byte, then TAG_JSON, then the utf8 JSON payload', () => {
    const buf = encodeFrame({ t: 'ack', reqId: 'r1', ok: true })
    const payload = Buffer.from(JSON.stringify({ t: 'ack', reqId: 'r1', ok: true }), 'utf8')
    expect(buf.readUInt32BE(0)).toBe(payload.length + 1) // length includes the 1 tag byte
    expect(buf.readUInt8(4)).toBe(0) // TAG_JSON
    expect(buf.subarray(5).toString('utf8')).toBe(payload.toString('utf8'))
    expect(buf.length).toBe(4 + 1 + payload.length)
  })

  it('encodes a value that stringifies to undefined as null rather than throwing', () => {
    expect(() => encodeFrame(undefined)).not.toThrow()
    // Encoded body is "null"; the decoder drops it (null is not an object), so nothing is emitted.
    expect(decodeAll(encodeFrame(undefined))).toEqual([])
  })
})

describe('FrameDecoder — encode→decode roundtrip', () => {
  it('round-trips a representative message unchanged', () => {
    const msg: WorkerToHub = { t: 'event', sessionId: 's1', wseq: 7, kind: 'claude/text', payload: { text: 'hi' } }
    expect(decodeAll(encodeFrame(msg))).toEqual([msg])
  })

  it('round-trips a payload with nested objects, arrays, and unicode', () => {
    const msg = { t: 'rpc', callId: 'c1', method: 'memory.write', args: { tags: ['a', 'b'], note: 'héllo 🌊', n: { deep: 1 } } }
    expect(decodeAll(encodeFrame(msg))).toEqual([msg])
  })
})

describe('FrameDecoder — partial reads', () => {
  it('buffers a chunk that stops mid-frame and completes on the rest', () => {
    const full = encodeFrame({ t: 'turnStarted', sessionId: 's', wseq: 1 })
    const dec = new FrameDecoder()
    // Split in the middle of the body.
    expect(dec.push(full.subarray(0, 6))).toEqual([])
    expect(dec.push(full.subarray(6))).toEqual([{ t: 'turnStarted', sessionId: 's', wseq: 1 }])
  })

  it('buffers a chunk that stops inside the 4-byte length header', () => {
    const full = encodeFrame({ t: 'interrupt', reqId: 'r9', sessionId: 's' })
    const dec = new FrameDecoder()
    expect(dec.push(full.subarray(0, 2))).toEqual([]) // header not even complete
    expect(dec.push(full.subarray(2, 5))).toEqual([]) // still partial
    expect(dec.push(full.subarray(5))).toEqual([{ t: 'interrupt', reqId: 'r9', sessionId: 's' }])
  })

  it('reassembles a frame delivered one byte at a time', () => {
    const full = encodeFrame({ t: 'turnCompleted', sessionId: 's', wseq: 42, vendorSessionId: 'v' })
    const dec = new FrameDecoder()
    let out: object[] = []
    for (const byte of full) out = out.concat(dec.push(Buffer.from([byte])))
    expect(out).toEqual([{ t: 'turnCompleted', sessionId: 's', wseq: 42, vendorSessionId: 'v' }])
  })
})

describe('FrameDecoder — multiple frames', () => {
  it('decodes two frames delivered in one chunk', () => {
    const a = { t: 'turnStarted', sessionId: 's', wseq: 1 }
    const b = { t: 'turnCompleted', sessionId: 's', wseq: 2 }
    expect(decodeAll(Buffer.concat([encodeFrame(a), encodeFrame(b)]))).toEqual([a, b])
  })

  it('decodes three frames plus a trailing partial, completing the partial on the next push', () => {
    const a = encodeFrame({ t: 'a' })
    const b = encodeFrame({ t: 'b' })
    const c = encodeFrame({ t: 'c' })
    const dec = new FrameDecoder()
    const first = dec.push(Buffer.concat([a, b, c.subarray(0, 3)]))
    expect(first).toEqual([{ t: 'a' }, { t: 'b' }])
    expect(dec.push(c.subarray(3))).toEqual([{ t: 'c' }])
  })
})

describe('FrameDecoder — corrupt frames are dropped, never thrown', () => {
  it('drops a non-JSON payload (content corruption) and RESYNCS to the next valid frame', () => {
    const bad = frame('not json{{{', 0)
    const good = encodeFrame({ t: 'ok', v: 1 })
    // The length is honest, so the decoder skips exactly the bad frame and recovers the good one.
    expect(decodeAll(Buffer.concat([bad, good]))).toEqual([{ t: 'ok', v: 1 }])
  })

  it('drops a frame carrying non-object JSON (a bare number) but keeps a following object', () => {
    const bad = frame('12345', 0)
    const good = encodeFrame({ t: 'ok' })
    expect(decodeAll(Buffer.concat([bad, good]))).toEqual([{ t: 'ok' }])
  })

  it('drops a frame with an unknown tag byte and resyncs', () => {
    const bad = frame('{"t":"x"}', 7) // valid framing, wrong tag
    const good = encodeFrame({ t: 'ok' })
    expect(decodeAll(Buffer.concat([bad, good]))).toEqual([{ t: 'ok' }])
  })

  it('drops an oversize/implausible length (framing corruption) without throwing or hanging', () => {
    const oversize = Buffer.alloc(8)
    oversize.writeUInt32BE(0xffffffff, 0) // ~4 GiB — far beyond MAX_FRAME_BYTES
    oversize.writeUInt8(0, 4)
    let out: object[] = []
    expect(() => {
      out = new FrameDecoder().push(oversize)
    }).not.toThrow()
    expect(out).toEqual([])
  })

  it('drops a zero length (below the 1-byte tag minimum) without throwing', () => {
    const zero = Buffer.alloc(6) // length == 0
    expect(() => new FrameDecoder().push(zero)).not.toThrow()
    expect(new FrameDecoder().push(zero)).toEqual([])
  })
})

// --- RELAY lane (WorkerServer, socket-free) ----------------------------------------------------

/** A server with no listener bound — the queue lanes work purely in-memory (no socket needed). */
function unboundServer() {
  return new WorkerServer('\\\\.\\pipe\\test-never-bound')
}

function rpc(callId: string): Extract<WorkerToHub, { t: 'rpc' }> {
  return { t: 'rpc', callId, method: 'memory.write', args: { note: callId } }
}

describe('WorkerServer relay lane — overflow is terminal for the newcomer (never drop-oldest)', () => {
  it(`rejects the ${RELAY_QUEUE_MAX + 1}th queued relay with HubUnavailableError and keeps the earlier ${RELAY_QUEUE_MAX}`, async () => {
    const server = unboundServer()
    // Fill the lane to capacity with no hub attached; each stays pending (catch the eventual timeout).
    for (let i = 0; i < RELAY_QUEUE_MAX; i++) server.relay(rpc(`c${i}`)).catch(() => {})
    expect(server.pendingRelayCount).toBe(RELAY_QUEUE_MAX)

    // One more overflows: the NEWCOMER fails terminally; no in-flight relay is evicted.
    await expect(server.relay(rpc('overflow'))).rejects.toBeInstanceOf(HubUnavailableError)
    expect(server.pendingRelayCount).toBe(RELAY_QUEUE_MAX)

    await server.close() // rejects the queued relays (already caught) + clears their timers
  })
})

describe('WorkerServer relay lane — the transient→terminal timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a queued relay with HubUnavailableError once HUB_RELAY_TIMEOUT_MS elapses with no attach', async () => {
    vi.useFakeTimers()
    const server = unboundServer()
    const p = server.relay(rpc('c1'))
    // Attach the outcome handler synchronously so the timer's rejection is never momentarily unhandled.
    const settled = p.then(() => undefined, (e: unknown) => e)
    expect(server.pendingRelayCount).toBe(1)

    // Just under the bound: still pending, no hub arrived yet.
    await vi.advanceTimersByTimeAsync(HUB_RELAY_TIMEOUT_MS - 1)
    expect(server.pendingRelayCount).toBe(1)

    // At the bound: the reach-a-hub window closes → terminal, retryable shape.
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toBeInstanceOf(HubUnavailableError)
    expect(server.pendingRelayCount).toBe(0)
  })

  it('an approvalRequest relay also times out to HubUnavailableError (never a false "denied")', async () => {
    vi.useFakeTimers()
    const server = unboundServer()
    const p = server.relay({ t: 'approvalRequest', approvalId: 'ap_1', sessionId: 's', kind: 'practice/write', payload: {} })
    const settled = p.then(() => undefined, (e: unknown) => e)
    await vi.advanceTimersByTimeAsync(HUB_RELAY_TIMEOUT_MS)
    const err = await settled
    expect(err).toBeInstanceOf(HubUnavailableError)
    expect((err as HubUnavailableError).retryable).toBe(true)
  })
})

describe('WorkerServer relay lane — a reply resolves the pending relay', () => {
  it('resolves an rpc relay when the matching rpcResult arrives (correlated by callId)', async () => {
    const server = unboundServer()
    const p = server.relay(rpc('c1'))
    expect(server.pendingRelayCount).toBe(1)

    server.onHub({ t: 'rpcResult', callId: 'c1', ok: true, value: { id: 'm-99' } })
    await expect(p).resolves.toMatchObject({ t: 'rpcResult', callId: 'c1', ok: true, value: { id: 'm-99' } })
    expect(server.pendingRelayCount).toBe(0)
  })

  it('resolves an approvalRequest relay when approvalResolved arrives (correlated by approvalId)', async () => {
    const server = unboundServer()
    const p = server.relay({ t: 'approvalRequest', approvalId: 'ap_7', sessionId: 's', kind: 'practice/write', payload: {} })
    server.onHub({ t: 'approvalResolved', approvalId: 'ap_7', approved: true })
    await expect(p).resolves.toMatchObject({ t: 'approvalResolved', approvalId: 'ap_7', approved: true })
  })

  it('a reply for an unknown/already-resolved id is a safe no-op (idempotent re-flush)', async () => {
    const server = unboundServer()
    const p = server.relay(rpc('c1'))
    server.onHub({ t: 'rpcResult', callId: 'c1', ok: true, value: 1 })
    await p
    // A duplicate reply (e.g. both blue and green answered a re-flushed relay) must not throw.
    expect(() => server.onHub({ t: 'rpcResult', callId: 'c1', ok: true, value: 1 })).not.toThrow()
    expect(() => server.onHub({ t: 'rpcResult', callId: 'never', ok: false, error: 'x' })).not.toThrow()
    expect(server.pendingRelayCount).toBe(0)
  })
})

// --- defaultWorkerSocket -----------------------------------------------------------------------

describe('defaultWorkerSocket', () => {
  const saved = process.env.HUB_WORKER_SOCKET
  afterEach(() => {
    if (saved === undefined) delete process.env.HUB_WORKER_SOCKET
    else process.env.HUB_WORKER_SOCKET = saved
  })

  it('honors the HUB_WORKER_SOCKET override when present', () => {
    process.env.HUB_WORKER_SOCKET = '/custom/worker.sock'
    expect(defaultWorkerSocket('/data')).toBe('/custom/worker.sock')
  })

  it('falls back to the platform default under data/ when the env var is absent', () => {
    delete process.env.HUB_WORKER_SOCKET
    const got = defaultWorkerSocket('/data')
    if (process.platform === 'win32') expect(got).toBe('\\\\.\\pipe\\allmyagents-worker')
    else expect(got).toBe('/data/worker.sock')
  })
})
