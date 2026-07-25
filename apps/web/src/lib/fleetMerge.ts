/**
 * What happens to an already-merged REMOTE row (a project or session pulled from another fleet machine)
 * when a fresh roster arrives.
 *
 * This is the one decision the unified fleet view kept getting wrong: "the machine is unreachable" and
 * "the row was deleted over there" are completely different events, and collapsing them makes another
 * machine's projects silently VANISH from the sidebar the moment it sleeps — indistinguishable from
 * someone deleting them. A row may only be forgotten when we can actually SEE the owning site and it no
 * longer offers the row; if we cannot see the site, the honest answer is "last known, unreachable".
 */
export type RowFate =
  /** The site answered and still has this row — refresh it. */
  | 'keep'
  /** The site is in the fleet but unreachable — keep the last-known row, flagged unreachable. */
  | 'mark-offline'
  /** Really gone: either the site is reachable and no longer has it, or the site left the fleet. */
  | 'drop'

export function rowFate(opts: {
  siteId: string
  /** Every non-local site in the CURRENT roster, reachable or not. */
  knownSiteIds: Set<string>
  /** The subset that answered a health probe this round. */
  onlineSiteIds: Set<string>
  /** Whether this row came back in this round's pull (only meaningful for an online site). */
  seenNow: boolean
}): RowFate {
  // The site is no longer part of the fleet at all (unpaired / removed) — nothing left to attribute the
  // row to, so stop showing it.
  if (!opts.knownSiteIds.has(opts.siteId)) return 'drop'
  // The site is reachable: its answer is authoritative. Absent means genuinely deleted there.
  if (opts.onlineSiteIds.has(opts.siteId)) return opts.seenNow ? 'keep' : 'drop'
  // The site is in the fleet but did not answer — we simply do not know. Keep what we last saw.
  return 'mark-offline'
}

/**
 * Whether the UI should badge rows with the machine they live on. With a single site there is nothing to
 * disambiguate, so badges are pure noise; the moment a second machine joins, "which box is this on?"
 * becomes a real question on every row.
 */
export function shouldBadgeNodes(siteCount: number): boolean {
  return siteCount > 1
}
