import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { attachReplayStream, ReplayPrincipalBudget } from './replayStream.js'
import type { HubEvent } from './types.js'

function event(seq: number, text = `event-${seq}`): HubEvent {
  return {
    seq,
    ts: '2026-07-30T12:00:00.000Z',
    sessionId: 's',
    kind: 'session/input',
    payload: { text },
  }
}

class FakeJournal extends EventEmitter {
  generation = 4
  resetFloorSeq = 0
  events: HubEvent[] = []
  onRead?: () => void

  replayCheckpoint() {
    return {
      version: 1 as const,
      generation: this.generation,
      cursor: this.events.at(-1)?.seq ?? 0,
      resetFloorSeq: this.resetFloorSeq,
    }
  }

  boundedReplayPage(
    afterSeq: number,
    throughSeq: number,
    options: { maxRows: number; maxBytes: number; maxFrameBytes: number }
  ) {
    const rows = this.events
      .filter((candidate) => candidate.seq > afterSeq && candidate.seq <= throughSeq)
      .slice(0, options.maxRows)
    const hook = this.onRead
    this.onRead = undefined
    hook?.()
    const accepted: HubEvent[] = []
    let encodedBytes = 0
    for (const row of rows) {
      const bytes = Buffer.byteLength(JSON.stringify(row))
      if (bytes > options.maxFrameBytes) {
        return {
          checkpoint: this.replayCheckpoint(),
          events: accepted,
          lastSeq: accepted.at(-1)?.seq ?? afterSeq,
          hasMore: true,
          encodedBytes,
          tooLarge: { seq: row.seq, encodedBytes: bytes },
        }
      }
      if (encodedBytes + bytes > options.maxBytes) break
      accepted.push(row)
      encodedBytes += bytes
    }
    const lastSeq = accepted.at(-1)?.seq ?? afterSeq
    return {
      checkpoint: this.replayCheckpoint(),
      events: accepted,
      lastSeq,
      hasMore: lastSeq < throughSeq,
      encodedBytes,
    }
  }
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  sent: string[] = []
  closed?: { code: number; reason: string }
  onSend?: (encoded: string) => void
  throwOnSend = false

  send(encoded: string): void {
    if (this.throwOnSend) throw new Error('send failed')
    this.sent.push(encoded)
    this.onSend?.(encoded)
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason }
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent.map((encoded) => JSON.parse(encoded) as Record<string, unknown>)
  }
}

describe('bounded replay to live join', () => {
  it('requires a baseline on a non-empty journal instead of silently replaying from zero', () => {
    const journal = new FakeJournal()
    journal.events = [event(1)]
    const socket = new FakeSocket()

    attachReplayStream(socket, journal, { since: 0, generation: undefined })

    expect(socket.messages()).toEqual([
      expect.objectContaining({
        type: 'replay-reset-required',
        reason: 'baseline-required',
        checkpoint: expect.objectContaining({ generation: 4, cursor: 1 }),
      }),
    ])
    expect(socket.closed?.code).toBe(1008)
    expect(journal.listenerCount('event')).toBe(0)
  })

  it('atomically rejects a catch-up that cannot reach high-water inside one bounded tail', () => {
    const journal = new FakeJournal()
    journal.events = Array.from({ length: 10 }, (_, index) => event(index + 1))
    const socket = new FakeSocket()

    attachReplayStream(socket, journal, {
      since: 2,
      generation: 4,
      maxEvents: 3,
      maxBytes: 10_000,
    })

    const messages = socket.messages()
    expect(messages.filter((message) => typeof message.seq === 'number')).toEqual([])
    expect(messages.at(-1)).toEqual({
      type: 'replay-reset-required',
      reason: 'tail-too-large',
      checkpoint: { version: 1, generation: 4, cursor: 10, resetFloorSeq: 0 },
    })
    expect(socket.closed).toEqual({ code: 1008, reason: 'replay tail requires baseline' })
  })

  it('queues a concurrently appended event once and flushes it after the replay boundary', () => {
    const journal = new FakeJournal()
    journal.events = [event(1), event(2)]
    journal.onRead = () => {
      const live = event(3, 'live')
      journal.events.push(live)
      journal.emit('event', live)
    }
    const socket = new FakeSocket()

    attachReplayStream(socket, journal, {
      since: 1,
      generation: 4,
      maxEvents: 10,
      maxBytes: 10_000,
    })

    expect(socket.messages().map((message) => message.type ?? message.seq)).toEqual([
      'replay-start',
      2,
      'replay-complete',
      3,
    ])
    expect(socket.closed).toBeUndefined()
    expect(journal.listenerCount('event')).toBe(1)
    socket.close(1000, 'test complete')
    expect(journal.listenerCount('event')).toBe(0)
  })

  it('durably polls a second-process append that did not emit on this Journal instance', () => {
    const journal = new FakeJournal()
    journal.events = [event(1)]
    const socket = new FakeSocket()
    const controller = attachReplayStream(socket, journal, {
      since: 1,
      generation: 4,
      durablePollMs: 60_000,
    })

    journal.events.push(event(2, 'other process'))
    controller.pollNow()

    expect(socket.messages().map((message) => message.type ?? message.seq)).toEqual([
      'replay-start',
      'replay-complete',
      2,
    ])
    socket.close(1000, 'test complete')
  })

  it('requires a fresh baseline when maintenance changed the replay generation', () => {
    const journal = new FakeJournal()
    journal.events = [event(1), event(2)]
    journal.resetFloorSeq = 2
    const socket = new FakeSocket()

    attachReplayStream(socket, journal, { since: 1, generation: 3 })

    expect(socket.messages()).toEqual([
      expect.objectContaining({
        type: 'replay-reset-required',
        reason: 'generation-changed',
      }),
    ])
    expect(socket.closed?.code).toBe(1008)
  })

  it('sends no tail rows when generation changes between checkpoint and bounded page snapshot', () => {
    const journal = new FakeJournal()
    journal.events = [event(1), event(2)]
    journal.onRead = () => {
      journal.generation = 5
      journal.resetFloorSeq = 2
    }
    const socket = new FakeSocket()

    attachReplayStream(socket, journal, { since: 1, generation: 4 })

    expect(socket.messages().filter((message) => typeof message.seq === 'number')).toEqual([])
    expect(socket.messages().at(-1)).toEqual(
      expect.objectContaining({
        type: 'replay-reset-required',
        reason: 'generation-changed',
        checkpoint: expect.objectContaining({ generation: 5 }),
      })
    )
    expect(socket.closed?.code).toBe(1008)
  })

  it('adopts many maintenance generations when the cursor is already beyond every changed row', () => {
    const journal = new FakeJournal()
    journal.generation = 104
    journal.resetFloorSeq = 1
    journal.events = [event(1), event(2)]
    const socket = new FakeSocket()

    attachReplayStream(socket, journal, { since: 2, generation: 4 })

    expect(socket.messages().map((message) => message.type)).toEqual([
      'replay-start',
      'replay-complete',
    ])
    expect(socket.messages().at(-1)).toEqual(
      expect.objectContaining({ generation: 104, lastSeq: 2 })
    )
    expect(socket.closed).toBeUndefined()
    socket.close(1000, 'test complete')
  })

  it('closes with retryable backpressure before the socket retains an unbounded replay', () => {
    const journal = new FakeJournal()
    journal.events = [event(1), event(2), event(3)]
    const socket = new FakeSocket()
    socket.onSend = () => {
      socket.bufferedAmount = 2 * 1024 * 1024
    }

    attachReplayStream(socket, journal, {
      since: 1,
      generation: 4,
      bufferSoftBytes: 2 * 1024 * 1024,
      bufferCloseBytes: 4 * 1024 * 1024,
    })

    expect(socket.sent).toHaveLength(1)
    expect(socket.closed?.code).toBe(1013)
    expect(journal.listenerCount('event')).toBe(0)
  })

  it('bounds aggregate queued bytes across every socket for one authenticated principal', () => {
    const journal = new FakeJournal()
    journal.events = [event(1)]
    const budget = new ReplayPrincipalBudget(200)
    const first = new FakeSocket()
    attachReplayStream(first, journal, {
      since: 1,
      generation: 4,
      principalBudget: budget,
    })
    first.bufferedAmount = 100

    const second = new FakeSocket()
    second.bufferedAmount = 100
    attachReplayStream(second, journal, {
      since: 1,
      generation: 4,
      principalBudget: budget,
    })

    expect(second.closed).toEqual({
      code: 1013,
      reason: 'principal replay backpressure',
    })
    expect(first.closed).toBeUndefined()
    first.close(1000, 'test complete')
  })

  it('requires a fresh baseline for an oversized tail event without sending a partial tail', () => {
    const journal = new FakeJournal()
    journal.events = [event(1), event(2, 'x'.repeat(2_000))]
    const socket = new FakeSocket()

    attachReplayStream(socket, journal, {
      since: 1,
      generation: 4,
      maxFrameBytes: 512,
    })

    expect(socket.messages().at(-1)).toEqual(
      expect.objectContaining({
        type: 'replay-reset-required',
        reason: 'tail-too-large',
      })
    )
    expect(socket.messages().filter((message) => typeof message.seq === 'number')).toEqual([])
    expect(socket.closed?.code).toBe(1008)
  })

  it('never turns a 690k-row cursor gap into repeated continuation sockets', () => {
    const journal = new FakeJournal()
    journal.events = [
      ...Array.from({ length: 5_001 }, (_, index) => event(index + 1)),
      event(690_000),
    ]
    const socket = new FakeSocket()

    attachReplayStream(socket, journal, {
      since: 1,
      generation: 4,
      maxEvents: 5_000,
      maxBytes: 2 * 1024 * 1024,
    })

    expect(socket.messages()).toEqual([
      expect.objectContaining({ type: 'replay-start' }),
      expect.objectContaining({
        type: 'replay-reset-required',
        reason: 'tail-too-large',
        checkpoint: expect.objectContaining({ cursor: 690_000 }),
      }),
    ])
    expect(socket.closed?.code).toBe(1008)
  })

  it('contains a synchronous bounded journal read failure to one socket', () => {
    const journal = new FakeJournal()
    journal.events = [event(1)]
    journal.boundedReplayPage = () => {
      throw new Error('SQLITE_IOERR')
    }
    const socket = new FakeSocket()

    expect(() => attachReplayStream(socket, journal, { since: 1, generation: 4 })).not.toThrow()
    expect(socket.closed?.code).toBe(1011)
  })

  it('contains a synchronous event encoding failure to one socket', () => {
    const journal = new FakeJournal()
    journal.events = [event(1), event(2)]
    journal.boundedReplayPage = () => ({
      checkpoint: journal.replayCheckpoint(),
      events: [{ ...event(2), payload: { unsupported: 1n } }],
      lastSeq: 2,
      hasMore: false,
      encodedBytes: 1,
    })
    const socket = new FakeSocket()

    expect(() => attachReplayStream(socket, journal, { since: 1, generation: 4 })).not.toThrow()
    expect(socket.closed?.code).toBe(1011)
  })

  it('contains a synchronous socket send failure to one socket', () => {
    const journal = new FakeJournal()
    const socket = new FakeSocket()
    socket.throwOnSend = true

    expect(() => attachReplayStream(socket, journal, { since: 0, generation: 4 })).not.toThrow()
    expect(socket.closed?.code).toBe(1011)
  })
})
