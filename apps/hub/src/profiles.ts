import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Profile } from './types.js'

export interface ProfileAuthEvidence {
  authStatus?: 'signed_in' | 'signed_out'
  authError?: string
}

/**
 * Infer only what the credential on disk can honestly prove at boot. A recognized token with a
 * future expiry (or a non-expiring API key) is locally signed in; a missing, malformed, or expired
 * credential is signed out. Tokens without an inspectable expiry remain unknown until a real login
 * or vendor request succeeds. File presence alone must never be reported as a healthy account.
 */
export function profileAuthEvidence(
  profile: Pick<Profile, 'id' | 'provider' | 'dir'>,
  nowMs = Date.now(),
): ProfileAuthEvidence {
  const file = path.join(profile.dir, profile.provider === 'claude' ? '.credentials.json' : 'auth.json')
  let credential: Record<string, unknown>
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return signedOut('Credential file is malformed. Sign in again.')
    }
    credential = parsed as Record<string, unknown>
  } catch {
    return signedOut('Credential is missing or unreadable. Sign in again.')
  }

  if (profile.provider === 'claude') {
    const oauth = asRecord(credential.claudeAiOauth)
    const token = stringValue(oauth?.accessToken) ?? stringValue(oauth?.access_token)
    if (!token) return signedOut('Claude credential has no access token. Sign in again.')

    const expiry = claudeExpiryMs(oauth?.expiresAt ?? oauth?.expires_at)
    if (expiry === undefined) return {}
    if (expiry <= nowMs) return signedOut('Claude credential has expired. Sign in again.')
    return { authStatus: 'signed_in' }
  }

  if (stringValue(credential.OPENAI_API_KEY)) return { authStatus: 'signed_in' }
  const tokens = asRecord(credential.tokens)
  const token = stringValue(tokens?.access_token) ?? stringValue(tokens?.accessToken)
  if (!token) return signedOut('Codex credential has no access token. Sign in again.')

  const expiry = jwtExpiryMs(token)
  if (expiry === undefined) return {}
  if (expiry <= nowMs) return signedOut('Codex credential has expired. Sign in again.')
  return { authStatus: 'signed_in' }
}

function signedOut(authError: string): ProfileAuthEvidence {
  return { authStatus: 'signed_out', authError }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function claudeExpiryMs(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    const exp = asRecord(decoded)?.exp
    const seconds = typeof exp === 'string' ? Number(exp) : exp
    return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : undefined
  } catch {
    return undefined
  }
}

export function scanProfiles(profilesDir: string): Profile[] {
  if (!fs.existsSync(profilesDir)) return []
  const out: Profile[] = []
  for (const name of fs.readdirSync(profilesDir)) {
    const dir = path.join(profilesDir, name)
    if (!fs.statSync(dir).isDirectory()) continue
    if (fs.existsSync(path.join(dir, 'auth.json'))) {
      out.push({ id: name, provider: 'codex', dir })
    } else if (fs.existsSync(path.join(dir, '.credentials.json'))) {
      out.push({ id: name, provider: 'claude', dir })
    }
  }
  return out
}

// Fixed ids for the user's DEFAULT vendor homes (the regular CLI + IDE extension config dirs), so
// import can adopt the real history that lives there — not just AllMyAgents-managed profiles/*.
export const CLAUDE_DEFAULT_ID = 'claude-default'
export const CODEX_DEFAULT_ID = 'codex-default'

/**
 * The user's default vendor homes as importable/resumable profiles: `~/.claude` (Claude Code CLI +
 * IDE) and `~/.codex` (Codex CLI + IDE). Gated on the home DIRECTORY existing — NOT on a credential
 * file: on Windows the real `~/.claude` keeps its OAuth token in the OS keychain (no
 * `.credentials.json`), and `~/.codex` carries `auth.json`. Binding a resumed session to these dirs
 * makes the vendor CLI/app-server authenticate the way it normally does (keychain / auth.json).
 * `homeDir` is injectable for tests.
 */
export function defaultHomeProfiles(homeDir: string = os.homedir()): Profile[] {
  const out: Profile[] = []
  const claude = path.join(homeDir, '.claude')
  const codex = path.join(homeDir, '.codex')
  if (isDir(claude)) out.push({ id: CLAUDE_DEFAULT_ID, provider: 'claude', dir: claude })
  if (isDir(codex)) out.push({ id: CODEX_DEFAULT_ID, provider: 'codex', dir: codex })
  return out
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * True for an AllMyAgents-MANAGED profile (`profiles/*`), false for the user's real vendor homes
 * (`~/.claude`, `~/.codex`).
 *
 * THE RULE this encodes: the hub configures what it manages, never the user's vendor home. Those dirs are
 * shared with their ordinary Claude Code / Codex CLI + IDE usage OUTSIDE this app, so writing our policy
 * into them would leak hub behavior into unrelated sessions — a suppressed-connector setting they didn't
 * ask for, or an MCP bridge pointed at a hub that isn't running. Both the connector policy (#8) and the
 * Codex agent-tool bridge (#11) gate on this; new hub-writes-vendor-config paths should too.
 */
export function isManagedProfile(profileId: string): boolean {
  return profileId !== CLAUDE_DEFAULT_ID && profileId !== CODEX_DEFAULT_ID
}

/**
 * Profiles that are real AllMyAgents accounts and may be offered as session targets.
 *
 * The session manager also registers the user's vendor homes so import can discover and resume chats
 * stored there. Those registrations are internal import bindings, not accounts the operator created.
 */
export function pickableProfiles<T extends { id: string }>(profiles: readonly T[]): T[] {
  return profiles.filter((profile) => isManagedProfile(profile.id))
}

/**
 * Apply the claude.ai-connector policy to every MANAGED claude profile's settings.json (merge-preserving):
 * sets `disableClaudeAiConnectors = !enable` so the Claude SDK suppresses (default, safe) or allows cloud
 * MCP connectors for hub-managed sessions. Only touches AllMyAgents-managed `profiles/*` — never the user's
 * real `~/.claude` (CLAUDE_DEFAULT_ID is skipped), and never codex profiles. Idempotent (skips a profile
 * already at the target value) and best-effort per profile (a write failure is swallowed). Driven at boot +
 * on the `enableClaudeConnectors` Danger-Zone toggle. Returns the profile ids it (re)wrote.
 */
export function setClaudeConnectorPolicy(profiles: Profile[], enable: boolean): string[] {
  const written: string[] = []
  for (const p of profiles) {
    if (p.provider !== 'claude' || !isManagedProfile(p.id) || p.available === false) continue
    const file = path.join(p.dir, 'settings.json')
    try {
      let obj: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
        if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>
      } catch {
        /* missing or invalid settings.json → start from an empty object */
      }
      if (obj.disableClaudeAiConnectors === !enable) continue // already correct — no rewrite (no churn)
      obj.disableClaudeAiConnectors = !enable
      fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
      written.push(p.id)
    } catch {
      /* best-effort: a profile we can't write just keeps whatever its settings.json already says */
    }
  }
  return written
}
