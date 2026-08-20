import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { BoundedReplayPage, Journal, ReplayCheckpoint } from './journal.js'
import type { HubEvent } from './types.js'

export const REPLAY_TAIL_MAX_EVENTS = 5_000
export const REPLAY_TAIL_MAX_BYTES = 2 * 1024 * 1024
export const REPLAY_MAX_FRAME_BYTES = 512 * 1024
export const REPLAY_MAX_QUEUED_FRAMES = 1_024
export const REPLAY_BUFFER_SOFT_BYTES = 2 * 1024 * 1024
export const REPLAY_BUFFER_CLOSE_BYTES = 4 * 1024 * 1024
export const REPLAY_PRINCIPAL_BUFFER_BYTES = 32 * 1024 * 1024
export const REPLAY_DURABLE_POLL_MS = 250

export type ReplayResetRequired = {
  type: 'replay-reset-required'
  reason: 'baseline-required' | 'generation-changed' | 'invalid-cursor' | 'tail-too-large'
  checkpoint: ReplayCheckpoint
}

interface ReplaySocket {
  readyState: number
  bufferedAmount: number
  send(encoded: string): void
  close(code: number, reason: string): void
  on(event: 'close', listener: () => void): unknown
}

export class ReplayPrincipalBudget {
  private readonly sockets = new Set<ReplaySocket>()

  constructor(readonly maxBufferedBytes = REPLAY_PRINCIPAL_BUFFER_BYTES) {
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
      throw new Error('replay principal budget is invalid')
    }
  }

  register(socket: ReplaySocket): void {
    this.sockets.add(socket)
  }

  unregister(socket: ReplaySocket): void {
    this.sockets.delete(socket)
  }

  permits(frameBytes: number): boolean {
    let total = frameBytes
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        total += Math.max(0, socket.bufferedAmount)
        if (total > this.maxBufferedBytes) return false
      }
    }
    return true
  }
}

interface ReplayJournal {
  replayCheckpoint(): ReplayCheckpoint
  boundedReplayPage(
    afterSeq: number,
    throughSeq: number,
    options: {
      maxRows: number
      maxBytes: number
      maxFrameBytes: number
      eventFilter?: (event: { seq: number; sessionId: string | null; kind: string }) => boolean
    }
  ): BoundedReplayPage
  on(event: 'event', listener: (event: HubEvent) => void): unknown
  off(event: 'event', listener: (event: HubEvent) => void): unknown
}

export interface ReplayStreamOptions {
  since: number
  generation: number | undefined
  maxEvents?: number
  maxBytes?: number
  maxFrameBytes?: number
  maxQueuedFrames?: number
  bufferSoftBytes?: number
  bufferCloseBytes?: number
  durablePollMs?: number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  principalBudget?: ReplayPrincipalBudget
  /** Optional durable metadata filter. Skipped rows still advance the stream cursor. */
  eventFilter?: (event: { seq: number; sessionId: string | null; kind: string }) => boolean
}

export interface ReplayStreamController {
  /** Test/diagnostic wake-up. Production also polls, so cross-process commits cannot remain invisible. */
  pollNow(): void
}

/**
 * Join one bounded replay page to a durably polled live stream.
 *
 * The local listener is installed before the checkpoint and acts only as a low-latency wake-up. SQLite is
 * the delivery authority: each wake and the bounded timer read rows after the last transmitted sequence,
 * catching commits from a concurrently booting/relinquishing hub process too. No raw payload is decoded
 * until Journal has established that it fits the page and frame budgets.
 */
export function attachReplayStream(
  ws: ReplaySocket,
  journal: ReplayJournal,
  options: ReplayStreamOptions
): ReplayStreamController {
  const maxEvents = options.maxEvents ?? REPLAY_TAIL_MAX_EVENTS
  const maxBytes = options.maxBytes ?? REPLAY_TAIL_MAX_BYTES
  const maxFrameBytes = Math.min(options.maxFrameBytes ?? REPLAY_MAX_FRAME_BYTES, maxBytes)
  const maxQueuedFrames = options.maxQueuedFrames ?? REPLAY_MAX_QUEUED_FRAMES
  const boundedTailEvents = Math.min(maxEvents, maxQueuedFrames)
  const bufferSoftBytes = options.bufferSoftBytes ?? REPLAY_BUFFER_SOFT_BYTES
  const bufferCloseBytes = options.bufferCloseBytes ?? REPLAY_BUFFER_CLOSE_BYTES
  const durablePollMs = options.durablePollMs ?? REPLAY_DURABLE_POLL_MS
  const scheduleInterval = options.setIntervalFn ?? setInterval
  const cancelInterval = options.clearIntervalFn ?? clearInterval
  const principalBudget = options.principalBudget
  let replaying = true
  let polling = false
  let closed = false
  let generation = options.generation
  let cursor = options.since
  let timer: ReturnType<typeof setInterval> | undefined
  principalBudget?.register(ws)

  const cleanup = (): void => {
    if (closed) return
    closed = true
    principalBudget?.unregister(ws)
    try {
      journal.off('event', listener)
    } catch {
      // Socket containment must not turn a subscriber cleanup failure into a hub failure.
    }
    if (timer !== undefined) {
      try {
        cancelInterval(timer)
      } catch {
        // The socket is already terminal; retain that truthful state.
      }
    }
  }
  const close = (code: number, reason: string): void => {
    cleanup()
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(code, reason.slice(0, 123))
      } catch {
        // A transport implementation may throw synchronously while already closing.
      }
    }
  }
  const sendEncoded = (encoded: string, frameBytes: number): boolean => {
    if (closed || ws.readyState !== WebSocket.OPEN) return false
    if (frameBytes > maxFrameBytes) return false
    if (principalBudget && !principalBudget.permits(frameBytes)) {
      close(1013, 'principal replay backpressure')
      return false
    }
    if (ws.bufferedAmount >= bufferCloseBytes || ws.bufferedAmount + frameBytes > bufferCloseBytes) {
      close(1013, 'replay backpressure')
      return false
    }
    if (ws.bufferedAmount >= bufferSoftBytes) {
      close(1013, 'replay backpressure')
      return false
    }
    try {
      ws.send(encoded)
      return true
    } catch {
      close(1011, 'websocket send failed')
      return false
    }
  }
  const sendControl = (control: object): boolean => {
    try {
      const encoded = JSON.stringify(control)
      return sendEncoded(encoded, Buffer.byteLength(encoded))
    } catch {
      close(1011, 'replay control encoding failed')
      return false
    }
  }
  const sendEvents = (page: BoundedReplayPage): boolean => {
    for (const event of page.events) {
      let encoded: string
      try {
        encoded = JSON.stringify(event)
      } catch {
        close(1011, 'journal event encoding failed')
        return false
      }
      if (!sendEncoded(encoded, Buffer.byteLength(encoded))) return false
      cursor = event.seq
    }
    cursor = Math.max(cursor, page.lastSeq)
    return true
  }
  const resetForGeneration = (checkpoint: ReplayCheckpoint): void => {
    sendControl({
      type: 'replay-reset-required',
      reason: 'generation-changed',
      checkpoint,
    } satisfies ReplayResetRequired)
    close(1008, 'replay generation changed')
  }
  const pollNow = (): void => {
    if (closed || replaying || polling) return
    polling = true
    try {
      const checkpoint = journal.replayCheckpoint()
      if (checkpoint.generation !== generation) {
        if (cursor < checkpoint.resetFloorSeq) {
          resetForGeneration(checkpoint)
          return
        }
        generation = checkpoint.generation
      }
      if (checkpoint.cursor <= cursor) return
      const page = journal.boundedReplayPage(cursor, checkpoint.cursor, {
        maxRows: maxQueuedFrames,
        maxBytes: Math.min(REPLAY_TAIL_MAX_BYTES, bufferCloseBytes),
        maxFrameBytes,
        ...(options.eventFilter ? { eventFilter: options.eventFilter } : {}),
      })
      if (page.checkpoint.generation !== generation) {
        if (cursor < page.checkpoint.resetFloorSeq) {
          resetForGeneration(page.checkpoint)
          return
        }
        generation = page.checkpoint.generation
      }
      if (page.tooLarge || page.hasMore) {
        sendControl({
          type: 'replay-reset-required',
          reason: 'tail-too-large',
          checkpoint,
        } satisfies ReplayResetRequired)
        close(1008, 'live durable catch-up requires baseline')
        return
      }
      if (!sendEvents(page)) return
    } catch {
      close(1011, 'journal replay unavailable')
    } finally {
      polling = false
    }
  }
  const listener = (): void => {
    pollNow()
  }
  const controller: ReplayStreamController = { pollNow }

  try {
    journal.on('event', listener)
    ws.on('close', cleanup)
    const checkpoint = journal.replayCheckpoint()
    generation = checkpoint.generation

  if (
    !Number.isSafeInteger(options.since) ||
    options.since < 0 ||
    options.since > checkpoint.cursor
  ) {
    sendControl({
      type: 'replay-reset-required',
      reason: 'invalid-cursor',
      checkpoint,
    } satisfies ReplayResetRequired)
    close(1008, 'invalid replay cursor')
    return controller
  }
  if (options.generation === undefined || (options.since === 0 && checkpoint.cursor > 0)) {
    sendControl({
      type: 'replay-reset-required',
      reason: 'baseline-required',
      checkpoint,
    } satisfies ReplayResetRequired)
    close(1008, 'replay baseline required')
    return controller
  }
  if (options.generation !== checkpoint.generation) {
    if (options.since < checkpoint.resetFloorSeq) {
      resetForGeneration(checkpoint)
      return controller
    }
    generation = checkpoint.generation
  }
  if (
    !sendControl({
      type: 'replay-start',
      generation: checkpoint.generation,
      highWater: checkpoint.cursor,
      resetFloorSeq: checkpoint.resetFloorSeq,
    })
  ) {
    close(1013, 'replay start backpressure')
    return controller
  }

  const page = journal.boundedReplayPage(options.since, checkpoint.cursor, {
    maxRows: boundedTailEvents,
    maxBytes,
    maxFrameBytes,
    ...(options.eventFilter ? { eventFilter: options.eventFilter } : {}),
  })
  if (page.checkpoint.generation !== checkpoint.generation) {
    if (options.since < page.checkpoint.resetFloorSeq) {
      resetForGeneration(page.checkpoint)
      return controller
    }
    generation = page.checkpoint.generation
  }
  if (page.tooLarge || page.hasMore) {
    sendControl({
      type: 'replay-reset-required',
      reason: 'tail-too-large',
      checkpoint,
    } satisfies ReplayResetRequired)
    close(1008, 'replay tail requires baseline')
    return controller
  }
  if (!sendEvents(page)) return controller

  if (!sendControl({ type: 'replay-complete', lastSeq: cursor, generation })) {
    close(1013, 'replay completion backpressure')
    return controller
  }
  replaying = false
  pollNow()
  if (!closed) {
    timer = scheduleInterval(pollNow, durablePollMs)
    timer.unref?.()
  }
    return controller
  } catch {
    close(1011, 'journal replay unavailable')
    return controller
  }
}

// Structural guard: the production Journal is an EventEmitter, while the narrowed test seam above avoids
// importing its private implementation. This assignment makes an accidental API drift a compile error.
const _journalEmitterCompatibility: Pick<EventEmitter, 'on' | 'off'> | undefined = undefined
const _journalReplayCompatibility: Pick<Journal, 'boundedReplayPage'> | undefined = undefined
void _journalEmitterCompatibility
void _journalReplayCompatibility
