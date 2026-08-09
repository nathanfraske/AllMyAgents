import { describe, expect, it } from 'vitest'
import { resetLabel } from './time'

describe('usage reset labels', () => {
  it('uses a countdown when the reset is less than 24 hours away', () => {
    const now = Date.parse('2026-08-08T12:00:00.000Z')
    const reset = Math.floor((now + (4 * 60 + 47) * 60_000) / 1000)
    expect(resetLabel(reset, now, 'UTC')).toBe('Resets in 4 hr 47 min')
  })

  it('uses a local absolute date and time outside the 24-hour window', () => {
    const now = Date.parse('2026-08-08T12:00:00.000Z')
    const reset = Date.parse('2026-09-07T16:00:00.000Z') / 1000
    expect(resetLabel(reset, now, 'UTC')).toBe('Resets 4:00 PM Sep. 7th')
  })

  it('includes the year when the reset crosses into another year', () => {
    const now = Date.parse('2026-12-30T12:00:00.000Z')
    const reset = Date.parse('2027-01-02T09:30:00.000Z') / 1000
    expect(resetLabel(reset, now, 'UTC')).toBe('Resets 9:30 AM Jan. 2nd, 2027')
  })
})
