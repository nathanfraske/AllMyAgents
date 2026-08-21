import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Profile, ProfileAvailableModel } from './types.js'

export interface ProfileAuthEvidence {
  authStatus?: 'signed_in' | 'signed_out'
  authError?: string
}

export interface ProfileAccountIdentity {
  accountEmail?: string
  providerAccountId?: string
}

interface CodexCatalogCacheEntry {
  signature: string
  value?: { models: ProfileAvailableModel[]; updatedAt: string }
}

const codexCatalogCache = new Map<string, CodexCatalogCacheEntry>()

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim()
  return clean ? clean.slice(0, max) : undefined
}

function catalogStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => boundedString(item, 40)).filter((item): item is string => !!item))].slice(0, 12)
}

/**
 * Read Codex's provider-maintained model catalog for ONE managed account.
 *
 * `models_cache.json` is account-scoped and refreshed by app-server after authentication, so it is the
 * entitlement boundary for private/preview catalogs (for example a cyber model on codex-a). Project only
 * display/options metadata: model instructions and other large provider internals never leave the profile.
 * Cache by the file generation so ordinary `/api/profiles` reads pay only a stat after the first parse.
 */
export function readCodexProfileModelCatalog(
  profileDir: string,
): { models: ProfileAvailableModel[]; updatedAt: string } | undefined {
  const file = path.join(profileDir, 'models_cache.json')
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    codexCatalogCache.delete(file)
    return undefined
  }
  const signature = `${stat.size}:${stat.mtimeMs}`
  const cached = codexCatalogCache.get(file)
  if (cached?.signature === signature) return cached.value

  try {
    const root = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const rows = Array.isArray(root.models) ? root.models : Array.isArray(root.data) ? root.data : []
    const models: ProfileAvailableModel[] = []
    const seen = new Set<string>()
    for (const raw of rows.slice(0, 200)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const row = raw as Record<string, unknown>
      if (row.hidden === true || row.visibility === 'hide') continue
      const slug = boundedString(row.slug ?? row.model ?? row.id, 160)
      if (!slug || seen.has(slug)) continue
      const name = boundedString(row.display_name ?? row.displayName, 160) ?? slug
      const rawEfforts = Array.isArray(row.supported_reasoning_levels)
        ? row.supported_reasoning_levels
        : Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts
          : []
      const supportedEfforts = [...new Set(rawEfforts.map((entry) => {
        if (typeof entry === 'string') return boundedString(entry, 40)
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
        const value = entry as Record<string, unknown>
        return boundedString(value.effort ?? value.reasoningEffort, 40)
      }).filter((item): item is string => !!item))].slice(0, 12)
      const rawTiers = Array.isArray(row.service_tiers)
        ? row.service_tiers
        : Array.isArray(row.serviceTiers)
          ? row.serviceTiers
          : []
      const serviceTiers = rawTiers.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
        const value = entry as Record<string, unknown>
        const id = boundedString(value.id, 40)
        if (!id) return undefined
        return { id, name: boundedString(value.name, 80) ?? id }
      }).filter((item): item is { id: string; name: string } => !!item).slice(0, 12)
      // Older caches expose speed tier ids without the richer service-tier objects.
      if (serviceTiers.length === 0) {
        for (const id of catalogStringList(row.additional_speed_tiers ?? row.additionalSpeedTiers)) {
          serviceTiers.push({ id: id === 'fast' ? 'priority' : id, name: id === 'fast' ? 'Fast' : id })
        }
      }
      const defaultEffort = boundedString(
        row.default_reasoning_level ?? row.defaultReasoningEffort,
        40,
      )
      seen.add(slug)
      models.push({
        slug,
        name,
        ...(boundedString(row.description, 500) ? { description: boundedString(row.description, 500) } : {}),
        supportedEfforts,
        ...(defaultEffort ? { defaultEffort } : {}),
        serviceTiers,
        ...((row.is_default === true || row.isDefault === true) ? { isDefault: true } : {}),
      })
    }
    const fetched = boundedString(root.fetched_at ?? root.fetchedAt, 80)
    const fetchedMs = fetched ? Date.parse(fetched) : Number.NaN
    const value = models.length > 0
      ? { models, updatedAt: Number.isFinite(fetchedMs) ? new Date(fetchedMs).toISOString() : stat.mtime.toISOString() }
      : undefined
    codexCatalogCache.set(file, { signature, value })
    return value
  } catch {
    // A provider refresh can briefly replace the cache. Keep this account's picker on the bounded static
    // catalog until the next profile read rather than leaking a parse failure into app startup.
    codexCatalogCache.set(file, { signature, value: undefined })
    return undefined
  }
}

/**
 * Infer only what the credential on disk can honestly prove at boot. A recognized token with a
 * future expiry (or a non-expiring API key) is locally signed in; a missing or malformed credential is
 * signed out. An expired access token WITH refresh material is deliberately unknown: OAuth access tokens
 * are short-lived and the vendor refreshes them lazily, so expiry alone cannot honestly log an account
 * out. A vendor invalid_grant/refresh failure remains the authoritative terminal signal elsewhere.
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
    const refresh = stringValue(oauth?.refreshToken) ?? stringValue(oauth?.refresh_token)
    if (!token) {
      return refresh ? {} : signedOut('Claude credential has no access or refresh token. Sign in again.')
    }

    const expiry = claudeExpiryMs(oauth?.expiresAt ?? oauth?.expires_at)
    if (expiry === undefined) return {}
    if (expiry <= nowMs) {
      return refresh ? {} : signedOut('Claude credential has expired and cannot be refreshed. Sign in again.')
    }
    return { authStatus: 'signed_in' }
  }

  if (stringValue(credential.OPENAI_API_KEY)) return { authStatus: 'signed_in' }
  const tokens = asRecord(credential.tokens)
  const token = stringValue(tokens?.access_token) ?? stringValue(tokens?.accessToken)
  const refresh = stringValue(tokens?.refresh_token) ?? stringValue(tokens?.refreshToken)
  if (!token) {
    return refresh ? {} : signedOut('Codex credential has no access or refresh token. Sign in again.')
  }

  const expiry = jwtExpiryMs(token)
  if (expiry === undefined) return {}
  if (expiry <= nowMs) {
    return refresh ? {} : signedOut('Codex credential has expired and cannot be refreshed. Sign in again.')
  }
  return { authStatus: 'signed_in' }
}

/**
 * Project the account identity that the vendor already persists beside a managed credential.
 *
 * This intentionally returns only an email address and an opaque account id. Tokens, organization
 * metadata, entitlements, and the rest of the provider files never cross the hub API. Claude records
 * this in `.claude.json`; Codex records the account id plus an email-bearing ID token in `auth.json`.
 * Missing or concurrently-replaced metadata is ordinary and returns an empty identity.
 */
export function profileAccountIdentity(
  profile: Pick<Profile, 'provider' | 'dir'>,
): ProfileAccountIdentity {
  try {
    if (profile.provider === 'claude') {
      const root = readJsonRecord(path.join(profile.dir, '.claude.json'))
      const account = asRecord(root?.oauthAccount)
      return compactAccountIdentity(
        accountEmail(account?.emailAddress ?? account?.email),
        providerAccountId(account?.accountUuid ?? account?.account_id),
      )
    }

    const root = readJsonRecord(path.join(profile.dir, 'auth.json'))
    const tokens = asRecord(root?.tokens)
    const claims = jwtClaims(
      stringValue(tokens?.id_token) ??
        stringValue(tokens?.idToken) ??
        stringValue(tokens?.access_token) ??
        stringValue(tokens?.accessToken),
    )
    return compactAccountIdentity(
      accountEmail(claims?.email ?? claims?.preferred_username ?? claims?.upn),
      providerAccountId(tokens?.account_id ?? tokens?.accountId ?? claims?.account_id),
    )
  } catch {
    return {}
  }
}

function compactAccountIdentity(
  email: string | undefined,
  accountId: string | undefined,
): ProfileAccountIdentity {
  return {
    ...(email ? { accountEmail: email } : {}),
    ...(accountId ? { providerAccountId: accountId } : {}),
  }
}

function accountEmail(value: unknown): string | undefined {
  const clean = stringValue(value)?.slice(0, 320)
  return clean && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(clean) ? clean : undefined
}

function providerAccountId(value: unknown): string | undefined {
  const clean = stringValue(value)?.slice(0, 200)
  return clean && !/\s/u.test(clean) ? clean : undefined
}

function readJsonRecord(file: string): Record<string, unknown> | undefined {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  return asRecord(parsed)
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
  const exp = jwtClaims(token)?.exp
  const seconds = typeof exp === 'string' ? Number(exp) : exp
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : undefined
}

function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const payload = token?.split('.')[1]
  if (!payload) return undefined
  try {
    return asRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown)
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
      const profile: Profile = { id: name, provider: 'codex', dir }
      out.push({ ...profile, ...profileAccountIdentity(profile) })
    } else if (fs.existsSync(path.join(dir, '.credentials.json'))) {
      const profile: Profile = { id: name, provider: 'claude', dir }
      out.push({ ...profile, ...profileAccountIdentity(profile) })
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
