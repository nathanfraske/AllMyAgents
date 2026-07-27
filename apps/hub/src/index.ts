import crypto from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ApprovalService } from './approvals.js'
import {
  JOURNAL_CONDENSE_GRACE_MS,
  JOURNAL_CONDENSE_INTERVAL_MS,
  JOURNAL_CONDENSE_MAX_COMMAND_DELTAS,
  JOURNAL_CONDENSE_MAX_DIFF_SNAPSHOTS,
  Journal,
  type JournalCondenseResult,
} from './journal.js'
import { ProjectStore } from './projects.js'
import { scanProfiles, setClaudeConnectorPolicy } from './profiles.js'
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
import { asChatNamePool } from './title.js'
import type { DangerFlags, HubConfig, HubPrefs } from './types.js'
import { RestartController, type RestartState } from './restartController.js'
import { SCHEMA_VERSION, type SupervisorMsg } from './restartHandshake.js'
import {
  PREFLIGHT_EXIT_CODE,
  recordExistingSchemaVersion,
  recordSchemaVersion,
  runHubPreflight,
  type PreflightFailure,
} from './preflight.js'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
const supervised = process.env.HUB_SUPERVISED === '1' && typeof process.send === 'function'
// HUB_DATA_DIR relocates the journal/config/worktrees/device-token root off the repo's data/. Profiles keep
// their real repo path so auth still resolves. Unset → repo data/ (byte-identical to today); set only by an
// isolated harness (e.g. the restart-survival acceptance test) to keep its DB + state off the live hub's.
const dataDir = process.env.HUB_DATA_DIR ? path.resolve(process.env.HUB_DATA_DIR) : path.join(repoRoot, 'data')
const journalPath = path.join(dataDir, 'hub.db')

async function reportPreflightFailure(failure: PreflightFailure): Promise<never> {
  const message = { type: 'preflight-failed' as const, ...failure }
  console.error(`[hub-preflight] ${JSON.stringify(message)}`)
  if (supervised && process.send) {
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, 250)
      try {
        process.send?.(message, finish)
      } catch {
        finish()
      }
    })
  }
  process.exit(PREFLIGHT_EXIT_CODE)
}

const preflight = runHubPreflight({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
for (const check of preflight.checks) {
  const line = `[hub-preflight] ${check.name}: ${check.status} (${check.durationMs}ms) — ${check.detail}`
  if (check.status === 'skipped') console.warn(line)
  else console.log(line)
}
if (!preflight.ok) await reportPreflightFailure(preflight.failure)
if (fs.existsSync(journalPath)) {
  try {
    recordExistingSchemaVersion(journalPath, SCHEMA_VERSION)
  } catch (error) {
    await reportPreflightFailure({
      code: 'schema-version-unrecordable',
      message: `The journal passed read-only checks, but its schema version could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
      recovery: 'Check free disk space and write permission for hub.db, then restart AllMyAgents.',
    })
  }
}
// HUB_PROFILES_DIR relocates the managed-profiles root (auth creds + settings) off the repo's profiles/ —
// the alpha step toward keeping credentials out of the repo/bundle path (%APPDATA%/AllMyAgents/profiles on a
// real install). Unset → repo profiles/ (byte-identical to today). The scan, login, and rescan all use it.
const profilesDir = process.env.HUB_PROFILES_DIR ? path.resolve(process.env.HUB_PROFILES_DIR) : path.join(repoRoot, 'profiles')
if (process.env.HUB_PROFILES_DIR) fs.mkdirSync(profilesDir, { recursive: true })

let config: HubConfig = {}
const configPath = path.join(dataDir, 'config.json')
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as HubConfig
} catch {
  /* no config yet — defaults apply (overage: block) */
}

const journal = new Journal(journalPath)
try {
  recordSchemaVersion(journal.db, SCHEMA_VERSION)
} catch (error) {
  try {
    journal.db.close()
  } catch {
    /* preserve the schema-recording failure as the actionable error */
  }
  await reportPreflightFailure({
    code: 'schema-version-unrecordable',
    message: `The journal opened, but its schema version could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
    recovery: 'Check free disk space and write permission for hub.db, then restart AllMyAgents.',
  })
}
// Each live WebSocket (pane / device / reconnect) attaches a journal 'event' listener, removed on
// close — legitimately more than the EventEmitter default of 10 for a multi-pane/fleet hub. Raise
// the cap so a healthy number of connections doesn't emit a spurious MaxListeners leak warning.
journal.setMaxListeners(64)
const store = new SessionStore(journal.db)
const profiles = scanProfiles(profilesDir)
const profileMap = new Map(profiles.map((p) => [p.id, p]))
const approvals = new ApprovalService(journal)
const usage = new UsageMonitor(journal, profiles, config)
const workspace = new WorkspaceManager(path.join(dataDir, 'worktrees'))
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
  enableClaudeConnectors: config.danger?.enableClaudeConnectors === true,
  fullAccessAnyOrigin: config.danger?.fullAccessAnyOrigin === true,
}
// Owner preferences — resolved from config exactly like `danger` above, and shared by reference with the
// SessionManager and the server for the same reason: POST /api/config/prefs mutates this object, so the
// next chat is named from the newly chosen pool without a restart. asChatNamePool tolerates a hand-edited
// config.json holding nonsense (or the removed men-only value) by falling back to the default.
const prefs: HubPrefs = { chatNamePool: asChatNamePool(config.prefs?.chatNamePool) }
// Apply the connector policy to managed claude profiles at boot (safe default OFF → connectors suppressed).
// The SDK reads disableClaudeAiConnectors from each profile's settings.json, so this makes the flag
// authoritative on startup; the Danger-Zone toggle re-applies it on a flip (server.ts). Never touches ~/.claude.
setClaudeConnectorPolicy(profiles, danger.enableClaudeConnectors === true)
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
      // The worker's MCP tool handlers reaching hub-owned services (§3.3): an `rpc` runs against the same
      // bus/memory/practices the in-process executor uses; an `approvalRequest` goes to the operator via
      // the idempotent approvals.request(id) so a re-issue across a restart dedups (§7.2).
      runRelay: (method, args) => sessions.runRelay(method, args),
      resolveApproval: (approvalId, sessionId, kind, payload) => approvals.request(sessionId, kind, payload, approvalId),
      // Step 5 (§6, §7.1): on every WorkerClient (re)connect, re-attach to the still-running worker and
      // replay the in-flight turn's event gap gap-free + exactly-once — so a mid-turn survives a hub restart.
      attachWorker: () => sessions.attachWorker(),
    })
  : new InProcessExecutor({ approvals, usage, danger, memory, practices })
sessions = new SessionManager(journal, store, profileMap, approvals, usage, workspace, projects, instructions, bus, memory, practices, danger, autoMemoryRecall, repoRoot, executor, prefs)
usage.setCodexReader((profileId) => sessions.readCodexLimits(profileId))
// Let full-access chats and "always allow" grants skip the operator prompt. Installed here because the
// policy reads session records, and ApprovalService is constructed before the SessionManager exists.
// Deciding it in the hub (rather than in each executor's canUseTool) is what makes it take effect on the
// next tool call without respawning the long-lived agent worker.
approvals.setAutoApprove((sessionId, kind, payload) => sessions.isAutoApproved(sessionId, kind, payload))

// --- Blue-green restart wiring (docs/agent-detachment-impl.md §1.6) --------------------------------
// hubctl launches us with HUB_SUPERVISED=1 + an IPC channel. A booting "green" gets HUB_PORT=0
// (ephemeral) and promotes to the fixed public port 7777 only after passing the supervisor's
// health-check; an unsupervised standalone hub behaves exactly as before.
const bootPort = Number(process.env.HUB_PORT ?? 7777)
// The fixed public port a green promotes to / a rollback re-claims — HUB_FIXED_PORT keeps it in lockstep with
// hubctl's override so an isolated harness promotes to its own port, not 7777. Unset → 7777 as before.
const publicPort = supervised ? Number(process.env.HUB_FIXED_PORT ?? 7777) : bootPort
const isGreen = supervised && bootPort === 0

// --- Journal condensation ----------------------------------------------------------------------
// The measured journal grew to 390 MB / 375k events in three days, mostly two superseded Codex streams.
// Run maintenance only after this process owns the public role, and in a ONE-SHOT CHILD: better-sqlite3's
// JSON scan is synchronous, so setInterval(() => journal.condense...) would freeze this hub's HTTP/WS and
// worker ingestion. The Journal method bounds deletes as well, limiting the cross-process SQLite write lock
// and WAL burst. A failure is logged and retried next interval; maintenance must never become a boot cause.
type JournalMaintenanceMessage =
  | { type: 'journal-condensed'; result: JournalCondenseResult }
  | { type: 'journal-condense-error'; error: string }

let journalMaintenanceTimer: NodeJS.Timeout | undefined
let journalMaintenanceChild: ChildProcess | undefined

function runJournalMaintenance(): void {
  if (journalMaintenanceChild) return // a slow disk gets one job, never an accumulating process queue
  try {
    const sourceMode = import.meta.url.endsWith('.ts')
    const entry = path.join(import.meta.dirname, sourceMode ? 'journalMaintenance.ts' : 'journalMaintenance.js')
    // Source mode needs tsx. Resolve it against this package and pass an absolute URL: a bare `tsx/esm`
    // depends on the desktop/process cwd, the same launch-path mistake that previously broke the MCP bridge.
    const execArgv = sourceMode
      ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href]
      : []
    const child = fork(
      entry,
      [
        journalPath,
        String(JOURNAL_CONDENSE_GRACE_MS),
        String(JOURNAL_CONDENSE_MAX_COMMAND_DELTAS),
        String(JOURNAL_CONDENSE_MAX_DIFF_SNAPSHOTS),
      ],
      {
        execArgv,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }
    )
    journalMaintenanceChild = child
    let reportedFailure = false
    const guard = setTimeout(() => {
      reportedFailure = true
      console.error('[journal] condensation exceeded one interval; terminating it so maintenance can retry')
      child.kill()
    }, JOURNAL_CONDENSE_INTERVAL_MS - 10_000)
    guard.unref?.()
    child.on('message', (raw: unknown) => {
      const msg = raw as JournalMaintenanceMessage
      if (msg?.type === 'journal-condense-error') {
        reportedFailure = true
        console.error(`[journal] condensation failed: ${msg.error}`)
        return
      }
      if (msg?.type !== 'journal-condensed') return
      const { commandOutputDeltasDeleted, diffSnapshotsDeleted, cursorCheckpointsWritten } = msg.result
      if (commandOutputDeltasDeleted || diffSnapshotsDeleted || cursorCheckpointsWritten) {
        console.log(
          `[journal] condensed ${commandOutputDeltasDeleted} command deltas + ${diffSnapshotsDeleted} diff snapshots` +
            (cursorCheckpointsWritten ? `; wrote ${cursorCheckpointsWritten} wseq checkpoint(s)` : '')
        )
      }
    })
    child.once('error', (error) => {
      clearTimeout(guard)
      reportedFailure = true
      if (journalMaintenanceChild === child) journalMaintenanceChild = undefined
      console.error(`[journal] could not launch condensation: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(guard)
      if (journalMaintenanceChild === child) journalMaintenanceChild = undefined
      if (code !== 0 && !reportedFailure) {
        console.error(`[journal] condensation child exited ${signal ? `on ${signal}` : `with code ${String(code)}`}`)
      }
    })
  } catch (error) {
    console.error(`[journal] could not launch condensation: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function startJournalMaintenance(): void {
  if (journalMaintenanceTimer) return
  journalMaintenanceTimer = setInterval(runJournalMaintenance, JOURNAL_CONDENSE_INTERVAL_MS)
  journalMaintenanceTimer.unref?.()
}

function stopJournalMaintenance(): void {
  if (journalMaintenanceTimer) clearInterval(journalMaintenanceTimer)
  journalMaintenanceTimer = undefined
  // Killing a one-shot child mid-transaction is safe: SQLite rolls it back. Do not leave an unsupervised
  // maintenance process holding the DB after its parent has been asked to exit.
  journalMaintenanceChild?.kill()
  journalMaintenanceChild = undefined
}
// RestartController.retire() exits directly rather than going through shutdown(); cover that path too.
process.once('exit', stopJournalMaintenance)

// --- Codex agent-tool bridge (cross-vendor parity: give Codex the mcp__allmyagents__* tools) --------
// The hub writes an `allmyagents` MCP server into each Codex profile's config.toml pointing at this
// bridge script; codex app-server spawns it per thread, and it forwards each tool call to
// POST /internal/agent-tool — which the hub authenticates with this secret and attributes to the
// calling Codex session (by profile id + the bridge child's cwd). See docs/codex-agent-tools-parity.md.
const agentToolSecret = crypto.randomBytes(32).toString('hex')
/**
 * How to launch the bridge that `codex app-server` spawns per thread.
 *
 * A BUILT hub has `dist/agentBridge.js` beside us → plain `node <js>`. A DEV hub runs from SOURCE under
 * tsx, where the sibling is `agentBridge.ts`: it must be launched with the tsx ESM loader, passed as an
 * ABSOLUTE file URL — codex spawns the bridge with the THREAD's cwd, so a bare `tsx/esm` specifier would
 * resolve against that unrelated directory and fail. Without this, the whole Codex tool surface silently
 * no-opped in exactly the dev harness the desktop app uses (`pnpm hubctl:dev` → tsx), which is how the
 * gap was found — from inside the running app. Returns null when no bridge can be launched at all, in
 * which case Codex keeps its prior behavior (still RECEIVES bus messages, just no send/memory/practice
 * tools) rather than getting a config.toml pointing at a missing file.
 */
function resolveAgentBridge(): { bridgePath: string; nodeArgs: string[] } | null {
  const withTsxLoader = (p: string): { bridgePath: string; nodeArgs: string[] } | null => {
    try {
      const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
      return { bridgePath: p, nodeArgs: ['--import', loader] }
    } catch {
      return null // no tsx resolvable → we cannot run a .ts bridge
    }
  }
  const override = process.env.AMA_BRIDGE_PATH
  if (override) return override.endsWith('.ts') ? withTsxLoader(override) : { bridgePath: override, nodeArgs: [] }
  const js = path.join(import.meta.dirname, 'agentBridge.js')
  if (fs.existsSync(js)) return { bridgePath: js, nodeArgs: [] }
  const ts = path.join(import.meta.dirname, 'agentBridge.ts')
  return fs.existsSync(ts) ? withTsxLoader(ts) : null
}
const agentBridge = resolveAgentBridge()
if (agentBridge) {
  sessions.setCodexBridge({
    bridgePath: agentBridge.bridgePath,
    nodeArgs: agentBridge.nodeArgs,
    hubUrl: `http://127.0.0.1:${publicPort}`,
    secret: agentToolSecret,
    nodePath: process.env.AMA_BRIDGE_NODE ?? process.execPath,
  })
}

const restartState: RestartState = { booted: false, draining: false, promoting: false, sockets: new Set() }

sessions.boot({ reconcile: !isGreen }) // green defers stale-reconcile to promote (it doesn't own the port yet)
if (!isGreen) usage.startPolling() //     green starts polling only once it owns the port (on promote)
restartState.booted = true

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

// Device token — proof of an authorized device. Generated + persisted under `dataDir` alongside the
// journal + config, which is what HUB_DATA_DIR already promised ("journal/config/worktrees/device-token
// root", line 29). It used to hardcode `repoRoot/data`, so an installed build — the only configuration
// that sets HUB_DATA_DIR — would have split its token away from the rest of its state. Unset
// HUB_DATA_DIR resolves to exactly the same path as before, so dev is unchanged. Enforcement is opt-in
// (HUB_REQUIRE_TOKEN or config.security.requireToken) so local-only use is unaffected; turn it on for
// fleet/remote exposure.
const deviceToken = getOrCreateDeviceToken(dataDir)
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
const server = startServer({ port: bootPort, defaultCwd: repoRoot, profilesDir, journal, sessions, profiles, approvals, usage, projects, instructions, bus, memory, practices, danger, prefs, rescanProfiles, mesh, deviceToken, requireToken, agentToolSecret, restartState, executor, configPath })

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
  if (!isGreen) {
    registerMesh()
    startJournalMaintenance()
  }
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
      startJournalMaintenance()
    },
    // §8.4: drain() signals the worker to hold relays before blue's socket drops; abort() un-drains a
    // rolled-back flip. No-op in-process (the in-process executor implements no signalDraining), so the
    // flag-off restart path is byte-identical.
    executor,
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
  stopJournalMaintenance()
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
