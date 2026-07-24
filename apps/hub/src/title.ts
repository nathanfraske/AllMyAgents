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
