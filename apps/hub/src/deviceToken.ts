import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A per-install device token — proof that a client is an authorized device on the owner's fleet.
 *
 * The hub has full control, so once it's reachable beyond pure loopback (mesh exposure) a request
 * needs to prove it's an authorized device, not just any client that reached the tunneled port.
 * The token is generated once and persisted (gitignored, under data/). The desktop shell reads it
 * through native IPC; a genuinely remote device pairs with an explicit operator reveal in Settings.
 * HTTP never bootstraps this capability, and enforcement is mandatory even on loopback because local
 * vendor agents are untrusted callers.
 */
export function getOrCreateDeviceToken(dataDir: string): string {
  const file = path.join(dataDir, 'device-token.txt')
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) {
      hardenDeviceTokenFile(file)
      return existing
    }
  } catch {
    /* not created yet */
  }
  const token = crypto.randomBytes(32).toString('base64url')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, token, { mode: 0o600 })
  hardenDeviceTokenFile(file)
  return token
}

/**
 * Restrict the token capability to the interactive owner and machine administrators.
 *
 * Mode 0600 alone is not sufficient on Windows because inherited directory ACLs can still grant
 * CodexSandboxUsers read access. Repair every existing token on boot and fail closed if that repair
 * cannot be made.
 */
export function hardenDeviceTokenFile(file: string): void {
  fs.chmodSync(file, 0o600)
  if (process.platform !== 'win32') return

  const account = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim()
  if (!account) throw new Error('cannot determine the Windows account that owns the device token')
  execFileSync(
    'icacls',
    [
      file,
      '/inheritance:r',
      '/grant:r',
      `${account}:(F)`,
      '*S-1-5-18:(F)',
      '*S-1-5-32-544:(F)',
    ],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

/** Constant-time compare so token checks don't leak length/prefix via timing. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
