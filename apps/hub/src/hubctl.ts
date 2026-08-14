/**
 * hubctl — the AllMyAgents supervisor (Phase 1 of `docs/agent-detachment-impl.md` §1.3–1.7).
 *
 * A tiny, near-immutable Node process that owns hub lifetime and performs a graceful **blue-green
 * restart**: it boots the live hub ("blue") on the fixed public port 7777, and on a restart request
 * spawns a successor ("green") on an OS-assigned ephemeral port, health-checks it against the SAME
 * `data/` it shares with blue, then sequences a fast hand-off of 7777 (drain blue → promote green →
 * retire blue). A green that fails to boot/health-check/promote is a pure rollback — blue never moves.
 *
 * It holds NO journal, NO sockets on the data path, NO agent state — only child handles + the flip
 * state machine. The desktop shell spawns hubctl (replacing the direct hub spawn); killing hubctl's
 * tree tears down its hubs, so there is no new teardown logic.
 *
 * The typed supervisor<->hub IPC contract + the `waitForHubMsg`/`healthCheck` helpers live in
 * `restartHandshake.ts` and are shared with the hub side (`index.ts`/`restartController.ts`).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  HUB_DRAIN_RELEASE_TIMEOUT_MS,
  MalformedPreflightRefusalError,
  PreflightRefusalError,
  ProfilePublicEpochSequence,
  SCHEMA_VERSION,
  profileGenerationEnvironment,
  requestRestartAbort,
  sendToHub,
  waitForHubReady,
  waitForHubMsg,
  healthCheck,
  type HubMsg,
  type ProfileGenerationAuthority,
} from './restartHandshake.js'
import { journalPreflightIdentity } from './preflight.js'
import { defaultWorkerSocket } from './workerTransport.js'
import { JournalBackupOwnershipProtocol } from './journalBackupOwnership.js'
import {
  abandonLiveForRevival,
  FlipRecoveryTracker,
  rollbackToBlue,
  waitForPortRelease,
} from './restartRollback.js'
import { bootstrapJournalRecoveryInWorker } from './journalRecovery.js'
import { writeOverseerSupervisorStatus, type OverseerSupervisorPhase } from './overseerSupervisor.js'
import { readJournalProgress } from './journalProgress.js'

/** The hard public singleton the web client hardcodes (`api.ts:145`). Blue owns it; green takes it on promote.
 *  HUB_FIXED_PORT overrides it for an isolated harness (e.g. the restart-survival acceptance test) so a
 *  second supervisor can run beside the live hub without fighting for 7777; unset → 7777 exactly as before. */
const FIXED_PORT = Number(process.env.HUB_FIXED_PORT ?? 7777)
const profileOwnerId = process.env.HUB_PROFILE_OWNER_ID ?? crypto.randomUUID()
const profileOwnerEnv = {
  HUB_PROFILE_OWNER_ID: profileOwnerId,
  HUB_PROFILE_OWNER_PID: String(process.pid),
  HUB_PROFILE_OWNER_PORT: String(FIXED_PORT),
}
const profilePublicEpochs = new ProfilePublicEpochSequence()

/**
 * Worker mode (docs/agent-worker-impl.md §5) is OPT-IN — the hard requirement is that flag-off is
 * byte-identical to today. It is enabled when the operator sets HUB_WORKER_SOCKET (an explicit socket
 * path) or HUB_WORKER=1 (use the platform default path) in hubctl's environment. When enabled, hubctl
 * spawns the agent worker as a sibling of the hub (before blue, outliving every flip) and injects
 * HUB_WORKER_SOCKET into every hub so blue AND green connect to the same worker — which lights index.ts's
 * Phase-2 flag. When DISABLED (neither set, the default), no worker is spawned and nothing is injected, so
 * every supervised hub runs the in-process executor exactly as before.
 */
// HUB_DATA_DIR relocates the shared data/ root (worker socket path here; journal/config in the hub). Unset →
// the repo's data/ exactly as before. Lets an isolated harness keep its worker socket + journal off the live one.
const dataDir = process.env.HUB_DATA_DIR
  ? path.resolve(process.env.HUB_DATA_DIR)
  : path.resolve(import.meta.dirname, '..', '..', '..', 'data')
const journalPath = path.join(dataDir, 'hub.db')
// Process-local only. A desktop/supervisor restart deliberately forgets the receipt and verifies again.
let preflightCacheIdentity: string | undefined
const workerEnabled = !!process.env.HUB_WORKER_SOCKET || process.env.HUB_WORKER === '1'
const workerSocket: string | undefined = workerEnabled ? defaultWorkerSocket(dataDir) : undefined
// Process-lifetime channel credential shared only with blue, green, and the worker. Each child captures
// and deletes it before it can launch a vendor process; a supervisor reboot rotates it automatically.
const workerSecret: string | undefined = workerEnabled ? crypto.randomBytes(32).toString('hex') : undefined

type HubColor = 'blue' | 'green'

interface HubHandle {
  child: ChildProcess
  color: HubColor
  port: number // 7777 for the live hub; the ephemeral port for a booting green (until it's promoted)
  restored: number // sessions restored, from the hub's `ready` message
  preflightAttemptId: string
  profileGenerationId: string
  profilePublicEpoch: number
  state: 'booting' | 'live' | 'draining' | 'promoted' | 'retired'
}

function nextActiveProfileAuthority(): ProfileGenerationAuthority {
  return {
    generationId: crypto.randomUUID(),
    publicEpoch: profilePublicEpochs.next(),
    active: true,
  }
}

function standbyProfileAuthority(current: HubHandle): ProfileGenerationAuthority {
  return {
    generationId: crypto.randomUUID(),
    publicEpoch: current.profilePublicEpoch,
    active: false,
  }
}

function waitForReady(handle: HubHandle) {
  return waitForHubReady(
    handle.child,
    handle.preflightAttemptId,
    undefined,
    (phase, elapsedMs) =>
      log(
        `hub(${handle.color}) preflight phase: ${phase}${
          phase === 'integrity-check' ? ' — integrity verification still running' : ''
        } elapsedMs=${elapsedMs}`
      )
  )
}

/** The hub currently listening on 7777. */
let live: HubHandle | null = null
/** True while a blue-green flip is running — a re-entrant restart is ignored. */
let flipInFlight = false
/** Defers an unexpected live-blue exit until the flip either adopts green or rolls back. */
const flipRecovery = new FlipRecoveryTracker()
/** Exactly one supervised hub may schedule journal backups against the shared data root. */
const journalBackupOwnership = new JournalBackupOwnershipProtocol()

/**
 * Every hub process we've spawned and not yet reaped. Lets a signal / fatal tear ALL of them down
 * (blue plus a mid-flip green) so we never orphan a node tree.
 */
const children = new Set<ChildProcess>()

/** The live hub's `restart-request` listener, tracked so we detach it when `live` changes. */
let restartListener: ((m: unknown) => void) | null = null

/** The current agent-worker child (worker mode only). Tracked so its exit handler can respawn it. */
let workerHandle: ChildProcess | null = null
/** Set while a signal/fatal teardown is killing the tree, so the worker's exit handler doesn't respawn. */
let tearingDown = false
/** Poison latch: while true no old hub/worker may be revived against a root under recovery review. */
let recoveryPoisoned = false
let recoveryInFlight: Promise<void> | undefined
let recoveryOfflineHold: ReturnType<typeof setInterval> | undefined

function log(msg: string): void {
  console.log(`[hubctl] ${msg}`)
}

function overseerStatus(
  phase: OverseerSupervisorPhase,
  detail: string,
  extra: { hubPid?: number; port?: number; attempt?: number; error?: string } = {},
): void {
  writeOverseerSupervisorStatus(dataDir, { phase, detail, ...extra })
}

function recoveryPolicyForFailure(
  error: unknown,
  child: ChildProcess
): RecoveryTriggerPolicy | 'ordinary' {
  if (error instanceof PreflightRefusalError) {
    if (error.refusal.code === 'question-owner-activation-failed') return 'ordinary'
    if (error.refusal.code === 'database-validation-unavailable') {
      // This refusal is not mutation authority. It only routes to the poison path where every
      // shared-root process is stopped and an isolated, stable family copy is classified once.
      return 'automatic'
    }
    if (
      error.refusal.code === 'database-lineage-invalid' &&
      error.refusal.recoveryCause === 'lineage-rollback'
    ) {
      // A crash may have published an authorized fallback while its exact active plan still needs
      // completion. The poison path may resume that plan; this refusal alone never authorizes bytes.
      return 'automatic'
    }
    return error.automaticRecoveryCause ? 'automatic' : 'offline-only'
  }
  if (child.exitCode === 78) return 'automatic'
  if (error instanceof MalformedPreflightRefusalError) {
    // The malformed frame is never authority to mutate. The "automatic" path first kills every
    // shared-root process, takes exclusive ownership, and independently classifies an isolated exact
    // family copy. Only that closed classifier can authorize sqlite-corruption/orphan-family recovery.
    return 'automatic'
  }
  return 'ordinary'
}

/**
 * How to launch a hub child. A built install runs the compiled JS on this same Node
 * (`process.execPath`); dev runs the TS entry under the tsx ESM loader — but IN THE SAME node process
 * (`node --import tsx/esm index.ts`), NEVER via `npx tsx` or the `tsx` binary. The IPC channel (the
 * 4th `ipc` stdio slot) is owned by the FIRST node in the chain, and Node strips `NODE_CHANNEL_FD`
 * before spawning grandchildren; any wrapper that re-spawns node would swallow the channel and the hub
 * would never get `process.send`, breaking the whole handshake. Dev is detected by the absence of a
 * built `dist/index.js` (no new dependency) or an explicit `HUBCTL_DEV=1`. Entries resolve relative to
 * this file, so `src/hubctl.ts` finds `src/index.ts` and `dist/hubctl.js` finds `dist/index.js`.
 */
function hubLaunchCommand(): { cmd: string; args: string[] } {
  const dir = import.meta.dirname
  const prodEntry = path.join(dir, 'index.js')
  const devEntry = path.join(dir, 'index.ts')
  const dev = process.env.HUBCTL_DEV === '1' || !fs.existsSync(prodEntry)
  return dev
    ? { cmd: process.execPath, args: ['--import', 'tsx/esm', devEntry] }
    : { cmd: process.execPath, args: [prodEntry] }
}

/**
 * Spawn a hub with the IPC handshake wired. `stdio: ['ignore','inherit','inherit','ipc']` keeps hub
 * stdout/stderr surfacing exactly as today while giving us `child.send()`/`child.on('message')`.
 * `HUB_PORT=0` asks the OS for an ephemeral port (green); the hub reports its ACTUAL port in `ready`.
 */
function spawnHub(
  port: number,
  color: HubColor,
  profileAuthority: ProfileGenerationAuthority,
): HubHandle {
  const { cmd, args } = hubLaunchCommand()
  const preflightAttemptId = crypto.randomUUID()
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // POSIX (macOS/Linux): run each hub as its OWN process-group leader so killTree can signal the
    // whole group — the hub AND every vendor descendant it spawned (codex app-server, MCP servers) —
    // in one shot. That is the direct analog of Windows `taskkill /T /F`, which POSIX has no
    // equivalent of otherwise. NOT set on win32, where `detached` would pop a new console window and
    // the PID-tree kill already covers descendants. `detached` is orthogonal to the `ipc` stdio slot,
    // so the blue-green restart handshake is unaffected.
    detached: process.platform !== 'win32',
    // Windows: never allocate a console window for a child. The desktop shell is a GUI app with no
    // console of its own, so each console child it launches — the hub, then this worker, then the
    // vendor CLIs beneath them — otherwise gets its own black window sitting in front of the app.
    // Inherited stdio still flows to whatever the supervisor was started with.
    windowsHide: true,
    // Worker mode (opt-in) injects HUB_WORKER_SOCKET so blue AND green connect to the same worker; when
    // disabled the spread adds nothing, so the env is byte-identical to today (docs/agent-worker-impl.md §5.1).
    env: {
      ...process.env,
      ...profileOwnerEnv,
      ...profileGenerationEnvironment(profileAuthority),
      HUB_PORT: String(port),
      HUB_SUPERVISED: '1',
      HUB_PREFLIGHT_ATTEMPT_ID: preflightAttemptId,
      ...(preflightCacheIdentity ? { HUB_PREFLIGHT_CACHE_ID: preflightCacheIdentity } : {}),
      ...(workerSocket && workerSecret
        ? { HUB_WORKER_SOCKET: workerSocket, HUB_WORKER_SECRET: workerSecret }
        : {}),
    },
  })
  const handle: HubHandle = {
    child,
    color,
    port,
    restored: 0,
    preflightAttemptId,
    profileGenerationId: profileAuthority.generationId,
    profilePublicEpoch: profileAuthority.publicEpoch,
    state: 'booting',
  }
  overseerStatus('booting', `Booting ${color} hub`, { hubPid: child.pid, port })
  children.add(child)
  child.on('message', (raw: unknown) => {
    const message = raw as Partial<HubMsg>
    if (
      message.type !== 'preflight-cacheable' ||
      message.attemptId !== preflightAttemptId ||
      typeof message.identity !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(message.identity)
    ) return
    const current = journalPreflightIdentity(dataDir, journalPath)
    if (current === message.identity) preflightCacheIdentity = current
  })
  child.on('error', (err) => log(`hub(${color}) failed to spawn: ${String(err)}`))
  child.on('exit', (code, signal) => {
    children.delete(child)
    const expected = handle.state === 'retired'
    log(`hub(${color}) exited (code=${code ?? 'null'} signal=${signal ?? 'null'})${expected ? '' : ' — UNEXPECTED'}`)
    // The LIVE hub died on its own (a crash, not a planned retire) with no flip running: nothing is on
    // 7777. RECOVER IT.
    //
    // This used to `process.exit(1)`, on the reasoning that "hubctl can't recover it — exit so the
    // desktop shell's probe surfaces the failure". The desktop shell has no such probe: it checks the
    // port once, before spawning, and never again. So the handoff was to nobody. In practice the app sat
    // there with no hub, no error and no recovery, and the operator saw a window that had simply stopped
    // working — twice in one day, once from a crash loop that no amount of relaunching could clear.
    //
    // A supervisor that exits when its child dies is not supervising. Respawn with backoff instead, the
    // same shape the agent worker above already uses.
    if (!expected && live === handle) {
      clearLiveHandle(handle)
      if (!recoveryPoisoned) {
        const recovery = flipRecovery.noteUnexpectedLiveExit(flipInFlight)
        if (recovery === 'revive-now') void reviveLiveHub()
      }
    }
  })
  return handle
}

/**
 * How to launch the agent worker — the same prod-JS/dev-TS resolution as {@link hubLaunchCommand}, but
 * resolving `agentWorker.js`/`agentWorker.ts` next to this file. Dev is the absence of a built
 * `dist/index.js` (the identical signal hubLaunchCommand uses) or an explicit HUBCTL_DEV=1.
 */
function workerLaunchCommand(): { cmd: string; args: string[] } {
  const dir = import.meta.dirname
  const dev = process.env.HUBCTL_DEV === '1' || !fs.existsSync(path.join(dir, 'index.js'))
  return dev
    ? { cmd: process.execPath, args: ['--import', 'tsx/esm', path.join(dir, 'agentWorker.ts')] }
    : { cmd: process.execPath, args: [path.join(dir, 'agentWorker.js')] }
}

/**
 * Spawn the agent worker as a supervised sibling of the hub (docs/agent-worker-impl.md §5.1). Same stdio
 * shape as spawnHub (the IPC slot is unused for now — §5.2's worker-unreachable signal is out of the first
 * cut). The worker is meant to be ALWAYS-UP: on an unexpected exit (not a hubctl teardown) respawn it, and
 * the hubs' auto-reconnecting WorkerClients re-attach; a turn that was live is lost (degrades to Phase-1
 * semantics — re-attach across a WORKER restart is out of scope here). Only called in worker mode, so
 * `workerSocket` is defined (guarded regardless).
 */
function spawnWorker(): ChildProcess | undefined {
  if (!workerSocket) return undefined
  const { cmd, args } = workerLaunchCommand()
  // The worker relays browser calls back to the hub and never talks to the
  // desktop bridge itself. Do not let the bridge secret flow through the
  // worker into Claude/Codex subprocess environments.
  const workerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...profileOwnerEnv,
    HUB_WORKER_SOCKET: workerSocket,
    HUB_WORKER_SECRET: workerSecret,
  }
  delete workerEnv.AMA_DESKTOP_BROWSER_SECRET
  delete workerEnv.AMA_DESKTOP_BROWSER_ADDR
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // Same POSIX process-group reasoning as spawnHub: the worker owns the agent SDK subprocesses, so
    // it must be group-killable as a unit on teardown. No-op on win32 (taskkill /T handles the tree).
    detached: process.platform !== 'win32',
    // Windows: never allocate a console window for a child. The desktop shell is a GUI app with no
    // console of its own, so each console child it launches — the hub, then this worker, then the
    // vendor CLIs beneath them — otherwise gets its own black window sitting in front of the app.
    // Inherited stdio still flows to whatever the supervisor was started with.
    windowsHide: true,
    env: workerEnv,
  })
  workerHandle = child
  children.add(child)
  child.on('error', (err) => log(`worker failed to spawn: ${String(err)}`))
  child.on('exit', (code, signal) => {
    children.delete(child)
    const wasCurrent = workerHandle === child
    if (wasCurrent) workerHandle = null
    const shouldRespawn = !tearingDown && !recoveryPoisoned
    log(
      `worker exited (code=${code ?? 'null'} signal=${signal ?? 'null'})${
        shouldRespawn ? ' — respawning' : ''
      }`
    )
    if (shouldRespawn && wasCurrent) spawnWorker()
  })
  return child
}

/**
 * Bring the live hub back after a crash, retrying until it sticks.
 *
 * Backoff is capped rather than unbounded, and it NEVER gives up. Those are deliberate and they trade
 * against each other:
 *   - Giving up is what produced today's outage. A hub that is unreachable forever, with the app still
 *     open, is the worst possible end state — the operator cannot tell a crash from a hang from a bug,
 *     and relaunching does not help because the supervisor is already gone.
 *   - Retrying hot is the other failure: a hub that dies instantly on boot (a corrupt journal row, a bad
 *     migration) would spin the CPU and flood the log. Hence the cap.
 * A crash-looping hub therefore settles into a slow, quiet retry that recovers by itself the moment the
 * underlying problem is fixed — including a fix applied by an agent, which is the point of this app.
 *
 * `consecutiveFailures` resets once a hub has stayed up for STABLE_MS, so an unrelated crash weeks later
 * starts from a fast retry rather than inheriting an old penalty.
 */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000]
const STABLE_MS = 60_000
const HEALTH_NO_PROGRESS_MS = 90_000
const HEALTH_RECHECK_MS = 5_000
let consecutiveFailures = 0
let reviving = false

/**
 * Does a hub on this port actually SERVE, as opposed to merely exist?
 *
 * The stable-window check used to accept "the process object is still the one I spawned", which a wedged
 * hub satisfies perfectly — and a wedged hub is indistinguishable from a healthy one to an operator
 * staring at a window that will not load. Asking it a question is the only honest test.
 *
 * Deliberately tolerant: any answer at all from /api/health counts. This is a liveness probe, not a
 * correctness one, and being strict about the body would turn a schema change into a spurious respawn.
 */
async function hubAnswersHealth(port: number, timeoutMs = 3_000): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal })
      return res.ok
    } finally {
      clearTimeout(t)
    }
  } catch {
    return false
  }
}

/**
 * A missed HTTP timeout proves only that the event loop did not answer quickly. SQLite integrity checks
 * and lineage hashing are synchronous native work. Observe a bounded no-progress window, and never kill
 * while this exact hub instance reports that it is inside the crash-sensitive lineage boundary. A dead
 * child is still handled immediately by its exit listener.
 */
function observeRevivedHubStability(settled: HubHandle): void {
  let healthFailureStartedAt: number | undefined
  let lastProgressAt = Date.now()
  let lastProgressSignature = ''
  let loggedProtection = false

  const schedule = (delayMs: number): void => {
    const timer = setTimeout(() => void observe(), delayMs)
    timer.unref?.()
  }
  const observe = async (): Promise<void> => {
    if (live !== settled) return
    if (settled.child.exitCode !== null || settled.child.signalCode !== null) return
    if (await hubAnswersHealth(settled.port ?? FIXED_PORT)) {
      consecutiveFailures = 0
      return
    }

    const now = Date.now()
    // The no-progress clock starts when health first becomes unavailable, not when the worker was
    // spawned. Otherwise the initial STABLE_MS delay silently consumes most of the promised observation
    // window and a first missed probe can still kill a merely busy hub after only ~30 seconds.
    if (healthFailureStartedAt === undefined) {
      healthFailureStartedAt = now
      lastProgressAt = now
    }
    const pid = settled.child.pid
    const progress = pid === undefined
      ? undefined
      : readJournalProgress(dataDir, pid, settled.preflightAttemptId)
    if (progress) {
      const signature = [
        progress.operationId,
        progress.sequence,
        progress.phase,
        progress.rowsCompleted,
        progress.bytesCompleted,
        progress.active,
      ].join(':')
      if (signature !== lastProgressSignature) {
        lastProgressSignature = signature
        lastProgressAt = now
      }
      if (progress.active && progress.suspendWatchdog) {
        if (!loggedProtection) {
          loggedProtection = true
          log(
            `hub health is temporarily unresponsive during protected journal phase ${progress.phase}; ` +
              'watchdog termination is suspended until that crash-sensitive boundary exits'
          )
        }
        schedule(HEALTH_RECHECK_MS)
        return
      }
    }

    if (now - lastProgressAt < HEALTH_NO_PROGRESS_MS) {
      if (!loggedProtection) {
        loggedProtection = true
        log(
          `hub did not answer /api/health; observing for ${HEALTH_NO_PROGRESS_MS}ms of no progress before respawn`
        )
      }
      schedule(HEALTH_RECHECK_MS)
      return
    }
    log(
      `hub made no observable progress for ${now - Math.max(lastProgressAt, healthFailureStartedAt)}ms ` +
        'while /api/health was unavailable — treating as failed and respawning'
    )
    killTree(settled.child)
  }
  schedule(STABLE_MS)
}

async function reviveLiveHub(): Promise<void> {
  if (reviving || tearingDown || recoveryPoisoned) return
  reviving = true
  try {
    for (;;) {
      if (tearingDown) return
      const wait = BACKOFF_MS[Math.min(consecutiveFailures, BACKOFF_MS.length - 1)] as number
      consecutiveFailures++
      overseerStatus('retrying', `Live hub is down; retrying in ${wait}ms`, { attempt: consecutiveFailures })
      log(`live hub is down — respawning in ${wait}ms (attempt ${consecutiveFailures})`)
      await new Promise((r) => setTimeout(r, wait))
      if (tearingDown) return
      let candidate: HubHandle | undefined
      try {
        candidate = spawnHub(FIXED_PORT, 'blue', nextActiveProfileAuthority())
        const next = candidate
        const ready = await waitForReady(next)
        next.port = ready.port
        next.restored = ready.restored
        await healthCheck(next.port, { expectRestored: next.restored })
        await journalBackupOwnership.activateInitialBlueAfterHealth(next.child)
        setLive(next)
        candidate = undefined // adopted; the failure path below must not kill it
        log(`hub recovered on :${next.port} — ${next.restored} session(s) restored`)
        // Only declare success once it has SURVIVED a while. A hub that boots, reports ready, and dies a
        // second later is still a crash loop, and treating that as recovery would reset the backoff every
        // time and turn the cap into a hot loop.
        //
        // SURVIVED means "still answering", not "still a process". This used to compare object identity
        // only, so a hub that was alive but wedged — an event loop blocked, a native addon spinning —
        // counted as recovered and reset the backoff. A supervisor that accepts a process it cannot talk
        // to is measuring the wrong thing, which is the same mistake as exiting when the child dies.
        observeRevivedHubStability(next)
        return
      } catch (err) {
        // KILL THE CANDIDATE BEFORE TRYING AGAIN. A spawn that never reached `ready` is still a live
        // process holding the port, the SQLite lock and (in worker mode) a socket. Leaving it behind and
        // spawning another accumulates siblings that then make every later attempt fail for a *different*
        // reason than the original one — a self-inflicted crash loop layered on top of the real fault.
        if (candidate) killTree(candidate.child)
        if (candidate) {
          const policy = recoveryPolicyForFailure(err, candidate.child)
          if (policy !== 'ordinary') {
            await enterRecoveryPoison(`revived blue preflight: ${String(err)}`, [candidate], policy)
            return
          }
        }
        log(`respawn attempt ${consecutiveFailures} failed: ${String(err)}`)
        overseerStatus('retrying', 'Hub respawn attempt failed', {
          attempt: consecutiveFailures,
          error: String(err),
        })
        // loop and try again after a longer wait
      }
    }
  } finally {
    reviving = false
  }
}

/** Make `handle` the live hub and (re-)wire the `restart-request` listener onto it. */
function setLive(handle: HubHandle): void {
  if (live && restartListener) live.child.off('message', restartListener)
  live = handle
  handle.state = 'live'
  overseerStatus('live', `Hub is live with ${handle.restored} restored session(s)`, {
    hubPid: handle.child.pid,
    port: handle.port,
  })
  flipRecovery.adoptLiveReplacement()
  const listener = (m: unknown): void => {
    const msg = m as HubMsg
    if (msg && typeof msg === 'object' && msg.type === 'restart-request') {
      log(`live hub asked to restart: ${msg.reason}`)
      void restart(msg.reason)
    }
  }
  restartListener = listener
  handle.child.on('message', listener)
}

function clearLiveHandle(handle: HubHandle): void {
  if (live !== handle) return
  if (restartListener) handle.child.off('message', restartListener)
  restartListener = null
  live = null
  overseerStatus('retrying', 'The live hub exited; supervisor recovery is active', { hubPid: handle.child.pid })
}

/** Hard-kill a child and its whole process tree. Best-effort — never throws out of a teardown path. */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // Windows has no kill-on-parent-death, so killing just the parent orphans the tree (codex
    // app-server grandchildren, in-flight node). `taskkill /T /F` terminates the whole PID tree — the
    // same approach as the codex adapter (`sessions.ts`/`adapters/codex.ts`) and the desktop shell.
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      try {
        child.kill()
      } catch {
        /* best-effort */
      }
    }
  } else {
    // POSIX (macOS/Linux): the child was spawned `detached`, so it LEADS a process group whose id
    // equals its pid. Signalling a NEGATIVE pid targets that whole group, so the hub/worker and every
    // descendant that inherited the group (codex app-server, MCP servers, in-flight node) die
    // together — the POSIX equivalent of `taskkill /T /F`. Fall back to a plain kill if the group
    // send fails (ESRCH, or a child that somehow never became a leader).
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* best-effort */
      }
    }
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`hub process did not exit within ${timeoutMs}ms after kill`))
    }, timeoutMs)
    const onExit = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
    }
    child.once('exit', onExit)
  })
}

function childIsRunning(child: ChildProcess | null): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null
}

type RecoveryTriggerPolicy = 'automatic' | 'offline-only'

function enterRecoveryPoison(
  reason: string,
  implicated: HubHandle[],
  policy: RecoveryTriggerPolicy
): Promise<void> {
  if (recoveryInFlight) return recoveryInFlight
  recoveryPoisoned = true
  overseerStatus('recovering', 'Journal recovery boundary is active', { error: reason })
  recoveryOfflineHold ??= setInterval(() => {
    // Intentionally ref'ed: an offline poisoned supervisor must remain present so the desktop cannot
    // relaunch a second supervisor against an unresolved root. Recovery is operator-visible in logs;
    // there is deliberately no hot retry or repeated byte mutation.
  }, 60_000)
  const operationId = crypto.randomUUID()
  const task = (async () => {
    log(`journal recovery poison latched (${reason}); operation=${operationId}`)
    for (const handle of implicated) handle.state = 'retired'
    if (live) clearLiveHandle(live)
    const victims = [...children]
    for (const child of victims) killTree(child)
    await Promise.all(victims.map((child) => waitForChildExit(child, 10_000)))
    if (workerHandle && (workerHandle.exitCode === null && workerHandle.signalCode === null)) {
      throw new Error('old worker generation did not exit')
    }
    workerHandle = null
    await waitForPortRelease(FIXED_PORT, 10_000)
    if (policy !== 'automatic') {
      overseerStatus('offline', 'Journal preflight refused automatic recovery; root remains offline', { error: reason })
      throw new Error('preflight refusal is not eligible for automatic recovery; root remains offline')
    }

    const recoveryAttemptId = crypto.randomUUID()
    const recovery = await bootstrapJournalRecoveryInWorker({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
      operationId,
      attemptId: recoveryAttemptId,
      onLiveness: (elapsedMs) =>
        log(
          `independent journal recovery still running; operation=${operationId}; attempt=${recoveryAttemptId}; elapsedMs=${elapsedMs}`
        ),
    })
    if (!recovery.preflight.ok) {
      throw new Error(
        `independent recovery classifier refused [${recovery.preflight.failure.code}]: ${recovery.preflight.failure.message}`
      )
    }
    if (!recovery.recovery) {
      log(
        'independent copied-family classifier found no recoverable corruption; attempting one fresh normal boot'
      )
    } else {
      log(
        `recovery operation ${recovery.recovery.planId} restored generation ${recovery.recovery.generation}; quarantine=${recovery.recovery.quarantineDir}`
      )
    }

    let freshWorker: ChildProcess | null = null
    let freshBlue: HubHandle | undefined
    try {
      if (workerSocket) {
        freshWorker = spawnWorker() ?? null
        if (
          !freshWorker ||
          freshWorker.exitCode !== null ||
          freshWorker.signalCode !== null
        ) {
          throw new Error('fresh worker generation did not remain alive for recovery reboot')
        }
      }
      freshBlue = spawnHub(FIXED_PORT, 'blue', nextActiveProfileAuthority())
      const ready = await waitForReady(freshBlue)
      freshBlue.port = ready.port
      freshBlue.restored = ready.restored
      await healthCheck(freshBlue.port, { expectRestored: freshBlue.restored })
      await journalBackupOwnership.activateInitialBlueAfterHealth(freshBlue.child)
      if (
        workerSocket &&
        (!freshWorker ||
          workerHandle !== freshWorker ||
          !childIsRunning(freshWorker))
      ) {
        throw new Error('fresh worker generation died before recovery reboot committed')
      }
      setLive(freshBlue)
      // This synchronous handoff is the generation fence. Once poison clears, an exit callback for
      // the verified fresh worker is permitted to respawn it. There is no await between the final
      // generation check, publishing the live hub, and clearing the latch, so an exit cannot be
      // observed in the old "suppressed forever" policy window.
      recoveryPoisoned = false
      if (workerSocket && !childIsRunning(workerHandle)) {
        freshWorker = spawnWorker() ?? null
        if (!childIsRunning(freshWorker)) {
          recoveryPoisoned = true
          clearLiveHandle(freshBlue)
          throw new Error('fresh worker generation could not be committed after recovery')
        }
      }
      if (recoveryOfflineHold) {
        clearInterval(recoveryOfflineHold)
        recoveryOfflineHold = undefined
      }
      recoveryInFlight = undefined
      log(`recovery reboot committed on :${freshBlue.port}; operation=${operationId}`)
    } catch (error) {
      if (freshBlue) {
        freshBlue.state = 'retired'
        killTree(freshBlue.child)
        await waitForChildExit(freshBlue.child, 10_000).catch(() => {})
      }
      if (freshWorker) {
        killTree(freshWorker)
        await waitForChildExit(freshWorker, 10_000).catch(() => {})
      }
      throw error
    }
  })().catch((error: unknown) => {
    log(
      `journal recovery remains visibly OFFLINE; operation=${operationId}; ${error instanceof Error ? error.message : String(error)}`
    )
    overseerStatus('offline', 'Journal recovery did not produce a bootable hub', { error: String(error) })
  })
  recoveryInFlight = task
  return task
}

/** Ask a hub to retire, then hard-kill its tree if it hasn't exited within `graceMs`. Non-blocking. */
function reap(handle: HubHandle, graceMs: number): void {
  const child = handle.child
  if (child.exitCode !== null || child.signalCode !== null) return // already gone
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    log(`hub(${handle.color}) did not exit in ${graceMs}ms — killing its tree`)
    killTree(child)
  }, graceMs)
  timer.unref?.()
  child.once('exit', () => clearTimeout(timer))
}

/** Boot the first hub (blue) on the fixed port and wait for it to become ready. */
async function boot(): Promise<void> {
  // Worker mode (opt-in): the worker is a sibling born BEFORE blue so blue can connect on its first turn.
  // No health-check gate — a hub with no worker yet simply retries its connect loop (§5.1).
  if (workerSocket) {
    log(`spawning agent worker (socket ${workerSocket})`)
    spawnWorker()
  }
  log(`booting hub (blue) on :${FIXED_PORT}`)
  const blue = spawnHub(FIXED_PORT, 'blue', nextActiveProfileAuthority())
  try {
    const ready = await waitForReady(blue)
    blue.port = ready.port
    blue.restored = ready.restored
    await healthCheck(blue.port, { expectRestored: blue.restored })
    await journalBackupOwnership.activateInitialBlueAfterHealth(blue.child)
    setLive(blue)
    log(`hub (blue) live on :${blue.port} — ${blue.restored} session(s) restored (schema v${ready.schemaVersion})`)
  } catch (error) {
    const recoveryPolicy = recoveryPolicyForFailure(error, blue.child)
    // Activation may have applied even if its acknowledgement was lost. Kill this provisional owner
    // before the retry loop can consider another process for the shared backup directory.
    killTree(blue.child)
    if (recoveryPolicy !== 'ordinary') {
      await enterRecoveryPoison(
        `initial blue preflight: ${String(error)}`,
        [blue],
        recoveryPolicy
      )
      return
    }
    throw error
  }
}

/**
 * The blue-green flip. Boot green on an ephemeral port, health-check it against blue's shared `data/`,
 * then sequence the 7777 hand-off. Before backup ownership commits, rollback kills green and, if it had
 * already bound 7777, confirms both process death and port release before blue may re-listen. Once green
 * has both the listener and backup ownership the flip has committed; later cleanup errors never roll back.
 */
async function restart(reason: string): Promise<void> {
  if (recoveryPoisoned) {
    log(`restart ignored while journal recovery is latched offline: ${reason}`)
    return
  }
  if (flipInFlight) {
    log(`restart ignored (already flipping): ${reason}`)
    return
  }
  if (!live) {
    log(`restart ignored (no live hub): ${reason}`)
    return
  }
  flipInFlight = true
  overseerStatus('restarting', 'Blue-green restart requested', {
    hubPid: live.child.pid,
    port: live.port,
  })
  const blue = live
  let committed = false
  let greenMayOwnPublicListener = false
  log(`restart requested (${reason}) — booting green on an ephemeral port`)
  const green = spawnHub(0, 'green', standbyProfileAuthority(blue))
  try {
    const ready = await waitForReady(green)
    green.port = ready.port
    green.restored = ready.restored
    log(`green ready on :${green.port} — ${green.restored} session(s) restored; health-checking`)
    await healthCheck(green.port, { expectRestored: blue.restored })
    log(`green health-check passed — flipping ${FIXED_PORT}`)

    await journalBackupOwnership.pauseBlueBeforeDrain(blue.child)
    log('blue journal backups paused — current generation settled')
    sendToHub(blue.child, { type: 'drain' }) // blue: 503 new sessions, close the 7777 listener, stay alive
    blue.state = 'draining'
    const released = await waitForHubMsg(
      blue.child,
      'released',
      HUB_DRAIN_RELEASE_TIMEOUT_MS
    )
    log(
      `blue drained — ${FIXED_PORT} released (question turns settled=${released.questionTurns.settled}, outcome-unknown=${released.questionTurns.outcomeUnknown}; login attempts settled=${released.loginAttempts.settled}, outcome-unknown=${released.loginAttempts.outcomeUnknown})`
    )

    // From this point the public bind is ambiguous until green exits: it can bind successfully and lose
    // its `promoted` IPC acknowledgement. Fence rollback BEFORE sending the command so an ACK timeout
    // still waits for confirmed green death and an explicit port-release probe before blue can rebind.
    greenMayOwnPublicListener = true
    const promotionEpoch = profilePublicEpochs.next()
    sendToHub(green.child, {
      type: 'promote',
      port: FIXED_PORT,
      profilePublicEpoch: promotionEpoch,
    }) // green: re-listen on 7777
    const promoted = await waitForHubMsg(green.child, 'promoted', 8_000)
    if (promoted.profilePublicEpoch !== promotionEpoch) {
      throw new Error(
        `green acknowledged profile epoch ${promoted.profilePublicEpoch}, expected ${promotionEpoch}`,
      )
    }
    green.port = FIXED_PORT
    green.profilePublicEpoch = promotionEpoch
    green.state = 'promoted'
    log(`green promoted on :${FIXED_PORT} — acquiring journal backup ownership`)

    // Promotion binds the public listener; ownership acknowledgement is the final commit gate. If it
    // fails, green can still be killed and blue resumed/re-listened without two backup writers.
    await journalBackupOwnership.activatePromotedGreen(green.child)
    committed = true
    setLive(green) // swap + re-wire the restart-request listener onto green
    log(`green live on :${FIXED_PORT} with journal backup ownership`)
    sendToHub(blue.child, { type: 'retire' }) // blue: finish in-flight, close WS, shut down, exit(0)
    blue.state = 'retired'
    reap(blue, 3_000) // ...or kill blue's tree if it doesn't exit in 3s
    log('blue retiring')
  } catch (err) {
    const recoveryPolicy = recoveryPolicyForFailure(err, green.child)
    if (!committed && recoveryPolicy !== 'ordinary') {
      await enterRecoveryPoison(
        `green preflight during restart: ${String(err)}`,
        [blue, green],
        recoveryPolicy
      )
      return
    }
    if (committed) {
      // Green already owns 7777 (the flip committed) — a failure here is post-flip cleanup, NOT a
      // rollback trigger. Tearing green down now would leave 7777 dead; just surface it.
      log(`post-flip cleanup error (green is live): ${String(err)}`)
    } else {
      log(`restart aborted — rolling back to blue: ${String(err)}`)
      try {
        let rollbackEpoch: number | undefined
        await rollbackToBlue({
          blue: blue.child,
          green: green.child,
          publicPort: FIXED_PORT,
          reason: String(err),
          greenMayOwnPublicListener,
          killGreen: (child) => {
            green.state = 'retired'
            killTree(child)
          },
          waitForGreenExit: waitForChildExit,
          requestBlueRebind: (child, rollbackReason, timeoutMs) => {
            rollbackEpoch = profilePublicEpochs.next()
            return requestRestartAbort(child, rollbackReason, timeoutMs, rollbackEpoch)
          },
          resumeBlue: () => journalBackupOwnership.resumeBlueAfterRollback(blue.child),
          onResumeFailure: (resumeError, nextDelayMs) => {
            log(
              nextDelayMs === undefined
                ? `blue journal backup resume exhausted retries: ${String(resumeError)}`
                : `blue journal backup resume failed: ${String(resumeError)}; retrying in ${nextDelayMs}ms`
            )
          },
        })
        if (rollbackEpoch === undefined) {
          throw new Error('blue rollback completed without a profile public epoch')
        }
        blue.profilePublicEpoch = rollbackEpoch
        log('blue journal backups resumed after rollback')
      } catch (rollbackError) {
        await abandonLiveForRevival({
          child: blue.child,
          reason: String(rollbackError),
          clearLive: () => clearLiveHandle(blue),
          markRetired: () => {
            blue.state = 'retired'
          },
          requestDeferredRecovery: () => flipRecovery.requestDeferredRecovery(),
          kill: killTree,
          waitForExit: waitForChildExit,
          log,
        })
      }
    }
  } finally {
    flipInFlight = false
    if (!recoveryPoisoned && flipRecovery.finishFlip(live !== null)) void reviveLiveHub()
  }
}

/** On a shell signal, tear down every hub tree and exit. (The desktop shell also taskkills our tree.) */
function teardown(signal: NodeJS.Signals): void {
  tearingDown = true // stop the worker's exit handler from respawning it into a teardown
  if (recoveryOfflineHold) {
    clearInterval(recoveryOfflineHold)
    recoveryOfflineHold = undefined
  }
  log(`${signal} — tearing down hub(s) and exiting`)
  overseerStatus('stopping', `Supervisor stopping after ${signal}`)
  for (const child of children) killTree(child)
  process.exit(0)
}
process.on('SIGINT', () => teardown('SIGINT'))
process.on('SIGTERM', () => teardown('SIGTERM'))

overseerStatus('starting', 'Supervisor starting')
log(`supervisor starting (pid ${process.pid})`)
boot().catch((err) => {
  // A FIRST boot that fails must NOT end the supervisor — this was the brick.
  //
  // reviveLiveHub() only runs when a hub that already reached `live` dies. On the very first boot a
  // pre-ready failure landed here, tore the whole tree down and exited, so the shipped promise of
  // "respawn with backoff, never give up" was false for precisely the case it was written for: a hub
  // that cannot start. Killing a healthy hub recovered every time in testing; a hub that could not reach
  // ready was never tested, and that is the one the operator actually hit.
  //
  // The distinction that matters is transient vs deterministic. Retrying is right for both — a
  // deterministic fault (a corrupt DB, a half-installed dependency, a port held by something else)
  // usually needs a human or an agent to change something on disk, and the supervisor's job is to be
  // alive and trying when that happens, so the fix takes effect without the operator knowing to relaunch
  // anything. Exiting guarantees the opposite: nothing is running to notice the repair.
  //
  // So: fall into the same capped-backoff loop, which never gives up, and say plainly what is happening.
  // The retry is cheap and the cap means a permanently broken install settles into one quiet attempt
  // every 30s rather than a hot loop.
  log(`hub failed its FIRST boot: ${String(err)}`)
  overseerStatus('retrying', 'Hub failed its first boot; supervisor will keep retrying', { error: String(err) })
  log('supervisor staying up and retrying — fix the cause and it will come back on its own')
  void reviveLiveHub()
})
