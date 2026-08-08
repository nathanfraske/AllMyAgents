/**
 * Claude's SDK reports a token-priced API cost for each turn. AllMyAgents accumulates that value for
 * the lifetime of the current hub process; it is neither a provider invoice nor subscription-plan
 * utilization, so it must never be divided by a monthly plan price or labelled "of plan".
 */
export function apiEquivalentCostLabel(
  costUsd: number,
  scope: 'this hub run' | 'this session' | 'past year' | 'this day' = 'this hub run',
): string {
  if (!Number.isFinite(costUsd) || costUsd < 0) return 'API-equivalent cost unavailable'
  return `${apiEquivalentCostAmount(costUsd)} API-equivalent ${scope}`
}

export function apiEquivalentCostAmount(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd < 0) return 'unavailable'
  const digits = costUsd >= 100 ? 0 : costUsd >= 10 ? 1 : 2
  return `~$${costUsd.toFixed(digits)}`
}
