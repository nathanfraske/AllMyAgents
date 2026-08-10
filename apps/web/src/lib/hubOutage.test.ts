import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { HubStore } from './store.svelte'

/**
 * The hub-outage clock behind the "hub stopped, restarting…" banner.
 *
 * `connected` alone could not drive a banner. A sub-second blue-green restart and a hub that has died
 * both set it false, so the only thing honest enough to render from it was a 6px dot in the sidebar —
 * and when the hub really died, the app showed stale content and a grey dot, which reads as "this app is
 * broken" rather than "the hub is coming back". Elapsed time is what separates the two cases, so these
 * tests pin the clock rather than the wording.
 */

function priv(store: HubStore): { markConnected: () => void; markDisconnected: () => void } {
  return store as unknown as { markConnected: () => void; markDisconnected: () => void }
}

interface SocketHarness {
  replayGeneration: number
  connect(): void
}

class DeferredCloseWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = DeferredCloseWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  private closeCode = 1000
  private closeReason = ''

  constructor(url: string | URL) {
    this.url = String(url)
    sockets.push(this)
  }

  open(): void {
    this.readyState = DeferredCloseWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  close(code = 1000, reason = ''): void {
    this.readyState = DeferredCloseWebSocket.CLOSING
    this.closeCode = code
    this.closeReason = reason
  }

  /** Deliberately separate from close(): browsers deliver this event asynchronously. */
  emitClose(): void {
    this.readyState = DeferredCloseWebSocket.CLOSED
    this.onclose?.({ code: this.closeCode, reason: this.closeReason } as CloseEvent)
  }
}

let sockets: DeferredCloseWebSocket[] = []

let store: HubStore
beforeEach(() => {
  vi.useFakeTimers()
  sockets = []
  store = new HubStore()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('hub outage clock', () => {
  it('reads zero before anything has happened', () => {
    expect(store.hubDownSeconds).toBe(0)
    expect(store.hubConnectionPhase).toBe('starting')
  })

  it('counts startup separately before a socket has ever opened', () => {
    priv(store).markDisconnected()
    vi.advanceTimersByTime(5_000)
    expect(store.hubDownSeconds).toBe(5)
    expect(store.hubConnectionPhase).toBe('starting')
  })

  it('resets to zero the moment the socket reopens', () => {
    priv(store).markDisconnected()
    vi.advanceTimersByTime(30_000)
    expect(store.hubDownSeconds).toBe(30)
    priv(store).markConnected()
    expect(store.hubDownSeconds).toBe(0)
    expect(store.connected).toBe(true)
    expect(store.hubConnectionPhase).toBe('connected')
  })

  /**
   * THE ONE THAT MATTERS. Reconnect attempts fail repeatedly during a single outage, and each failure
   * calls markDisconnected again. If that restarted the clock, the counter would never pass the banner's
   * threshold and a real outage would stay invisible — which is the exact bug the banner exists to fix.
   */
  it('measures the whole outage, not the time since the last failed retry', () => {
    priv(store).markDisconnected()
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(1_500)
      priv(store).markDisconnected() // a retry attempt that failed again
    }
    expect(store.hubDownSeconds).toBe(9)
  })

  it('stops counting once reconnected, rather than leaking a timer', () => {
    priv(store).markDisconnected()
    vi.advanceTimersByTime(3_000)
    priv(store).markConnected()
    vi.advanceTimersByTime(60_000)
    expect(store.hubDownSeconds).toBe(0)
  })

  it('starts a fresh count on a second, separate outage', () => {
    priv(store).markDisconnected()
    vi.advanceTimersByTime(10_000)
    priv(store).markConnected()
    priv(store).markDisconnected()
    vi.advanceTimersByTime(2_000)
    expect(store.hubDownSeconds).toBe(2)
    expect(store.hubConnectionPhase).toBe('reconnecting')
  })

  /**
   * The banner shows at >= 4s. An ordinary blue-green restart drops the socket for well under a second,
   * and a banner that flashes on every restart is one you learn to ignore — so the quiet window has to
   * stay quiet. Asserted at the threshold rather than in the markup so the intent survives a redesign.
   */
  it('stays below the banner threshold during a blue-green restart', () => {
    priv(store).markDisconnected()
    vi.advanceTimersByTime(900)
    priv(store).markConnected()
    expect(store.hubDownSeconds).toBeLessThan(4)
  })

  it('crosses the banner threshold for a real outage', () => {
    priv(store).markDisconnected()
    vi.advanceTimersByTime(4_000)
    expect(store.hubDownSeconds).toBeGreaterThanOrEqual(4)
  })

  it('ignores a superseded socket close and schedules only one reconnect for the owner', () => {
    vi.stubGlobal('WebSocket', DeferredCloseWebSocket)
    const transport = store as unknown as SocketHarness
    transport.replayGeneration = 1

    transport.connect()
    const first = sockets[0] as DeferredCloseWebSocket
    first.open()
    expect(store.hubConnectionPhase).toBe('connected')

    // A baseline/generation replacement can open before the browser delivers the old close event.
    transport.connect()
    const replacement = sockets[1] as DeferredCloseWebSocket
    replacement.open()
    first.emitClose()

    expect(store.connected).toBe(true)
    expect(store.hubConnectionPhase).toBe('connected')
    vi.advanceTimersByTime(1_500)
    expect(sockets).toHaveLength(2)

    // Even a duplicate terminal callback from the current socket cannot arm two retry loops.
    replacement.emitClose()
    replacement.emitClose()
    expect(store.hubConnectionPhase).toBe('reconnecting')
    vi.advanceTimersByTime(1_500)
    expect(sockets).toHaveLength(3)
  })
})
