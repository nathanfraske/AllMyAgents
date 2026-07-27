// Unread teammate (bus) mail count for a sidebar chat row, and its tooltip text.
//
// PURE + DEFENSIVE, kept out of the component so the API-shape handling is testable in one place. The
// hub sessions field is OPTIONAL (an older hub, or before Bose's change deploys, omits it), so anything
// that is not a positive finite number yields 0 — and the sidebar renders NO badge at 0, never a zero
// placeholder or a `NaN`. We only ever report the hub's count; we never infer delivery timing here.

/** The badge count from a raw sessions-API value. 0 (⇒ no badge) unless it is a positive finite number. */
export function unreadMailCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Tooltip naming what the marker is — a number alone doesn't say "teammate mail". Assumes n >= 1. */
export function unreadMailTitle(n: number): string {
  return `${n} unread message${n === 1 ? '' : 's'} from teammates`
}
