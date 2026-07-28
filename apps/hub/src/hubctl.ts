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
import path from 'node:path'
import crypto from 'node:crypto'
import { createConnection } from 'node:net'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  MAX_REVIVE_FAILURES,
  ReviveFailureGuard,
  revivePreflightIssue,
  supervisorRuntimeIssue,
} from './hubctlPolicy.js'
import { sendToHub, waitForHubMsg, healthCheck, type HubMsg } from './restartHandshake.js'
import { defaultWorkerSocket } from './workerTransport.js'

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
const workerEnabled = !!process.env.HUB_WORKER_SOCKET || process.env.HUB_WORKER === '1'
const workerSocket: string | undefined = workerEnabled ? defaultWorkerSocket(dataDir) : undefined

type HubColor = 'blue' | 'green'

interface HubHandle {
  child: ChildProcess
  color: HubColor
  port: number // 7777 for the live hub; the ephemeral port for a booting green (until it's promoted)
  restored: number // sessions restored, from the hub's `ready` message
  state: 'booting' | 'live' | 'draining' | 'retired'
}

/** The hub currently listening on 7777. */
let live: HubHandle | null = null
/** True while a blue-green flip is running — a re-entrant restart is ignored. */
let flipInFlight = false

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
const supervisorWorkingDirectory = process.cwd()

function log(msg: string): void {
  console.log(`[hubctl] ${msg}`)
}

function terminateSupervisor(reason: string): never {
  tearingDown = true
  log(`TERMINAL supervisor failure — ${reason}`)
  log('stopping instead of retrying forever; run `pnpm supervisors:status` to find other supervisors')
  for (const child of children) killTree(child)
  process.exit(1)
}

/**
 * How to launch a hub child. A built install runs the compiled JS on this same Node
 * (`process.execPath`); dev runs the TS entry under the tsx ESM loader — but IN THE SAME node process
 * (`node --import tsx/esm index.ts`), NEVER via `npx tsx` or the `tsx` binary. The IPC channel (the
 * 4th `ipc` stdio slot) is owned by the FIRST node in the chain, and Node strips `NODE_CHANNEL_FD`
 * before spawning grandchildren; any wrapper that re-spawns node would swallow the channel and the hub
 * would never get `process.send`, breaking the whole handshake. Dev is explicit (`HUBCTL_DEV=1`) or
 * follows a supervisor that is itself running from TypeScript. A missing production entry must NOT be
 * reinterpreted as dev mode: that is the deleted-worktree failure this supervisor must stop on.
 */
function hubLaunchCommand(): { cmd: string; args: string[] } {
  const dir = import.meta.dirname
  const prodEntry = path.join(dir, 'index.js')
  const devEntry = path.join(dir, 'index.ts')
  const dev = process.env.HUBCTL_DEV === '1' || import.meta.filename.endsWith('.ts')
  return dev
    ? { cmd: process.execPath, args: ['--import', 'tsx/esm', devEntry] }
    : { cmd: process.execPath, args: [prodEntry] }
}

function currentRuntimeIssue(): string | null {
  const command = hubLaunchCommand()
  const hubEntry = command.args.at(-1)
  if (!hubEntry) return 'hub launch command has no entry path'
  return supervisorRuntimeIssue({
    supervisorEntry: import.meta.filename,
    hubEntry,
    workingDirectory: supervisorWorkingDirectory,
  })
}

/**
 * Spawn a hub with the IPC handshake wired. `stdio: ['ignore','inherit','inherit','ipc']` keeps hub
 * stdout/stderr surfacing exactly as today while giving us `child.send()`/`child.on('message')`.
 * `HUB_PORT=0` asks the OS for an ephemeral port (green); the hub reports its ACTUAL port in `ready`.
 */
function spawnHub(port: number, color: HubColor): HubHandle {
  const { cmd, args } = hubLaunchCommand()
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
    env: { ...process.env, ...profileOwnerEnv, HUB_PORT: String(port), HUB_SUPERVISED: '1', ...(workerSocket ? { HUB_WORKER_SOCKET: workerSocket } : {}) },
  })
  const handle: HubHandle = { child, color, port, restored: 0, state: 'booting' }
  children.add(child)
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
    if (!tearingDown && !expected && live === handle && !flipInFlight) {
      live = null
      recordReviveFailure(`live hub exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
      void reviveLiveHub()
    }
  })
  return handle
}

/**
 * How to launch the agent worker — the same prod-JS/dev-TS resolution as {@link hubLaunchCommand}, but
 * resolving `agentWorker.js`/`agentWorker.ts` next to this file. Dev follows the running supervisor
 * itself; a deleted production entry is terminal rather than an implicit switch to TypeScript.
 */
function workerLaunchCommand(): { cmd: string; args: string[] } {
  const dir = import.meta.dirname
  const dev = process.env.HUBCTL_DEV === '1' || import.meta.filename.endsWith('.ts')
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
function spawnWorker(): void {
  if (!workerSocket) return
  const runtimeIssue = currentRuntimeIssue()
  if (runtimeIssue) terminateSupervisor(runtimeIssue)
  const { cmd, args } = workerLaunchCommand()
  // The worker relays browser calls back to the hub and never talks to the
  // desktop bridge itself. Do not let the bridge secret flow through the
  // worker into Claude/Codex subprocess environments.
  const workerEnv: NodeJS.ProcessEnv = { ...process.env, ...profileOwnerEnv, HUB_WORKER_SOCKET: workerSocket }
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
    log(`worker exited (code=${code ?? 'null'} signal=${signal ?? 'null'})${tearingDown ? '' : ' — recovery required'}`)
    if (!tearingDown && wasCurrent) {
      const issue = currentRuntimeIssue()
      if (issue) terminateSupervisor(issue)
      const cause = `agent worker exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`
      const state = workerFailures.record(cause)
      if (state.exhausted) {
        terminateSupervisor(
          `agent worker failed ${state.attempts} time(s); last cause repeated ${state.repeated} time(s): ${cause}`
        )
      }
      const wait = BACKOFF_MS[Math.min(state.attempts - 1, BACKOFF_MS.length - 1)] as number
      log(`agent worker recovery attempt ${state.attempts + 1}/${MAX_REVIVE_FAILURES} in ${wait}ms`)
      setTimeout(() => {
        if (!tearingDown && !workerHandle) spawnWorker()
      }, wait).unref?.()
    }
  })
  setTimeout(() => {
    if (workerHandle === child && child.exitCode === null && child.signalCode === null) {
      workerFailures.reset()
    }
  }, STABLE_MS).unref?.()
}

/**
 * Bring the live hub back after a crash, retrying only while recovery remains plausible.
 *
 * Backoff limits frequency; MAX_REVIVE_FAILURES limits lifetime. A supervisor whose checkout disappeared,
 * whose dead port is still held, or whose replacement fails repeatedly cannot repair itself and must exit
 * so stale code does not outlive every future fix.
 */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000]
const STABLE_MS = 60_000
const reviveFailures = new ReviveFailureGuard()
const workerFailures = new ReviveFailureGuard()
let reviveFailureAttempts = 0
let reviving = false

function recordReviveFailure(cause: string): void {
  const state = reviveFailures.record(cause)
  reviveFailureAttempts = state.attempts
  log(
    `recovery failure ${state.attempts}/${MAX_REVIVE_FAILURES}` +
      ` (same cause ${state.repeated} time(s)): ${cause}`
  )
  if (state.exhausted) {
    terminateSupervisor(
      `hub recovery failed ${state.attempts} time(s); last cause repeated ${state.repeated} time(s): ${cause}`
    )
  }
}

async function portIsListening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (occupied: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(occupied)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.unref()
  })
}

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

async function reviveLiveHub(): Promise<void> {
  if (reviving || tearingDown) return
  reviving = true
  try {
    while (reviveFailureAttempts < MAX_REVIVE_FAILURES) {
      if (tearingDown) return
      const preflightIssue = revivePreflightIssue(
        currentRuntimeIssue(),
        FIXED_PORT,
        await portIsListening(FIXED_PORT)
      )
      if (preflightIssue) terminateSupervisor(preflightIssue)
      const wait = BACKOFF_MS[Math.min(Math.max(0, reviveFailureAttempts - 1), BACKOFF_MS.length - 1)] as number
      log(`live hub is down — respawning in ${wait}ms (attempt ${reviveFailureAttempts + 1}/${MAX_REVIVE_FAILURES})`)
      await new Promise((r) => setTimeout(r, wait))
      if (tearingDown) return
      const delayedRuntimeIssue = currentRuntimeIssue()
      if (delayedRuntimeIssue) terminateSupervisor(delayedRuntimeIssue)
      let candidate: HubHandle | undefined
      try {
        candidate = spawnHub(FIXED_PORT, 'blue')
        const next = candidate
        const ready = await waitForHubMsg(next.child, 'ready', 20_000)
        next.port = ready.port
        next.restored = ready.restored
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
        const settled = next
        setTimeout(() => {
          if (live !== settled) return
          if (settled.child.exitCode !== null || settled.child.signalCode !== null) return
          void hubAnswersHealth(settled.port ?? FIXED_PORT).then((ok) => {
            if (live !== settled) return
            if (ok) {
              reviveFailures.reset()
              reviveFailureAttempts = 0
            } else {
              // Alive but not serving. Treat it as a failed attempt and go round again rather than
              // leaving the operator with a process that exists and a hub that does not.
              log('hub is running but not answering /api/health — treating as failed and respawning')
              killTree(settled.child)
            }
          })
        }, STABLE_MS).unref?.()
        return
      } catch (err) {
        // KILL THE CANDIDATE BEFORE TRYING AGAIN. A spawn that never reached `ready` is still a live
        // process holding the port, the SQLite lock and (in worker mode) a socket. Leaving it behind and
        // spawning another accumulates siblings that then make every later attempt fail for a *different*
        // reason than the original one — a self-inflicted crash loop layered on top of the real fault.
        if (candidate) killTree(candidate.child)
        recordReviveFailure(String(err))
      }
    }
    terminateSupervisor(`hub recovery exhausted ${MAX_REVIVE_FAILURES} attempts`)
  } finally {
    reviving = false
  }
}

/** Make `handle` the live hub and (re-)wire the `restart-request` listener onto it. */
function setLive(handle: HubHandle): void {
  if (live && restartListener) live.child.off('message', restartListener)
  live = handle
  handle.state = 'live'
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
  const blue = spawnHub(FIXED_PORT, 'blue')
  const ready = await waitForHubMsg(blue.child, 'ready', 20_000)
  blue.port = ready.port
  blue.restored = ready.restored
  setLive(blue)
  log(`hub (blue) live on :${blue.port} — ${blue.restored} session(s) restored (schema v${ready.schemaVersion})`)
}

/**
 * The blue-green flip. Boot green on an ephemeral port, health-check it against blue's shared `data/`,
 * then sequence the 7777 hand-off. Any failure BEFORE green owns 7777 is a clean rollback: kill green,
 * tell blue (which is untouched, or re-listens on the abort) it was aborted. Once green is promoted the
 * flip has committed — a later hiccup is cleanup noise, never a reason to tear the new live hub down.
 */
async function restart(reason: string): Promise<void> {
  if (flipInFlight) {
    log(`restart ignored (already flipping): ${reason}`)
    return
  }
  if (!live) {
    log(`restart ignored (no live hub): ${reason}`)
    return
  }
  flipInFlight = true
  const blue = live
  let promoted = false
  log(`restart requested (${reason}) — booting green on an ephemeral port`)
  const green = spawnHub(0, 'green')
  try {
    const ready = await waitForHubMsg(green.child, 'ready', 15_000)
    green.port = ready.port
    green.restored = ready.restored
    log(`green ready on :${green.port} — ${green.restored} session(s) restored; health-checking`)
    await healthCheck(green.port, { expectRestored: blue.restored })
    log('green health-check passed — flipping 7777')

    sendToHub(blue.child, { type: 'drain' }) // blue: 503 new sessions, close the 7777 listener, stay alive
    blue.state = 'draining'
    await waitForHubMsg(blue.child, 'released', 5_000)
    log('blue drained — 7777 released')

    sendToHub(green.child, { type: 'promote', port: FIXED_PORT }) // green: re-listen on 7777
    await waitForHubMsg(green.child, 'promoted', 8_000)
    promoted = true
    green.port = FIXED_PORT
    log(`green promoted — now live on :${FIXED_PORT}`)

    setLive(green) // swap + re-wire the restart-request listener onto green
    sendToHub(blue.child, { type: 'retire' }) // blue: finish in-flight, close WS, shut down, exit(0)
    blue.state = 'retired'
    reap(blue, 3_000) // ...or kill blue's tree if it doesn't exit in 3s
    log('blue retiring')
  } catch (err) {
    if (promoted) {
      // Green already owns 7777 (the flip committed) — a failure here is post-flip cleanup, NOT a
      // rollback trigger. Tearing green down now would leave 7777 dead; just surface it.
      log(`post-flip cleanup error (green is live): ${String(err)}`)
    } else {
      // ROLLBACK: green never took 7777 and blue is untouched (or re-listens on the abort). Kill the
      // green tree and tell blue it was aborted so it journals hub/restart-aborted for the operator.
      log(`restart aborted — rolling back to blue: ${String(err)}`)
      killTree(green.child)
      sendToHub(blue.child, { type: 'restart-aborted', error: String(err) })
    }
  } finally {
    flipInFlight = false
  }
}

/** On a shell signal, tear down every hub tree and exit. (The desktop shell also taskkills our tree.) */
function teardown(signal: NodeJS.Signals): void {
  tearingDown = true // stop the worker's exit handler from respawning it into a teardown
  log(`${signal} — tearing down hub(s) and exiting`)
  for (const child of children) killTree(child)
  process.exit(0)
}
process.on('SIGINT', () => teardown('SIGINT'))
process.on('SIGTERM', () => teardown('SIGTERM'))

// A loaded JavaScript module remains executable after its file or whole worktree is deleted. Check the
// invariant independently of hub crashes so even a still-serving orphan cannot live indefinitely on code
// that no longer exists and can never receive a fix.
setInterval(() => {
  if (tearingDown) return
  const issue = currentRuntimeIssue()
  if (issue) terminateSupervisor(issue)
}, 30_000).unref?.()

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
  // So: fall into the same bounded backoff loop. Transient failures get another chance; permanent
  // failures stop with a discoverable terminal diagnostic instead of leaving stale code alive forever.
  log(`hub failed its FIRST boot: ${String(err)}`)
  recordReviveFailure(String(err))
  void reviveLiveHub()
})
