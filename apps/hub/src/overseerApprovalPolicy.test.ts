import { describe, expect, it } from 'vitest'
import {
  applyOverseerApprovalPolicyUpdate, approvalRequesterAllowed, normalizeApprovalRequesterIds,
} from './overseerApprovalPolicy.js'
import type { OverseerApprovalPolicy, OverseerConfig } from './types.js'

describe('requester-scoped Overseer approval policy', () => {
  it('stores explicit operator review precedents without granting risk or requester authority', () => {
    const next = applyOverseerApprovalPolicyUpdate({}, { enabled: true, maxRisk: 'low', requesterSessionIds: ['a'], reviewGuidance: ' Prefer routine read-only pagination within the already granted origin. ' })
    expect(next.approvalPolicy?.reviewGuidance).toBe('Prefer routine read-only pagination within the already granted origin.')
    expect(approvalRequesterAllowed(next.approvalPolicy, 'b')).toBe(false)
    expect(next.approvalPolicy?.maxRisk).toBe('low')
    expect(applyOverseerApprovalPolicyUpdate(next, { enabled: false, maxRisk: 'low' }).approvalPolicy?.reviewGuidance).toBe(next.approvalPolicy?.reviewGuidance)
    expect(applyOverseerApprovalPolicyUpdate(next, { enabled: false, maxRisk: 'low', reviewGuidance: '' }).approvalPolicy?.reviewGuidance).toBe('')
    expect(() => applyOverseerApprovalPolicyUpdate(next, { enabled: true, maxRisk: 'low', reviewGuidance: 'x'.repeat(4001) })).toThrow('4000')
  })
  it('preserves unrelated config and survives JSON persistence without broadening the scope', () => {
    const original: OverseerConfig = { profileId: 'account', operatingMode: 'eco', approvalPolicy: { enabled: false, maxRisk: 'low' } }
    const next = applyOverseerApprovalPolicyUpdate(original, { enabled: true, maxRisk: 'medium', requesterSessionIds: ['arnold', 'arnold'] })
    const restored: OverseerConfig = JSON.parse(JSON.stringify(next))
    expect(restored).toMatchObject({ profileId: 'account', operatingMode: 'eco', approvalPolicy: {
      enabled: true, maxRisk: 'medium', requesterSessionIds: ['arnold'],
    } })
    expect(approvalRequesterAllowed(restored.approvalPolicy, 'arnold')).toBe(true)
    expect(approvalRequesterAllowed(restored.approvalPolicy, 'other')).toBe(false)
    expect(original.approvalPolicy?.enabled).toBe(false)
    next.approvalPolicy!.requesterSessionIds!.push('other')
    expect(approvalRequesterAllowed(restored.approvalPolicy, 'other')).toBe(false)
  })

  it('preserves a scoped list when toggling, with explicit empty list revocation', () => {
    const current: OverseerConfig = { approvalPolicy: { enabled: true, maxRisk: 'low', requesterSessionIds: ['arnold'] } }
    const disabled = applyOverseerApprovalPolicyUpdate(current, { enabled: false, maxRisk: 'low' })
    expect(disabled.approvalPolicy?.requesterSessionIds).toEqual(['arnold'])
    expect(approvalRequesterAllowed(disabled.approvalPolicy, 'arnold')).toBe(false)
    const enabled = applyOverseerApprovalPolicyUpdate(disabled, { enabled: true, maxRisk: 'low' })
    expect(approvalRequesterAllowed(enabled.approvalPolicy, 'arnold')).toBe(true)
    const revoked = applyOverseerApprovalPolicyUpdate(enabled, { enabled: true, maxRisk: 'low', requesterSessionIds: [] })
    expect(approvalRequesterAllowed(revoked.approvalPolicy, 'arnold')).toBe(false)
  })

  it('does not create global delegation from omission, while leaving stored legacy policy unchanged', () => {
    const legacy: OverseerConfig = { approvalPolicy: { enabled: true, maxRisk: 'low' } }
    expect(approvalRequesterAllowed(legacy.approvalPolicy, 'other')).toBe(true)
    expect(() => applyOverseerApprovalPolicyUpdate({}, { enabled: true, maxRisk: 'low' })).toThrow('global enablement')
    expect(() => applyOverseerApprovalPolicyUpdate(legacy, { enabled: true, maxRisk: 'low' })).toThrow('global enablement')
    expect(applyOverseerApprovalPolicyUpdate(legacy, { enabled: false, maxRisk: 'low' }).approvalPolicy?.enabled).toBe(false)
    expect(legacy.approvalPolicy?.enabled).toBe(true)
  })

  it.each([null, '*', ['*'], ['arnold', '*'], [' arnold'], [''], [2], Array(33).fill('arnold'), undefined])(
    'fails closed on a present malformed requester scope: %j', value => {
      expect(() => normalizeApprovalRequesterIds(value)).toThrow()
      expect(approvalRequesterAllowed({ enabled: true, maxRisk: 'medium', requesterSessionIds: value } as OverseerApprovalPolicy, 'arnold')).toBe(false)
    },
  )

  it('rejects high or unknown risk configuration', () => {
    expect(() => applyOverseerApprovalPolicyUpdate({}, { enabled: true, maxRisk: 'high', requesterSessionIds: ['arnold'] } as never)).toThrow('low/medium')
    expect(approvalRequesterAllowed({ enabled: true, maxRisk: 'high' } as never, 'arnold')).toBe(false)
  })
})
