import fs from 'node:fs'
import path from 'node:path'
import { ApprovalService } from './approvals.js'
import { Journal } from './journal.js'
import { ProjectStore } from './projects.js'
import { scanProfiles } from './profiles.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import { startServer } from './server.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import type { HubConfig } from './types.js'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')

let config: HubConfig = {}
const configPath = path.join(repoRoot, 'data', 'config.json')
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as HubConfig
} catch {
  /* no config yet — defaults apply (overage: block) */
}

const journal = new Journal(path.join(repoRoot, 'data', 'hub.db'))
const store = new SessionStore(journal.db)
const profiles = scanProfiles(path.join(repoRoot, 'profiles'))
const profileMap = new Map(profiles.map((p) => [p.id, p]))
const approvals = new ApprovalService(journal)
const usage = new UsageMonitor(journal, profiles, config)
const workspace = new WorkspaceManager(path.join(repoRoot, 'data', 'worktrees'))
const projects = new ProjectStore(journal.db)
const sessions = new SessionManager(journal, store, profileMap, approvals, usage, workspace, projects, repoRoot)
usage.setCodexReader((profileId) => sessions.readCodexLimits(profileId))
sessions.boot()
usage.startPolling()

const profilesDir = path.join(repoRoot, 'profiles')
function rescanProfiles(): typeof profiles {
  for (const p of scanProfiles(profilesDir)) {
    if (!profileMap.has(p.id)) {
      profileMap.set(p.id, p)
      usage.addProfile(p) // pushes into the shared `profiles` array (same reference)
      journal.append(null, 'profiles/added', { id: p.id, provider: p.provider })
    }
  }
  return profiles
}

const port = Number(process.env.HUB_PORT ?? 7777)
startServer({ port, defaultCwd: repoRoot, journal, sessions, profiles, approvals, usage, projects, rescanProfiles })
journal.append(null, 'hub/started', {
  port,
  profiles: profiles.map((p) => ({ id: p.id, provider: p.provider })),
  restoredSessions: sessions.list().length,
})
console.log(
  `[hub] http://127.0.0.1:${port} — profiles: ${profiles.map((p) => `${p.id}(${p.provider})`).join(', ') || 'none found'} — sessions restored: ${sessions.list().length}`
)
