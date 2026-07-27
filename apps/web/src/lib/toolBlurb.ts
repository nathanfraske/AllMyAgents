import type { ThreadItem } from './store.svelte'

// --- Tool-call blurbs ---------------------------------------------------------------------------
//
// A tool row used to show only the tool NAME, so forty `Read`s were forty identical rows that cost
// attention without paying it back. This derives the tool's SUBJECT — the file it read, the command
// it ran, the pattern it searched — as one pure, testable line.
//
// Single authority on purpose: codexGroup.ts's group summary calls the SAME function for its "current
// step" label, so the collapsed group and the expanded rows never disagree, and item 3 does not become
// a second renderer competing with item 2's grouping.

export interface ToolBlurb {
  /** One line, already trimmed/truncated — safe to render without wrapping. */
  label: string
  /** The full, untruncated value for a `title` (hover) — e.g. the absolute path or the whole command. */
  title?: string
}

/** Last path segment, tolerant of both separators and a trailing slash. `''` stays `''`. */
export function basename(p: string): string {
  const s = p.replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

/**
 * Truncate the MIDDLE, keeping both ends. For a path the end is the part that identifies it (the
 * basename), so lopping the end — what CSS ellipsis does — is exactly wrong; this keeps it.
 */
export function truncateMiddle(s: string, max = 48): string {
  if (s.length <= max) return s
  const keep = max - 1 // room for the ellipsis
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return s.slice(0, head) + '…' + s.slice(s.length - tail)
}

/** Collapse whitespace and clip the END — for commands/queries, where the front carries the meaning. */
function clipEnd(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined
}

/** A Codex/Claude command can be a string, an argv array, or `{ command }` — normalize to one line. */
function commandText(input: unknown): string | undefined {
  if (typeof input === 'string') return str(input)
  if (Array.isArray(input)) return str(input.map(String).join(' '))
  if (input && typeof input === 'object') {
    const c = (input as { command?: unknown }).command
    if (typeof c === 'string') return str(c)
    if (Array.isArray(c)) return str(c.map(String).join(' '))
  }
  return undefined
}

function unquote(s: string): string {
  const m = /^(['"])([\s\S]*)\1$/.exec(s.trim())
  return m ? (m[2] as string) : s
}

/**
 * Strip a leading shell-runner wrapper so the blurb shows the ACTUAL command, not the launcher.
 *
 * Codex on Windows runs every command as `"C:\…\powershell.exe" -Command <cmd>`, so an un-stripped
 * blurb is 60 characters of powershell path with the real command (`ls`, `cat package.json`) truncated
 * off the end — the launcher, not the thing it ran. Also handles cmd.exe /c and sh/bash -c. The full
 * wrapped command is still available on hover (the caller keeps it as the title).
 */
export function stripShellWrapper(cmd: string): string {
  const patterns = [
    /^\s*"?[^"]*\b(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+(?:\s+\S+)?\s+)*-Command\s+([\s\S]+)$/i,
    /^\s*"?[^"]*\bcmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/i,
    /^\s*"?[^"]*\b(?:ba)?sh"?\s+-[a-z]*c\s+([\s\S]+)$/i,
  ]
  for (const re of patterns) {
    const m = re.exec(cmd)
    if (m) return unquote((m[1] as string).trim())
  }
  return cmd
}

function firstString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined
  for (const k of keys) {
    const v = str(obj[k])
    if (v) return v
  }
  return undefined
}

/**
 * Derive a subject line for a tool call. Returns `undefined` for anything it does not recognise — the
 * caller then shows the plain tool name, so an unknown/new vendor tool degrades gracefully rather than
 * rendering "undefined" or an empty blurb (this repo has been bitten by assuming payload shapes).
 */
export function toolBlurb(item: ThreadItem): ToolBlurb | undefined {
  if (item.kind !== 'tool') return undefined
  const name = item.toolName ?? ''
  const input = item.toolInput

  // --- Codex items (store sets toolInput to the command value / the file-change item) ---
  if (name === 'command') {
    const raw = commandText(input)
    if (!raw) return undefined
    return { label: clipEnd(stripShellWrapper(raw)), title: raw } // clean label, full command on hover
  }
  if (name === 'fileChange') {
    const p = firstString(objOf(input), ['path', 'file', 'filename'])
    return p ? { label: `edit ${truncateMiddle(basename(p))}`, title: p } : undefined
  }
  if (name.startsWith('mcp:')) return undefined // the tool name already carries the subject

  const obj = objOf(input)

  // --- Claude file tools. `notebook_path` is a distinct, load-bearing spelling (see writeScope.ts,
  //     which had a containment bug from exactly this inconsistency) — do NOT collapse it to file_path.
  const filePath = firstString(obj, ['file_path', 'notebook_path'])
  if (filePath) return { label: truncateMiddle(basename(filePath)), title: filePath }

  // --- Glob / Grep ---
  const pattern = firstString(obj, ['pattern'])
  if (pattern) {
    const where = firstString(obj, ['path'])
    return where
      ? { label: `${clipEnd(pattern, 48)} in ${basename(where)}`, title: `${pattern}  ·  ${where}` }
      : { label: clipEnd(pattern, 64), title: pattern }
  }

  // --- Bash: prefer the human-written description; the full command is the more useful hover. ---
  const command = firstString(obj, ['command'])
  if (command !== undefined || name.toLowerCase() === 'bash') {
    const desc = firstString(obj, ['description'])
    const text = desc ?? command
    return text ? { label: clipEnd(text), title: command ?? desc } : undefined
  }

  // --- Other single-subject tools (WebFetch/WebSearch/Task/…) ---
  const url = firstString(obj, ['url'])
  if (url) return { label: clipEnd(url, 64), title: url }
  const query = firstString(obj, ['query'])
  if (query) return { label: clipEnd(query, 64), title: query }
  const description = firstString(obj, ['description'])
  if (description) return { label: clipEnd(description), title: description }

  return undefined
}

function objOf(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}
