// A throwaway hub you can break, that cannot touch the one you are using.
//
//   node scripts/sandbox.mjs up        # start it, print the URL
//   node scripts/sandbox.mjs status    # is it running, where, since when
//   node scripts/sandbox.mjs logs      # tail the log
//   node scripts/sandbox.mjs down      # stop it
//   node scripts/sandbox.mjs reset     # stop it and delete all its state
//
// WHY THIS EXISTS. Verifying hub behaviour used to mean poking the operator's live hub on 7777 — the one
// running their actual work. That is a bad trade even when it goes well, and when it goes badly it takes
// their session with it. This gives a second, disposable hub with its own port, database, worktrees and
// config, so an agent can restart it, corrupt it, or kill it mid-turn without anybody noticing.
//
// WHAT IS ISOLATED, precisely:
//   - HUB_DATA_DIR  → .sandbox/data     journal DB, config.json, worktrees, device token
//   - port          → 7788 by default   never 7777, enforced below rather than by convention
//   - process tree  → its own hubctl + hub + agent worker, tracked by a pidfile here
//
// WHAT IS SHARED, deliberately: the managed PROFILES directory, i.e. vendor credentials. Without it no
// agent can actually run and the sandbox can only test the shell. Sharing is read-mostly (the hub writes
// settings.json when connector policy changes), so pass --isolated-profiles for a copy-free empty profile
// root when testing anything that touches profile settings. The tradeoff is stated rather than hidden
// because "which credentials is this using" should never be a guess.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const HUB = path.join(REPO, 'apps', 'hub')
// Resolve before handing this path to hubctl: the launcher runs from REPO while the supervised hub runs
// from apps/hub. A relative override otherwise splits pid/log state from the hub's token/database.
const ROOT = path.resolve(process.env.SANDBOX_DIR ?? path.join(REPO, '.sandbox'))
const DATA = path.join(ROOT, 'data')
const PROFILES = path.join(ROOT, 'profiles')
const PIDFILE = path.join(ROOT, 'hubctl.pid')
const LOG = path.join(ROOT, 'hubctl.log')
const PORT = Number(process.env.SANDBOX_PORT ?? 7788)

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'status'
const isolatedProfiles = argv.includes('--isolated-profiles')

// ---- guards --------------------------------------------------------------------------------------
// These are checks, not comments, because "the sandbox must not touch the live hub" is exactly the kind
// of rule that holds right up until someone sets an env var in a hurry.
const LIVE_PORT = 7777
if (PORT === LIVE_PORT) {
  console.error(`refusing to use port ${LIVE_PORT}: that is the live hub. Set SANDBOX_PORT to something else.`)
  process.exit(2)
}
const liveData = path.resolve(process.env.HUB_DATA_DIR ?? path.join(REPO, 'data'))
if (path.resolve(DATA) === liveData) {
  console.error(`refusing to use ${DATA}: that is the live hub's data dir. Set SANDBOX_DIR elsewhere.`)
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function req(method, pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: pathname, timeout: 2000 }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null })
        } catch {
          resolve({ status: res.statusCode, raw: b })
        }
      })
    })
    r.on('timeout', () => r.destroy(new Error('timeout')))
    r.on('error', reject)
    r.end()
  })
}
const health = async () => {
  try {
    return (await req('GET', '/api/health')).json
  } catch {
    return null
  }
}

const readPid = () => {
  try {
    const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Kill the sandbox's whole process tree. hubctl supervises a hub AND a sibling agent worker, so killing
 *  only the pid we spawned would orphan the worker — which would then hold the port and confuse the next
 *  `up` into thinking a stale sandbox is healthy. */
function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
}

async function up() {
  const running = readPid()
  if (running && alive(running) && (await health())) {
    console.log(`sandbox already up  pid=${running}  http://127.0.0.1:${PORT}`)
    return
  }
  fs.mkdirSync(DATA, { recursive: true })
  if (isolatedProfiles) fs.mkdirSync(PROFILES, { recursive: true })

  const env = {
    ...process.env,
    HUB_WORKER: '1',
    HUBCTL_DEV: '1',
    HUB_FIXED_PORT: String(PORT),
    HUB_DATA_DIR: DATA,
    // Never advertise a sandbox on the mesh: a disposable hub must not appear in the operator's fleet
    // roster, and certainly must not be reachable from another machine.
    MESH_EXPOSE: '0',
    // Force a blue-green flip to land MID-TURN instead of waiting for a turn boundary. The hub defers a
    // restart while a turn is live, which is right in production and useless in a harness: the whole
    // reason to restart a test hub is to see what a live turn does across the seam. Short by default here
    // precisely because that case is the one worth exercising.
    HUB_RESTART_MAX_DEFER_MS: process.env.SANDBOX_MAX_DEFER_MS ?? '3000',
  }
  if (isolatedProfiles) env.HUB_PROFILES_DIR = PROFILES
  // Inherited supervision vars would make the sandbox think it is a green being promoted by the LIVE
  // hubctl. Strip them so it always boots as its own independent supervisor.
  delete env.HUB_SUPERVISED
  delete env.HUB_PORT
  delete env.HUB_WORKER_SOCKET

  const logFd = fs.openSync(LOG, 'a')
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/hubctl.ts'], {
    env,
    cwd: HUB,
    stdio: ['ignore', logFd, logFd],
    // Detached on EVERY platform. Detaching only on POSIX meant the Windows child stayed tied to this
    // launcher's process group and died the moment `up` returned — the sandbox reported itself healthy
    // (it genuinely was, briefly) and then vanished, which reads as "the hub crashed" rather than "the
    // thing that started it exited". windowsHide keeps a detached child from opening a console window;
    // stdout/stderr already go to the log file.
    detached: true,
    windowsHide: true,
  })
  child.unref()
  fs.writeFileSync(PIDFILE, String(child.pid))

  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const h = await health()
    if (h) {
      console.log(`sandbox up  pid=${child.pid}  http://127.0.0.1:${PORT}`)
      console.log(`  data     ${DATA}`)
      console.log(`  profiles ${isolatedProfiles ? PROFILES + ' (isolated, empty)' : 'SHARED with your real profiles'}`)
      console.log(`  log      ${LOG}`)
      return
    }
    if (!alive(child.pid)) break
  }
  console.error(`sandbox failed to come up; last 40 log lines:\n`)
  console.error(tail(40))
  process.exit(1)
}

function tail(n) {
  try {
    return fs.readFileSync(LOG, 'utf8').split(/\r?\n/).slice(-n).join('\n')
  } catch {
    return '(no log yet)'
  }
}

async function down() {
  const pid = readPid()
  if (!pid) {
    console.log('sandbox not running (no pidfile)')
    return
  }
  if (alive(pid)) killTree(pid)
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(200)
  try {
    fs.rmSync(PIDFILE)
  } catch {
    /* ignore */
  }
  console.log(alive(pid) ? `sandbox pid ${pid} did not exit` : 'sandbox down')
}

async function status() {
  const pid = readPid()
  const h = await health()
  console.log(`port      ${PORT}`)
  console.log(`pid       ${pid ?? '-'}${pid ? (alive(pid) ? ' (alive)' : ' (stale pidfile)') : ''}`)
  console.log(`health    ${h ? JSON.stringify(h) : 'unreachable'}`)
  console.log(`data      ${DATA}${fs.existsSync(DATA) ? '' : ' (absent)'}`)
  console.log(`log       ${LOG}`)
}

/**
 * The throwaway APP: a Vite dev server whose proxy points at the sandbox hub instead of the live one.
 *
 * Runs on its own port so it cannot collide with a dev server the operator already has open, and it is
 * the real web UI — same code the desktop shell loads — so the full lifecycle (spawn, approve, interrupt,
 * stop, restart) can be exercised end to end against disposable state. Blocking, because it is a server:
 * Ctrl-C stops it, and it does not touch the sandbox hub's lifecycle either way.
 */
async function app() {
  if (!(await health())) {
    console.error(`no sandbox hub on ${PORT}. Run 'node scripts/sandbox.mjs up' first.`)
    process.exit(1)
  }
  const webPort = Number(process.env.SANDBOX_WEB_PORT ?? 5274) // 5273 is the normal dev server
  console.log(`sandbox app  http://127.0.0.1:${webPort}  →  hub 127.0.0.1:${PORT}`)
  // `shell: true` is REQUIRED on Windows, not cosmetic. Node 20+ refuses to spawn a .cmd/.bat directly
  // (CVE-2024-27980 hardening) and throws EINVAL before the app ever opens. Three auditors hit exactly
  // that here and had to launch the frontend by hand — which is worse than a broken script, because it
  // quietly turns "test it in the real app" into "test it however you can".
  // Every argument below is a fixed literal or a number, so there is nothing for the shell to re-split.
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['--filter', 'web', 'dev', '--port', String(webPort), '--strictPort'],
    {
      cwd: REPO,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        HUB_URL: `http://127.0.0.1:${PORT}`,
        HUB_DATA_DIR: DATA,
        HUB_DEVICE_TOKEN: fs.readFileSync(path.join(DATA, 'device-token.txt'), 'utf8').trim(),
      },
    }
  )
  await new Promise((resolve) => child.on('exit', resolve))
}

async function reset() {
  await down()
  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`sandbox state deleted: ${ROOT}`)
}

const commands = { up, down, status, reset, app, logs: () => console.log(tail(200)) }
const run = commands[cmd]
if (!run) {
  console.error(`unknown command '${cmd}'. Use: up | app | down | status | logs | reset`)
  process.exit(2)
}
await run()
