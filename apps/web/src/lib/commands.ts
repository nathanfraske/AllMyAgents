// Slash-command support for the composer.
//
// Two kinds of `/command` exist:
//   1. CUSTOM commands — markdown files under a profile's `<configDir>/commands/*.md`. These are
//      expanded by the vendor driver (the Claude Agent SDK expands them at turn time), so the
//      composer must NOT intercept them — it sends the text through unchanged (`passthrough`).
//   2. BUILT-IN commands — the interactive CLI built-ins (`/model`, `/compact`, …) are disabled in
//      the headless SDK env, so they'd silently no-op. We MAP the useful ones to hub features and run
//      that action instead of sending text.
//
// `resolveSlash` is the pure classifier the composer uses to decide which path a leading-`/` message
// takes. It is deliberately free of store/api/DOM so it can be unit-tested in isolation.
import { modelsFor, type ModelDef, type Provider } from './catalog'
import { api, type CommandInfo } from './api'

export type PermMode = 'safe' | 'edits' | 'full'

/** One hub-mapped built-in command shown in the picker (and matched by `resolveSlash`). */
export interface BuiltinSpec {
  /** Canonical name (no leading `/`). */
  name: string
  /** Alternate names that resolve to the same action (e.g. `mode` → approvals, `new` → clear). */
  aliases: string[]
  /** Providers this mapping applies to — the picker only offers it for these. */
  providers: Provider[]
  /** Hint shown after the name in the picker, e.g. `<name>` or `<safe|edits|full>`. */
  argHint?: string
  /** One-line description for the picker. */
  description: string
}

// The mapped built-ins. Cross-vendor parity: model / approvals(mode) / usage(cost) / clear(new) map
// for BOTH providers; `compact` is Claude-only (Codex app-server has no compaction method — and the
// driver has none either yet, so even for Claude it's an honest not-yet-supported stub).
export const BUILTINS: BuiltinSpec[] = [
  { name: 'model', aliases: [], providers: ['claude', 'codex'], argHint: '<name>', description: 'Switch the model for your next message' },
  { name: 'approvals', aliases: ['mode'], providers: ['claude', 'codex'], argHint: '<safe|edits|full>', description: 'Set the permission mode (safe / edits / full)' },
  { name: 'usage', aliases: ['cost'], providers: ['claude', 'codex'], description: 'Show this session + account usage' },
  { name: 'clear', aliases: ['new'], providers: ['claude', 'codex'], description: 'Start a new chat (fresh context)' },
  { name: 'compact', aliases: [], providers: ['claude'], description: 'Compact the conversation to free context' },
]

/** The built-ins offered for a provider (picker source). */
export function builtinsForProvider(provider: Provider): BuiltinSpec[] {
  return BUILTINS.filter((b) => b.providers.includes(provider))
}

/** Whether a built-in (by canonical name) expects an argument — drives picker completion UX. */
export function builtinNeedsArg(name: string): boolean {
  return name === 'model' || name === 'approvals'
}

function findBuiltin(name: string, provider: Provider): BuiltinSpec | undefined {
  return BUILTINS.find((b) => b.providers.includes(provider) && (b.name === name || b.aliases.includes(name)))
}

/**
 * Split a leading-`/` message into `{ name, args }`. Returns null when the text isn't a slash
 * command. The name is the first whitespace-delimited token after `/` (lowercased for matching);
 * everything after is `args`.
 */
export function parseSlash(input: string): { name: string; args: string } | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(input.trim())
  if (!m) return null
  return { name: (m[1] as string).toLowerCase(), args: (m[2] as string).trim() }
}

/**
 * Fuzzy-match a `/model` argument to a catalog model for the given provider. Tries, in order: exact
 * slug, exact name/shortName, then a substring match on slug/name/shortName (shortest slug wins, so
 * `opus` → claude-opus-5, not claude-opus-4-8). Returns undefined when nothing matches.
 */
export function matchModel(arg: string, provider: Provider): ModelDef | undefined {
  const q = arg.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return undefined
  const models = modelsFor(provider)
  const norm = (s: string): string => s.toLowerCase()
  const exactSlug = models.find((m) => norm(m.slug) === q)
  if (exactSlug) return exactSlug
  const exactName = models.find((m) => norm(m.name) === q || (m.shortName ? norm(m.shortName) === q : false))
  if (exactName) return exactName
  const partial = models.filter(
    (m) => norm(m.slug).includes(q) || norm(m.name).includes(q) || (m.shortName ? norm(m.shortName).includes(q) : false)
  )
  return partial.sort((a, b) => a.slug.length - b.slug.length)[0]
}

/** What a leading-`/` message resolves to. `passthrough` = send the text as-is to the agent. */
export type SlashResult =
  | { kind: 'passthrough' }
  | { kind: 'model'; model: string; label: string }
  | { kind: 'mode'; mode: PermMode }
  | { kind: 'usage' }
  | { kind: 'new' }
  | { kind: 'compact' }
  | { kind: 'message'; text: string; tone: 'info' | 'error' }

/**
 * Classify a composer message. Non-slash text and CUSTOM commands (anything not a mapped built-in for
 * this provider) resolve to `passthrough` — the composer sends them unchanged so the driver can
 * expand a custom command. Mapped built-ins resolve to the hub action to run instead; a built-in
 * with a missing/invalid argument resolves to a `message` (inline help / error), never a send.
 */
export function resolveSlash(input: string, provider: Provider): SlashResult {
  const parsed = parseSlash(input)
  if (!parsed) return { kind: 'passthrough' }
  const spec = findBuiltin(parsed.name, provider)
  if (!spec) return { kind: 'passthrough' } // custom command / unknown → let the driver handle it
  switch (spec.name) {
    case 'model':
      return resolveModelCmd(parsed.args, provider)
    case 'approvals':
      return resolveModeCmd(parsed.args)
    case 'usage':
      return { kind: 'usage' }
    case 'clear':
      return { kind: 'new' }
    case 'compact':
      return { kind: 'compact' }
    default:
      return { kind: 'passthrough' }
  }
}

function resolveModelCmd(args: string, provider: Provider): SlashResult {
  if (!args) {
    const eg = modelsFor(provider)
      .slice(0, 3)
      .map((m) => m.shortName ?? m.name)
      .join(', ')
    return { kind: 'message', text: `usage: /model <name> — e.g. ${eg}`, tone: 'info' }
  }
  const model = matchModel(args, provider)
  if (!model) return { kind: 'message', text: `no ${provider} model matches "${args}"`, tone: 'error' }
  return { kind: 'model', model: model.slug, label: model.name }
}

function resolveModeCmd(args: string): SlashResult {
  const a = args.toLowerCase().trim()
  if (!a) {
    return {
      kind: 'message',
      text: 'usage: /approvals <safe|edits|full> — safe asks before every tool, edits auto-approves file edits, full skips approvals',
      tone: 'info',
    }
  }
  if (a === 'safe' || a === 'ask' || a === 'plan') return { kind: 'mode', mode: 'safe' }
  if (a === 'edits' || a === 'accept-edits' || a === 'acceptedits' || a === 'edit') return { kind: 'mode', mode: 'edits' }
  if (a === 'full' || a === 'full-access' || a === 'bypass' || a === 'yolo') return { kind: 'mode', mode: 'full' }
  return { kind: 'message', text: `unknown mode "${args}" — use safe, edits, or full`, tone: 'error' }
}

// --- Custom-command loading (for the picker) ----------------------------------------------------
// Memoize per profileId so multiple panes / re-renders don't refetch. A profile's commands change
// rarely (files on disk); a full reload picks up edits.
const commandCache = new Map<string, Promise<CommandInfo[]>>()

/** Load (and cache) a profile's on-disk custom commands. Never rejects — returns [] on any failure. */
export function loadProfileCommands(profileId: string | undefined): Promise<CommandInfo[]> {
  if (!profileId) return Promise.resolve([])
  let p = commandCache.get(profileId)
  if (!p) {
    p = api
      .commands(profileId)
      .then((r) => (Array.isArray(r) ? r : []))
      .catch(() => [])
    commandCache.set(profileId, p)
  }
  return p
}
