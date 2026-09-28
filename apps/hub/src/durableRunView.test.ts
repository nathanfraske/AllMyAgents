import { describe, expect, it } from 'vitest'
import { durableRunTerminalNotice } from './durableRunView.js'

const run = {
  id: 'run-exact-123', kind: 'test' as const, state: 'succeeded' as const, exitCode: 0,
  commandSummary: 'node test.mjs', stderrBytes: 0, logsTruncated: false,
}

describe('compact durable run wake-up', () => {
  it('keeps the exact identity/state/exit and a route to complete retained evidence', () => {
    const notice = durableRunTerminalNotice(run, 'Allen')
    expect(notice).toContain('Durable test run run-exact-123 for Allen succeeded (exit 0)')
    expect(notice).toContain('Command preview: node test.mjs')
    expect(notice).toContain('Inspect run run-exact-123')
    expect(notice).toContain('detail=full')
    expect(notice).not.toContain('failure')
    expect(notice).not.toContain('Stderr')
  })

  it('does not mislabel successful stderr as failure or repeat its log tail', () => {
    const record = { ...run, stderrBytes: 3000, error: 'expected negative-test stderr'.repeat(80) }
    const original = structuredClone(record)
    const notice = durableRunTerminalNotice(record, 'Allen')
    expect(notice).toContain('succeeded (exit 0)')
    expect(notice).toContain('Stderr/diagnostics retained')
    expect(notice).not.toContain('failure detail')
    expect(notice).not.toContain('expected negative-test stderr')
    expect(record).toEqual(original)
  })

  it('bounds noisy previews visibly and strips terminal formatting without mutating the record', () => {
    const record = { ...run, state: 'failed' as const, exitCode: 19, signal: 'SIGTERM',
      error: '\u001b[31mfailed\u001b[0m\n' + 'x'.repeat(1500),
      commandSummary: 'node ' + '🧪'.repeat(300), logsTruncated: true }
    const original = structuredClone(record)
    const notice = durableRunTerminalNotice(record, 'Target\n' + 'z'.repeat(300))
    expect(notice).toContain('failed (exit 19), signal SIGTERM')
    expect(notice).toContain('Bounded failure detail: failed ')
    expect(notice).not.toContain('\u001b')
    expect(notice).toContain('[truncated]')
    expect(notice).toContain('Retained logs are truncated')
    expect(Array.from(notice).length).toBeLessThan(1200)
    expect(notice).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
    expect(record).toEqual(original)
  })

  it('preserves cancellation and does not invent an exit code', () => {
    const notice = durableRunTerminalNotice({ ...run, state: 'cancelled', exitCode: null, signal: 'SIGTERM' }, 'Allen')
    expect(notice).toContain('was cancelled, signal SIGTERM')
    expect(notice).not.toContain('(exit')
  })

  it('keeps the no-replay warning and missing-observation detail for unknown outcomes', () => {
    const notice = durableRunTerminalNotice({ ...run, state: 'outcome_unknown', exitCode: null,
      error: 'status RPC timed out' }, 'CEC')
    expect(notice).toContain('unknown outcome')
    expect(notice).toContain('may still be running or may have completed')
    expect(notice).toContain('Do not retry it blindly')
    expect(notice).toContain('status RPC timed out')
    expect(notice).not.toContain('(exit')
  })

  it.each(['running', 'queued'] as const)('never reports a %s run as terminal', state => {
    expect(() => durableRunTerminalNotice({ ...run, state }, 'Allen')).toThrow('not terminal')
  })
})
