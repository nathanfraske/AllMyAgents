import { describe, it, expect } from 'vitest'
import { rowFate, shouldBadgeNodes } from './fleetMerge'

const known = (...ids: string[]) => new Set(ids)

describe('rowFate — unreachable machine vs. deleted row', () => {
  it('keeps a row the owning site still offers', () => {
    expect(rowFate({ siteId: 'b', knownSiteIds: known('b'), onlineSiteIds: known('b'), seenNow: true })).toBe('keep')
  })

  // The regression this exists for: a sleeping machine used to make its projects disappear entirely,
  // which reads as "someone deleted my work" rather than "that box is off".
  it('KEEPS (flagged offline) a row whose site is in the fleet but unreachable', () => {
    expect(rowFate({ siteId: 'b', knownSiteIds: known('b'), onlineSiteIds: known(), seenNow: false })).toBe('mark-offline')
  })

  it('drops a row the site is reachable but no longer offers (really deleted there)', () => {
    expect(rowFate({ siteId: 'b', knownSiteIds: known('b'), onlineSiteIds: known('b'), seenNow: false })).toBe('drop')
  })

  it('drops a row whose site left the fleet entirely', () => {
    expect(rowFate({ siteId: 'gone', knownSiteIds: known('b'), onlineSiteIds: known('b'), seenNow: false })).toBe('drop')
  })

  it('an unreachable site never drops rows even if the pull returned nothing for it', () => {
    // seenNow is meaningless for an offline site (we could not pull) — it must not force a drop.
    expect(rowFate({ siteId: 'b', knownSiteIds: known('b', 'c'), onlineSiteIds: known('c'), seenNow: false })).toBe('mark-offline')
  })
})

describe('shouldBadgeNodes', () => {
  it('stays quiet on a single-machine install', () => {
    expect(shouldBadgeNodes(1)).toBe(false)
    expect(shouldBadgeNodes(0)).toBe(false)
  })
  it('badges every row once a second machine exists', () => {
    expect(shouldBadgeNodes(2)).toBe(true)
  })
})
