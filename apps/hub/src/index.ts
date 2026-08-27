import crypto from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { ApprovalService } from './approvals.js'
import { QuestionService } from './questions.js'
import {
  JOURNAL_CONDENSE_GRACE_MS,
  JOURNAL_CONDENSE_INTERVAL_MS,
  JOURNAL_CONDENSE_MAX_AGENT_MESSAGE_DELTAS,
  JOURNAL_CONDENSE_MAX_COMMAND_DELTAS,
  JOURNAL_CONDENSE_MAX_DIFF_SNAPSHOTS,
  JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES,
  JOURNAL_SQLITE_TARGET_BYTES,
  Journal,
  type JournalCondenseResult,
} from './journal.js'
import { ProjectStore } from './projects.js'
import { TestbedRunStore } from './testbedRuns.js'
import { TestbedReservationStore } from './testbedReservations.js'
import { DurableRunController, DurableRunStore } from './durableRuns.js'
import { profileAuthEvidence, scanProfiles, setClaudeConnectorPolicy } from './profiles.js'
import { ProfileOwnership } from './profileOwnership.js'
import { ProfileRuntime } from './profileRuntime.js'
import {
  ProfileLoginCoordinator,
  ProfileLoginRegistry,
} from './profileLoginCoordinator.js'
import {
  createJournalBackupSupervisor,
  JOURNAL_BACKUP_KEEP_DEFAULT,
  JOURNAL_BACKUP_MAX_RETAINED_BYTES_DEFAULT,
} from './journalBackup.js'
import { createJournalSnapshotChildTask } from './journalBackupProcess.js'
import {
  JournalProgressReporter,
  sizeAwareJournalMaintenanceBudgetMs,
  sizeAwareJournalMaintenanceNoProgressMs,
} from './journalProgress.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import { startServer } from './server.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { WorktreeCollisionDetector } from './worktreeCollisionDetector.js'
import { WorkspacePressureMonitor } from './workspacePressure.js'
import { JournalPressureMonitor } from './journalPressure.js'
import { MeshSite } from './meshSite.js'
import { MyOwnMeshRpcBridge } from './myOwnMeshRpc.js'
import { getOrCreateDeviceToken } from './deviceToken.js'
import { InstructionStore } from './instructions.js'
import { AgentBus } from './bus.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { BrowserBroker } from './browserBroker.js'
import { NotificationService } from './notifications.js'
import { InProcessExecutor, type Executor } from './executor.js'
import { WorkerExecutor } from './workerExecutor.js'
import { WorkerClient } from './workerTransport.js'
import { buildFleet, probeHubRoute } from './fleet.js'
import {
  DeviceExecutor,
  FleetConnectionStore,
  RemoteDeviceController,
} from './remoteDevices.js'
import { TestbedDeploymentService } from './testbedDeployment.js'
import { asChatNamePool } from './title.js'
import { asFileWriteDiffDensity } from './types.js'
import { asUiPreferences, type DangerFlags, type HubConfig, type HubPrefs } from './types.js'
import { RestartController, type RestartState } from './restartController.js'
import {
  parseProfileGenerationEnvironment,
  SCHEMA_VERSION,
  type ProfileGenerationAuthority,
  type SupervisorMsg,
} from './restartHandshake.js'
import {
  PREFLIGHT_EXIT_CODE,
  journalPreflightIdentity,
  recordExistingSchemaVersion,
  recordSchemaVersion,
  runHubPreflight,
  runHubPreflightInWorker,
  type PreflightFailure,
} from './preflight.js'
import {
  consumeRecoveryReceipts,
  JournalRecoveryLease,
  validateRecoveryReceiptsBeforeWritableOpen,
  verifyNormalJournalLineage,
} from './journalRecovery.js'

// The desktop shell runs the shipped hub entry with this flag before trusting a persisted
// node_modules tree. Static ESM imports have already linked the hub's real module graph by the time
// this executes; opening an in-memory Journal additionally loads and executes better-sqlite3's native
// addon, the failure most likely to survive an interrupted install or an architecture/ABI change.
// Nothing under HUB_DATA_DIR or HUB_PROFILES_DIR is touched in this mode.
if (process.env.AMA_VERIFY_HUB_DEPS === '1') {
  const verificationJournal = new Journal(':memory:')
  verificationJournal.db.prepare('SELECT 1 AS ok').get()
  verificationJournal.db.close()
  console.log('[hub-deps] verified entry module graph and better-sqlite3 native binding')
  process.exit(0)
}

const hubStartupStartedAt = performance.now()
let hubStartupPreviousPhaseAt = hubStartupStartedAt
function reportHubStartupPhase(phase: string, detail = ''): void {
  const now = performance.now()
  const phaseMs = Math.round((now - hubStartupPreviousPhaseAt) * 10) / 10
  const totalMs = Math.round((now - hubStartupStartedAt) * 10) / 10
  hubStartupPreviousPhaseAt = now
  console.log(
    `[hub-startup] ${phase}: ${phaseMs}ms (total ${totalMs}ms)${detail ? ` — ${detail}` : ''}`
  )
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
function configuredInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback
}
const supervised = process.env.HUB_SUPERVISED === '1' && typeof process.send === 'function'
const bootPort = Number(process.env.HUB_PORT ?? 7777)
const publicPort = supervised ? Number(process.env.HUB_FIXED_PORT ?? 7777) : bootPort
const isGreen = supervised && bootPort === 0
const journalSqliteTargetBytes = configuredInteger(
  process.env.AMA_JOURNAL_SQLITE_TARGET_BYTES,
  JOURNAL_SQLITE_TARGET_BYTES,
  128 * 1024 * 1024,
  64 * 1024 * 1024 * 1024,
)
const journalSnapshotKeep = configuredInteger(
  process.env.AMA_JOURNAL_SNAPSHOT_KEEP,
  JOURNAL_BACKUP_KEEP_DEFAULT,
  1,
  16,
)
const journalSnapshotMaxBytes = configuredInteger(
  process.env.AMA_JOURNAL_SNAPSHOT_MAX_BYTES,
  JOURNAL_BACKUP_MAX_RETAINED_BYTES_DEFAULT,
  128 * 1024 * 1024,
  64 * 1024 * 1024 * 1024,
)
function sendSupervisorMessage(message: unknown): void {
  if (!process.connected || !process.send) return
  try {
    process.send(message as never, (error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_IPC_CHANNEL_CLOSED') {
        console.error(`[hub] supervisor IPC send failed: ${error.message}`)
      }
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_IPC_CHANNEL_CLOSED') {
      console.error(
        `[hub] supervisor IPC send failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}
// HUB_DATA_DIR relocates the journal/config/worktrees/unfiled-workspaces/device-token root off the repo's data/. Profiles keep
// their real repo path so auth still resolves. Unset → repo data/ (byte-identical to today); set only by an
// isolated harness (e.g. the restart-survival acceptance test) to keep its DB + state off the live hub's.
const dataDir = process.env.HUB_DATA_DIR ? path.resolve(process.env.HUB_DATA_DIR) : path.join(repoRoot, 'data')
const journalPath = path.join(dataDir, 'hub.db')
const preflightAttemptId = process.env.HUB_PREFLIGHT_ATTEMPT_ID
const validPreflightAttempt =
  typeof preflightAttemptId === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    preflightAttemptId
  )
const hubProcessInstanceId = validPreflightAttempt ? preflightAttemptId! : crypto.randomUUID()
if (supervised && !validPreflightAttempt) {
  console.error('[hub-preflight] supervised boot lacks a valid preflight attempt binding')
  process.exit(PREFLIGHT_EXIT_CODE)
}
let preflightLivenessSequence = 0
let preflightLivenessPhase: 'starting' | 'integrity-check' | 'booting' = 'starting'
let preflightLivenessTimer: ReturnType<typeof setInterval> | undefined
// This is a parent-thread liveness/phase lease, not proof that SQLite advanced between frames.
// The supervisor's absolute ceiling remains authoritative even while valid leases continue.
const sendPreflightLiveness = (): void => {
  if (!supervised || !validPreflightAttempt) return
  sendSupervisorMessage({
    type: 'preflight-liveness',
    attemptId: preflightAttemptId,
    phase: preflightLivenessPhase,
    sequence: preflightLivenessSequence++,
  })
}
if (supervised) {
  sendPreflightLiveness()
  preflightLivenessPhase = 'integrity-check'
  sendPreflightLiveness()
  preflightLivenessTimer = setInterval(sendPreflightLiveness, 1_000)
}

async function reportPreflightFailure(
  failure:
    | PreflightFailure
    | {
        code: 'profile-generation-invalid'
        message: string
        recovery: string
      },
): Promise<never> {
  const message = {
    type: 'preflight-failed' as const,
    ...(validPreflightAttempt ? { attemptId: preflightAttemptId } : {}),
    ...failure,
  }
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

const profileGeneration: ProfileGenerationAuthority = await (async () => {
  try {
    return supervised
      ? parseProfileGenerationEnvironment(process.env)
      : {
          generationId: crypto.randomUUID(),
          publicEpoch: 1,
          active: true,
        }
  } catch (error) {
    return reportPreflightFailure({
      code: 'profile-generation-invalid',
      message: `The supervisor supplied invalid profile authority: ${
        error instanceof Error ? error.message : String(error)
      }`,
      recovery: 'Keep this hub offline and restart the AllMyAgents desktop supervisor.',
    })
  }
})()

const recoveryLease = new JournalRecoveryLease(dataDir)
try {
  recoveryLease.acquireShared()
} catch (error) {
  await reportPreflightFailure({
    code: 'database-validation-unavailable',
    message: `The journal ownership boundary could not be established: ${error instanceof Error ? error.message : String(error)}`,
    recovery:
      'Keep the data root offline. Resolve the lease, filesystem, or recovery-metadata error and restart AllMyAgents.',
  })
}
const preflight = await (async () => {
  try {
    const currentIdentity = journalPreflightIdentity(dataDir, journalPath)
    const reuseVerifiedIdentity =
      supervised &&
      typeof currentIdentity === 'string' &&
      /^[0-9a-f]{64}$/u.test(process.env.HUB_PREFLIGHT_CACHE_ID ?? '') &&
      process.env.HUB_PREFLIGHT_CACHE_ID === currentIdentity
    return supervised
      ? await runHubPreflightInWorker({
          dataDir,
          journalPath,
          schemaVersion: SCHEMA_VERSION,
          onLiveness: () => {},
          reuseVerifiedIdentity,
        })
      : runHubPreflight({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
  } catch (error) {
    return reportPreflightFailure({
      code: 'database-validation-unavailable',
      message: `The isolated preflight verifier failed: ${error instanceof Error ? error.message : String(error)}`,
      recovery:
        'Keep the data root offline. Repair the verifier/runtime failure and restart AllMyAgents.',
    })
  }
})()
for (const check of preflight.checks) {
  const line = `[hub-preflight] ${check.name}: ${check.status} (${check.durationMs}ms) — ${check.detail}`
  if (check.status === 'skipped') console.warn(line)
  else console.log(line)
}
if (!preflight.ok) await reportPreflightFailure(preflight.failure)
const lineageFailure = verifyNormalJournalLineage({
  dataDir,
  journalPath,
  maxSchemaVersion: SCHEMA_VERSION,
})
if (lineageFailure) await reportPreflightFailure(lineageFailure)
const receiptFailure = validateRecoveryReceiptsBeforeWritableOpen({ dataDir, journalPath })
if (receiptFailure) await reportPreflightFailure(receiptFailure)
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
reportHubStartupPhase('preflight complete')
if (supervised) {
  preflightLivenessPhase = 'booting'
  sendPreflightLiveness()
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

// Account names are aliases, never identity migrations. Credential directories, session rows, usage
// history, manager grants, and account-scoped instructions continue to use the immutable profile id.
const profileNames: Record<string, string> = Object.fromEntries(
  Object.entries(config.profileNames ?? {}).flatMap(([id, value]) => {
    const name = typeof value === 'string' ? value.trim() : ''
    return name && name.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(name) ? [[id, name]] : []
  }),
)

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
const consumedRecoveryReceipts = consumeRecoveryReceipts(journal)
if (consumedRecoveryReceipts > 0) {
  console.warn(
    `[journal-recovery] recorded ${consumedRecoveryReceipts} recovery notice(s); post-snapshot tail outcome remains unknown`
  )
}
reportHubStartupPhase('journal opened')
if (supervised && validPreflightAttempt) {
  const identity = journalPreflightIdentity(dataDir, journalPath)
  if (identity) {
    sendSupervisorMessage({
      type: 'preflight-cacheable',
      attemptId: preflightAttemptId,
      identity,
    })
  }
}
// Each live WebSocket (pane / device / reconnect) attaches a journal 'event' listener, removed on
// close — legitimately more than the EventEmitter default of 10 for a multi-pane/fleet hub. Raise
// the cap so a healthy number of connections doesn't emit a spurious MaxListeners leak warning.
journal.setMaxListeners(64)

const restartState: RestartState = {
  booted: false,
  draining: false,
  promoting: false,
  rollbackRebinding: false,
  sockets: new Set(),
  journalBackup: { status: 'inactive' },
  journalBackupRequired: false,
}

// AUTOMATIC, VERIFIED JOURNAL SNAPSHOTS.
//
// The operator's journal was corrupted twice in two days; the second time it was truncated to an empty
// schema, and the only reason fourteen hours of history survived at all was a backup a human happened to
// take by hand. Nothing in the product was protecting it. This is that protection: a consistent online
// size-aware snapshots after readiness, each one integrity-checked before it is kept. Two independently
// verified generations preserve rollback depth without multiplying a multi-gigabyte journal by six.
//
// The supervisor is constructed here but does NO work until the server's listening callback declares
// readiness below. A large initial snapshot must never sit on the port-bind/readiness critical path.
//
// SUPERVISED HUBS ONLY TAKE ONE SET. During a blue-green flip two hubs briefly share this database; both
// snapshotting would double the IO for no benefit, and green is the one that will survive.
const journalBackupsDir = path.join(dataDir, 'backups')
const notifications = new NotificationService(journal.db)
let journalBackupWorkActive = false
let journalMaintenanceDeferredForBackup = false
let journalMaintenanceChild: ChildProcess | undefined
const journalProgress = new JournalProgressReporter(
  dataDir,
  process.pid,
  hubProcessInstanceId,
  (error) =>
    console.error(
      `[journal] out-of-band progress heartbeat failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
)
const journalSnapshotChildTask = createJournalSnapshotChildTask(journalPath)
const journalBackups = createJournalBackupSupervisor(journal.db, {
  dir: journalBackupsDir,
  recoveryDataDir: dataDir,
  keep: journalSnapshotKeep,
  maxRetainedBytes: journalSnapshotMaxBytes,
  recoveryKeep: journalSnapshotKeep,
  recoveryMaxRetainedBytes: journalSnapshotMaxBytes,
  onProgress: (progress) => {
    journalBackupWorkActive = progress.active
    journalProgress.report(progress)
    if (!progress.active && journalMaintenanceDeferredForBackup) {
      journalMaintenanceDeferredForBackup = false
      setImmediate(runJournalMaintenance).unref?.()
    }
  },
  log: (message) => console.log(message),
  onStateChange: (state) => {
    // State transitions occur after the snapshot task settles, including worker crashes that cannot send
    // a terminal progress frame. Never strand deferred storage maintenance behind a stale active bit.
    journalBackupWorkActive = false
    if (journalMaintenanceDeferredForBackup) {
      journalMaintenanceDeferredForBackup = false
      setImmediate(runJournalMaintenance).unref?.()
    }
    if (state.status !== 'inactive') restartState.journalBackupRequired = true
    restartState.journalBackup = state
    if (state.status === 'degraded') {
      notifications.publish({
        kind: 'hub-warning',
        severity: 'error',
        sourceRole: 'system',
        route: 'operator',
        title: 'Journal backup protection is degraded',
        body: state.error,
        dedupeKey: `journal-backup-degraded:${state.error.slice(0, 160)}:${new Date().toISOString().slice(0, 10)}`,
      })
    }
  },
}, async (db, options) => {
  if (journalMaintenanceChild) {
    options.log?.('[journal-backup] snapshot deferred while exclusive storage maintenance is active')
    return { ok: true, skipped: true }
  }
  return await journalSnapshotChildTask(db, options)
})
process.once('exit', () => recoveryLease.release())
const store = new SessionStore(journal.db)
const profiles: ReturnType<typeof scanProfiles> = []
const profileOwnership = new ProfileOwnership({
  ownerId: process.env.HUB_PROFILE_OWNER_ID ?? crypto.randomUUID(),
  pid: Number(process.env.HUB_PROFILE_OWNER_PID ?? process.pid),
  port: Number(process.env.HUB_PROFILE_OWNER_PORT ?? process.env.HUB_PORT ?? 7777),
  // Set by scripts/sandbox.mjs. It marks this hub as expendable, which is what lets the operator's own
  // app take an account back from a sandbox that is squatting on it. Absent for a real install, so the
  // installed app is never the one that yields.
  transient: process.env.HUB_TRANSIENT === '1',
}, {
  generationId: profileGeneration.generationId,
  publicGenerationActive: profileGeneration.active,
  publicEpoch: profileGeneration.publicEpoch,
})
const profileMap = new Map(profiles.map((p) => [p.id, p]))
const configuredApprovalMinutes = config.approvals?.timeoutMinutes
const approvalTimeoutMs = typeof configuredApprovalMinutes === 'number' && Number.isFinite(configuredApprovalMinutes)
  ? Math.min(24 * 60, Math.max(1, Math.floor(configuredApprovalMinutes))) * 60_000
  : undefined
const approvals = new ApprovalService(journal, approvalTimeoutMs ? { timeoutMs: approvalTimeoutMs } : {})
const questions = new QuestionService(journal)
const usage = new UsageMonitor(journal, profiles, config)
usage.setAlertListener((alert) => {
  const reset = alert.resetsAt ? new Date(alert.resetsAt * 1000).toISOString() : 'unknown reset'
  notifications.publish({
    kind: 'hub-warning',
    severity: alert.kind === 'headroom-low' ? 'warning' : 'error',
    sourceRole: 'system',
    route: 'operator',
    title: alert.kind === 'entitlement-denied'
      ? `${profileNames[alert.profileId] ?? alert.profileId} cannot run agents`
      : `${profileNames[alert.profileId] ?? alert.profileId} usage ${alert.kind === 'rejected' ? 'is exhausted' : 'is running low'}`,
    body: `${alert.reason}${alert.resetsAt ? `; resets ${reset}` : ''}`,
    dedupeKey: `account-usage:${alert.profileId}:${alert.kind}:${alert.resetsAt ?? 'none'}`,
  })
})
const workspace = new WorkspaceManager(path.join(dataDir, 'worktrees'), path.join(dataDir, 'workspaces'))
const projects = new ProjectStore(journal.db, journal)
const testbedRuns = new TestbedRunStore(journal.db)
const testbedReservations = new TestbedReservationStore(journal.db)
const durableRuns = new DurableRunController(
  new DurableRunStore(journal.db),
  journal,
  path.join(dataDir, 'runs'),
)
const instructions = new InstructionStore(journal.db)
const bus = new AgentBus(journal.db)
const memory = new MemoryStore(journal.db)
const practices = new PracticeStore(journal.db)
const desktopBrowserSecret = process.env.AMA_DESKTOP_BROWSER_SECRET ?? ''
const desktopBrowserAddress = process.env.AMA_DESKTOP_BROWSER_ADDR ?? ''
// The desktop grants this process the bridge credential. Capture it once, then
// remove it from the ambient environment before any vendor/login child can
// inherit it and expose it to a model shell command.
delete process.env.AMA_DESKTOP_BROWSER_SECRET
delete process.env.AMA_DESKTOP_BROWSER_ADDR
const browserBroker = new BrowserBroker({
  address: desktopBrowserAddress,
  secret: desktopBrowserSecret,
})
// Automatic hub-side memory recall (memory.ts) — on unless config.features.autoMemoryRecall === false.
const autoMemoryRecall = config.features?.autoMemoryRecall !== false
// Danger Zone flags — resolved to safe defaults (OFF) from config, then shared by reference with the
// SessionManager (which reads them live when gating tools) and the server (which mutates + persists
// them on POST /api/config/danger). Same object → a toggle flip takes effect without a restart.
const danger: DangerFlags = {
  disableWorktreeCollisionWarnings: config.danger?.disableWorktreeCollisionWarnings === true,
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
const persistedUiPreferences = asUiPreferences(config.prefs?.ui)
const prefs: HubPrefs = {
  chatNamePool: asChatNamePool(config.prefs?.chatNamePool),
  // Opt-out so configs written before the preference existed get the operator-requested default ON.
  steerMessagesAtToolBoundary: config.prefs?.steerMessagesAtToolBoundary !== false,
  fileWriteDiffDensity: asFileWriteDiffDensity(config.prefs?.fileWriteDiffDensity),
  ...(persistedUiPreferences ? { ui: persistedUiPreferences } : {}),
}
let profileBootstrapComplete = false
const profileRuntime = new ProfileRuntime({
  profilesDir,
  profiles,
  profileMap,
  profileOwnership,
  usage,
  generation: profileGeneration,
  scanProfiles: () => scanProfiles(profilesDir).map((profile) => ({
    ...profile,
    ...(profileNames[profile.id] ? { displayName: profileNames[profile.id] } : {}),
  })),
  refreshAuth: (profile) => {
    refreshProfileAuth(profile)
    usage.noteProfileAuth(profile)
  },
  onAdded: (profile) => {
    usage.addProfile(profile)
    if (profileBootstrapComplete) {
      journal.append(null, 'profiles/added', {
        id: profile.id,
        provider: profile.provider,
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        ...(profile.accountEmail ? { accountEmail: profile.accountEmail } : {}),
        ...(profile.providerAccountId ? { providerAccountId: profile.providerAccountId } : {}),
      })
    }
  },
  applyConnectorPolicy: (profile) =>
    setClaudeConnectorPolicy([profile], danger.enableClaudeConnectors === true),
  log: (message) => console.error(message),
})
profileRuntime.bootstrap()
profileBootstrapComplete = true
reportHubStartupPhase('profiles restored', `${profiles.length} managed profile(s)`)
// Agent execution runs behind the Executor seam (docs/agent-worker-impl.md §4.1). The implementation is
// chosen by the presence of HUB_WORKER_SOCKET (§4.4, the Phase-2 feature flag hubctl injects when worker
// mode is opted into): absent → the in-process executor (byte-identical to today); present → a
// WorkerExecutor that relays every method to the long-lived agent worker over a WorkerClient and drives
// the hub's side effects from the worker→hub event/lifecycle streams (ingestWorkerEvent / applyLifecycle /
// recall / requestRestart). The callbacks forward to `sessions`, assigned just below — they only fire once
// a worker message arrives (well after assignment), so the forward reference is safe.
const workerSocket = process.env.HUB_WORKER_SOCKET
const workerSecret = process.env.HUB_WORKER_SECRET
// This process has fallback paths that can spawn vendor/login helpers. Keep the control bearer out of them.
delete process.env.HUB_WORKER_SECRET
if (workerSocket && (!workerSecret || workerSecret.length < 32)) {
  throw new Error('HUB_WORKER_SECRET is required when HUB_WORKER_SOCKET is enabled')
}
// Overseer identity is duplicated deliberately outside SQLite: config.json tells the supervisor/UI which
// account was designated even when journal preflight refuses to open. The live role is still rechecked
// against the hub-minted SessionRecord on every control call.
const overseer = {
  ...(typeof config.overseer?.profileId === 'string' ? { profileId: config.overseer.profileId } : {}),
  ...(typeof config.overseer?.sessionId === 'string' ? { sessionId: config.overseer.sessionId } : {}),
  ...(typeof config.overseer?.updatedAt === 'string' ? { updatedAt: config.overseer.updatedAt } : {}),
}
let sessions: SessionManager
const executor: Executor = workerSocket
  ? new WorkerExecutor(new WorkerClient(workerSocket, { danger: () => danger, authSecret: workerSecret }), {
      ingestWorkerEvent: (sessionId, wseq, kind, payload) => sessions.ingestWorkerEvent(sessionId, wseq, kind, payload),
      applyLifecycle: (msg) => sessions.applyLifecycle(msg),
      recall: (sessionId, prompt) => sessions.recallForWorker(sessionId, prompt),
      requestRestart: (reason, bySession) => void sessions.requestRestart(reason, bySession),
      // The worker's MCP tool handlers reaching hub-owned services (§3.3): an `rpc` runs against the same
      // bus/memory/practices the in-process executor uses; an `approvalRequest` goes to the operator via
      // the idempotent approvals.request(id) so a re-issue across a restart dedups (§7.2).
      runRelay: (method, args) => sessions.runRelay(method, args),
      resolveApproval: (approvalId, sessionId, kind, payload) =>
        approvals.requestDetailed(sessionId, kind, payload, approvalId),
      // Step 5 (§6, §7.1): on every WorkerClient (re)connect, re-attach to the still-running worker and
      // replay the in-flight turn's event gap gap-free + exactly-once — so a mid-turn survives a hub restart.
      attachWorker: () => sessions.attachWorker(),
    })
  : new InProcessExecutor({ approvals, questions, usage, danger, memory, practices })
sessions = new SessionManager(journal, store, profileMap, approvals, usage, workspace, projects, instructions, bus, memory, practices, danger, autoMemoryRecall, dataDir, questions, executor, prefs, browserBroker, notifications)
sessions.setTestbedRunStore(testbedRuns)
sessions.setTestbedReservationStore(testbedReservations)
sessions.setDurableRunController(durableRuns)
const profileLoginCoordinator = new ProfileLoginCoordinator({
  profilesDir,
  registry: new ProfileLoginRegistry(path.join(dataDir, 'profile-logins.json')),
  profileRuntime,
  profileOwnership,
  sessions,
})
// Active ProfileRuntime bootstrap above already reconciled any crash-left credential saga. Publish the
// same durable public attempt as terminal/unknown now; a successor never recreates the predecessor's
// process-local turn freeze.
if (profileRuntime.currentGeneration().active) {
  profileLoginCoordinator.recoverAfterProfileBootstrap()
}
process.once('exit', () => profileLoginCoordinator.dispose())
browserBroker.onNavigation((event) =>
  sessions.noteBrowserNavigation(event.sessionId, event.url, event.title, event.actor, event.ok, event.errorCode)
)
browserBroker.start()
process.once('exit', () => browserBroker.stop())
journal.on('event', (event) => {
  if (event.kind !== 'worktree/risk-detected') return
  void sessions.reportWorktreeRiskToManagers(event.payload)
})
const worktreeCollisions = new WorktreeCollisionDetector({
  sessions: () => sessions.list(),
  enabled: () => danger.disableWorktreeCollisionWarnings !== true,
  steer: (sessionId, message) => sessions.steerWorktreeCollision(sessionId, message),
  // Global, typed risk events let a Project Manager consume the same fact without scraping agent prose.
  // sessionId stays null because collision events concern a pair and stale-base events concern a branch;
  // the exact involved session ids live in the stable payload contract.
  report: (event) => {
    journal.append(null, 'worktree/risk-detected', event)
  },
})
process.once('exit', () => worktreeCollisions.stop())
const workspacePressure = new WorkspacePressureMonitor({
  sessions: () => sessions.list(),
  workspace,
  report: (sessionId, pressure, notifyAgent) =>
    sessions.reportWorkspacePressure(sessionId, pressure, notifyAgent),
})
process.once('exit', () => workspacePressure.stop())
const journalPressure = new JournalPressureMonitor({
  dbPath: journalPath,
  db: journal.db,
  notifications,
})
process.once('exit', () => journalPressure.stop())
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
// --- Journal condensation ----------------------------------------------------------------------
// The measured journal grew to 390 MB / 375k events in three days, mostly two superseded Codex streams.
// Run maintenance only after this process owns the public role, and in a ONE-SHOT CHILD: better-sqlite3's
// JSON scan is synchronous, so setInterval(() => journal.condense...) would freeze this hub's HTTP/WS and
// worker ingestion. The Journal method bounds deletes as well, limiting the cross-process SQLite write lock
// and WAL burst. A failure is logged and retried next interval; maintenance must never become a boot cause.
type JournalMaintenanceMessage =
  | { type: 'journal-condensed'; operationId: string; result: JournalCondenseResult }
  | { type: 'journal-condense-deferred'; operationId: string; reason: string }
  | { type: 'journal-condense-error'; operationId: string; error: string }
  | {
      type: 'journal-condense-progress'
      operationId: string
      phase: string
      rowsCompleted: number
      bytesCompleted: number
      suspendWatchdog?: boolean
    }

let journalMaintenanceTimer: NodeJS.Timeout | undefined
let journalMaintenanceImmediate: NodeJS.Immediate | undefined

function runJournalMaintenance(): void {
  if (journalMaintenanceChild) return // a slow disk gets one job, never an accumulating process queue
  if (journalBackupWorkActive) {
    journalMaintenanceDeferredForBackup = true
    return
  }
  const operationId = crypto.randomUUID()
  try {
    journal.recordCompactionLifecycle(operationId, 'started', {
      detail: 'Bounded journal maintenance child is being launched.',
    })
    const sourceMode = import.meta.url.endsWith('.ts')
    const entry = path.join(import.meta.dirname, sourceMode ? 'journalMaintenance.ts' : 'journalMaintenance.js')
    // Source mode needs tsx. Resolve it against this package and pass an absolute URL: a bare `tsx/esm`
    // depends on the desktop/process cwd, the same launch-path mistake that previously broke the MCP bridge.
    const execArgv = sourceMode
      ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href]
      : []
    let journalBytes = 0
    try {
      journalBytes = fs.statSync(journalPath).size
    } catch {
      /* a fresh journal uses the minimum bounded budget */
    }
    const workBudgetMs = sizeAwareJournalMaintenanceBudgetMs(journalBytes)
    const noProgressMs = sizeAwareJournalMaintenanceNoProgressMs(journalBytes)
    const child = fork(
      entry,
      [
        journalPath,
        journalBackupsDir,
        operationId,
        String(JOURNAL_CONDENSE_GRACE_MS),
        String(JOURNAL_CONDENSE_MAX_COMMAND_DELTAS),
        String(JOURNAL_CONDENSE_MAX_AGENT_MESSAGE_DELTAS),
        String(JOURNAL_CONDENSE_MAX_DIFF_SNAPSHOTS),
        String(JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES),
        String(workBudgetMs),
        String(journalSqliteTargetBytes),
        String(journalSnapshotKeep),
        String(journalSnapshotMaxBytes),
      ],
      {
        execArgv,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }
    )
    journalMaintenanceChild = child
    let terminalReported = false
    let lastProgressAt = Date.now()
    let progressWatchdogSuspended = false
    const guard = setInterval(() => {
      if (progressWatchdogSuspended) return
      if (Date.now() - lastProgressAt < noProgressMs) return
      if (!terminalReported) {
        terminalReported = true
        try {
          journal.recordCompactionLifecycle(operationId, 'unobservable', {
            detail: `Maintenance child made no directly observable progress for ${noProgressMs}ms and was terminated.`,
          })
        } catch (error) {
          console.error(
            `[journal] could not record condensation observation loss: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
      console.error(
        `[journal] condensation made no progress for ${noProgressMs}ms; terminating it so maintenance can retry`
      )
      clearInterval(guard)
      child.kill()
    }, Math.min(10_000, Math.max(1_000, Math.floor(noProgressMs / 6))))
    guard.unref?.()
    child.on('message', (raw: unknown) => {
      const msg = raw as JournalMaintenanceMessage
      if (msg?.operationId !== operationId) return
      if (msg?.type === 'journal-condense-progress') {
        lastProgressAt = Date.now()
        progressWatchdogSuspended = msg.suspendWatchdog === true
        return
      }
      if (msg?.type === 'journal-condense-error') {
        terminalReported = true
        clearInterval(guard)
        console.error(`[journal] condensation failed: ${msg.error}`)
        return
      }
      if (msg?.type === 'journal-condense-deferred') {
        terminalReported = true
        clearInterval(guard)
        console.warn(`[journal] condensation deferred without deletion: ${msg.reason}`)
        return
      }
      if (msg?.type !== 'journal-condensed') return
      terminalReported = true
      clearInterval(guard)
      const {
        commandOutputDeltasDeleted,
        agentMessageDeltasDeleted,
        diffSnapshotsDeleted,
        itemStartedDeleted,
        transientPayloadBytesDeleted,
        cursorCheckpointsWritten,
        writerLockMs,
      } = msg.result
      if (
        commandOutputDeltasDeleted ||
        agentMessageDeltasDeleted ||
        diffSnapshotsDeleted ||
        itemStartedDeleted ||
        cursorCheckpointsWritten
      ) {
        console.log(
          `[journal] condensed ${commandOutputDeltasDeleted} command deltas + ${agentMessageDeltasDeleted} message deltas + ${diffSnapshotsDeleted} diff snapshots + ${itemStartedDeleted} completed-item start rows (${transientPayloadBytesDeleted} payload bytes)` +
            (cursorCheckpointsWritten ? `; wrote ${cursorCheckpointsWritten} wseq checkpoint(s)` : '') +
            `; writer lock ${writerLockMs.toFixed(1)}ms`
        )
      }
    })
    child.once('error', (error) => {
      clearInterval(guard)
      if (!terminalReported) {
        terminalReported = true
        try {
          journal.recordCompactionLifecycle(operationId, 'unobservable', {
            detail: `Maintenance child launch failed: ${error.message}`,
          })
        } catch {
          /* the launch error is still reported below */
        }
      }
      if (journalMaintenanceChild === child) journalMaintenanceChild = undefined
      console.error(`[journal] could not launch condensation: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      clearInterval(guard)
      if (journalMaintenanceChild === child) journalMaintenanceChild = undefined
      if (!terminalReported) {
        terminalReported = true
        try {
          journal.recordCompactionLifecycle(operationId, 'unobservable', {
            detail: `Maintenance child exited without a terminal report (${
              signal ? `signal ${signal}` : `code ${String(code)}`
            }).`,
          })
        } catch (error) {
          console.error(
            `[journal] could not record condensation observation loss: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
      if (code !== 0) {
        console.error(`[journal] condensation child exited ${signal ? `on ${signal}` : `with code ${String(code)}`}`)
      }
    })
  } catch (error) {
    try {
      journal.recordCompactionLifecycle(operationId, 'unobservable', {
        detail: `Maintenance launch was not observable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    } catch {
      /* launch failure is still reported below */
    }
    console.error(`[journal] could not launch condensation: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function startJournalMaintenance(): void {
  if (journalMaintenanceTimer) return
  // Queue the first bounded attempt only after this process owns the public role. The child performs the
  // strong-snapshot gate and truthfully defers without deleting when recovery evidence is not ready.
  journalMaintenanceImmediate = setImmediate(() => {
    journalMaintenanceImmediate = undefined
    runJournalMaintenance()
  })
  journalMaintenanceTimer = setInterval(runJournalMaintenance, JOURNAL_CONDENSE_INTERVAL_MS)
  journalMaintenanceTimer.unref?.()
}

function stopJournalMaintenance(): void {
  if (journalMaintenanceImmediate) clearImmediate(journalMaintenanceImmediate)
  journalMaintenanceImmediate = undefined
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

sessions.boot({ reconcile: !isGreen }) // green defers stale-reconcile to promote (it doesn't own the port yet)
reportHubStartupPhase('sessions restored', `${sessions.list().length} session(s)`)
let durableCapabilityUpgradeImmediate: NodeJS.Immediate | undefined
function scheduleDurableCapabilityUpgrade(): void {
  if (durableCapabilityUpgradeImmediate) return
  durableCapabilityUpgradeImmediate = setImmediate(() => {
    durableCapabilityUpgradeImmediate = undefined
    void sessions.upgradeDurableSessionCapabilitiesPostReady().catch((error) => {
      console.error(
        `[hub] post-ready durable capability upgrade failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })
  })
}
process.once('exit', () => {
  if (durableCapabilityUpgradeImmediate) clearImmediate(durableCapabilityUpgradeImmediate)
})
if (!isGreen) usage.startPolling() //     green starts polling only once it owns the port (on promote)
// Reclaim agent worktrees no session owns only AFTER the listener is ready, in a one-shot child. This used
// to run synchronously between sessions.boot() and startServer(), and a setImmediate version could still
// win the event-loop race against the supervisor's first HTTP health probe. Serial Git checks and recursive
// build-artifact cleanup now cannot delay either port bind or any request. Green schedules the child only
// after promotion owns the data root. The live snapshot is taken before fork, on the single hub event loop,
// so an existing session's checkout cannot be mistaken for an orphan.
type WorkspaceHousekeepingMessage =
  | {
      type: 'workspace-reaped'
      durationMs: number
      liveCount: number
      removed: string[]
      keptWithWork: Array<{ worktree: string; reason: string }>
    }
  | { type: 'workspace-reap-error'; error: string }

let workspaceHousekeepingChild: ChildProcess | undefined
function scheduleWorkspaceHousekeeping(): void {
  if (workspaceHousekeepingChild) return
  const live = sessions
    .list()
    .map((session) => session.worktree)
    .filter((worktree): worktree is string => typeof worktree === 'string' && worktree.length > 0)
  // A one-minute eligibility grace makes the snapshot/worker boundary fail closed even on a filesystem
  // with coarse timestamps. A checkout created after this snapshot is simply reconsidered next boot.
  const eligibleBeforeMs = Date.now() - 60_000
  try {
    const sourceMode = import.meta.url.endsWith('.ts')
    const entry = path.join(import.meta.dirname, sourceMode ? 'workspaceMaintenance.ts' : 'workspaceMaintenance.js')
    const execArgv = sourceMode
      ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href]
      : []
    const child = fork(
      entry,
      [path.join(dataDir, 'worktrees'), path.join(dataDir, 'workspaces')],
      { execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    )
    workspaceHousekeepingChild = child
    let terminalReported = false
    const guard = setTimeout(() => {
      if (terminalReported) return
      terminalReported = true
      console.error('[workspace] orphan worktree sweep exceeded 15 minutes and was terminated')
      child.kill()
    }, 15 * 60 * 1000)
    guard.unref?.()
    child.on('message', (raw: unknown) => {
      const message = raw as WorkspaceHousekeepingMessage
      if (message?.type === 'workspace-reap-error') {
        terminalReported = true
        console.error(`[workspace] orphan worktree sweep failed: ${message.error}`)
        return
      }
      if (message?.type !== 'workspace-reaped') return
      terminalReported = true
      if (message.removed.length > 0) {
        console.log(`[workspace] reclaimed ${message.removed.length} orphaned worktree(s)`)
      }
      for (const kept of message.keptWithWork) {
        console.log(`[workspace] kept orphaned worktree ${path.basename(kept.worktree)} — ${kept.reason}`)
      }
      console.log(
        `[hub-startup] post-ready workspace housekeeping: ${message.durationMs}ms` +
          ` — ${message.liveCount} live, ${message.removed.length} reclaimed, ${message.keptWithWork.length} kept`
      )
    })
    child.once('error', (error) => {
      clearTimeout(guard)
      terminalReported = true
      if (workspaceHousekeepingChild === child) workspaceHousekeepingChild = undefined
      console.error(`[workspace] could not launch orphan sweep: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(guard)
      if (workspaceHousekeepingChild === child) workspaceHousekeepingChild = undefined
      if (!terminalReported) {
        console.error(
          `[workspace] orphan sweep exited without a result (${signal ? `signal ${signal}` : `code ${String(code)}`})`
        )
      }
    })
    child.send({ type: 'reap', liveWorktrees: live, eligibleBeforeMs }, (error) => {
      if (!error) return
      console.error(`[workspace] could not dispatch orphan sweep: ${error.message}`)
      child.kill()
    })
  } catch (error) {
    console.error(
      `[workspace] could not launch orphan sweep: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
process.once('exit', () => {
  workspaceHousekeepingChild?.kill()
  workspaceHousekeepingChild = undefined
})
restartState.booted = true

function rescanProfiles(): typeof profiles {
  return profileRuntime.rescan()
}

function refreshProfileAuth(profile: (typeof profiles)[number]): void {
  const evidence = profileAuthEvidence(profile)
  // Unknown refresh-capable credentials must not erase a real vendor refresh/invalid_grant failure
  // already observed by this generation. On a fresh boot there is no prior state, so they remain
  // honestly unknown and are not falsely logged out merely because an access token expired.
  if (!evidence.authStatus && profile.authStatus === 'signed_out') return
  profile.authStatus = evidence.authStatus
  profile.authError = evidence.authError
}

// Device token — proof of an authorized device. Generated + persisted under `dataDir` alongside the
// journal + config, which is what HUB_DATA_DIR already promised ("journal/config/worktrees/device-token
// root", line 29). It used to hardcode `repoRoot/data`, so an installed build — the only configuration
// that sets HUB_DATA_DIR — would have split its token away from the rest of its state. Unset
// HUB_DATA_DIR resolves to exactly the same path as before, so dev is unchanged. Enforcement is
// mandatory even on loopback: vendor agents are local callers too.
const deviceToken = getOrCreateDeviceToken(dataDir)
const requireToken = true
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
// Explicit fallback ports for old/mislabelled peers. Normal discovery needs no configuration: the node's
// session snapshot already carries each peer's presence-advertised sites and therefore its actual hub port.
// Keep config.mesh.peerPorts = [7778, 7900, …] as an operator override for compatibility.
const meshPeerPorts: number[] = Array.isArray(config.mesh?.peerPorts)
  ? config.mesh.peerPorts.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 65536)
  : []

const deviceExecutor = new DeviceExecutor(path.join(dataDir, 'device-executor.json'))
const fleetConnections = new FleetConnectionStore(path.join(dataDir, 'fleet-connections.json'))
// The Site-free lane is still remote exposure and follows the exact same operator/config switch as Sites.
// Keep the bridge allocated so a runtime enable can start it, but never register while mesh is disabled.
const directMesh = new MyOwnMeshRpcBridge()
const remoteDevices = new RemoteDeviceController(fleetConnections, async (siteId) => {
  const canonical = (value: string): string => value.split('-', 1)[0]!.toLowerCase()
  const wanted = canonical(siteId)
  const directStatus = directMesh.status()
  const directDiagnostic = directStatus.available
    ? undefined
    : directStatus.reason === 'permission-denied'
      ? 'The direct MyOwnMesh lane is also unavailable because its control pipe denied this user read/write access; the MyOwnMesh/AllMyStuff service owner must grant the interactive console user full duplex access.'
      : directStatus.reason === 'control-error'
        ? `The direct MyOwnMesh lane is also unavailable: ${directStatus.error ?? 'control request failed'}`
        : undefined
  const withDirectDiagnostic = (message: string): string => directDiagnostic ? `${message} ${directDiagnostic}` : message
  const local = mesh.status()
  let roster
  try {
    roster = await mesh.ownedRosterRequired()
  } catch (error) {
    return {
      siteId,
      label: fleetConnections.get(siteId)?.label ?? siteId.slice(0, 8),
      baseUrl: '',
      online: false,
      failureCode: 'fleet-control-unavailable',
      error: withDirectDiagnostic(error instanceof Error ? error.message : String(error)),
    }
  }
  const member = roster.find((candidate) => canonical(candidate.device) === wanted)
  if (!member) {
    return {
      siteId,
      label: fleetConnections.get(siteId)?.label ?? siteId.slice(0, 8),
      baseUrl: '',
      online: false,
      failureCode: 'not-in-fleet-roster',
      error: withDirectDiagnostic('This paired device is not present in the signed AllMyStuff fleet roster.'),
    }
  }
  const fleet = await buildFleet({
    localSiteId: local.siteId,
    localLabel: local.label,
    localBaseUrl: `http://127.0.0.1:${local.port}`,
    roster: async () => roster,
    peerSites: () => mesh.peerSites(),
    siteMap: (node, port) => mesh.siteMap(node, port),
    recoverSiteMap: (node, port) => mesh.recoverSiteMap(node, port),
    probeRoute: (baseUrl) => probeHubRoute(baseUrl, 5000),
    // A paired device is already an exact target, so its well-known hub port is a safe compatibility
    // fallback when presence has temporarily lost the site advert. Never apply this across the roster.
    hubPort: 7777,
    targetDeviceId: siteId,
    extraPorts: meshPeerPorts,
  })
  const route = fleet.find((site) => !site.local && canonical(site.siteId) === wanted)
  return route
    ? {
        siteId: route.siteId,
        label: route.label,
        baseUrl: route.baseUrl,
        online: route.online,
        ...(route.routeCode ? { failureCode: route.routeCode } : {}),
        ...(!route.online && route.routeError ? { error: withDirectDiagnostic(route.routeError) } : {}),
      }
    : {
        siteId: member.device,
        label: member.label || fleetConnections.get(siteId)?.label || siteId.slice(0, 8),
        baseUrl: '',
        online: false,
        failureCode: 'site-route-unavailable',
        error: withDirectDiagnostic('The signed fleet member has no usable advertised or well-known AllMyAgents Site route.'),
      }
}, { bridge: directMesh, localDeviceToken: deviceToken, enabled: () => mesh.status().enabled })
sessions.setRemoteDeviceController(remoteDevices)

// Desktop releases carry one platform/architecture-matched, vendor-free node payload. Development
// builds may opt into the same path by running `pnpm testbed:bundle`; an absent payload simply leaves
// remote bootstrap unavailable rather than manufacturing an unverified runtime at request time.
const configuredTestbedBundle = process.env.ALLMYAGENTS_TESTBED_BUNDLE_DIR?.trim()
const testbedBundleDir = configuredTestbedBundle
  ? path.resolve(configuredTestbedBundle)
  : path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'testbed-runtime')
const testbedDeployment = fs.existsSync(path.join(testbedBundleDir, 'manifest.json'))
  ? new TestbedDeploymentService({
      bundleDir: testbedBundleDir,
      directMesh,
      remoteDevices,
      ownedRoster: () => mesh.ownedRosterRequired(),
      emit: (event) => journal.append(null, `testbed/deployment-${event.stage}`, event),
    })
  : undefined

// Listen on the BOOT port (0 → ephemeral for a green); the server reports its actual port back.
const server = startServer({ port: bootPort, defaultCwd: dataDir, profilesDir, profileNames, profileOwnership, profileLoginCoordinator, journal, sessions, profiles, approvals, questions, notifications, usage, projects, testbedRuns, testbedReservations, workspace, instructions, bus, memory, practices, danger, prefs, rescanProfiles, mesh, deviceToken, requireToken, meshPeerPorts, agentToolSecret, restartState, executor, configPath, projectActivity: (projectId) => worktreeCollisions.projectActivity(projectId), deviceExecutor, remoteDevices, directMesh, testbedDeployment, overseer, overseerCwd: repoRoot })

// Register the mesh advert — factored so a promoted green can (re)register once it owns the port.
function registerMesh(): void {
  if (mesh.status().enabled) void directMesh.start().then(() => {
    const status = directMesh.status()
    if (status.available) {
      console.log(`[mesh] direct hub RPC active on ${status.networkId ?? 'unknown fleet'}`)
    } else {
      console.log(
        `[mesh] direct hub RPC unavailable (${status.reason ?? 'unknown'})` +
        `${status.error ? ` — ${status.error}` : ''}; background discovery will keep retrying`,
      )
    }
    journal.append(null, 'mesh/direct-rpc', status)
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[mesh] direct hub RPC unavailable — ${message}`)
    journal.append(null, 'mesh/direct-rpc', { available: false, error: message })
  })
  void mesh.register().then((s) => {
    if (s.exposed) console.log(`[mesh] exposed as site "${s.label}" (${s.siteId}) — fleet peers open ${s.peerUrl}`)
    else if (s.enabled && s.nodePresent) console.log(`[mesh] node present but not exposed — ${s.error ?? 'unknown'}`)
    else if (s.enabled) console.log('[mesh] no AllMyStuff node on this machine — will keep checking')
    journal.append(null, 'mesh/site', s)
    // Keep trying after the first attempt. A hub that starts before the AllMyStuff node — the normal
    // order when both start at login — used to conclude "no mesh" once and stay invisible to the fleet
    // until it was restarted, with nothing on screen hinting that a restart was the cure.
    mesh.startAutoRegister(30_000, (now) => {
      if (now.exposed) console.log(`[mesh] attached late — exposed as site "${now.label}" (${now.siteId})`)
      else console.log(`[mesh] no longer exposed — ${now.error ?? 'dropped from the node map'}; retrying`)
      journal.append(null, 'mesh/site', now)
    })
  })
}

server.once('listening', () => {
  const actualPort = (server.address() as { port?: number } | null)?.port ?? bootPort
  reportHubStartupPhase('listener ready', `port ${actualPort}`)
  if (!isGreen) {
    try {
      // Claim only after this process has actually won the public bind. A contender that loses with
      // EADDRINUSE never reaches this callback and therefore cannot terminalize the incumbent's questions.
      // The callback runs synchronously before Node dispatches an HTTP request on the new listener.
      questions.activatePublicOwner()
    } catch (error) {
      restartState.draining = true
      const message = error instanceof Error ? error.message : String(error)
      server.close()
      void reportPreflightFailure({
        code: 'question-owner-activation-failed',
        message: `The hub bound its public listener but could not claim question ownership: ${message}`,
        recovery: 'Check free disk space and journal write access, then restart AllMyAgents.',
      })
      return
    }
  }
  journal.append(null, 'hub/started', {
    port: actualPort,
    profiles: profiles.map((p) => ({ id: p.id, provider: p.provider })),
    restoredSessions: sessions.list().length,
  })
  console.log(
    `[hub] http://127.0.0.1:${actualPort} — profiles: ${profiles.map((p) => `${p.id}(${p.provider})`).join(', ') || 'none found'} — sessions restored: ${sessions.list().length} — profilesDir=${profilesDir} — dataDir=${dataDir}`
  )
  console.log(`[hub] device token ${requireToken ? 'REQUIRED for /api + /ws' : 'not enforced (local)'} — pair remote devices from Settings → Mesh`)
  // Tell the supervisor we're up (report the ACTUAL port so it health-checks green's ephemeral port).
  if (supervised) {
    if (preflightLivenessTimer) {
      clearInterval(preflightLivenessTimer)
      preflightLivenessTimer = undefined
    }
    sendSupervisorMessage({
      type: 'ready',
      attemptId: preflightAttemptId,
      port: actualPort,
      restored: sessions.list().length,
      schemaVersion: SCHEMA_VERSION,
    })
  }
  // Standalone owns its data root once listening. Under hubctl, both blue and green stay inactive here:
  // the parent grants one explicit cross-process owner only after health / handoff completes.
  if (!supervised) {
    restartState.journalBackupRequired = true
    journalBackups.activateStandalone()
  }
  // Blue / standalone own the port at boot → advertise now. Green defers mesh to promote.
  if (!isGreen) {
    scheduleDurableCapabilityUpgrade()
    scheduleWorkspaceHousekeeping()
    registerMesh()
    startJournalMaintenance()
    worktreeCollisions.start()
    workspacePressure.start()
    journalPressure.start()
  }
})

// Under supervision, wire the restart handshake: the hub asks hubctl to flip; hubctl drives
// drain/promote/retire back to us. onPromoted starts the services green deferred until it owns the port.
if (supervised && process.send) {
  const send = sendSupervisorMessage
  const controller = new RestartController({
    server,
    sessions,
    journal,
    questions,
    state: restartState,
    publicPort,
    send,
    onPromoted: () => {
      usage.startPolling()
      scheduleDurableCapabilityUpgrade()
      scheduleWorkspaceHousekeeping()
      registerMesh()
      startJournalMaintenance()
      worktreeCollisions.start()
      workspacePressure.start()
      journalPressure.start()
    },
    // The direct RPC method is process-local. Release it only once BLUE has actually surrendered the
    // public listener, so GREEN can register the stable method without two hub generations competing.
    onDrained: () => directMesh.stop(),
    stopJournalBackups: () => journalBackups.stop(),
    profileRuntime,
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
        void controller.drain().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[hub] drain failed before releasing the public listener: ${message}`)
          send({ type: 'drain-failed', error: message })
        })
        break
      case 'promote':
        controller.promote(msg.port, msg.profilePublicEpoch)
        break
      case 'retire':
        void controller.retire()
        break
      case 'restart-aborted':
        void controller
          .abort(msg.error, msg.profilePublicEpoch)
          .then(() => {
            // A drained BLUE that reclaims the public listener must reclaim its RPC method too.
            if (!restartState.draining && mesh.status().enabled) void directMesh.start()
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            restartState.rollbackRebinding = false
            restartState.draining = true
            restartState.journalBackupRequired = true
            restartState.journalBackup = {
              status: 'degraded',
              error: `rollback transition failed: ${message}`,
            }
            send({ type: 'rollback-failed', error: message })
          })
        break
      case 'journal-backup-control':
        void journalBackups
          .applyControl(msg)
          .then((result) => send(result))
          .catch((error: unknown) => {
            console.error(
              `[journal-backup] ownership response failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          })
        break
    }
  })
  let supervisorDisconnectHandled = false
  const handleSupervisorDisconnect = (): void => {
    if (supervisorDisconnectHandled) return
    supervisorDisconnectHandled = true
    void controller
      .resolveOrphanedListenerOwnership()
      .then((ownsPublicListener) => {
        if (!ownsPublicListener) {
          console.log(
            '[journal-backup] supervisor disconnected; this hub does not own the public listener and will stop'
          )
          shutdown('supervisor disconnect without public listener')
          return
        }
        const activation = journalBackups.activateStandalone()
        console.log(
          activation.ok
            ? '[journal-backup] supervisor disconnected; public listener retained backup ownership'
            : `[journal-backup] supervisor disconnected; public listener backup ownership is degraded and retrying: ${activation.error}`
        )
      })
      .catch((error: unknown) => {
        console.error(
          `[journal-backup] supervisor disconnect ownership resolution failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        shutdown('supervisor disconnect ownership failure')
      })
  }
  process.once('disconnect', handleSupervisorDisconnect)
  // A parent can disappear during module boot, before this listener is installed. The IPC state is the
  // durable observation; checking it after registration closes that missed-event window.
  if (!process.connected) handleSupervisorDisconnect()
}

// Best-effort: pull our site out of the node's exposed map on a clean exit so a stopped hub
// doesn't linger as a dead advert. The node replaces the whole map, so deregister re-reads first.
let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  stopJournalMaintenance()
  worktreeCollisions.stop()
  workspacePressure.stop()
  journalPressure.stop()
  const done = (): void => process.exit(0)
  // Cap the cleanup so a hung socket or child can't wedge shutdown.
  const guard = setTimeout(done, 2500)
  guard.unref?.()
  // Tear down the vendor children we spawned (codex app-server, in-flight claude queries) so a
  // standalone hub stop doesn't orphan them, and pull our mesh advert. Both are best-effort and
  // race the guard above; sessions.shutdown() dispatches the codex kills synchronously so they
  // land even if the guard fires first.
  mesh.stopAutoRegister()
  directMesh.stop()
  void Promise.allSettled([journalBackups.stop(), mesh.deregister(), sessions.shutdown()]).finally(() => {
    if (!supervised) profileOwnership.releaseAll()
    clearTimeout(guard)
    console.log(`[hub] ${signal} — stopped`)
    done()
  })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
