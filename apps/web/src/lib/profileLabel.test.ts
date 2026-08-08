import { describe, expect, it } from 'vitest'
import { profileLabel, profileNativeId, profileOptionLabel } from './profileLabel'

describe('fleet account labels', () => {
  it('keeps transport namespaces out of user-facing labels', () => {
    const profile = {
      id: 'long-peer-identity:codex-b',
      provider: 'codex' as const,
      siteId: 'long-peer-identity',
      siteLabel: 'gdual',
    }

    expect(profileNativeId(profile)).toBe('codex-b')
    expect(profileLabel(profile)).toBe('codex-b')
    expect(profileOptionLabel(profile)).toBe('codex-b · gdual')
  })

  it('combines an operator alias with the hub-local id and readable hub name', () => {
    const profile = {
      id: 'peer:claude-c',
      displayName: 'Review account',
      provider: 'claude' as const,
      siteId: 'peer',
      siteLabel: 'Nathan Beefy Laptop',
    }

    expect(profileLabel(profile)).toBe('Review account')
    expect(profileOptionLabel(profile)).toBe('Review account · claude-c · Nathan Beefy Laptop')
  })
})
