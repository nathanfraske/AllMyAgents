import fs from 'node:fs'
import path from 'node:path'

/** One custom slash command discovered on disk under a profile's `commands/` tree. */
export interface CommandInfo {
  /** The invocable name (without the leading `/`). Subdirectories namespace it with `:`
   *  (Claude Code's convention), e.g. `commands/git/commit.md` → `git:commit`. */
  name: string
  /** One-line description: the frontmatter `description:` when present, else the first
   *  non-empty content line (heading markers stripped). Empty when the file has neither. */
  description: string
}

// Cap the recursion + count so a pathological commands/ tree can't stall the hub. Claude Code
// itself only namespaces one level deep in practice; we allow a little more headroom.
const MAX_DEPTH = 4
const MAX_COMMANDS = 500

/**
 * Parse a command markdown file's leading metadata into a one-line description.
 * Prefers YAML frontmatter `description:` (the format Claude Code / plugin commands use); falls
 * back to the first non-empty, non-frontmatter line with any leading markdown heading `#` removed.
 * Exported for unit tests. Never throws.
 */
export function commandDescription(raw: string): string {
  const text = raw.replace(/^﻿/, '') // strip a BOM if present
  const lines = text.split(/\r?\n/)
  let bodyStart = 0
  // Frontmatter block: a leading `---` line, a `description:` key inside wins outright.
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '---') {
        bodyStart = i + 1
        break
      }
      const m = /^description\s*:\s*(.+)$/i.exec(line)
      if (m) return unquote(m[1]!.trim())
    }
  }
  // No frontmatter description — use the first meaningful body line, heading markers stripped.
  for (let i = bodyStart; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (!line) continue
    const cleaned = line.replace(/^#{1,6}\s*/, '').trim()
    if (cleaned) return truncate(cleaned)
  }
  return ''
}

function unquote(s: string): string {
  const m = /^(['"])(.*)\1$/.exec(s)
  return truncate((m ? m[2]! : s).trim())
}

function truncate(s: string): string {
  return s.length > 120 ? s.slice(0, 117).trimEnd() + '…' : s
}

/**
 * Enumerate a profile's custom slash commands: every `*.md` under `<profileDir>/commands/`
 * (recursively, bounded). Returns them sorted by name. Missing dir → []. Best-effort: an
 * unreadable file is skipped, never thrown. This is the on-disk source the `/` picker lists as the
 * profile's custom commands (the Claude Agent SDK expands the SAME files at `$CLAUDE_CONFIG_DIR/commands/*.md`).
 */
export function readProfileCommands(profileDir: string): CommandInfo[] {
  const root = path.join(profileDir, 'commands')
  const out: CommandInfo[] = []
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_COMMANDS) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // not a directory / unreadable — nothing to list here
    }
    for (const entry of entries) {
      if (out.length >= MAX_COMMANDS) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, prefix ? `${prefix}:${entry.name}` : entry.name, depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const base = entry.name.slice(0, -3)
        const name = prefix ? `${prefix}:${base}` : base
        let description = ''
        try {
          description = commandDescription(fs.readFileSync(full, 'utf8'))
        } catch {
          /* unreadable — list it with no description rather than dropping it */
        }
        out.push({ name, description })
      }
    }
  }
  walk(root, '', 0)
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}
