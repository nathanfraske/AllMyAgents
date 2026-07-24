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
import { MeshSite } from './meshSite.js'
import { getOrCreateDeviceToken } from './deviceToken.js'
import { InstructionStore } from './instructions.js'
import { AgentBus } from './bus.js'
import { MemoryStore } from './memory.js'
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
const instructions = new InstructionStore(journal.db)
const bus = new AgentBus(journal.db)
const memory = new MemoryStore(journal.db)
const sessions = new SessionManager(journal, store, profileMap, approvals, usage, workspace, projects, instructions, bus, memory, repoRoot)
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
// Device token — proof of an authorized device. Generated + persisted under data/. Enforcement
// is opt-in (HUB_REQUIRE_TOKEN or config.security.requireToken) so local-only use is unaffected;
// turn it on for fleet/remote exposure.
const deviceToken = getOrCreateDeviceToken(path.join(repoRoot, 'data'))
const requireToken =
  process.env.HUB_REQUIRE_TOKEN === '1' ||
  process.env.HUB_REQUIRE_TOKEN === 'true' ||
  config.security?.requireToken === true
// Mesh exposure is AUTOMATIC: on startup we probe the local AllMyStuff node and, if one is
// running, register the hub as a "site" so any fleet PC can reach it with zero per-machine setup.
// The hub still binds only 127.0.0.1 — the node dials loopback and tunnels the site; registration
// no-ops cleanly when no node is present. Opt out with MESH_EXPOSE=0 or config.mesh.enable=false.
// Exposure is to the owner's own fleet only (AllMyStuff sites need no cross-owner grant), and the
// server's origin guard blocks browser drive-bys; a per-device token is the remaining hardening
// (DESIGN D12/D13.1).
const meshEnable = !(
  process.env.MESH_EXPOSE === '0' ||
  process.env.MESH_EXPOSE === 'false' ||
  config.mesh?.enable === false
)
const mesh = new MeshSite({ port, label: config.mesh?.label, enable: meshEnable })
startServer({ port, defaultCwd: repoRoot, journal, sessions, profiles, approvals, usage, projects, instructions, bus, memory, rescanProfiles, mesh, deviceToken, requireToken })
journal.append(null, 'hub/started', {
  port,
  profiles: profiles.map((p) => ({ id: p.id, provider: p.provider })),
  restoredSessions: sessions.list().length,
})
console.log(
  `[hub] http://127.0.0.1:${port} — profiles: ${profiles.map((p) => `${p.id}(${p.provider})`).join(', ') || 'none found'} — sessions restored: ${sessions.list().length}`
)
console.log(`[hub] device token ${requireToken ? 'REQUIRED for /api + /ws' : 'not enforced (local)'} — pair remote devices from Settings → Mesh`)

// Auto-register — self-detects the node and no-ops if it's absent or exposure is disabled.
void mesh.register().then((s) => {
  if (s.exposed) console.log(`[mesh] exposed as site "${s.label}" (${s.siteId}) — fleet peers open ${s.peerUrl}`)
  else if (s.enabled && s.nodePresent) console.log(`[mesh] node present but not exposed — ${s.error ?? 'unknown'}`)
  else if (s.enabled) console.log('[mesh] no AllMyStuff node on this machine — hub stays local-only')
  journal.append(null, 'mesh/site', s)
})

// Best-effort: pull our site out of the node's exposed map on a clean exit so a stopped hub
// doesn't linger as a dead advert. The node replaces the whole map, so deregister re-reads first.
let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  const done = (): void => process.exit(0)
  // Cap the cleanup so a hung socket or child can't wedge shutdown.
  const guard = setTimeout(done, 2500)
  guard.unref?.()
  // Tear down the vendor children we spawned (codex app-server, in-flight claude queries) so a
  // standalone hub stop doesn't orphan them, and pull our mesh advert. Both are best-effort and
  // race the guard above; sessions.shutdown() dispatches the codex kills synchronously so they
  // land even if the guard fires first.
  void Promise.allSettled([mesh.deregister(), sessions.shutdown()]).finally(() => {
    clearTimeout(guard)
    console.log(`[hub] ${signal} — stopped`)
    done()
  })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
