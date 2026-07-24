import fs from 'node:fs'
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
