import { describe, expect, it } from 'vitest'
import { maxApprovalRisk, parseApprovalHelperEvaluation } from './approvalHelper.js'

describe('Manager Approval Helper response boundary', () => {
  it('accepts the bounded schema and strips a JSON fence', () => {
    expect(parseApprovalHelperEvaluation(
      '```json\n{"riskLevel":"low","requested":"yes","decision":"allow","reason":"Read-only status inspection."}\n```',
      'low',
    )).toEqual({
      riskLevel: 'low',
      requested: 'yes',
      decision: 'allow',
      reason: 'Read-only status inspection.',
    })
  })

  it('never lets the model lower the deterministic risk floor', () => {
    expect(parseApprovalHelperEvaluation(
      '{"riskLevel":"low","requested":"yes","decision":"allow","reason":"Looks safe."}',
      'high',
    ).riskLevel).toBe('high')
    expect(maxApprovalRisk('critical', 'low')).toBe('critical')
  })

  it('rejects prose and invalid decisions so the caller escalates', () => {
    expect(() => parseApprovalHelperEvaluation('I would probably approve this.', 'low')).toThrow(/JSON object/)
    expect(() => parseApprovalHelperEvaluation(
      '{"riskLevel":"low","requested":"yes","decision":"maybe","reason":"Unsure."}',
      'low',
    )).toThrow(/invalid decision/)
  })
})
