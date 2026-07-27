/**
 * Project import — discover existing Claude Code / Codex conversations on disk whose recorded
 * working directory belongs to a folder, so the hub can adopt them as auto-named sessions.
 *
 * Grounded in the REAL on-disk formats on this machine (inspected 2026-07-24):
 *
 *  - Claude Code: `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<session-uuid>.jsonl`, one file per
 *    session. `encoded-cwd = cwd.replace(/[^a-zA-Z0-9]/g,'-')` — deterministic FORWARD but lossy in
 *    reverse (`foo bar`, `foo-bar`, `foo.bar` all collide), so we use it only to *narrow* candidate
 *    folders and then CONFIRM by reading the `cwd` field inside the transcript. Records are one JSON
 *    object per line; the session uuid (filename stem, also `sessionId` on every record) is the
 *    resume id. A `user` record's `message.content` is a string OR a block array — and is frequently
 *    a `tool_result` array rather than real user text, so the first *prompt* is the first `user`
 *    record that yields an actual `text` block. `ai-title.aiTitle` is Claude's own generated label.
 *
 *  - Codex: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO>-<session_id>.jsonl`, date-partitioned
 *    (NOT keyed by cwd — must walk + read line 1). Line 1 is `session_meta` with `payload.cwd`
 *    (real backslash path) and `payload.session_id` (the `thread/resume` id). The cleanest first
 *    prompt is the first `event_msg` whose `payload.type === 'user_message'` (its `payload.message`
 *    is a plain string) — this skips the injected developer/plugin `response_item` framing.
 *
 * Everything below the parse helpers is bounded file I/O (glob + streamed head reads, capped bytes),
 * never a whole-file `JSON.parse` — real transcripts reach many MB.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { deriveTitle, sanitizeTitle } from './title.js'
import type { Profile, Provider } from './types.js'

export interface ImportableChat {
  provider: Provider
  /** Claude session uuid / Codex session_id — the vendor resume id. */
  vendorSessionId: string
  /** The profile (config dir) that owns the transcript; the import binds + resumes under it. */
  profileId: string
  cwd: string
  /** Auto-name: deriveTitle(firstUserMessage), falling back to Claude's ai-title, then a generic. */
  title: string
  firstPrompt?: string
  aiTitle?: string
  /** ISO — the transcript file's mtime (reliable; the tail record often carries no timestamp). */
  lastActivity: string
  messageCount: number
  model?: string
  gitBranch?: string
  sizeBytes: number
  /** Absolute path to the source transcript (hub-internal; never sent to the browser wholesale). */
  transcriptPath: string
  /** Already adopted as a hub SessionRecord (dedupe by profileId + vendorSessionId). */
  alreadyImported: boolean
}

/**
 * Read-only summary of a project folder's adoptable configuration — surfaced so the user can SEE
 * what's there, and specifically WHAT WOULD EXECUTE, before approving it (a project's hooks are
 * arbitrary code and its MCP servers are processes the agent talks to — importing a repo must not
 * silently gain the right to run them; see the gate in adapters/claude.ts and the per-project trust in
 * projects.ts).
 *
 * VALUES-FREE ON SECRETS, NOT ON CODE. MCP env/header VALUES are credentials and never SURFACE (only
 * `hasSecrets`). But the COMMAND a stdio server runs, a remote server's URL, and a hook's command string
 * ARE the executable surface — "runs `curl x | sh` before every tool call" is the decision, and a consent
 * screen that hides it is theatre — so those ARE surfaced.
 *
 * FAIL CLOSED. This scanner produces a trust verdict, and a scanner that only reports what it UNDERSTANDS
 * would fail open the instant it met a config shape it did not — the default-deny gate would silently
 * relax. So anything present that this version cannot fully model+fingerprint is recorded in `unmodeled`,
 * and a non-empty `unmodeled` means the project must stay GATED regardless of approval (projects.ts).
 * `fingerprint` covers only the FULLY MODELED surface (incl. env/header values + hook args, so a change to
 * any of them re-gates), and is `null` only when there is genuinely nothing executable. What we cannot
 * fingerprint we do not pretend to; we gate it.
 */
export interface ProjectConfig {
  mcpServers: {
    name: string
    transport: 'stdio' | 'http' | 'sse'
    hasSecrets: boolean
    /** What actually runs / is contacted: the stdio command+args, or the http/sse URL. Not a secret. */
    command?: string
  }[]
  /** Hook event names present in .claude/settings*.json (e.g. ["PreToolUse","PostToolUse"]). */
  hooks: string[]
  /** The actual hook COMMANDS that would run, per event — the executable surface the operator approves. */
  hookCommands: { event: string; command: string }[]
  /** Whether .claude/settings*.json defines a permissions allow/deny policy. */
  hasPermissions: boolean
  memoryFiles: { name: string; bytes: number }[]
  /** Config files actually found at the project root (relative names). */
  sources: string[]
  /**
   * Executable surfaces PRESENT that this version cannot fully model + fingerprint (a config file it could
   * not parse, an MCP entry with no command/url, a non-command or malformed hook, a statusLine, plugins,
   * or a `.claude/plugins`/`.claude/skills` dir). NON-EMPTY ⇒ the project MUST stay gated: we cannot
   * honestly claim "what you approve is what will run". Human-readable reasons, safe to surface (no secrets).
   */
  unmodeled: string[]
  /** sha256 of the FULLY MODELED executable surface (or `null` when there is none). NOT trustworthy on
   *  its own — a project is trusted only when `unmodeled` is empty AND this equals the approved value. */
  fingerprint: string | null
}

export interface ScanResult {
  path: string
  chats: ImportableChat[]
  /** profileId → count of importable (not-yet-imported) chats found under it. */
  byProfile: Record<string, number>
  scannedProfiles: string[]
  config: ProjectConfig
  warnings: string[]
}

export interface DiscoverOptions {
  profiles: Profile[]
  path: string
  /** `${profileId}::${vendorSessionId}` for every hub session that already carries a vendor id. */
  importedKeys: Set<string>
  /** Hub-internal worktrees root — transcripts whose cwd lives here are hub scratch, never offered. */
  worktreesRoot?: string
  maxBytesPerFile?: number
  maxCodexFiles?: number
}

const MAX_SCAN_BYTES = 4 * 1024 * 1024 // read at most 4 MB of a transcript to build its scan card
const CODEX_SCAN_BYTES = 1024 * 1024 // ...but Codex rollouts reach many MB each; 1 MB head is plenty
const MAX_CODEX_FILES = 2000 // bound the Codex walk (newest first) on huge histories

/** The dedupe key: a vendor session is identified by its owning profile + its vendor id. */
export function importKey(profileId: string, vendorSessionId: string): string {
  return `${profileId}::${vendorSessionId}`
}

/** Claude's lossy forward cwd → folder-name encoding. Used only to narrow candidate folders. */
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Normalize a path for comparison: unify separators, drop trailing slash, lowercase (Windows). */
export function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** True when `recordCwd` is the target folder itself or nested inside it. */
export function cwdMatches(recordCwd: string, target: string): boolean {
  const a = normPath(recordCwd)
  const b = normPath(target)
  return a === b || a.startsWith(b + '/')
}

/** True when `cwd` is the hub's worktrees root or inside it (hub scratch — excluded from import). */
export function isUnderWorktrees(cwd: string, worktreesRoot?: string): boolean {
  if (!worktreesRoot) return false
  const a = normPath(cwd)
  const w = normPath(worktreesRoot)
  return a === w || a.startsWith(w + '/')
}

/**
 * Whether a Claude `projects/<dir>` folder could hold transcripts for `target` or a subfolder.
 * A path inside `target` encodes to `enc(target)` + '-' + …, so this prefix test is a sound
 * (case-insensitive) SUPERSET filter — it may over-include a sibling like `foo-x` for target
 * `foo`, which the per-transcript `cwd` confirmation then rejects. Cheap narrowing, never trusted.
 */
export function isCandidateClaudeDir(dirName: string, target: string): boolean {
  const enc = encodeClaudeCwd(target).toLowerCase()
  const d = dirName.toLowerCase()
  return d === enc || d.startsWith(enc + '-')
}

// Injected / synthetic user-message wrappers that are never a real first prompt.
function isSyntheticUserText(t: string): boolean {
  return (
    /^<(command-|local-command|bash-|user-memory|system-)/i.test(t) ||
    /^Caveat: The messages below/i.test(t) ||
    /^\[Request interrupted/i.test(t)
  )
}

// The hub's Claude adapter prepends a thinking-budget keyword as the prompt's OWN first line
// (`ultrathink\n\n<prompt>`), so an imported transcript's first user message starts with it. Strip a
// leading standalone keyword line so the title/preview reflect the real prompt, not "ultrathink".
function stripThinkingPreamble(text: string): string {
  return text.replace(/^\s*(ultrathink|megathink|think hard|think)\s*(\r?\n)+/i, '').trim() || text.trim()
}

/** First real user text from a Claude `message.content` (string, or the first `text` block). */
function firstUserText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const t = content.trim()
    return t && !isSyntheticUserText(t) ? stripThinkingPreamble(t) : undefined
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const t = String((block as { text?: unknown }).text ?? '').trim()
        if (t && !isSyntheticUserText(t)) return stripThinkingPreamble(t)
      }
    }
  }
  return undefined
}

export interface ParsedClaude {
  sessionId?: string
  cwd?: string
  firstPrompt?: string
  aiTitle?: string
  model?: string
  gitBranch?: string
  messageCount: number
}

/** Pure: fold an array of parsed Claude JSONL records into the fields a scan card needs. */
export function parseClaudeRecords(records: unknown[]): ParsedClaude {
  const out: ParsedClaude = { messageCount: 0 }
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    const r = rec as Record<string, unknown>
    if (typeof r.sessionId === 'string' && !out.sessionId) out.sessionId = r.sessionId
    if (typeof r.cwd === 'string' && !out.cwd) out.cwd = r.cwd
    if (typeof r.gitBranch === 'string' && !out.gitBranch) out.gitBranch = r.gitBranch
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim() && !out.aiTitle) {
      out.aiTitle = r.aiTitle.trim()
    }
    if (r.type === 'user' || r.type === 'assistant') {
      out.messageCount++
      const message = r.message as { role?: string; model?: string; content?: unknown } | undefined
      if (r.type === 'assistant' && !out.model && typeof message?.model === 'string') out.model = message.model
      if (r.type === 'user' && !out.firstPrompt && r.isMeta !== true) {
        const text = firstUserText(message?.content)
        if (text) out.firstPrompt = text
      }
    }
  }
  return out
}

export interface ParsedCodex {
  sessionId?: string
  cwd?: string
  firstPrompt?: string
  originator?: string
  cliVersion?: string
  model?: string
  messageCount: number
}

/** Pure: fold ONE parsed Codex rollout record into the running scan-card accumulator. */
function foldCodexRecord(out: ParsedCodex, r: Record<string, unknown>): void {
  const payload = (r.payload ?? {}) as Record<string, unknown>
  if (r.type === 'session_meta') {
    if (typeof payload.session_id === 'string') out.sessionId = payload.session_id
    else if (typeof payload.id === 'string') out.sessionId = payload.id
    if (typeof payload.cwd === 'string') out.cwd = payload.cwd
    if (typeof payload.originator === 'string') out.originator = payload.originator
    if (typeof payload.cli_version === 'string') out.cliVersion = payload.cli_version
  } else if (r.type === 'event_msg') {
    if (payload.type === 'user_message') {
      out.messageCount++
      if (!out.firstPrompt && typeof payload.message === 'string') {
        const t = payload.message.trim()
        if (t && !isSyntheticUserText(t)) out.firstPrompt = t
      }
    } else if (payload.type === 'agent_message') {
      out.messageCount++
    }
  } else if (r.type === 'turn_context' && typeof payload.model === 'string' && !out.model) {
    out.model = payload.model
  }
}

/** Pure: fold an array of parsed Codex rollout records into the fields a scan card needs. */
export function parseCodexRecords(records: unknown[]): ParsedCodex {
  const out: ParsedCodex = { messageCount: 0 }
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    foldCodexRecord(out, rec as Record<string, unknown>)
  }
  return out
}

/**
 * Stream a Codex rollout only as far as it's worth reading. `cwd` lives on the FIRST record
 * (`session_meta`), so the moment we know it we bail on any rollout that isn't this folder's — a
 * non-match then costs ~one line instead of the whole (often multi-MB, up to gigabytes across a
 * heavy history) file. A matching rollout keeps streaming for the first prompt + a floor message
 * count, capped at `maxBytes`. Returns null when the rollout doesn't belong to `target`.
 */
async function readCodexRollout(
  file: string,
  matches: (cwd: string) => boolean,
  maxBytes: number
): Promise<ParsedCodex | null> {
  const out: ParsedCodex = { messageCount: 0 }
  let bytes = 0
  let cwdDecided = false
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      bytes += Buffer.byteLength(line) + 1
      const t = line.trim()
      if (t) {
        try {
          foldCodexRecord(out, JSON.parse(t) as Record<string, unknown>)
        } catch {
          /* skip a malformed / partial line */
        }
        // As soon as session_meta gives us a cwd, drop the file if it isn't this folder's.
        if (!cwdDecided && out.cwd) {
          cwdDecided = true
          if (!matches(out.cwd)) return null
        }
      }
      // Stop the moment this rollout is confirmed ours AND we have the first prompt — that's all a
      // scan card needs. Without this we streamed up to `maxBytes` of EVERY matching rollout (~1 MB ×
      // ~100 files = ~100 MB per scan), which is the 2 s "won't populate" stall on a big project. The
      // message count is then a floor, which is fine for a preview. `maxBytes` remains the safety cap
      // for a rollout whose first user turn is unusually deep in the file.
      if ((cwdDecided && out.firstPrompt) || bytes >= maxBytes) break
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return out.cwd && matches(out.cwd) ? out : null
}

/**
 * A short single-line preview of a first prompt for the scan card. Codex/Claude first messages are
 * frequently tens of KB of pasted content (one AllMyStuff session was 54 KB) — sending the full text
 * for every chat bloated the scan response to 650 KB+. The browser only shows this as a tooltip, so a
 * preview is all it needs; the auto-title is derived hub-side from the FULL text before truncation.
 */
function previewText(text: string | undefined, max = 280): string | undefined {
  if (!text) return text
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** Compose the auto-name: deriveTitle(firstPrompt) preferred (per spec), else ai-title, else generic. */
function composeTitle(provider: Provider, firstPrompt?: string, aiTitle?: string): string {
  const derived = firstPrompt ? deriveTitle(firstPrompt) : ''
  if (derived) return derived
  if (aiTitle) return sanitizeTitle(aiTitle)
  return provider === 'claude' ? 'imported Claude chat' : 'imported Codex chat'
}

/**
 * Read a JSONL transcript line-by-line, parsing each line, until `maxBytes` is consumed. Bounds
 * multi-MB files (the scan only needs head-ish fields + a count); a truncated read yields a floor
 * count, never a hang. Malformed lines are skipped.
 */
async function readJsonlBounded(file: string, maxBytes: number): Promise<{ records: unknown[]; truncated: boolean }> {
  const records: unknown[] = []
  let bytes = 0
  let truncated = false
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      bytes += Buffer.byteLength(line) + 1
      const t = line.trim()
      if (t) {
        try {
          records.push(JSON.parse(t))
        } catch {
          /* skip a malformed line — a partial write or a non-JSON row shouldn't abort the scan */
        }
      }
      if (bytes >= maxBytes) {
        truncated = true
        break
      }
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return { records, truncated }
}

interface Ctx {
  maxBytes: number
  imported: Set<string>
  isExcluded: (cwd: string) => boolean
}

async function discoverClaudeChats(
  profile: Profile,
  target: string,
  ctx: Ctx
): Promise<{ chats: ImportableChat[]; warnings: string[] }> {
  const chats: ImportableChat[] = []
  const warnings: string[] = []
  const projectsDir = path.join(profile.dir, 'projects')
  let dirNames: string[]
  try {
    dirNames = await fs.promises.readdir(projectsDir)
  } catch {
    return { chats, warnings } // no projects dir for this profile
  }
  for (const dirName of dirNames) {
    if (!isCandidateClaudeDir(dirName, target)) continue
    const dir = path.join(projectsDir, dirName)
    let files: string[]
    try {
      const dirStat = await fs.promises.stat(dir)
      if (!dirStat.isDirectory()) continue
      files = await fs.promises.readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const full = path.join(dir, file)
      try {
        const st = await fs.promises.stat(full)
        const { records } = await readJsonlBounded(full, ctx.maxBytes)
        const parsed = parseClaudeRecords(records)
        // Confirm via the transcript's own cwd field (the folder name is lossy) and skip hub scratch.
        if (!parsed.cwd || !cwdMatches(parsed.cwd, target) || ctx.isExcluded(parsed.cwd)) continue
        // Only offer real conversations: a transcript with no human prompt and no ai-title is a
        // command probe (e.g. the hub's own `/usage` rate-limit reads run in apps/hub) or an empty
        // session — not a chat worth importing.
        if (!parsed.firstPrompt && !parsed.aiTitle) continue
        const vendorSessionId = parsed.sessionId ?? path.basename(file, '.jsonl')
        chats.push({
          provider: 'claude',
          vendorSessionId,
          profileId: profile.id,
          cwd: parsed.cwd,
          title: composeTitle('claude', parsed.firstPrompt, parsed.aiTitle),
          firstPrompt: previewText(parsed.firstPrompt),
          aiTitle: parsed.aiTitle,
          lastActivity: st.mtime.toISOString(),
          messageCount: parsed.messageCount,
          model: parsed.model,
          gitBranch: parsed.gitBranch,
          sizeBytes: st.size,
          transcriptPath: full,
          alreadyImported: ctx.imported.has(importKey(profile.id, vendorSessionId)),
        })
      } catch (err) {
        warnings.push(`unreadable Claude transcript ${dirName}/${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return { chats, warnings }
}

/** Recursively collect `rollout-*.jsonl` files under a Codex `sessions/` tree, newest mtime first.
 * ASYNC (fs.promises) so a deep sessions/ tree never blocks the hub's event loop mid-scan. */
async function walkRollouts(root: string, cap: number): Promise<string[]> {
  const found: { file: string; mtimeMs: number }[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          const st = await fs.promises.stat(full)
          found.push({ file: full, mtimeMs: st.mtimeMs })
        } catch {
          /* vanished mid-walk — ignore */
        }
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.slice(0, cap).map((f) => f.file)
}

async function discoverCodexChats(
  profile: Profile,
  target: string,
  ctx: Ctx,
  maxFiles: number
): Promise<{ chats: ImportableChat[]; warnings: string[] }> {
  const chats: ImportableChat[] = []
  const warnings: string[] = []
  const sessionsDir = path.join(profile.dir, 'sessions')
  const codexCap = Math.min(ctx.maxBytes, CODEX_SCAN_BYTES)
  // cwd match + not hub scratch — passed into the streaming reader so a non-matching rollout is
  // dropped after its first line instead of being read in full.
  const matches = (cwd: string): boolean => cwdMatches(cwd, target) && !ctx.isExcluded(cwd)
  for (const full of await walkRollouts(sessionsDir, maxFiles)) {
    try {
      const parsed = await readCodexRollout(full, matches, codexCap)
      // Null = wrong folder (bailed early). Also skip rollouts with no human prompt (system-only).
      if (!parsed || !parsed.cwd || !parsed.firstPrompt) continue
      const st = await fs.promises.stat(full)
      const vendorSessionId = parsed.sessionId ?? codexIdFromFilename(full)
      if (!vendorSessionId) continue
      chats.push({
        provider: 'codex',
        vendorSessionId,
        profileId: profile.id,
        cwd: parsed.cwd,
        title: composeTitle('codex', parsed.firstPrompt),
        firstPrompt: previewText(parsed.firstPrompt),
        lastActivity: st.mtime.toISOString(),
        messageCount: parsed.messageCount,
        model: parsed.model,
        sizeBytes: st.size,
        transcriptPath: full,
        alreadyImported: ctx.imported.has(importKey(profile.id, vendorSessionId)),
      })
    } catch (err) {
      warnings.push(`unreadable Codex rollout ${path.basename(full)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { chats, warnings }
}

/** Recover a Codex session_id from a `rollout-<ISO>-<uuid>.jsonl` filename (fallback only). */
function codexIdFromFilename(file: string): string | undefined {
  const m = /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-fA-F-]{36})\.jsonl$/.exec(path.basename(file))
  return m?.[1]
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(file)) return undefined
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined // malformed config — caller records a warning
  }
}

/**
 * Detect a project folder's adoptable config (MCP servers, hooks, permissions, memory files),
 * values-free. Reads `<path>/.mcp.json`, `<path>/.claude/settings.json` (+ `.local.json`), and stats
 * `CLAUDE.md`/`AGENTS.md`. Never opens `.env`, `auth.json`, or `.credentials.json`.
 */
export function readProjectConfig(projectPath: string, warnings: string[] = []): ProjectConfig {
  const sources: string[] = []
  const mcpServers: ProjectConfig['mcpServers'] = []
  const unmodeled: string[] = []
  // The fingerprint INPUT — the FULL modeled executable surface, including secret env/header VALUES and
  // hook args/matchers (so any change to them re-gates). Kept separate from the values-free SURFACE
  // (`mcpServers`/`hookCommands`) that the operator is shown.
  const fpMcp: unknown[] = []
  const fpHooks: unknown[] = []

  const mcpPath = path.join(projectPath, '.mcp.json')
  if (fs.existsSync(mcpPath)) {
    const mcp = readJsonFile(mcpPath)
    if (!mcp) {
      // FAIL CLOSED. A config file we cannot parse is NOT "no config" — we cannot know what it will run,
      // so it must gate, never fall through as trusted. (This is the audit's finding #1, inverted.)
      unmodeled.push('.mcp.json is present but could not be parsed')
      warnings.push('unreadable .mcp.json')
    } else {
      sources.push('.mcp.json')
      const servers = (mcp.mcpServers ?? {}) as Record<string, Record<string, unknown>>
      for (const [name, def] of Object.entries(servers)) {
        const type = typeof def.type === 'string' ? (def.type as string) : undefined
        const transport = type === 'http' || type === 'sse' ? type : 'stdio'
        const env = def.env && typeof def.env === 'object' ? (def.env as Record<string, unknown>) : undefined
        const headers = def.headers && typeof def.headers === 'object' ? (def.headers as Record<string, unknown>) : undefined
        const hasSecrets = !!(env && Object.keys(env).length) || !!(headers && Object.keys(headers).length)
        const command = mcpCommandString(def, transport)
        if (!command) {
          unmodeled.push(`mcp server "${name}" declares neither a command nor a url`)
          continue
        }
        mcpServers.push({ name, transport, hasSecrets, command })
        fpMcp.push({ name, transport, command, env: fpPairs(env), headers: fpPairs(headers) })
      }
    }
  }
  // Hooks + permissions live in .claude/settings.json, overridden by settings.local.json.
  const hookEvents = new Set<string>()
  const hookCommands: ProjectConfig['hookCommands'] = []
  let hasPermissions = false
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const p = path.join(projectPath, rel.replace('/', path.sep))
    if (!fs.existsSync(p)) continue
    const s = readJsonFile(p)
    if (!s) {
      unmodeled.push(`${rel} is present but could not be parsed`)
      warnings.push(`unreadable ${rel}`)
      continue
    }
    sources.push(rel)
    // Executable settings surfaces this version does NOT model → keep the project gated (fail closed)
    // rather than approve a config whose statusLine/plugins would still run unseen.
    if (s.statusLine) unmodeled.push(`${rel} defines a statusLine command (not modeled)`)
    if (s.plugins || s.enabledPlugins) unmodeled.push(`${rel} configures plugins (not modeled)`)
    const hooks = s.hooks as Record<string, unknown> | undefined
    if (hooks && typeof hooks === 'object') {
      for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries) || !entries.length) continue
        hookEvents.add(event)
        // Shape: hooks[Event] = [{ matcher?, hooks: [{ type:'command', command, args? }] }]. We model
        // command hooks fully (command + args + matcher). Anything else gates.
        for (const matcher of entries) {
          const matcherStr = typeof (matcher as { matcher?: unknown })?.matcher === 'string' ? (matcher as { matcher: string }).matcher : ''
          const inner = (matcher as { hooks?: unknown })?.hooks
          if (!Array.isArray(inner)) {
            unmodeled.push(`hook "${event}" has an unrecognized shape`)
            continue
          }
          for (const h of inner) {
            const type = (h as { type?: unknown })?.type
            const cmd = (h as { command?: unknown })?.command
            if (type !== undefined && type !== 'command') {
              unmodeled.push(`hook "${event}" uses an unmodeled type "${String(type)}"`)
              continue
            }
            if (typeof cmd !== 'string' || !cmd.trim()) {
              unmodeled.push(`hook "${event}" is a command hook without a command`)
              continue
            }
            const args = Array.isArray((h as { args?: unknown }).args)
              ? (h as { args: unknown[] }).args.filter((a): a is string => typeof a === 'string')
              : []
            hookCommands.push({ event, command: cmd.trim() })
            fpHooks.push({ event, matcher: matcherStr, command: cmd.trim(), args })
          }
        }
      }
    }
    const perms = s.permissions as Record<string, unknown> | undefined
    if (perms && (Array.isArray(perms.allow) || Array.isArray(perms.deny))) hasPermissions = true
  }
  // Executable-content directories we do not fingerprint → gate if present.
  for (const dir of ['.claude/plugins', '.claude/skills']) {
    try {
      if (fs.statSync(path.join(projectPath, dir.replace('/', path.sep))).isDirectory()) unmodeled.push(`${dir}/ directory present (not modeled)`)
    } catch {
      /* absent */
    }
  }
  const memoryFiles: ProjectConfig['memoryFiles'] = []
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      const st = fs.statSync(path.join(projectPath, name))
      if (st.isFile()) memoryFiles.push({ name, bytes: st.size })
    } catch {
      /* absent */
    }
  }
  const fingerprint = fingerprintFromInput(fpMcp, fpHooks)
  return { mcpServers, hooks: [...hookEvents], hookCommands, hasPermissions, memoryFiles, sources, unmodeled, fingerprint }
}

/** Sorted [key, value] pairs of an env/headers object for the fingerprint. Includes VALUES (they are
 *  part of what an approved server runs with) — the fingerprint is a hash, so values never surface. */
function fpPairs(obj: Record<string, unknown> | undefined): [string, string][] {
  if (!obj) return []
  return Object.entries(obj)
    .map(([k, v]): [string, string] => [k, String(v)])
    .sort((a, b) => a[0].localeCompare(b[0]))
}

/** The human-readable, non-secret "what runs" string for an MCP server def: stdio `command args…`, or
 *  the http/sse URL. Used for the consent display; the fingerprint uses the richer fpMcp input. */
function mcpCommandString(def: Record<string, unknown>, transport: 'stdio' | 'http' | 'sse'): string | undefined {
  if (transport === 'http' || transport === 'sse') {
    return typeof def.url === 'string' ? def.url : undefined
  }
  const command = typeof def.command === 'string' ? def.command : undefined
  if (!command) return undefined
  const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : []
  return [command, ...args].join(' ')
}

function fingerprintFromInput(fpMcp: unknown[], fpHooks: unknown[]): string | null {
  if (!fpMcp.length && !fpHooks.length) return null // genuinely nothing executable → nothing to gate
  const mcp = [...fpMcp].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const hooks = [...fpHooks].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return crypto.createHash('sha256').update(JSON.stringify({ mcp, hooks })).digest('hex')
}

/**
 * The project's executable-config fingerprint (or `null` when there is none). Keyed on CONTENT, not the
 * folder path, so a MOVE keeps the operator's approval and a SWAP/EDIT breaks it. This is only a
 * component of the trust decision — {@link ProjectStore.isConfigTrusted} additionally requires
 * `config.unmodeled` to be EMPTY, because a fingerprint over a partially-understood config cannot
 * honestly mean "this is what you saw and what will run".
 */
export function fingerprintProjectConfig(config: ProjectConfig): string | null {
  return config.fingerprint
}

/**
 * Scan every profile for conversations whose recorded cwd is `path` (or nested inside it), skipping
 * hub worktree scratch and marking any already adopted. Bounded, read-only; sends nothing anywhere.
 */
export async function discoverImportableChats(opts: DiscoverOptions): Promise<ScanResult> {
  const target = opts.path
  const chats: ImportableChat[] = []
  const warnings: string[] = []
  const scannedProfiles: string[] = []
  const ctx: Ctx = {
    maxBytes: opts.maxBytesPerFile ?? MAX_SCAN_BYTES,
    imported: opts.importedKeys,
    isExcluded: (cwd) => isUnderWorktrees(cwd, opts.worktreesRoot),
  }
  const maxCodexFiles = opts.maxCodexFiles ?? MAX_CODEX_FILES
  for (const profile of opts.profiles) {
    scannedProfiles.push(profile.id)
    try {
      const res =
        profile.provider === 'claude'
          ? await discoverClaudeChats(profile, target, ctx)
          : await discoverCodexChats(profile, target, ctx, maxCodexFiles)
      chats.push(...res.chats)
      warnings.push(...res.warnings)
    } catch (err) {
      warnings.push(`scan failed for profile ${profile.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // A single Codex session commonly spans MANY rollout files that all carry the SAME session_id
  // (every resume writes a fresh file). Collapse to ONE card per (profile, vendor session), keeping
  // the most-recently-active rollout — which is what a resume actually continues. Without this the
  // picker showed 95 copies of one chat AND emitted 95 identical keyed-list keys, which crashes the
  // render (Svelte throws on duplicate {#each} keys) and freezes the panel on "Scanning…".
  const byKey = new Map<string, ImportableChat>()
  for (const c of chats) {
    const k = importKey(c.profileId, c.vendorSessionId)
    const prev = byKey.get(k)
    if (!prev || c.lastActivity > prev.lastActivity) byKey.set(k, c)
  }
  const unique = [...byKey.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  const byProfile: Record<string, number> = {}
  for (const c of unique) if (!c.alreadyImported) byProfile[c.profileId] = (byProfile[c.profileId] ?? 0) + 1
  const config = readProjectConfig(target, warnings)
  return { path: target, chats: unique, byProfile, scannedProfiles, config, warnings }
}
