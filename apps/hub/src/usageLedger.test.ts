import { afterEach, describe, expect, it, vi } from 'vitest'
import { Journal } from './journal.js'
import type { Profile } from './types.js'
import { UsageMonitor } from './usage.js'

const opened: Journal[] = []

function profile(id = 'claude-a', provider: Profile['provider'] = 'claude'): Profile {
  return { id, provider, dir: `C:/profiles/${id}`, authStatus: 'signed_in' }
}

afterEach(() => {
  vi.useRealTimers()
  while (opened.length) opened.pop()!.db.close()
})

describe('persistent account usage ledger', () => {
  it('distinguishes authentication from entitlement and restores both across a hub restart', () => {
    const journal = new Journal(':memory:')
    opened.push(journal)
    const firstProfile = profile()
    const first = new UsageMonitor(journal, [firstProfile], {})
    first.noteEntitlement(firstProfile.id, 'denied', 'Claude Code disabled for this organization')
    expect(first.list()[0]).toMatchObject({
      authenticated: true,
      entitlement: 'denied',
      headroom: 0,
    })

    const restoredProfile = profile()
    const restored = new UsageMonitor(journal, [restoredProfile], {})
    expect(restored.list()[0]).toMatchObject({
      authenticated: true,
      entitlement: 'denied',
      entitlementReason: 'Claude Code disabled for this organization',
      headroom: 0,
    })
    expect(restoredProfile.entitlementStatus).toBe('denied')
  })

  it('derives normalized headroom and emits one account-level transition alert', () => {
    const journal = new Journal(':memory:')
    opened.push(journal)
    const codex = profile('codex-a', 'codex')
    const usage = new UsageMonitor(journal, [codex], {})
    const alerts: unknown[] = []
    usage.setAlertListener((alert) => alerts.push(alert))
    usage.noteCodex(codex.id, { usedPercent: 85, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600 })
    expect(usage.list()[0]).toMatchObject({
      entitlement: 'entitled',
      windowType: '300-minute',
    })
    expect(usage.list()[0]!.headroom).toBeCloseTo(0.15)
    expect(alerts).toHaveLength(1)
    usage.noteCodex(codex.id, { usedPercent: 90, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600 })
    expect(alerts).toHaveLength(1)
  })

  it('routes exhausted provider state to zero until its reset boundary', () => {
    vi.useFakeTimers({ now: new Date('2026-08-13T12:00:00Z') })
    const journal = new Journal(':memory:')
    opened.push(journal)
    const claude = profile()
    const usage = new UsageMonitor(journal, [claude], {})
    const resetsAt = Date.now() / 1000 + 60
    usage.noteClaude(claude.id, { status: 'rejected', rateLimitType: 'five_hour', resetsAt })
    expect(usage.list()[0]).toMatchObject({ headroom: 0, limitStatus: 'rejected', resetsAt })
    vi.advanceTimersByTime(61_000)
    expect(usage.list()[0]).toMatchObject({ headroom: 1, limitStatus: 'allowed' })
  })
})
