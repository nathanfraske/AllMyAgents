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
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { sendToHub, waitForHubMsg, healthCheck, type HubMsg } from './restartHandshake.js'
import { defaultWorkerSocket } from './workerTransport.js'

/** The hard public singleton the web client hardcodes (`api.ts:145`). Blue owns it; green takes it on promote.
 *  HUB_FIXED_PORT overrides it for an isolated harness (e.g. the restart-survival acceptance test) so a
 *  second supervisor can run beside the live hub without fighting for 7777; unset → 7777 exactly as before. */
const FIXED_PORT = Number(process.env.HUB_FIXED_PORT ?? 7777)

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

function log(msg: string): void {
  console.log(`[hubctl] ${msg}`)
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
    env: { ...process.env, HUB_PORT: String(port), HUB_SUPERVISED: '1', ...(workerSocket ? { HUB_WORKER_SOCKET: workerSocket } : {}) },
  })
  const handle: HubHandle = { child, color, port, restored: 0, state: 'booting' }
  children.add(child)
  child.on('error', (err) => log(`hub(${color}) failed to spawn: ${String(err)}`))
  child.on('exit', (code, signal) => {
    children.delete(child)
    const expected = handle.state === 'retired'
    log(`hub(${color}) exited (code=${code ?? 'null'} signal=${signal ?? 'null'})${expected ? '' : ' — UNEXPECTED'}`)
    // If the LIVE hub dies on its own (a crash, not a planned retire) and no flip is running, nothing
    // is on 7777 and hubctl can't recover it — exit so the desktop shell's probe surfaces the failure.
    if (!expected && live === handle && !flipInFlight) {
      log('live hub died with no flip in progress — exiting supervisor')
      process.exit(1)
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
function spawnWorker(): void {
  if (!workerSocket) return
  const { cmd, args } = workerLaunchCommand()
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
    env: { ...process.env, HUB_WORKER_SOCKET: workerSocket },
  })
  workerHandle = child
  children.add(child)
  child.on('error', (err) => log(`worker failed to spawn: ${String(err)}`))
  child.on('exit', (code, signal) => {
    children.delete(child)
    const wasCurrent = workerHandle === child
    if (wasCurrent) workerHandle = null
    log(`worker exited (code=${code ?? 'null'} signal=${signal ?? 'null'})${tearingDown ? '' : ' — respawning'}`)
    if (!tearingDown && wasCurrent) spawnWorker()
  })
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
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'])
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

log(`supervisor starting (pid ${process.pid})`)
boot().catch((err) => {
  tearingDown = true // a fatal boot tears the tree down; don't let the worker respawn into it
  log(`fatal: hub failed to boot: ${String(err)}`)
  for (const child of children) killTree(child)
  process.exit(1)
})
