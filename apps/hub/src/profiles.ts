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
