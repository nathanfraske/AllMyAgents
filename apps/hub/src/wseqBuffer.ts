/**
 * WseqBuffer — a per-session, bounded, monotonic event buffer that guarantees
 * GAP-FREE event replay when a restarted hub re-attaches to a still-running
 * agent worker (docs/agent-detachment-impl.md §2.5, "gap-free re-attach event
 * replay").
 *
 * ## Why this exists
 *
 * In Phase 2 the agent worker is a *sibling* of the hub, supervised by hubctl,
 * so it outlives every hub bounce (§2.1). Between a hub dying and its successor
 * re-attaching, the worker keeps emitting vendor events (`claude/*`, `codex/*`,
 * `session/tokens`, …), each tagged with a `sessionId`. Those events must reach
 * the new hub **exactly once and in order** — never dropped, never doubled — so
 * the operator's reconnected browser watches an in-flight turn finish across the
 * restart seam (§2.4). That is the whole Phase 2 win.
 *
 * ## What it mirrors
 *
 * This buffer is the worker-side half of that contract and it deliberately
 * mirrors the "since cursor" invariant of the hub's own append-only journal
 * (`journal.ts`: `since(seq)` / `replay(seq)`):
 *
 *   - every event gets a per-session monotonically increasing `wseq`
 *     (the worker analogue of the journal's global `seq`);
 *   - `since(sessionId, afterWseq)` replays strictly-newer events in order;
 *   - the cursor is **exclusive** — `wseq > afterWseq`, exactly like the
 *     journal's `WHERE seq > ?`. A caller that has journaled through `afterWseq`
 *     asks for `since(afterWseq)` and gets everything after, no overlap.
 *
 * The reattaching hub drains `since(sid, lastWseq)` and can attach a live
 * listener in the same tick, joining replay→live with no gap and no duplicate —
 * the same join the journal's synchronous `replay()` enables for the WS.
 *
 * ## Where it differs — bounded, with a visible-gap sentinel
 *
 * Unlike the journal (an unbounded SQLite table), the worker holds events in
 * memory, so the buffer is BOUNDED per session: it keeps only the last N
 * (drop-oldest). If a hub stays gone long enough that trimming discards events
 * it had not yet replayed, silently returning "just what's left" on the next
 * `since()` would swallow whole turns.
 *
 * Instead, a spanning `since()` surfaces a single sentinel event
 * `{ kind: 'worker/attach-gap', payload: { droppedThrough } }` ahead of the
 * survivors, so the new hub journals a **visible** gap marker (§2.5:
 * "drop-oldest with a `worker/attach-gap` marker if a hub is gone too long").
 * `worker/attach-gap` is an additive event kind the web client already tolerates
 * via its `default: break` switch arm, so no web change is needed (§4.3).
 *
 * The sentinel is a **pure function of the cursor vs. the current retained
 * window** — there is no "already emitted" flag. A hub sees it at most once
 * because, after the first spanning replay, it advances its cursor past the gap;
 * subsequent `since()` calls no longer span it. This is the same statelessness
 * that lets the journal's `since(seq)` be called repeatedly without side effects.
 */

/** The additive event kind emitted when a `since()` cursor predates the retained window. */
export const ATTACH_GAP_KIND = 'worker/attach-gap'

/** Default per-session retention (drop-oldest beyond this). Overridable via the constructor. */
export const DEFAULT_MAX_PER_SESSION = 1000

/** A vendor event as handed to `append()` — the worker tags the `sessionId` separately. */
export interface WseqEvent {
  kind: string
  payload: unknown
}

/** A buffered (or replayed) event: a `WseqEvent` stamped with its per-session `wseq`. */
export interface BufferedEvent {
  wseq: number
  kind: string
  payload: unknown
}

interface SessionBuffer {
  /** Retained events, ascending by `wseq`; length is bounded by `max`. */
  events: BufferedEvent[]
  /**
   * The highest `wseq` ever assigned for this session. This is the monotonic
   * counter — it only ever climbs, and (crucially) trimming does NOT lower it.
   * Because trimming raises the oldest *retained* wseq (`events[0].wseq`) while
   * `last` stays put, a later `since()` can compare its cursor against the
   * retained floor to detect that events were dropped.
   */
  last: number
}

export class WseqBuffer {
  private readonly sessions = new Map<string, SessionBuffer>()
  private readonly max: number

  /**
   * @param maxPerSession retained events per session before drop-oldest kicks in
   *        (default {@link DEFAULT_MAX_PER_SESSION} = 1000). Must be a positive integer.
   */
  constructor(maxPerSession: number = DEFAULT_MAX_PER_SESSION) {
    if (!Number.isInteger(maxPerSession) || maxPerSession < 1) {
      throw new RangeError(
        `WseqBuffer maxPerSession must be a positive integer, got ${String(maxPerSession)}`
      )
    }
    this.max = maxPerSession
  }

  /**
   * Assign the next per-session `wseq` (monotonic, starts at 1 for each session),
   * store the event, and return the assigned `wseq`.
   *
   * When the session's retained count exceeds `max`, the oldest events are
   * dropped. `last` is untouched, so the oldest *retained* wseq climbs above 1 —
   * that rising floor is exactly what a later `since()` compares its cursor
   * against to detect a gap.
   */
  append(sessionId: string, event: WseqEvent): number {
    let buf = this.sessions.get(sessionId)
    if (!buf) {
      buf = { events: [], last: 0 }
      this.sessions.set(sessionId, buf)
    }
    const wseq = ++buf.last
    buf.events.push({ wseq, kind: event.kind, payload: event.payload })
    if (buf.events.length > this.max) {
      buf.events.splice(0, buf.events.length - this.max)
    }
    return wseq
  }

  /**
   * Replay every retained event with `wseq > afterWseq`, in ascending order.
   * Returns `[]` for an unknown session or when nothing is newer.
   *
   * The cursor is **exclusive** (mirrors the journal's `seq > ?`): pass the
   * `wseq` you last journaled and you get strictly-newer events, no overlap.
   *
   * If the cursor predates the retained window — i.e. trimming dropped events
   * the caller never saw — the returned array is prefixed with a single
   * {@link ATTACH_GAP_KIND} sentinel `{ payload: { droppedThrough } }`, where
   * `droppedThrough` is the highest wseq that is no longer available. The
   * sentinel carries `wseq === droppedThrough`, so the whole array stays
   * strictly increasing in `wseq` (sentinel, then the oldest survivor at
   * `droppedThrough + 1`, …) and a caller can advance its cursor uniformly.
   */
  since(sessionId: string, afterWseq: number): BufferedEvent[] {
    const buf = this.sessions.get(sessionId)
    if (!buf || buf.events.length === 0) return []

    // Clamp defensively: cursors are non-negative integers. A negative or
    // fractional cursor must not fabricate a spurious gap against the retained
    // floor, nor skip a real boundary event.
    const cursor = Math.max(0, Math.floor(afterWseq))
    const oldestRetained = buf.events[0].wseq

    const out: BufferedEvent[] = []

    // Gap: the caller's next-needed event (cursor + 1) is older than the oldest
    // event still retained → trimming discarded events between them. Note this
    // can only be true when `oldestRetained > 1` (something was actually
    // trimmed), because `cursor >= 0` forces `cursor + 1 >= 1`.
    if (cursor + 1 < oldestRetained) {
      const droppedThrough = oldestRetained - 1
      out.push({ wseq: droppedThrough, kind: ATTACH_GAP_KIND, payload: { droppedThrough } })
    }

    for (const ev of buf.events) {
      if (ev.wseq > cursor) {
        // Fresh wrapper so a caller mutating the result can't corrupt the buffer's
        // bookkeeping (payload is passed by reference, as the journal also does).
        out.push({ wseq: ev.wseq, kind: ev.kind, payload: ev.payload })
      }
    }
    return out
  }

  /** The highest `wseq` assigned for a session, or 0 if the session is unknown. */
  lastWseq(sessionId: string): number {
    return this.sessions.get(sessionId)?.last ?? 0
  }

  /**
   * Drop a session's buffer entirely (call on session end/delete). A subsequent
   * `append()` to the same id starts a fresh sequence at `wseq === 1`.
   */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
