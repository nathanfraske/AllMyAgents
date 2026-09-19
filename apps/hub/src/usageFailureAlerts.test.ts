import { expect, it } from 'vitest'
import { isUsageLimitFailure, sameProviderAccount, usageFailureStillApplies } from './usageFailureAlerts.js'
import type { Profile, UsageSnapshot } from './types.js'

it('uses provider identity, not a shared label, and respects conflicting account IDs', () => {
  const a: Profile = { id: 'a', provider: 'codex', dir: '/a', providerAccountId: 'acct', accountEmail: 'a@example.invalid' }
  expect(sameProviderAccount(a, { ...a, id: 'b', dir: '/b' })).toBe(true)
  expect(sameProviderAccount(a, { ...a, id: 'b', providerAccountId: 'other' })).toBe(false)
  expect(sameProviderAccount(a, { ...a, id: 'b', provider: 'claude' })).toBe(false)
  expect(sameProviderAccount(a, { ...a, id: 'b', providerAccountId: undefined, accountEmail: 'A@example.invalid' })).toBe(true)
})

it('classifies quota failures but not provider policy, login, context or unrelated failures', () => {
  for (const message of ["You've hit your limit", 'Usage limit reached', 'rate_limit_exceeded', 'rate limited']) expect(isUsageLimitFailure(message)).toBe(true)
  for (const message of ['cyberPolicy', 'flagged for cybersecurity risk', 'OAuth expired', 'Maximum context length exceeded', 'compile failed', 'compiler reached the limit']) expect(isUsageLimitFailure(message)).toBe(false)
})

it('releases on fresh healthy evidence or reset, while stale healthy telemetry cannot negate a new failure', () => {
  const now = Date.now()
  const failedAt = new Date(now - 1_000).toISOString()
  const snapshot: UsageSnapshot = { profileId: 'a', provider: 'codex', updatedAt: new Date(now).toISOString(), blocked: false, headroom: 1, entitlement: 'entitled', codex: { usedPercent: 10 } }
  expect(usageFailureStillApplies(snapshot, failedAt, now)).toBe(false)
  expect(usageFailureStillApplies({ ...snapshot, updatedAt: new Date(now - 2_000).toISOString() }, failedAt, now)).toBe(true)
  expect(usageFailureStillApplies({ ...snapshot, codex: { usedPercent: 100, resetsAt: now / 1000 + 60 } }, failedAt, now)).toBe(true)
  expect(usageFailureStillApplies({ ...snapshot, codex: { usedPercent: 100, resetsAt: now / 1000 - 1 }, resetsAt: now / 1000 - 1 }, failedAt, now)).toBe(false)
})
