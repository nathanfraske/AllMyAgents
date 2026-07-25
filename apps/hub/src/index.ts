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
import { PracticeStore } from './practices.js'
import { InProcessExecutor, type Executor } from './executor.js'
import { WorkerExecutor } from './workerExecutor.js'
import { WorkerClient } from './workerTransport.js'
import type { DangerFlags, HubConfig } from './types.js'
import { RestartController, type RestartState } from './restartController.js'
import { SCHEMA_VERSION, type SupervisorMsg } from './restartHandshake.js'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')

let config: HubConfig = {}
const configPath = path.join(repoRoot, 'data', 'config.json')
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as HubConfig
} catch {
  /* no config yet — defaults apply (overage: block) */
}

const journal = new Journal(path.join(repoRoot, 'data', 'hub.db'))
// Each live WebSocket (pane / device / reconnect) attaches a journal 'event' listener, removed on
// close — legitimately more than the EventEmitter default of 10 for a multi-pane/fleet hub. Raise
// the cap so a healthy number of connections doesn't emit a spurious MaxListeners leak warning.
journal.setMaxListeners(64)
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
const practices = new PracticeStore(journal.db)
// Automatic hub-side memory recall (memory.ts) — on unless config.features.autoMemoryRecall === false.
const autoMemoryRecall = config.features?.autoMemoryRecall !== false
// Danger Zone flags — resolved to safe defaults (OFF) from config, then shared by reference with the
// SessionManager (which reads them live when gating tools) and the server (which mutates + persists
// them on POST /api/config/danger). Same object → a toggle flip takes effect without a restart.
const danger: DangerFlags = {
  busCanUseRiskyTools: config.danger?.busCanUseRiskyTools === true,
  autoApprovePractices: config.danger?.autoApprovePractices === true,
  autoApproveRestart: config.danger?.autoApproveRestart === true,
}
// Agent execution runs behind the Executor seam (docs/agent-worker-impl.md §4.1). The implementation is
// chosen by the presence of HUB_WORKER_SOCKET (§4.4, the Phase-2 feature flag hubctl injects when worker
// mode is opted into): absent → the in-process executor (byte-identical to today); present → a
// WorkerExecutor that relays every method to the long-lived agent worker over a WorkerClient and drives
// the hub's side effects from the worker→hub event/lifecycle streams (ingestWorkerEvent / applyLifecycle /
// recall / requestRestart). The callbacks forward to `sessions`, assigned just below — they only fire once
// a worker message arrives (well after assignment), so the forward reference is safe.
const workerSocket = process.env.HUB_WORKER_SOCKET
let sessions: SessionManager
const executor: Executor = workerSocket
  ? new WorkerExecutor(new WorkerClient(workerSocket, { danger: () => danger }), {
      ingestWorkerEvent: (sessionId, wseq, kind, payload) => sessions.ingestWorkerEvent(sessionId, wseq, kind, payload),
      applyLifecycle: (msg) => sessions.applyLifecycle(msg),
      recall: (sessionId, prompt) => sessions.recallForWorker(sessionId, prompt),
      requestRestart: (reason, bySession) => void sessions.requestRestart(reason, bySession),
    })
  : new InProcessExecutor({ approvals, usage, danger, memory, practices })
sessions = new SessionManager(journal, store, profileMap, approvals, usage, workspace, projects, instructions, bus, memory, practices, danger, autoMemoryRecall, repoRoot, executor)
usage.setCodexReader((profileId) => sessions.readCodexLimits(profileId))

// --- Blue-green restart wiring (docs/agent-detachment-impl.md §1.6) --------------------------------
// hubctl launches us with HUB_SUPERVISED=1 + an IPC channel. A booting "green" gets HUB_PORT=0
// (ephemeral) and promotes to the fixed public port 7777 only after passing the supervisor's
// health-check; an unsupervised standalone hub behaves exactly as before.
const supervised = process.env.HUB_SUPERVISED === '1' && typeof process.send === 'function'
const bootPort = Number(process.env.HUB_PORT ?? 7777)
const publicPort = supervised ? 7777 : bootPort
const isGreen = supervised && bootPort === 0
const restartState: RestartState = { booted: false, draining: false, promoting: false, sockets: new Set() }

sessions.boot({ reconcile: !isGreen }) // green defers stale-reconcile to promote (it doesn't own the port yet)
if (!isGreen) usage.startPolling() //     green starts polling only once it owns the port (on promote)
restartState.booted = true

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
// (DESIGN D12/D13.1). Advertises the PUBLIC port (a green boots ephemeral but promotes to 7777).
const meshEnable = !(
  process.env.MESH_EXPOSE === '0' ||
  process.env.MESH_EXPOSE === 'false' ||
  config.mesh?.enable === false
)
const mesh = new MeshSite({ port: publicPort, label: config.mesh?.label, enable: meshEnable })

// Listen on the BOOT port (0 → ephemeral for a green); the server reports its actual port back.
const server = startServer({ port: bootPort, defaultCwd: repoRoot, journal, sessions, profiles, approvals, usage, projects, instructions, bus, memory, practices, danger, rescanProfiles, mesh, deviceToken, requireToken, restartState })

// Register the mesh advert — factored so a promoted green can (re)register once it owns the port.
function registerMesh(): void {
  void mesh.register().then((s) => {
    if (s.exposed) console.log(`[mesh] exposed as site "${s.label}" (${s.siteId}) — fleet peers open ${s.peerUrl}`)
    else if (s.enabled && s.nodePresent) console.log(`[mesh] node present but not exposed — ${s.error ?? 'unknown'}`)
    else if (s.enabled) console.log('[mesh] no AllMyStuff node on this machine — hub stays local-only')
    journal.append(null, 'mesh/site', s)
  })
}

server.once('listening', () => {
  const actualPort = (server.address() as { port?: number } | null)?.port ?? bootPort
  journal.append(null, 'hub/started', {
    port: actualPort,
    profiles: profiles.map((p) => ({ id: p.id, provider: p.provider })),
    restoredSessions: sessions.list().length,
  })
  console.log(
    `[hub] http://127.0.0.1:${actualPort} — profiles: ${profiles.map((p) => `${p.id}(${p.provider})`).join(', ') || 'none found'} — sessions restored: ${sessions.list().length}`
  )
  console.log(`[hub] device token ${requireToken ? 'REQUIRED for /api + /ws' : 'not enforced (local)'} — pair remote devices from Settings → Mesh`)
  // Tell the supervisor we're up (report the ACTUAL port so it health-checks green's ephemeral port).
  if (supervised && process.send) {
    process.send({ type: 'ready', port: actualPort, restored: sessions.list().length, schemaVersion: SCHEMA_VERSION })
  }
  // Blue / standalone own the port at boot → advertise now. Green defers mesh to promote.
  if (!isGreen) registerMesh()
})

// Under supervision, wire the restart handshake: the hub asks hubctl to flip; hubctl drives
// drain/promote/retire back to us. onPromoted starts the services green deferred until it owns the port.
if (supervised && process.send) {
  const send = process.send.bind(process)
  const controller = new RestartController({
    server,
    sessions,
    journal,
    state: restartState,
    publicPort,
    send,
    onPromoted: () => {
      usage.startPolling()
      registerMesh()
    },
  })
  sessions.setRestartSignal((reason, bySession) => send({ type: 'restart-request', reason, bySession }))
  process.on('message', (msg: SupervisorMsg) => {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'drain':
        void controller.drain()
        break
      case 'promote':
        controller.promote(msg.port)
        break
      case 'retire':
        void controller.retire()
        break
      case 'restart-aborted':
        controller.abort(msg.error)
        break
    }
  })
}

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
