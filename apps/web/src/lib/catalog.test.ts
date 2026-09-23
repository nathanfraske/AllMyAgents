import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRecentlyReleased, MODEL_NEW_WINDOW_MS } from './modelReleaseDates'
afterEach(() => vi.useRealTimers())
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
    vi.useFakeTimers().setSystemTime(new Date('2026-09-23T12:00:00Z'))
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

describe('dynamic discovery and release age', () => {
  it('includes an unknown new provider model without an app update or a guessed date', () => {
    const models = modelsFor('codex', [{ ...ordinary, slug: 'future-codex' }])
    expect(models[0]).toMatchObject({ slug: 'future-codex', isNew: false })
    expect(modelsFor('codex', [])).toEqual([])
  })
  it('supports dynamic Claude models without offering Codex effort/tier semantics', () => {
    const models = modelsFor('claude', [{ ...ordinary, slug: 'claude-next', supportedEfforts: [], serviceTiers: [], isDefault: undefined }])
    expect(models[0]?.provider).toBe('claude')
    expect(models[0]?.descriptors[0]?.label).toBe('Thinking')
    expect(models[0]?.isDefault).toBeUndefined()
  })
  it('expires New at 90 days and rejects missing, invalid, and future release dates', () => {
    const release = Date.parse('2026-09-22T00:00:00Z')
    expect(isRecentlyReleased('future', '2026-09-22', release)).toBe(true)
    expect(isRecentlyReleased('future', '2026-09-22', release + MODEL_NEW_WINDOW_MS - 1)).toBe(true)
    expect(isRecentlyReleased('future', '2026-09-22', release + MODEL_NEW_WINDOW_MS)).toBe(false)
    expect(isRecentlyReleased('future', '2026-09-22', release - 1)).toBe(false)
    expect(isRecentlyReleased('future', 'invalid', release)).toBe(false)
    expect(isRecentlyReleased('future', undefined, release)).toBe(false)
  })
  it('expires previously permanent badges in the static fallback too', () => {
    expect(modelsFor('codex', undefined, Date.parse('2027-01-01')).every(model => !model.isNew)).toBe(true)
    expect(modelsFor('claude', undefined, Date.parse('2027-01-01')).every(model => !model.isNew)).toBe(true)
    expect(modelsFor('codex', undefined, Date.parse('2026-09-23')).map(model => model.slug)).not.toContain('gpt-6-astra')
  })
})
