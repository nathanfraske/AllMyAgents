import { describe, expect, it } from 'vitest'
import type { ProfileInfo } from './api'
import { buildFleetAccountCatalog, suggestedLocalProfileId } from './accountCatalog'

describe('fleet account catalog', () => {
  it('consolidates the same provider email and records each device login independently', () => {
    const profiles: ProfileInfo[] = [
      {
        id: 'codex-work', provider: 'codex', accountEmail: 'Owner@Example.com',
        providerAccountId: 'account-1', authStatus: 'signed_out',
      },
      {
        id: 'peer-a:codex-main', provider: 'codex', accountEmail: 'owner@example.com',
        providerAccountId: 'account-1', authStatus: 'signed_in', siteId: 'peer-a',
        siteLabel: 'Beefy Laptop', siteOnline: true,
      },
      {
        id: 'peer-b:codex-other', provider: 'codex', accountEmail: 'different@example.com',
        providerAccountId: 'account-2', authStatus: 'signed_in', siteId: 'peer-b',
        siteLabel: 'Build Box', siteOnline: false,
      },
    ]

    const catalog = buildFleetAccountCatalog(profiles, 'Home PC')

    expect(catalog).toHaveLength(2)
    expect(catalog.find((account) => account.email?.toLowerCase() === 'owner@example.com')).toMatchObject({
      provider: 'codex',
      localProfiles: [{ id: 'codex-work', authStatus: 'signed_out' }],
      devices: [
        { key: 'local', label: 'Home PC', local: true, online: true, status: 'signed_out' },
        { key: 'peer-a', label: 'Beefy Laptop', local: false, online: true, status: 'signed_in' },
      ],
    })
  })

  it('does not conflate unidentified same-named slots on different devices', () => {
    const catalog = buildFleetAccountCatalog([
      { id: 'claude-a', provider: 'claude' },
      { id: 'peer:claude-a', provider: 'claude', siteId: 'peer', siteLabel: 'Peer' },
    ])
    expect(catalog).toHaveLength(2)
  })

  it('pre-populates a safe local slot and avoids an unrelated local collision', () => {
    const remote: ProfileInfo = {
      id: 'peer:codex-a', provider: 'codex', accountEmail: 'owner@example.com',
      siteId: 'peer', siteLabel: 'Peer', authStatus: 'signed_in',
    }
    const catalog = buildFleetAccountCatalog([
      { id: 'codex-a', provider: 'codex', accountEmail: 'other@example.com' },
      remote,
    ])
    const account = catalog.find((entry) => entry.email === 'owner@example.com')!
    expect(suggestedLocalProfileId(account, [
      { id: 'codex-a', provider: 'codex', accountEmail: 'other@example.com' },
      remote,
    ])).toBe('codex-owner')
  })
})
