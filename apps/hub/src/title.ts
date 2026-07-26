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
 *
 * Split into two pools so the owner can choose (see {@link ChatNamePool}). The only offered choices are
 * "women" and "everyone" — there is deliberately no men-only option. Plain ASCII throughout: these are
 * matched, stored and typed by operators, so Gödel is `Godel` and Spärck Jones is `Sparck`.
 */

/**
 * Women in computing and science.
 *
 * Heavy on computing on purpose, because this is a computing tool and the field's history is fuller than
 * its reputation: the ENIAC programmers (Bartik, Holberton), the compiler and language people (Hopper,
 * Sammet, Goldberg, Liskov, Allen), the networks that everything else runs on (Perlman), the chip design
 * that made modern processors possible (Conway), and the flight software that landed Apollo (Hamilton).
 *
 * Johnson, Vaughan, Jackson and Darden are the NASA mathematicians of Hidden Figures — Katherine Johnson
 * computed the trajectories, Dorothy Vaughan ran the computing group and taught herself FORTRAN when the
 * machines arrived, Mary Jackson became NASA's first Black female engineer, Christine Darden led the
 * sonic-boom work.
 */
export const WOMEN_CHAT_NAMES = [
  // Computing
  'Hopper', 'Lovelace', 'Liskov', 'Allen', 'Perlman', 'Goldberg', 'Conway', 'Hamilton',
  'Bartik', 'Holberton', 'Keller', 'Sammet', 'Borg', 'Wing', 'Shaw', 'Klawe',
  'Estrin', 'Rees', 'Granville', 'Blum', 'Sparck', 'Lamarr',
  // NASA — the Hidden Figures mathematicians, and Annie Easley's rocket-propulsion code
  'Johnson', 'Vaughan', 'Jackson', 'Darden', 'Easley', 'Ride', 'Jemison', 'Roman',
  // Physics, chemistry, mathematics
  'Curie', 'Noether', 'Meitner', 'Franklin', 'Germain', 'Kovalevskaya', 'Wu', 'Yalow',
  'Elion', 'Hodgkin', 'Ochoa', 'Mirzakhani', 'Tu', 'Clarke', 'Strickland', 'Arnold',
  'Charpentier', 'Doudna', 'Kariko', 'Blackburn', 'Greider', 'Cori', 'McClintock', 'Ball',
  // Astronomy and earth science
  'Payne', 'Rubin', 'Leavitt', 'Tharp', 'Cannon', 'Burnell', 'Ghez', 'Faber',
  'Herschel', 'Somerville', 'Anning',
] as const

/**
 * Men in computing and science — the rest of the pool, used only when the owner picks "everyone".
 *
 * Same bias toward computing: the theory (Turing, Church, Kleene, Godel, Shannon), the languages and
 * systems (Backus, McCarthy, Dijkstra, Hoare, Knuth, Wirth, Ritchie, Thompson), the network (Cerf, Kahn,
 * Postel, Berners-Lee), the interfaces (Engelbart, Kay, Sutherland), the cryptography (Diffie, Hellman,
 * Rivest, Shamir, Adleman), complexity (Karp, Cook, Yao, Valiant, Rabin), and modern machine learning
 * (Hinton, LeCun, Bengio).
 */
export const MEN_CHAT_NAMES = [
  // Computing — theory
  'Turing', 'Church', 'Kleene', 'Godel', 'Shannon', 'Neumann', 'Hilbert', 'Boole',
  'Frege', 'Babbage', 'Karp', 'Cook', 'Yao', 'Valiant', 'Rabin', 'Hamming',
  // Computing — languages, systems, practice
  'Knuth', 'Dijkstra', 'Hoare', 'Backus', 'McCarthy', 'Minsky', 'Codd', 'Ritchie',
  'Thompson', 'Kernighan', 'Torvalds', 'Stallman', 'Milner', 'Naur', 'Wirth', 'Strachey',
  'Iverson', 'Perlis', 'Newell', 'Simon', 'Wilkes', 'Corbato', 'Lamport', 'Wiener',
  // Networks, interfaces, cryptography
  'Cerf', 'Kahn', 'Postel', 'Engelbart', 'Kay', 'Sutherland', 'Diffie', 'Hellman',
  'Rivest', 'Shamir', 'Adleman',
  // Machine learning
  'Hinton', 'LeCun', 'Bengio',
  // Physics, mathematics, chemistry
  'Fermi', 'Lagrange', 'Raman', 'Bose', 'Faraday', 'Hubble', 'Sagan', 'Ramanujan',
  'Euler', 'Gauss', 'Maxwell', 'Planck', 'Dirac', 'Feynman', 'Chandrasekhar', 'Bhabha',
  'Tesla', 'Carver', 'Just',
] as const

/** Which pool a new chat's name is drawn from. There is no men-only option, by design. */
export type ChatNamePool = 'women' | 'everyone'

/** The default pool when nothing is configured. */
export const DEFAULT_CHAT_NAME_POOL: ChatNamePool = 'everyone'

/** Narrow an untrusted value (config file, request body) to a pool, falling back to the default. */
export function asChatNamePool(value: unknown): ChatNamePool {
  return value === 'women' || value === 'everyone' ? value : DEFAULT_CHAT_NAME_POOL
}

/**
 * The full pool. Women first so that "everyone" is not a list where the women are an appendix — the
 * generator walks from a hashed offset, so order does not bias selection, but it does decide what a
 * reader sees first.
 */
export const CHAT_NAMES = [...WOMEN_CHAT_NAMES, ...MEN_CHAT_NAMES] as const

export function chatNamesFor(pool: ChatNamePool = DEFAULT_CHAT_NAME_POOL): readonly string[] {
  return pool === 'women' ? WOMEN_CHAT_NAMES : CHAT_NAMES
}

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
 *
 * `pool` selects which list to walk, and is deliberately NOT part of the hash: the id alone still picks
 * the offset, so switching pools does not reshuffle the pool you were already on. Switching DOES mean a
 * given id names a different chat than it would have — which is fine, and is why the name is written onto
 * the record at creation (sessions.ts): existing chats keep the name they were born with, and only chats
 * created after the change draw from the new pool. Determinism is per (id, pool), which is all replay and
 * restart need, because both replay the pool the chat was actually created under.
 */
export function generatedTitle(sessionId: string, taken: Iterable<string> = [], pool?: ChatNamePool): string {
  const names = chatNamesFor(pool)
  const used = new Set(taken)
  let h = 0
  for (let i = 0; i < sessionId.length; i++) h = (Math.imul(h, 31) + sessionId.charCodeAt(i)) >>> 0
  const start = h % names.length
  for (let i = 0; i < names.length; i++) {
    const name = names[(start + i) % names.length] as string
    if (!used.has(name)) return name
  }
  const base = names[start] as string
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
