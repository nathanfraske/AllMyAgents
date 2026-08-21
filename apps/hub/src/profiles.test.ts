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
  profileAccountIdentity,
  readCodexProfileModelCatalog,
  scanProfiles,
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

  it.each([
    {
      provider: 'claude' as const,
      file: '.credentials.json',
      credential: {
        claudeAiOauth: { accessToken: 'expired', refreshToken: 'refreshable', expiresAt: 999_000 },
      },
    },
    {
      provider: 'codex' as const,
      file: 'auth.json',
      credential: {
        tokens: { access_token: jwt(999), refresh_token: 'refreshable' },
      },
    },
  ])('does not falsely log out an expired but refresh-capable $provider credential', ({ provider, file, credential }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ama-refresh-${provider}-`))
    fs.writeFileSync(path.join(dir, file), JSON.stringify(credential))

    expect(profileAuthEvidence({ id: `${provider}-refreshable`, provider, dir }, 1_000_000)).toEqual({})

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('profileAccountIdentity', () => {
  const jwt = (claims: Record<string, unknown>): string =>
    `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

  it('projects only Claude account identity metadata and never credential material', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-claude-identity-'))
    const dir = path.join(root, 'claude-work')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'never-project-this-token', expiresAt: 4_000_000 },
    }))
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'Owner@Example.com', accountUuid: 'account-claude-1' },
      organization: { name: 'also-private' },
    }))

    const profiles = scanProfiles(root)
    expect(profiles).toEqual([expect.objectContaining({
      id: 'claude-work',
      provider: 'claude',
      accountEmail: 'Owner@Example.com',
      providerAccountId: 'account-claude-1',
    })])
    expect(JSON.stringify(profiles)).not.toContain('never-project-this-token')
    expect(JSON.stringify(profiles)).not.toContain('also-private')
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('reads the Codex email from the provider token while exposing no token bytes', () => {
    const profile = tmpProfile('codex-owner', 'codex')
    const token = jwt({ email: 'owner@example.com', account_id: 'claim-account-id', exp: 4_000 })
    fs.writeFileSync(path.join(profile.dir, 'auth.json'), JSON.stringify({
      tokens: { id_token: token, access_token: 'never-project-this-access-token', account_id: 'codex-account-7' },
    }))

    const identity = profileAccountIdentity(profile)
    expect(identity).toEqual({ accountEmail: 'owner@example.com', providerAccountId: 'codex-account-7' })
    expect(JSON.stringify(identity)).not.toContain(token)
    expect(JSON.stringify(identity)).not.toContain('never-project-this-access-token')
    fs.rmSync(profile.dir, { recursive: true, force: true })
  })

  it('rejects malformed email and whitespace-bearing account identifiers', () => {
    const profile = tmpProfile('claude-invalid', 'claude')
    fs.writeFileSync(path.join(profile.dir, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'not-an-email', accountUuid: 'not an opaque id' },
    }))
    expect(profileAccountIdentity(profile)).toEqual({})
    fs.rmSync(profile.dir, { recursive: true, force: true })
  })
})

describe('readCodexProfileModelCatalog', () => {
  it('projects preview access per account without exposing hidden models or provider instructions', () => {
    const profileA = tmpProfile('codex-a', 'codex')
    const profileB = tmpProfile('codex-b', 'codex')
    fs.writeFileSync(path.join(profileA.dir, 'models_cache.json'), JSON.stringify({
      fetched_at: '2026-08-20T12:34:56.000Z',
      models: [
        {
          slug: 'gpt-daybreak-blue-latest',
          display_name: 'Daybreak Blue',
          description: 'Defensive cybersecurity work.',
          visibility: 'list',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }],
          service_tiers: [{ id: 'priority', name: 'Fast' }],
          base_instructions: 'must never leave the provider profile',
        },
        { slug: 'codex-auto-review', display_name: 'Auto Review', visibility: 'hide' },
      ],
    }))
    fs.writeFileSync(path.join(profileB.dir, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list' }],
    }))

    expect(readCodexProfileModelCatalog(profileA.dir)).toEqual({
      updatedAt: '2026-08-20T12:34:56.000Z',
      models: [{
        slug: 'gpt-daybreak-blue-latest',
        name: 'Daybreak Blue',
        description: 'Defensive cybersecurity work.',
        supportedEfforts: ['low', 'ultra'],
        defaultEffort: 'low',
        serviceTiers: [{ id: 'priority', name: 'Fast' }],
      }],
    })
    expect(readCodexProfileModelCatalog(profileB.dir)?.models.map((model) => model.slug)).toEqual([
      'gpt-5.6-sol',
    ])
    expect(JSON.stringify(readCodexProfileModelCatalog(profileA.dir))).not.toContain('provider profile')

    fs.rmSync(profileA.dir, { recursive: true, force: true })
    fs.rmSync(profileB.dir, { recursive: true, force: true })
  })

  it('accepts the live app-server model/list camelCase shape', () => {
    const profile = tmpProfile('codex-preview', 'codex')
    fs.writeFileSync(path.join(profile.dir, 'models_cache.json'), JSON.stringify({
      data: [{
        id: 'preview-model',
        displayName: 'Preview Model',
        hidden: false,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
        serviceTiers: [{ id: 'priority', name: 'Fast' }],
        isDefault: true,
      }],
    }))

    expect(readCodexProfileModelCatalog(profile.dir)?.models).toEqual([{
      slug: 'preview-model',
      name: 'Preview Model',
      supportedEfforts: ['medium', 'high'],
      defaultEffort: 'high',
      serviceTiers: [{ id: 'priority', name: 'Fast' }],
      isDefault: true,
    }])
    fs.rmSync(profile.dir, { recursive: true, force: true })
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
