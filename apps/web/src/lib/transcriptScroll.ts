// --- Jump-to-bottom affordance --------------------------------------------------------------------
//
// The transcript's autoscroll already does the RIGHT thing: it pins to the bottom only while you are
// near the bottom (`stick`), and leaves you alone once you scroll up to read history — new streaming
// content does not yank you down. This module is the way BACK: a control that appears once you are
// meaningfully scrolled away, and (cheaply, accurately) how much new content has landed below you.
//
// Pure so the thresholds are testable rather than buried in the component.

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Distance in px from the current viewport bottom to the end of the content (0 = at the bottom). */
export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight)
}

/**
 * Whether a pending wheel/touch gesture will leave the viewport inside the live-edge pin zone.
 *
 * The browser can deliver `scroll` after streamed content has already changed layout, so the gesture
 * handler must update the pin before that event. It cannot simply clear the pin, though: a downward
 * wheel at the bottom produces no scroll event at the boundary and would leave autoscroll disabled
 * forever. Projecting the gesture preserves the early intent guard while making direction and the
 * existing near-bottom threshold authoritative.
 */
export function shouldStickAfterScrollIntent(
  m: ScrollMetrics,
  deltaY: number,
  threshold = 60,
): boolean {
  const maxScrollTop = Math.max(0, m.scrollHeight - m.clientHeight)
  const projectedScrollTop = Math.min(maxScrollTop, Math.max(0, m.scrollTop + deltaY))
  return distanceFromBottom({ ...m, scrollTop: projectedScrollTop }) < threshold
}

/**
 * Whether the jump-to-bottom control should show.
 *
 * Threshold: half a viewport, floored at 200px. Rationale — the control must appear only when it is
 * USEFUL (the live end is clearly off-screen, you have scrolled past roughly half a screen of history),
 * never for a two-line nudge near the bottom. Making it a FRACTION of the pane height rather than a flat
 * pixel count keeps it from being too eager on a tall window or too sluggish on a short one; the 200px
 * floor stops a very short pane from popping it on the slightest scroll. This is deliberately a larger
 * gate than the 60px `stick` threshold that governs autoscroll — being "not pinned" is not the same as
 * "far enough away that you want a button".
 */
export function shouldShowJumpToBottom(m: ScrollMetrics): boolean {
  return distanceFromBottom(m) > Math.max(200, m.clientHeight * 0.5)
}

/**
 * How many transcript items are BELOW the anchor — the last item present when the reader scrolled away.
 *
 * Anchoring on the item KEY (not a saved count) is what keeps the number honest across the things that
 * would otherwise corrupt a naive counter: loading OLDER history prepends items (they land before the
 * anchor, so they are not counted as "new"); an optimistic item rolled back on a failed send removes
 * one; switching chats replaces the list. If the anchor is gone or unset we return 0 rather than guess —
 * a wrong "3 new" is worse than none. `lastIndexOf` guards the (pathological) duplicate-key case.
 */
export function newItemsBelow(keys: readonly string[], anchorKey: string | null): number {
  if (!anchorKey) return 0
  const i = keys.lastIndexOf(anchorKey)
  if (i < 0) return 0
  return keys.length - 1 - i
}
