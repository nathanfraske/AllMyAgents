import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  setClaudeConnectorPolicy,
  isManagedProfile,
  pickableProfiles,
  CLAUDE_DEFAULT_ID,
  CODEX_DEFAULT_ID,
  profileAuthEvidence,
} from './profiles.js'
import type { Profile } from './types.js'

function tmpProfile(id: string, provider: 'claude' | 'codex', settings?: Record<string, unknown>): Profile {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ama-prof-${id}-`))
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
  return { id, provider, dir }
}
function readSettings(p: Profile): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(p.dir, 'settings.json'), 'utf8')) as Record<string, unknown>
}

// The single rule both hub-writes-vendor-config paths gate on (#8 connector policy, #11 codex bridge):
// configure what we manage, never the user's real ~/.claude / ~/.codex, which their ordinary CLI/IDE use.
describe('isManagedProfile', () => {
  it('is false for the user real vendor homes', () => {
    expect(isManagedProfile(CLAUDE_DEFAULT_ID)).toBe(false)
    expect(isManagedProfile(CODEX_DEFAULT_ID)).toBe(false)
  })
  it('is true for AllMyAgents-managed profiles', () => {
    expect(isManagedProfile('claude-a')).toBe(true)
    expect(isManagedProfile('codex-a')).toBe(true)
  })
})

describe('pickableProfiles', () => {
  it('does not expose vendor homes as accounts on a fresh install', () => {
    const freshProfiles: Profile[] = [
      { id: CLAUDE_DEFAULT_ID, provider: 'claude', dir: '/home/operator/.claude' },
      { id: CODEX_DEFAULT_ID, provider: 'codex', dir: '/home/operator/.codex' },
    ]

    expect(pickableProfiles(freshProfiles)).toEqual([])
  })
})

describe('profileAuthEvidence', () => {
  const jwt = (expiresAtSeconds: number): string => {
    const encoded = Buffer.from(JSON.stringify({ exp: expiresAtSeconds })).toString('base64url')
    return `header.${encoded}.signature`
  }

  it.each([
    {
      provider: 'claude' as const,
      file: '.credentials.json',
      valid: { claudeAiOauth: { accessToken: 'valid', expiresAt: 2_000_000 } },
      expired: { claudeAiOauth: { accessToken: 'expired', expiresAt: 999_000 } },
    },
    {
      provider: 'codex' as const,
      file: 'auth.json',
      valid: { tokens: { access_token: jwt(2_000) } },
      expired: { tokens: { access_token: jwt(999) } },
    },
  ])('distinguishes a valid $provider credential from an expired one', ({ provider, file, valid, expired }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ama-auth-${provider}-`))
    fs.writeFileSync(path.join(dir, file), JSON.stringify(valid))
    expect(profileAuthEvidence({ id: `${provider}-a`, provider, dir }, 1_000_000)).toMatchObject({
      authStatus: 'signed_in',
    })

    fs.writeFileSync(path.join(dir, file), JSON.stringify(expired))
    expect(profileAuthEvidence({ id: `${provider}-a`, provider, dir }, 1_000_000)).toMatchObject({
      authStatus: 'signed_out',
      authError: expect.stringMatching(/expired/i),
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('setClaudeConnectorPolicy', () => {
  it('disables connectors (writes true) for a managed claude profile when the flag is OFF', () => {
    const p = tmpProfile('claude-a', 'claude')
    const written = setClaudeConnectorPolicy([p], false)
    expect(written).toEqual(['claude-a'])
    expect(readSettings(p).disableClaudeAiConnectors).toBe(true)
  })

  it('enables connectors (writes false) when the flag is ON', () => {
    const p = tmpProfile('claude-a', 'claude', { disableClaudeAiConnectors: true })
    setClaudeConnectorPolicy([p], true)
    expect(readSettings(p).disableClaudeAiConnectors).toBe(false)
  })

  it('preserves other settings.json fields (merge, not overwrite)', () => {
    const p = tmpProfile('claude-a', 'claude', { hooks: { PreToolUse: [] }, custom: 42 })
    setClaudeConnectorPolicy([p], false)
    const s = readSettings(p)
    expect(s.disableClaudeAiConnectors).toBe(true)
    expect(s.hooks).toEqual({ PreToolUse: [] })
    expect(s.custom).toBe(42)
  })

  it('is idempotent — no rewrite when already at the target value', () => {
    const p = tmpProfile('claude-a', 'claude', { disableClaudeAiConnectors: true })
    const written = setClaudeConnectorPolicy([p], false) // target !enable = true, already true
    expect(written).toEqual([])
  })

  it('never touches codex profiles or the real ~/.claude default home', () => {
    const codex = tmpProfile('codex-a', 'codex')
    const home = tmpProfile(CLAUDE_DEFAULT_ID, 'claude')
    const written = setClaudeConnectorPolicy([codex, home], false)
    expect(written).toEqual([])
    expect(fs.existsSync(path.join(codex.dir, 'settings.json'))).toBe(false)
    expect(fs.existsSync(path.join(home.dir, 'settings.json'))).toBe(false)
  })

  it('creates settings.json when a managed claude profile has none', () => {
    const p = tmpProfile('claude-b', 'claude') // no settings.json yet
    setClaudeConnectorPolicy([p], false)
    expect(readSettings(p).disableClaudeAiConnectors).toBe(true)
  })
})
