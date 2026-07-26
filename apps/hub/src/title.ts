/**
 * Session auto-naming + rename helpers (pure functions).
 *
 * v1 is a deterministic, offline heuristic: the first meaningful line of the first prompt makes a
 * good title for coding tasks ("Fix the login redirect loop") without an extra model call. The
 * `titleSource` field (see types.ts) is structured so a future async LLM refine can re-title only
 * auto-named sessions — no rework here.
 */

const AUTO_MAX = 48
const USER_MAX = 60

/**
 * Names for new chats. Surnames only: short enough for a sidebar row, and a name rather than a
 * description, which is the point — a chat you can refer to ("what did Hopper decide?") before it has
 * done anything worth describing.
 */
export const CHAT_NAMES = [
  'Hopper', 'Fermi', 'Lagrange', 'Curie', 'Noether', 'Meitner', 'Raman', 'Bose',
  'Franklin', 'Faraday', 'Turing', 'Hubble', 'Sagan', 'Lovelace', 'Ramanujan', 'Euler',
  'Gauss', 'Maxwell', 'Planck', 'Dirac', 'Feynman', 'Payne', 'Rubin', 'Leavitt',
  'Tharp', 'Cannon', 'Germain', 'Kovalevskaya', 'Wu', 'Yalow', 'Elion', 'Hodgkin',
  'Chandrasekhar', 'Bhabha', 'Tesla', 'Carver', 'Just', 'Ochoa', 'Mirzakhani', 'Tu',
] as const

/**
 * A stable name for a new chat, derived from its session id so it can never be rolled twice.
 *
 * DETERMINISTIC BY DESIGN. The id is the seed, so the hub, a replay of the journal, and a restart all
 * land on the same name — a chat whose name changed after a reload would be worse than no name at all.
 * That also means the client must never generate one independently: two rolls of "random" cannot agree.
 *
 * On collision it walks ON through the pool rather than suffixing immediately, because Fermi / Curie /
 * Hopper reads better than Fermi / Fermi 2 / Fermi 3, and with a pool this size collisions are common
 * rather than exotic (birthday problem: ~40 names means a repeat within the first handful of chats).
 * Numeric suffixes only appear once the pool is genuinely exhausted, and are then deterministic too.
 */
export function generatedTitle(sessionId: string, taken: Iterable<string> = []): string {
  const used = new Set(taken)
  let h = 0
  for (let i = 0; i < sessionId.length; i++) h = (Math.imul(h, 31) + sessionId.charCodeAt(i)) >>> 0
  const start = h % CHAT_NAMES.length
  for (let i = 0; i < CHAT_NAMES.length; i++) {
    const name = CHAT_NAMES[(start + i) % CHAT_NAMES.length] as string
    if (!used.has(name)) return name
  }
  const base = CHAT_NAMES[start] as string
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!used.has(candidate)) return candidate
  }
}

/** Sanitize a user-supplied rename: strip control chars/newlines, collapse whitespace, cap length. */
export function sanitizeTitle(raw: string): string {
  const clean = raw
    .replace(/\p{Cc}+/gu, ' ') // strip control chars / newlines
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > USER_MAX ? clean.slice(0, USER_MAX).trimEnd() : clean
}

/**
 * Derive an auto-title from the first prompt. Returns '' when nothing usable can be extracted (the
 * caller then leaves the session untitled and may retry on a later turn), including for the
 * handoff/port takeover preamble, which must never become a title.
 */
export function deriveTitle(prompt: string): string {
  if (/^\s*You are taking over a conversation/i.test(prompt)) return ''
  const lines = prompt.split(/\r?\n/)
  let inFence = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line) continue
    const cleaned = line
      .replace(/^#{1,6}\s+/, '') // markdown heading markers
      .replace(/^[-*+]\s+/, '') // list bullets
      .replace(/^>\s+/, '') // blockquote
      .replace(/[`*_~]/g, '') // inline emphasis/code markers
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) continue
    return truncateWords(cleaned, AUTO_MAX)
  }
  return ''
}

function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut
  return base.trimEnd() + '…'
}
