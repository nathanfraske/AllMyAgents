import { afterEach, describe, expect, it, vi } from 'vitest'
import { Journal } from './journal.js'
import type { Profile } from './types.js'
import { UsageMonitor } from './usage.js'

const opened: Journal[] = []

function profile(id = 'claude-a', provider: Profile['provider'] = 'claude'): Profile {
  return { id, provider, dir: `C:/profiles/${id}`, authStatus: 'signed_in' }
}

afterEach(() => {
  vi.clearAllTimers()
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

  it('expires a cached Codex rejection on send without requiring a dashboard read first', () => {
    vi.useFakeTimers({ now: new Date('2026-09-08T12:00:00Z') })
    const journal = new Journal(':memory:')
    opened.push(journal)
    const codex = profile('codex-a', 'codex')
    const usage = new UsageMonitor(journal, [codex], {})
    usage.noteCodex(codex.id, { usedPercent: 100, rateLimitReachedType: 'requests', resetsAt: Date.now() / 1000 + 10 })
    expect(() => usage.assertNotBlocked(codex.id)).toThrow(/usage limit/)
    vi.advanceTimersByTime(11_000)
    expect(() => usage.assertNotBlocked(codex.id)).not.toThrow()
    expect(usage.list()[0]).toMatchObject({ blocked: false, headroom: 1, limitStatus: 'allowed' })
    // A new rejection with a new reset must not be cleared using the previous window's reset time.
    usage.noteCodex(codex.id, { usedPercent: 100, rateLimitReachedType: 'requests', resetsAt: Date.now() / 1000 + 60 })
    expect(() => usage.assertNotBlocked(codex.id)).toThrow(/usage limit/)
  })

  it('rechecks only the exhausted Codex account before sending and publishes the reset', async () => {
    const journal = new Journal(':memory:')
    opened.push(journal)
    const usage = new UsageMonitor(journal, [profile('codex-a', 'codex'), profile('codex-b', 'codex'), profile()], {})
    usage.noteCodex('codex-a', { usedPercent: 100, rateLimitReachedType: 'requests' })
    const read = vi.fn(async () => ({ rateLimits: { primary: { usedPercent: 2, windowDurationMins: 300 } } }))
    const readClaude = vi.fn(async () => [])
    usage.setCodexReader(read)
    usage.setClaudeReader(readClaude)
    await usage.refreshCodexBeforeDispatch('codex-a')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('codex-a')
    expect(readClaude).not.toHaveBeenCalled()
    expect(() => usage.assertNotBlocked('codex-a')).not.toThrow()
    expect(usage.list()[0]).toMatchObject({ blocked: false, codex: { usedPercent: 2 }, headroom: 0.98 })
    expect(journal.since(0)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'usage/snapshot', payload: expect.objectContaining({ profileId: 'codex-a', codex: expect.objectContaining({ usedPercent: 2 }) }) }),
    ]))
    expect(usage.refreshCodexBeforeDispatch('codex-a')).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('polls exhausted accounts within 30 seconds and backs off once they recover', async () => {
    vi.useFakeTimers()
    const journal = new Journal(':memory:')
    opened.push(journal)
    const usage = new UsageMonitor(journal, [profile('codex-a', 'codex')], {})
    const read = vi.fn()
      .mockResolvedValueOnce({ rateLimits: { primary: { usedPercent: 100 } } })
      .mockResolvedValue({ rateLimits: { primary: { usedPercent: 0 } } })
    usage.setCodexReader(read)
    usage.startPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(usage.list()[0]?.codex?.usedPercent).toBe(0)
    await vi.advanceTimersByTimeAsync(270_000)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('coalesces concurrent refreshes and does not let a hung reader pile up or publish after timeout', async () => {
    vi.useFakeTimers()
    const journal = new Journal(':memory:')
    opened.push(journal)
    const usage = new UsageMonitor(journal, [profile('codex-a', 'codex')], {})
    usage.noteCodex('codex-a', { usedPercent: 100, rateLimitReachedType: 'requests' })
    let finish!: (value: unknown) => void
    const read = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValue({ rateLimits: { primary: { usedPercent: 1 } } })
    usage.setCodexReader(read)
    const poll = usage.pollCodexOnce()
    const send = usage.refreshCodexBeforeDispatch('codex-a')
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all([poll, send])
    expect(() => usage.assertNotBlocked('codex-a')).toThrow(/usage limit/)
    await usage.pollCodexOnce()
    expect(read).toHaveBeenCalledTimes(1)
    finish({ rateLimits: { primary: { usedPercent: 0 } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(usage.list()[0]?.codex?.usedPercent).toBe(100)
    expect(journal.since(0).filter((event) => event.kind === 'usage/poll-error')).toHaveLength(1)
    await usage.pollCodexOnce()
    expect(read).toHaveBeenCalledTimes(2)
    expect(usage.list()[0]?.codex?.usedPercent).toBe(1)
  })

  it('retains an actual limit after a failed recheck and rate-limits repeated send attempts', async () => {
    vi.useFakeTimers()
    const journal = new Journal(':memory:')
    opened.push(journal)
    const usage = new UsageMonitor(journal, [profile('codex-a', 'codex')], {})
    usage.noteCodex('codex-a', { usedPercent: 100, rateLimitReachedType: 'requests' })
    const read = vi.fn(async () => { throw new Error('provider unavailable') })
    usage.setCodexReader(read)
    await usage.refreshCodexBeforeDispatch('codex-a')
    expect(() => usage.assertNotBlocked('codex-a')).toThrow(/usage limit/)
    expect(usage.refreshCodexBeforeDispatch('codex-a')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5_000)
    await usage.refreshCodexBeforeDispatch('codex-a')
    expect(read).toHaveBeenCalledTimes(2)
    expect(() => usage.assertNotBlocked('codex-a')).toThrow(/usage limit/)
  })
})
