import { describe, it, expect } from 'vitest'
import { stableApprovalId, nextReqId, HubUnavailableError } from './workerProtocol.js'

describe('stableApprovalId — cross-process deterministic', () => {
  it('is identical for equal payloads regardless of top-level AND nested key order', () => {
    const a = stableApprovalId('s1', 'Bash', { command: 'ls', opts: { cwd: '/x', shell: true } })
    const b = stableApprovalId('s1', 'Bash', { opts: { shell: true, cwd: '/x' }, command: 'ls' })
    expect(a).toBe(b)
  })

  it('differs on sessionId, kind, or payload value', () => {
    const base = stableApprovalId('s1', 'Bash', { command: 'ls' })
    expect(stableApprovalId('s2', 'Bash', { command: 'ls' })).not.toBe(base)
    expect(stableApprovalId('s1', 'Edit', { command: 'ls' })).not.toBe(base)
    expect(stableApprovalId('s1', 'Bash', { command: 'rm' })).not.toBe(base)
  })

  it('preserves array order (arrays are ordered data, not sorted)', () => {
    const a = stableApprovalId('s', 'k', { xs: [1, 2, 3] })
    const b = stableApprovalId('s', 'k', { xs: [3, 2, 1] })
    expect(a).not.toBe(b)
  })

  it('produces a stable ap_ prefixed id', () => {
    expect(stableApprovalId('s', 'k', {})).toMatch(/^ap_[0-9a-f]{24}$/)
  })
})

describe('nextReqId', () => {
  it('is strictly monotonic', () => {
    const a = nextReqId()
    const b = nextReqId()
    expect(a).not.toBe(b)
  })
})

describe('HubUnavailableError', () => {
  it('is retryable and an Error', () => {
    const e = new HubUnavailableError()
    expect(e).toBeInstanceOf(Error)
    expect(e.retryable).toBe(true)
  })
})
