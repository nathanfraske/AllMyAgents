import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Profile } from './types.js'

export function scanProfiles(profilesDir: string): Profile[] {
  if (!fs.existsSync(profilesDir)) return []
  const out: Profile[] = []
  for (const name of fs.readdirSync(profilesDir)) {
    const dir = path.join(profilesDir, name)
    if (!fs.statSync(dir).isDirectory()) continue
    if (fs.existsSync(path.join(dir, 'auth.json'))) {
      out.push({ id: name, provider: 'codex', dir })
    } else if (fs.existsSync(path.join(dir, '.credentials.json'))) {
      out.push({ id: name, provider: 'claude', dir })
    }
  }
  return out
}

// Fixed ids for the user's DEFAULT vendor homes (the regular CLI + IDE extension config dirs), so
// import can adopt the real history that lives there — not just AllMyAgents-managed profiles/*.
export const CLAUDE_DEFAULT_ID = 'claude-default'
export const CODEX_DEFAULT_ID = 'codex-default'

/**
 * The user's default vendor homes as importable/resumable profiles: `~/.claude` (Claude Code CLI +
 * IDE) and `~/.codex` (Codex CLI + IDE). Gated on the home DIRECTORY existing — NOT on a credential
 * file: on Windows the real `~/.claude` keeps its OAuth token in the OS keychain (no
 * `.credentials.json`), and `~/.codex` carries `auth.json`. Binding a resumed session to these dirs
 * makes the vendor CLI/app-server authenticate the way it normally does (keychain / auth.json).
 * `homeDir` is injectable for tests.
 */
export function defaultHomeProfiles(homeDir: string = os.homedir()): Profile[] {
  const out: Profile[] = []
  const claude = path.join(homeDir, '.claude')
  const codex = path.join(homeDir, '.codex')
  if (isDir(claude)) out.push({ id: CLAUDE_DEFAULT_ID, provider: 'claude', dir: claude })
  if (isDir(codex)) out.push({ id: CODEX_DEFAULT_ID, provider: 'codex', dir: codex })
  return out
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Apply the claude.ai-connector policy to every MANAGED claude profile's settings.json (merge-preserving):
 * sets `disableClaudeAiConnectors = !enable` so the Claude SDK suppresses (default, safe) or allows cloud
 * MCP connectors for hub-managed sessions. Only touches AllMyAgents-managed `profiles/*` — never the user's
 * real `~/.claude` (CLAUDE_DEFAULT_ID is skipped), and never codex profiles. Idempotent (skips a profile
 * already at the target value) and best-effort per profile (a write failure is swallowed). Driven at boot +
 * on the `enableClaudeConnectors` Danger-Zone toggle. Returns the profile ids it (re)wrote.
 */
export function setClaudeConnectorPolicy(profiles: Profile[], enable: boolean): string[] {
  const written: string[] = []
  for (const p of profiles) {
    if (p.provider !== 'claude' || p.id === CLAUDE_DEFAULT_ID) continue
    const file = path.join(p.dir, 'settings.json')
    try {
      let obj: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
        if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>
      } catch {
        /* missing or invalid settings.json → start from an empty object */
      }
      if (obj.disableClaudeAiConnectors === !enable) continue // already correct — no rewrite (no churn)
      obj.disableClaudeAiConnectors = !enable
      fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
      written.push(p.id)
    } catch {
      /* best-effort: a profile we can't write just keeps whatever its settings.json already says */
    }
  }
  return written
}
