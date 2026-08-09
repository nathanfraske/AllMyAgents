import { describe, expect, it } from 'vitest'
import { apiEquivalentCostAmount, apiEquivalentCostLabel } from './usageDisplay'

describe('usage display semantics', () => {
  it('labels SDK token pricing as an API-equivalent hub-run estimate', () => {
    expect(apiEquivalentCostLabel(182.1816)).toBe('~$182 API-equivalent this hub run')
    expect(apiEquivalentCostLabel(37.42)).toBe('~$37.4 API-equivalent this hub run')
    expect(apiEquivalentCostLabel(1.234)).toBe('~$1.23 API-equivalent this hub run')
    expect(apiEquivalentCostLabel(1.234, 'this session')).toBe('~$1.23 API-equivalent this session')
    expect(apiEquivalentCostLabel(4591.16, 'past year')).toBe('~$4591 API-equivalent past year')
    expect(apiEquivalentCostAmount(4.591)).toBe('~$4.59')
  })

  it('never turns the estimate into subscription-plan utilization', () => {
    expect(apiEquivalentCostLabel(601.005)).not.toMatch(/%|plan|month|bill/i)
  })
})
