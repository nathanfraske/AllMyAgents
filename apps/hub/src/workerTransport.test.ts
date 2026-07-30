import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HUB_RELAY_TIMEOUT_MS,
  HubUnavailableError,
  QUESTION_RELAY_QUEUE_MAX,
  RELAY_QUEUE_MAX,
  type HubToWorker,
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

interface FakeChannel {
  send(message: WorkerToHub): void
  readonly isClosed: boolean
  destroy(): void
  readonly writes: WorkerToHub[]
}

function attachFakeChannel(server: WorkerServer, epoch: number): FakeChannel {
  const writes: WorkerToHub[] = []
  let closed = false
  const channel: FakeChannel = {
    send: (message) => writes.push(message),
    get isClosed() {
      return closed
    },
    destroy: () => {
      closed = true
    },
    writes,
  }
  const state = server as unknown as {
    channels: Set<FakeChannel>
    attach(
      channel: FakeChannel,
      hello: Extract<HubToWorker, { t: 'hello' }>
    ): void
  }
  state.channels.add(channel)
  state.attach(channel, {
    t: 'hello',
    attachEpoch: epoch,
    danger: {
      busCanUseRiskyTools: false,
      autoApprovePractices: false,
    },
  })
  return channel
}

function question(questionId: string, preview = 'comparison'): Extract<WorkerToHub, { t: 'questionRequest' }> {
  return {
    t: 'questionRequest',
    questionId,
    sessionId: 's',
    toolUseId: `tool-${questionId}`,
    requestId: `request-${questionId}`,
    input: {
      questions: [
        {
          question: `Question ${questionId}?`,
          header: 'Choice',
          options: [
            { label: 'One', description: 'First.', preview },
            { label: 'Two', description: 'Second.' },
          ],
          multiSelect: false,
        },
      ],
    },
  }
}

function rpc(callId: string): Extract<WorkerToHub, { t: 'rpc' }> {
  return { t: 'rpc', callId, method: 'memory.write', args: { note: callId } }
}

describe('WorkerServer question relay lane - dedicated resource and cancellation bounds', () => {
  it(`retains exactly ${QUESTION_RELAY_QUEUE_MAX} large questions and rejects the newcomer without eviction`, async () => {
    const server = unboundServer()
    const retained: Promise<unknown>[] = []
    const largePreview = 'x'.repeat(320_000)
    for (let index = 0; index < QUESTION_RELAY_QUEUE_MAX; index += 1) {
      retained.push(server.relay(question(`q${index}`, largePreview)).catch((error) => error))
    }
    expect(server.pendingRelayCount).toBe(QUESTION_RELAY_QUEUE_MAX)
    await expect(server.relay(question('overflow', largePreview))).rejects.toBeInstanceOf(
      HubUnavailableError
    )
    expect(server.pendingRelayCount).toBe(QUESTION_RELAY_QUEUE_MAX)
    await server.close()
    await Promise.all(retained)
  })

  it('reserves room for a matching abort even when the ordinary relay lane is full', async () => {
    const server = unboundServer()
    const pendingQuestion = server.relay(question('stop-me')).catch((error) => error)
    for (let index = 1; index < RELAY_QUEUE_MAX; index += 1) {
      server.relay(rpc(`fill-${index}`)).catch(() => {})
    }
    expect(server.pendingRelayCount).toBe(RELAY_QUEUE_MAX)

    const abort = server.relay({ t: 'questionAbort', questionId: 'stop-me', sessionId: 's' })
    expect(server.pendingRelayCount).toBe(RELAY_QUEUE_MAX + 1)
    server.onHub({ t: 'questionAbortAck', questionId: 'stop-me', aborted: true })
    await expect(abort).resolves.toMatchObject({ t: 'questionAbortAck', aborted: true })
    server.onHub({
      t: 'questionResolved',
      questionId: 'stop-me',
      outcome: { kind: 'cancelled', reason: 'aborted' },
    })
    await expect(pendingQuestion).resolves.toMatchObject({
      t: 'questionResolved',
      outcome: { kind: 'cancelled', reason: 'aborted' },
    })
    expect(server.pendingRelayCount).toBe(RELAY_QUEUE_MAX - 1)
    await server.close()
  })

  it('does not apply the delivered rpc backstop to a human-interaction question', async () => {
    vi.useFakeTimers()
    try {
      const server = unboundServer()
      attachFakeChannel(server, 1)
      const pending = server.relay(question('slow-human'))
      const settled = pending.then(() => 'resolved', () => 'rejected')
      await vi.advanceTimersByTimeAsync(240_000)
      expect(server.pendingRelayCount).toBe(1)
      server.onHub({
        t: 'questionResolved',
        questionId: 'slow-human',
        outcome: { kind: 'cancelled' },
      })
      expect(await settled).toBe('resolved')
      await server.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts a late correlated question answer from a retiring channel after successor attach', async () => {
    const server = unboundServer()
    const oldChannel = attachFakeChannel(server, 1)
    const pending = server.relay(question('blue-green'))
    const successor = attachFakeChannel(server, 2)
    expect(oldChannel.isClosed).toBe(true)
    const dispatch = (
      server as unknown as {
        dispatch(message: HubToWorker, channel: FakeChannel): void
      }
    ).dispatch.bind(server)
    dispatch(
      {
        t: 'questionResolved',
        questionId: 'blue-green',
        outcome: { kind: 'cancelled' },
      },
      oldChannel
    )
    await expect(pending).resolves.toMatchObject({
      t: 'questionResolved',
      questionId: 'blue-green',
    })
    expect(server.pendingRelayCount).toBe(0)
    expect(successor.isClosed).toBe(false)
    await server.close()
  })
})

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

describe('WorkerServer relay lane — coalesces a duplicate/re-issued relay (H1)', () => {
  it('returns the SAME promise for a repeated key, keeps ONE pending entry, and one reply settles both', async () => {
    const server = unboundServer()
    const p1 = server.relay(rpc('c1'))
    const p2 = server.relay(rpc('c1')) // same stable key — a re-issue, not a new call; must NOT orphan p1
    expect(p2).toBe(p1)
    expect(server.pendingRelayCount).toBe(1)
    const s1 = p1.then((r) => r)
    const s2 = p2.then((r) => r)
    server.onHub({ t: 'rpcResult', callId: 'c1', ok: true, value: { ok: 1 } })
    const [r1, r2] = await Promise.all([s1, s2])
    expect(r1).toEqual(r2)
    expect(server.pendingRelayCount).toBe(0)
    await server.close()
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

  // The Windows expectation here USED to be the fixed pipe `\\.\pipe\allmyagents-worker`, which is the
  // bug it was meant to describe: a named pipe is a GLOBAL name, so every hub on the machine shared one
  // worker however isolated its port and database were. The endpoint is now keyed by data dir on both
  // platforms; see workerSocketIsolation.test.ts for the properties that actually matter.
  it('falls back to a data-dir-keyed default when the env var is absent', () => {
    delete process.env.HUB_WORKER_SOCKET
    const got = defaultWorkerSocket('/data')
    if (process.platform === 'win32') expect(got).toMatch(/^\\\\\.\\pipe\\allmyagents-worker-[0-9a-f]+$/)
    else expect(got).toBe('/data/worker.sock')
  })

  // macOS/BSD cap `sockaddr_un.sun_path` at 104 bytes and bind() fails with an opaque ENAMETOOLONG
  // past it. An installed macOS build's data dir (~/Library/Application Support/AllMyAgents/data) is
  // long enough that a deep home or checkout can cross the line, so the endpoint must degrade to a
  // short temp path instead of producing a worker nobody can connect to. Windows named pipes have no
  // such limit, so the guard is POSIX-only.
  it('degrades to a short temp path when the data dir would overflow the unix socket limit', () => {
    delete process.env.HUB_WORKER_SOCKET
    const deep = `/${'nested-directory'.repeat(12)}/data` // comfortably over 104 bytes
    const got = defaultWorkerSocket(deep)
    if (process.platform === 'win32') {
      // Named pipes have no length limit, so the POSIX degradation does not apply — but the name is still
      // keyed by data dir, so a deep path must not collapse onto some other instance's endpoint.
      expect(got).toMatch(/^\\\\\.\\pipe\\allmyagents-worker-[0-9a-f]+$/)
    } else {
      expect(got).not.toContain(deep)
      expect(Buffer.byteLength(got)).toBeLessThan(104)
      expect(got).toMatch(/ama-worker-\d+\.sock$/)
    }
  })

  // Both sides (hubctl injecting HUB_WORKER_SOCKET, and any process recomputing it) must land on the
  // SAME endpoint, so the fallback has to be deterministic — never randomised per call.
  it('is deterministic for the same input', () => {
    delete process.env.HUB_WORKER_SOCKET
    const deep = `/${'nested-directory'.repeat(12)}/data`
    expect(defaultWorkerSocket(deep)).toBe(defaultWorkerSocket(deep))
  })
})
