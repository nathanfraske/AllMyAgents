import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A per-install device token — proof that a client is an authorized device on the owner's fleet.
 *
 * The hub has full control, so once it's reachable beyond pure loopback (mesh exposure) a request
 * needs to prove it's an authorized device, not just any client that reached the tunneled port.
 * The token is generated once and persisted (gitignored, under data/). Local clients pick it up
 * automatically during the pre-enforcement window (the hub hands it to same-origin/loopback
 * callers) and keep it; a genuinely remote device pairs by entering the token shown in Settings.
 * Enforcement is opt-in (config.security.requireToken / HUB_REQUIRE_TOKEN) so it never surprises a
 * local-only setup; turning it on is what a fleet/remote deployment does.
 */
export function getOrCreateDeviceToken(dataDir: string): string {
  const file = path.join(dataDir, 'device-token.txt')
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    /* not created yet */
  }
  const token = crypto.randomBytes(32).toString('base64url')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, token, { mode: 0o600 })
  return token
}

/** Constant-time compare so token checks don't leak length/prefix via timing. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
