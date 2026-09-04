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

const astra: ProfileModelInfo = {
  slug: 'gpt-6-astra',
  name: 'GPT-6-Astra',
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  defaultEffort: 'medium',
  serviceTiers: [{ id: 'priority', name: 'Fast' }],
  isDefault: true,
}

describe('account-scoped Codex model catalogs', () => {
  it('offers a preview model only on the account that advertised it', () => {
    const codexA = modelsFor('codex', [astra, ordinary, cyber])
    const codexB = modelsFor('codex', [ordinary])

    expect(codexA.map((model) => model.slug)).toContain('gpt-6-astra')
    expect(codexB.map((model) => model.slug)).not.toContain('gpt-6-astra')
    expect(findModel('gpt-6-astra', [ordinary])).toBeUndefined()
    expect(codexA.map((model) => model.slug)).toContain('gpt-daybreak-blue-latest')
    expect(codexB.map((model) => model.slug)).not.toContain('gpt-daybreak-blue-latest')
    expect(findModel('gpt-daybreak-blue-latest', [ordinary])).toBeUndefined()
  })

  it('uses the account catalog for effort and service-tier controls', () => {
    const daybreak = findModel('gpt-daybreak-blue-latest', [astra, ordinary, cyber])
    const astraModel = findModel('gpt-6-astra', [astra, ordinary, cyber])
    const sol = findModel('gpt-5.6-sol', [astra, ordinary, cyber])

    expect(daybreak?.descriptors.find((item) => item.id === 'effort')?.options?.map((item) => item.value))
      .toEqual(['low', 'high', 'ultra'])
    expect(astraModel).toMatchObject({ shortName: '6 Astra', isNew: true, isDefault: true })
    expect(astraModel?.descriptors.find((item) => item.id === 'effort')?.options?.map((item) => item.value))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(sol?.descriptors.find((item) => item.id === 'serviceTier')?.options?.map((item) => item.value))
      .toEqual(['', 'priority'])
  })
})
