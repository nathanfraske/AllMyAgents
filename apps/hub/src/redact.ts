const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
  // `key: value` style secrets. [ \t]* rather than \s* on purpose: a secret sits on the SAME line as its
  // label, and letting this cross a newline made it swallow the first line of any text that merely
  // MENTIONED one of these words — e.g. a directory listing containing an `authorization/` folder.
  /(?<=(?:api[_-]?key|authorization|bearer|token|secret|password)\\?["']?[ \t]*[:=][ \t]*\\?["']?)[^\s"',;\\]{8,}/gi,
]

/** Redact secrets from a plain string. */
export function redact(text: string): string {
  let out = text
  for (const pattern of PATTERNS) out = out.replace(pattern, '[REDACTED]')
  return out
}

/**
 * Redact a VALUE TREE — every string inside it — leaving the structure alone.
 *
 * This exists because the previous approach, regex over `JSON.stringify(payload)`, could corrupt the JSON
 * it was redacting — and did, taking the whole app down. In serialized form a newline is the two
 * characters `\` and `n`. The key/value pattern's optional `\\?` matched that backslash as part of its
 * lookbehind, so the replacement began at the `n` and left the backslash stranded in front of
 * `[REDACTED]`. `\[` is not a valid JSON escape, so the very next `JSON.parse` threw.
 *
 * The shape of that failure is worth remembering. The poisoned row was written to SQLite BEFORE the parse
 * that failed, so the corruption was durable; every later replay crossing it threw again, and the hub
 * crash-looped on startup. A single directory listing that happened to contain the word "authorization"
 * was enough to make the app permanently unable to boot.
 *
 * Redacting values instead of serialized text cannot produce invalid JSON: escaping happens afterwards, in
 * JSON.stringify, which is the only thing entitled to decide how a backslash is written.
 */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 64) return value // pathological nesting: leave it rather than recurse forever
  if (typeof value === 'string') return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, depth + 1)
    return out as unknown as T
  }
  return value
}

/**
 * Serialize a payload for the journal: redact FIRST, then stringify.
 *
 * The one supported way to get a payload into the journal. The order is the entire point — the bug above
 * was `redact(JSON.stringify(x))`, which reads almost identically and is why this helper exists rather
 * than a comment asking people to remember.
 */
export function redactedJson(payload: unknown): string {
  return JSON.stringify(redactValue(payload ?? null))
}
