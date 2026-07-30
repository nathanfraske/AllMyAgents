import { describe, expect, it, vi } from 'vitest'
import type { ClaimResult } from './profileOwnership.js'
import { reconcileProfileRegistry } from './profileRegistry.js'
import type { Profile } from './types.js'

function owner(ownerId: string, port: number): ClaimResult['owner'] {
  return {
    ownerId,
    pid: 100,
    port,
    startedAt: '2026-07-30T00:00:00.000Z',
    epoch: `${ownerId}-epoch`,
  }
}

describe('profile registry ownership refresh', () => {
  it('reclaims an existing profile and clears stale unavailability only after a fresh successful claim', () => {
    const existing: Profile = {
      id: 'claude-a',
      provider: 'claude',
      dir: 'C:/profiles/claude-a',
      available: false,
      ownerPort: 7999,
      unavailableReason: 'owned by an old hub',
    }
    const profiles = [existing]
    const profileMap = new Map([[existing.id, existing]])
    const claim = vi.fn((): ClaimResult => ({
      owned: true,
      owner: owner('new-hub', 7777),
      reclaimed: true,
    }))

    reconcileProfileRegistry({
      profiles,
      profileMap,
      scanned: [{ id: existing.id, provider: 'claude', dir: existing.dir }],
      claim,
      refreshAuth: vi.fn(),
      onAdded: vi.fn(),
    })

    expect(claim).toHaveBeenCalledWith(existing.id, existing.dir)
    expect(existing).toMatchObject({ available: true })
    expect(existing.ownerPort).toBeUndefined()
    expect(existing.unavailableReason).toBeUndefined()
  })

  it('keeps an existing profile unavailable when its fresh claim is still foreign', () => {
    const existing: Profile = {
      id: 'codex-a',
      provider: 'codex',
      dir: 'C:/profiles/codex-a',
      available: true,
    }
    const foreign = owner('old-live-hub', 7999)

    reconcileProfileRegistry({
      profiles: [existing],
      profileMap: new Map([[existing.id, existing]]),
      scanned: [{ ...existing }],
      claim: () => ({ owned: false, owner: foreign }),
      refreshAuth: vi.fn(),
      onAdded: vi.fn(),
    })

    expect(existing).toMatchObject({
      available: false,
      ownerPort: 7999,
      unavailableReason: expect.stringMatching(/7999.*codex-a/i),
    })
  })

  it('rechecks ownership and authentication when the credential file temporarily disappears', () => {
    const existing: Profile = {
      id: 'claude-a',
      provider: 'claude',
      dir: 'C:/profiles/claude-a',
      available: false,
      ownerPort: 7999,
      unavailableReason: 'stale',
    }
    const claim = vi.fn((): ClaimResult => ({
      owned: true,
      owner: owner('new-hub', 7777),
    }))
    const refreshAuth = vi.fn((profile: Profile) => {
      profile.authStatus = 'signed_out'
      profile.authError = 'Credential is missing or unreadable. Sign in again.'
    })

    reconcileProfileRegistry({
      profiles: [existing],
      profileMap: new Map([[existing.id, existing]]),
      scanned: [],
      claim,
      refreshAuth,
      onAdded: vi.fn(),
    })

    expect(claim).toHaveBeenCalledOnce()
    expect(refreshAuth).toHaveBeenCalledWith(existing)
    expect(existing).toMatchObject({ available: true, authStatus: 'signed_out' })
  })

  it('isolates one unverifiable claim, refreshes the next profile, and recovers on a later rescan', () => {
    const first: Profile = {
      id: 'claude-a',
      provider: 'claude',
      dir: 'C:/profiles/claude-a',
      available: false,
      ownerPort: 7999,
      unavailableReason: 'prior owner evidence',
    }
    const second: Profile = {
      id: 'codex-a',
      provider: 'codex',
      dir: 'C:/profiles/codex-a',
      available: false,
    }
    let firstClaimFails = true
    const claim = vi.fn((profileId: string): ClaimResult => {
      if (profileId === first.id && firstClaimFails) {
        throw Object.assign(new Error('C:/secret/path: EACCES'), { code: 'EACCES' })
      }
      return { owned: true, owner: owner('new-hub', 7777), reclaimed: true }
    })
    const refreshAuth = vi.fn((profile: Profile) => {
      profile.authStatus = 'signed_in'
      delete profile.authError
    })
    const options = {
      profiles: [first, second],
      profileMap: new Map([
        [first.id, first],
        [second.id, second],
      ]),
      scanned: [{ ...first }, { ...second }],
      claim,
      refreshAuth,
      onAdded: vi.fn(),
    }

    reconcileProfileRegistry(options)

    expect(first).toMatchObject({
      available: false,
      ownerPort: 7999,
      unavailableReason: expect.stringMatching(/could not be verified safely/i),
    })
    expect(first.unavailableReason).not.toContain('C:/secret')
    expect(refreshAuth).not.toHaveBeenCalledWith(first)
    expect(second).toMatchObject({ available: true, authStatus: 'signed_in' })

    firstClaimFails = false
    reconcileProfileRegistry(options)
    expect(first).toMatchObject({ available: true, authStatus: 'signed_in' })
    expect(first.ownerPort).toBeUndefined()
    expect(first.unavailableReason).toBeUndefined()
  })

  it('isolates an authentication refresh failure and keeps a newly identified profile visible', () => {
    const first: Profile = {
      id: 'claude-a',
      provider: 'claude',
      dir: 'C:/profiles/claude-a',
    }
    const second: Profile = {
      id: 'codex-a',
      provider: 'codex',
      dir: 'C:/profiles/codex-a',
    }
    const profiles = [first]
    const profileMap = new Map([[first.id, first]])
    const onAdded = vi.fn((profile: Profile) => profiles.push(profile))
    const refreshAuth = vi.fn((profile: Profile) => {
      if (profile.id === first.id) throw new Error('credential contents must stay private')
      profile.authStatus = 'signed_in'
    })

    reconcileProfileRegistry({
      profiles,
      profileMap,
      scanned: [{ ...first }, second],
      claim: () => ({ owned: true, owner: owner('new-hub', 7777) }),
      refreshAuth,
      onAdded,
    })

    expect(first).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(/authentication state.*safely/i),
    })
    expect(first.unavailableReason).not.toContain('credential contents')
    expect(second).toMatchObject({ available: true, authStatus: 'signed_in' })
    expect(profileMap.get(second.id)).toBe(second)
    expect(onAdded).toHaveBeenCalledWith(second)
  })
})
