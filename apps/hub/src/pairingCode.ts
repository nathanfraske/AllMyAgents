import crypto from 'node:crypto'

// No 0/O or 1/I: these codes are meant to be read from one screen and typed on another.
const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE_CHARS = 8
const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 10

export interface IssuedPairingCode {
  code: string
  expiresAt: string
}

interface ActiveCode {
  digest: Buffer
  expiresAtMs: number
  attempts: number
}

export function normalizePairingCode(value: string): string | undefined {
  const normalized = value.toUpperCase().replace(/[\s-]/gu, '')
  if (normalized.length !== CODE_CHARS) return undefined
  for (const character of normalized) {
    if (!PAIRING_ALPHABET.includes(character)) return undefined
  }
  return normalized
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest()
}

function randomCode(): string {
  let value = ''
  for (let index = 0; index < CODE_CHARS; index += 1) {
    value += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)]
  }
  return value
}

/**
 * In-memory, one-use exchange from a human-sized code to the long-lived device capability.
 * The short code is never persisted or journaled, expires quickly, and is invalidated after a bounded
 * number of guesses. Existing long device tokens remain valid for already-paired clients.
 */
export class PairingCodeBroker {
  private active: ActiveCode | undefined

  constructor(
    private readonly deviceToken: string,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxAttempts = DEFAULT_MAX_ATTEMPTS,
  ) {}

  issue(nowMs = Date.now()): IssuedPairingCode {
    const raw = randomCode()
    const expiresAtMs = nowMs + this.ttlMs
    this.active = { digest: digest(raw), expiresAtMs, attempts: 0 }
    return {
      code: `${raw.slice(0, 4)}-${raw.slice(4)}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }

  redeem(value: string, nowMs = Date.now()): { ok: true; token: string } | { ok: false } {
    const active = this.active
    if (!active || nowMs >= active.expiresAtMs || active.attempts >= this.maxAttempts) {
      this.active = undefined
      return { ok: false }
    }
    const normalized = normalizePairingCode(value)
    active.attempts += 1
    const matches = normalized !== undefined && crypto.timingSafeEqual(active.digest, digest(normalized))
    if (!matches) {
      if (active.attempts >= this.maxAttempts) this.active = undefined
      return { ok: false }
    }
    this.active = undefined
    return { ok: true, token: this.deviceToken }
  }
}
