// Sidebar chat ordering.
//
// THE BUG THIS EXISTS TO KILL. The sidebar sorted on `lastActivity`, and `lastActivity` is bumped by
// EVERY event the hub streams (store.apply → touch: assistant deltas, the live token counter, every
// tool call and result). With several agents running at once — which is the entire point of the
// product — whichever chat emitted the most recent token owned row 1, so the list re-sorted several
// times a second and rows leapt out from under the cursor exactly when the operator most needed to
// click one.
//
// PRIOR ART — t3code (MIT, github.com/pingdotgg/t3code @ 5719e8a), read from source. Their sidebar v2
// states the rule outright in apps/web/src/components/Sidebar.logic.ts, above sortThreadsForSidebarV2:
//
//   "v2 sort: static creation order, newest thread on top. Activity NEVER reorders the list — a row
//    holds its position from open until settled, so the screen only moves at lifecycle transitions.
//    Status (including pending approval) is carried by each card's edge strip, not by position."
//
// Their v1 sorter (packages/client-runtime/src/state/threadSort.ts) arrives at the same guarantee from
// the other side: its key is the latest USER message, so assistant output can never advance it. Both
// tie-break on id, with tests named "breaks timestamp ties by id so the order is stable".
//
// WHAT WE PORT, AND WHAT WE DO NOT. We take the principle — activity never reorders; the list moves
// only at lifecycle transitions — and leave their layout alone. t3code splits the list into Active and
// Settled shelves and sorts the Active shelf on immutable createdAt. We cannot: one group here is a
// single list carrying a persisted manual order (store.reorderChats) and chat folders, so a chat that
// crossed a shelf boundary would have to leave its folder. Instead of a shelf we freeze the KEY per
// row: while a chat is busy it keeps the key it held when the turn began, and only settling
// re-baselines it. Same guarantee — nothing moves while it works — while an idle fleet still reads
// most-recently-active first, and folders and the manual order are untouched.
//
// The two designs converge anyway for the case that matters most: a chat spawned and immediately put
// to work never settles during its first turn, so it holds the key `ensure()` gave it — its creation
// time. That is t3code v2's "static creation order, newest thread on top", reached from our side.

/**
 * Everything ordering depends on, and nothing else. Deliberately not `SessionView`: this module must
 * stay free of runes, vendor payloads and the store, so the comparator is testable as plain data.
 */
export interface ChatOrderFacts {
  id: string
  createdAt: string
  /** Live recency — bumped by every streamed event. Never the sort key on its own; see `orderKey`. */
  lastActivity: string
  /**
   * Recency as of the last time this chat SETTLED — the key the sidebar sorts on. Absent on a view
   * built before this field existed (or by a test fixture), which falls back to `lastActivity`: for an
   * idle chat the two are equal anyway, so the fallback is only ever wrong in the direction of the old
   * behaviour, never in the direction of losing a row.
   */
  orderKey?: string
}

/**
 * Is a turn in flight?
 *
 * Two signals because there are two kinds of row. A local chat has the turn clock `session/status`
 * (and the optimistic send) maintains. A fleet-merged REMOTE row has no local turn clock at all — it
 * is polled read-only — so its hub-reported status is the only thing that can speak for it.
 *
 * This is deliberately the same signal the row's own indicator reads (see `HubStore.status`): if the
 * sidebar is showing a chat as working, that chat's position is pinned. One rule, one thing to explain.
 */
export function isChatBusy(chat: { turnStartedAt?: number; status: string }): boolean {
  return chat.turnStartedAt != null || chat.status === 'active' || chat.status === 'starting'
}

/**
 * The sort key after an event at `ts`.
 *
 * While busy the chat keeps `prev` — that is the freeze, and it is the whole fix. Idle, the key
 * advances to the event time, which is what moves a chat to the top of its group the moment its turn
 * ends (the `session/status: idle` event is itself the settle).
 *
 * It never runs backwards. Journal replay on reconnect re-delivers a session's whole history in seq
 * order, and a row that sank on an old event only to climb again as the replay caught up would be the
 * same thrash arriving by a different road.
 */
export function nextOrderKey(prev: string, ts: string, busy: boolean): string {
  if (busy) return prev
  return ts > prev ? ts : prev
}

/** The key a chat sorts by, with the fallback for views that carry no `orderKey` yet. */
export function chatOrderKey(chat: ChatOrderFacts): string {
  return chat.orderKey ?? chat.lastActivity
}

/**
 * Order one group's chats: the operator's saved arrangement first, then settled recency.
 *
 * Ids named in `manualOrder` sort by their saved position and always precede ids that are not — a
 * chat created after the last drag is appended, never dropped. Everything else falls to (settled
 * recency desc, createdAt desc, id asc).
 *
 * That trailing `id` is not decoration. It makes the comparator a TOTAL order, so the result is a pure
 * function of the SET of chats and cannot depend on the order they happened to arrive in. Ties
 * therefore cannot swap between renders — which is thrash from a second, independent cause, and the
 * one the previous implementation had: it fell back to the incoming array index, and the incoming
 * array was itself sorted by the recency that was churning.
 *
 * Timestamps are compared as ISO strings rather than parsed to numbers on purpose. Lexicographic order
 * on `YYYY-MM-DDTHH:MM:SS.sssZ` is chronological order, and a malformed value still compares
 * deterministically against everything else — where `Date.parse` would yield NaN, and a NaN in a
 * comparator does not merely misplace one row, it corrupts the whole sort.
 */
export function orderChats<T>(
  items: readonly T[],
  manualOrder: readonly string[],
  read: (item: T) => ChatOrderFacts
): T[] {
  const rank = new Map<string, number>()
  manualOrder.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i) // a duplicated id keeps its FIRST slot; two slots would be ambiguous
  })
  const rows = items.map((item) => {
    const f = read(item)
    return { item, rank: rank.get(f.id) ?? Infinity, key: chatOrderKey(f), createdAt: f.createdAt, id: f.id }
  })
  rows.sort((a, b) => {
    // Compared, never subtracted. Two unarranged rows are both Infinity, and `Infinity - Infinity` is
    // NaN, which `Array.prototype.sort` coerces to +0 — so the pair is silently declared EQUAL and
    // falls back to whatever order it arrived in. That is how the previous implementation ended up
    // ordering unarranged chats by the churning recency list it was handed.
    if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1
    if (a.key !== b.key) return a.key < b.key ? 1 : -1
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return rows.map((r) => r.item)
}
