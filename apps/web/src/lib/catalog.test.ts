import { describe, expect, it } from 'vitest'
import { findModel, modelsFor } from './catalog'
import type { ProfileModelInfo } from './api'

const ordinary: ProfileModelInfo = {
  slug: 'gpt-5.6-sol',
  name: 'GPT-5.6 Sol',
  supportedEfforts: ['low', 'medium'],
  defaultEffort: 'low',
  serviceTiers: [{ id: 'priority', name: 'Fast' }],
  isDefault: true,
}

const cyber: ProfileModelInfo = {
  slug: 'gpt-daybreak-blue-latest',
  name: 'Daybreak Blue',
  supportedEfforts: ['low', 'high', 'ultra'],
  defaultEffort: 'low',
  serviceTiers: [],
}

describe('account-scoped Codex model catalogs', () => {
  it('offers a preview model only on the account that advertised it', () => {
    const codexA = modelsFor('codex', [ordinary, cyber])
    const codexB = modelsFor('codex', [ordinary])

    expect(codexA.map((model) => model.slug)).toContain('gpt-daybreak-blue-latest')
    expect(codexB.map((model) => model.slug)).not.toContain('gpt-daybreak-blue-latest')
    expect(findModel('gpt-daybreak-blue-latest', [ordinary])).toBeUndefined()
  })

  it('uses the account catalog for effort and service-tier controls', () => {
    const daybreak = findModel('gpt-daybreak-blue-latest', [ordinary, cyber])
    const sol = findModel('gpt-5.6-sol', [ordinary, cyber])

    expect(daybreak?.descriptors.find((item) => item.id === 'effort')?.options?.map((item) => item.value))
      .toEqual(['low', 'high', 'ultra'])
    expect(sol?.descriptors.find((item) => item.id === 'serviceTier')?.options?.map((item) => item.value))
      .toEqual(['', 'priority'])
  })
})
