import { describe, expect, it } from 'vitest'
import { heatmapMixPercent, heatmapRelativePercent } from './dashboardUsage'

describe('dashboard usage heatmap', () => {
  it('scales every active day against the busiest visible day', () => {
    expect(heatmapMixPercent(0, 314)).toBe(6)
    expect(heatmapMixPercent(314, 314)).toBe(100)
    expect(heatmapMixPercent(157, 314)).toBe(59)
    expect(heatmapMixPercent(78.5, 314)).toBe(38.5)
    expect(heatmapRelativePercent(157, 314)).toBe(50)
  })

  it('fails closed to an empty-day shade for invalid totals', () => {
    expect(heatmapMixPercent(10, 0)).toBe(6)
    expect(heatmapMixPercent(Number.NaN, 10)).toBe(6)
    expect(heatmapRelativePercent(10, Number.NaN)).toBe(0)
  })
})
