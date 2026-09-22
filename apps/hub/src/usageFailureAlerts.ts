import type { Profile, UsageSnapshot } from './types.js'

export function sameProviderAccount(left: Profile, right: Profile): boolean {
  if (left.provider !== right.provider) return false
  if (left.id === right.id) return true
  if (left.providerAccountId && right.providerAccountId) return left.providerAccountId === right.providerAccountId
  return Boolean(left.accountEmail && right.accountEmail &&
    left.accountEmail.trim().toLowerCase() === right.accountEmail.trim().toLowerCase())
}

/** Only terminal provider/hub error text enters here, never assistant/tool transcript text. */
export function isUsageLimitFailure(message: string): boolean {
  if (/cyberPolicy|cybersecurity|context (?:window|length)|maximum context|organization.*access/i.test(message)) return false
  return /(?:usage|rate|quota|spend)[ _-]?(?:limit|control)(?:[^.\n]{0,60})(?:reached|exceeded|exhausted|hit|reject|100%)|(?:hit|reached|exceeded) (?:your |the |its )?(?:usage |rate |quota )limit|hit your limit|(?:is|are) at (?:its |your |the )?(?:usage|rate|quota) limit|rate limited|insufficient_quota/i.test(message)
}

/** Re-evaluated per alert, never a sticky bit. New healthy evidence or an elapsed reset releases it. */
export function usageFailureStillApplies(snapshot: UsageSnapshot | undefined, failedAt: string, now = Date.now()): boolean {
  if (!snapshot) return true // a terminal quota error itself is evidence without a limits event
  const active = (reset: number | undefined) => reset === undefined || !Number.isFinite(reset) || reset > now / 1000
  const codex = snapshot.codex
  const claude = snapshot.claude
  if (codex?.credits?.unlimited || (codex?.credits?.hasCredits && !codex.spendControlReached) ||
    claude?.isUsingOverage || ['allowed', 'allowed_warning'].includes(claude?.overageStatus?.toLowerCase() ?? '')) return false
  const limited = codex?.spendControlReached ||
    (active(codex?.resetsAt) && (Boolean(codex?.rateLimitReachedType) || (codex?.usedPercent ?? 0) >= 100)) ||
    (active(claude?.resetsAt) && claude?.status === 'rejected') ||
    snapshot.claudeUsage?.some(line => line.percent >= 100 && active(line.resetsAt))
  if (limited) return true
  if (snapshot.resetsAt !== undefined && !active(snapshot.resetsAt)) return false
  // Only an observation newer than the failure can disprove that failure's missing-telemetry quota.
  return Date.parse(snapshot.updatedAt) <= Date.parse(failedAt)
}
