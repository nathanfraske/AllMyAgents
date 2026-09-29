import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperatorAssistance, assistancePreferences, agentToolFailure, boundedToolError, DEFAULT_ASSISTANCE } from './operatorAssistance.js'
import type { HubPrefs, SessionRecord } from './types.js'

function harness() {
  let record: SessionRecord = { id: 's1', provider: 'codex', profileId: 'p1', title: 'Worker', cwd: '.', status: 'active', createdAt: new Date().toISOString() }
  const prefs: Partial<HubPrefs> = {}
  const save = vi.fn(), audit = vi.fn(), notify = vi.fn()
  const host = { prefs: () => prefs, record: (id: string) => id === record.id ? record : undefined, save, audit, notify }
  const service = new OperatorAssistance(host)
  const fail = (callId: string, tool = 'remote_read_file', summary = 'transport connection failed') => service.tool('s1', { phase: 'failure', tool, callId, summary })
  const before = (callId: string, tool = 'remote_read_file') => service.tool('s1', { phase: 'before', tool, callId })
  return { get record() { return record }, prefs, service, fail, before, save, audit, notify,
    reattach: () => { record = JSON.parse(JSON.stringify(record)); return new OperatorAssistance(host) } }
}
afterEach(() => vi.useRealTimers())

describe('operator-owned tool assistance', () => {
  it('defaults on for old configs and validates configurable warning thresholds', () => {
    expect(assistancePreferences({})).toEqual(DEFAULT_ASSISTANCE)
    expect(assistancePreferences({ highTokenUsageThreshold: NaN, highContextUsagePercent: 101 })).toEqual(DEFAULT_ASSISTANCE)
    expect(assistancePreferences({ toolFailureEscalation: false, highTokenUsageWarnings: false, highTokenUsageThreshold: 5000, highContextUsagePercent: 90 }))
      .toEqual({ leanCoordination: true, toolFailureEscalation: false, highTokenUsageWarnings: false, highTokenUsageThreshold: 5000, highContextUsagePercent: 90 })
  })
  it('permits exactly one safe retry, holds further calls and notifies only the operator', () => {
    const h = harness()
    expect(h.before('initial').blocked).toBe(false)
    expect(h.fail('initial')).toMatchObject({ blocked: false, message: expect.stringContaining('once') })
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.before('retry').blocked).toBe(false)
    expect(h.before('parallel-retry').blocked).toBe(true)
    expect(h.fail('retry').blocked).toBe(true)
    expect(h.before('third').blocked).toBe(true)
    expect(h.before('other', 'list_agents').blocked).toBe(false)
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool-help-required', route: 'operator', sessionId: 's1' }))
    h.fail('third'); h.fail('retry')
    expect(h.notify).toHaveBeenCalledTimes(1)
  })
  it('persists dedupe and the in-flight retry hold across a reattach', () => {
    const h = harness()
    h.fail('initial'); h.fail('initial')
    expect(h.record.toolHelp![0]!.failures).toBe(1)
    h.before('retry')
    const restored = h.reattach()
    expect(restored.tool('s1', { phase: 'before', tool: 'remote_read_file', callId: 'different' }).blocked).toBe(true)
    restored.tool('s1', { phase: 'failure', tool: 'remote_read_file', callId: 'retry', summary: 'still disconnected' })
    expect(h.notify).toHaveBeenCalledTimes(1)
  })
  it('clears only the actual successful retry, not an unrelated late completion', () => {
    const h = harness()
    h.fail('initial'); h.before('retry')
    h.service.tool('s1', { phase: 'success', tool: 'remote_read_file', callId: 'older-inflight' })
    expect(h.record.toolHelp).toHaveLength(1)
    h.service.tool('s1', { phase: 'success', tool: 'remote_read_file', callId: 'retry' })
    expect(h.record.toolHelp).toEqual([])
    expect(h.audit).toHaveBeenCalledWith('s1', 'tool-help/recovered', expect.any(Object))
  })
  it.each(['remote_write_file', 'start_run', 'Bash'])('never grants a replay to %s', tool => {
    const h = harness()
    expect(h.fail('initial', tool).blocked).toBe(true)
    expect(h.notify).toHaveBeenCalledTimes(1)
  })
  it.each(['401 Unauthorized', 'usageLimitExceeded', 'outcome_unknown', 'credits exhausted'])('does not retry terminal/ambiguous %s', summary => {
    const h = harness()
    expect(h.fail('initial', 'remote_read_file', summary).blocked).toBe(true)
  })
  it.each(['permission denied', 'approval required', 'outside your project run scope', 'invalid arguments'])('does not label %s a broken tool', summary => {
    const h = harness()
    expect(h.fail('initial', 'remote_read_file', summary).blocked).toBe(false)
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.record.toolHelp).toEqual([])
  })
  it('honors opt-out without silently resolving old incidents', () => {
    const h = harness()
    h.fail('initial', 'Bash')
    h.prefs.toolFailureEscalation = false
    expect(h.before('next', 'Bash').blocked).toBe(false)
    expect(h.record.toolHelp![0]!.status).toBe('waiting')
    h.prefs.toolFailureEscalation = true
    expect(h.before('later', 'Bash').blocked).toBe(true)
  })
  it('supports native-tool reporting, a bounded operator diagnosis, and stale decision rejection', () => {
    vi.useFakeTimers()
    const h = harness()
    h.service.tool('s1', { phase: 'report', tool: 'Read', callId: 'report', summary: 'disconnected', retryAttempted: true })
    const id = h.record.toolHelp![0]!.id
    expect(h.service.resolve('s1', id, 'diagnose')).toContain('not a grant to install')
    expect(() => h.service.resolve('s1', id, 'retry')).toThrow('no longer pending')
    expect(h.before('read', 'Read').blocked).toBe(false)
    vi.advanceTimersByTime(300_001)
    expect(h.before('expired', 'Read').blocked).toBe(true)
    const freshId = h.record.toolHelp![0]!.id
    expect(freshId).not.toBe(id)
    h.service.resolve('s1', freshId, 'skip')
    expect(h.before('skipped', 'Read').blocked).toBe(true)
    h.service.resolve('s1', freshId, 'retry')
    expect(h.before('allowed', 'Read').blocked).toBe(false)
    expect(() => h.service.resolve('s1', freshId, 'retry')).toThrow()
  })
  it('redacts bounded details and never puts raw errors in a desktop notification', () => {
    const h = harness()
    h.fail('initial', 'Bash', '401 Authorization=private-token secret=hidden https://user:password@host/ sk-testing ' + 'x'.repeat(5000))
    expect(h.record.toolHelp![0]!.summary.length).toBeLessThanOrEqual(1000)
    expect(h.record.toolHelp![0]!.summary).not.toMatch(/private-token|hidden|user:password|sk-testing/)
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain('401')
    expect(boundedToolError('ok\x00')).toBe('ok')
    expect(boundedToolError('Authorization: Bearer private-value')).not.toContain('private-value')
  })
  it('recognizes error envelopes without interpreting failure logs as tool failures', () => {
    expect(agentToolFailure('Remote read failed: disconnected')).toContain('disconnected')
    expect(agentToolFailure(JSON.stringify({ ok: false, error: 'socket lost' }))).toBe('socket lost')
    expect(agentToolFailure([{ type: 'text', text: 'Browser unavailable: closed' }])).toContain('closed')
    expect(agentToolFailure(JSON.stringify({ runs: [{ state: 'failed', error: 'test failed' }], logs: { stderr: 'Error: broken assertion' } }))).toBeUndefined()
    expect(agentToolFailure('Test failed: expected 2, got 1')).toBeUndefined()
    expect(agentToolFailure([{ type: 'text', text: 'Page says Error: denied' }])).toBeUndefined()
  })
})

describe('non-blocking token warnings', () => {
  it('counts thread deltas once, excludes cache reads and reasoning subtotals, and resets per turn', () => {
    const h = harness()
    const p = { usageScope: 'thread', input: 200_000, cachedInput: 160_000, output: 60_000, reasoningOutput: 50_000, contextUsed: 800, contextWindow: 1000 }
    h.service.tokens(h.record, p); h.service.tokens(h.record, p)
    expect(h.record.tokenWarning).toMatchObject({ billable: 100_000, cached: 160_000, usageWarned: true, contextWarned: true })
    expect(h.notify).toHaveBeenCalledTimes(2)
    expect(h.record.status).toBe('active')
    h.service.beginTurn(h.record)
    h.service.tokens(h.record, p)
    expect(h.record.tokenWarning!.billable).toBe(0)
    expect(h.notify).toHaveBeenCalledTimes(3) // fresh context warning, no new spend warning
  })
  it('uses the durable baseline on existing conversations; resets do not manufacture usage', () => {
    const h = harness()
    h.record.vendorSessionId = 'existing'
    h.service.beginTurn(h.record, { usageScope: 'thread', input: 1_000_000, output: 500_000 })
    h.service.tokens(h.record, { usageScope: 'thread', input: 1_100_000, output: 500_000 })
    expect(h.record.tokenWarning!.billable).toBe(100_000)
    h.service.tokens(h.record, { usageScope: 'thread', input: 20, output: 10 })
    expect(h.record.tokenWarning!.billable).toBe(100_000)
    const unknown = harness(); unknown.record.vendorSessionId = 'existing'
    unknown.service.tokens(unknown.record, { usageScope: 'thread', input: 9_000_000 })
    expect(unknown.record.tokenWarning!.billable).toBe(0)
  })
  it('deduplicates request updates, lower replays, and late request events after aggregate totals', () => {
    const h = harness()
    const request = { scope: 'request', requestId: 'msg-1', input: 40_000, output: 10_000, cacheRead: 80_000 }
    h.service.tokens(h.record, request)
    h.service.tokens(h.record, { ...request, output: 20_000 })
    h.service.tokens(h.record, request)
    h.service.tokens(h.record, { scope: 'turn', input: 80_000, output: 20_000, cacheRead: 160_000 })
    h.service.tokens(h.record, { ...request, requestId: 'msg-2' })
    h.service.tokens(h.record, request)
    expect(h.record.tokenWarning).toMatchObject({ billable: 110_000, cached: 160_000 })
    expect(h.notify).toHaveBeenCalledTimes(1)
    h.reattach().tokens(h.record, request)
    expect(h.notify).toHaveBeenCalledTimes(1)
  })
  it('bounds per-request bookkeeping and relies on aggregate evidence past the cap', () => {
    const h = harness()
    for (let n = 0; n < 514; n++) h.service.tokens(h.record, { scope: 'request', requestId: String(n), input: 1 })
    expect(Object.keys(h.record.tokenWarning!.requests)).toHaveLength(512)
    expect(h.record.tokenWarning!.billable).toBe(512)
    h.service.tokens(h.record, { scope: 'turn', input: 514 })
    expect(h.record.tokenWarning!.billable).toBe(514)
  })
  it('warns on measured context only, honors opt-out, and never interprets cache as ordinary spend', () => {
    const h = harness()
    h.prefs.highTokenUsageWarnings = false
    h.service.tokens(h.record, { scope: 'turn', input: 150_000, cacheRead: 500_000 })
    expect(h.notify).not.toHaveBeenCalled()
    h.prefs.highTokenUsageWarnings = true
    h.service.tokens(h.record, { scope: 'turn', input: 150_000, contextUsed: 900, contextWindow: 1000 })
    expect(h.notify).toHaveBeenCalledTimes(2)
    const low = harness()
    low.service.tokens(low.record, { scope: 'turn', input: NaN, output: -1, cacheRead: 10_000_000, contextUsed: 999_999 })
    expect(low.notify).not.toHaveBeenCalled()
    expect(low.record.tokenWarning!.billable).toBe(0)
  })
})
