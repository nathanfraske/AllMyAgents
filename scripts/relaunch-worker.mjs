// One-time COLD entry into worker mode on a live install.
//
//   node scripts/relaunch-worker.mjs [--delay-ms 45000]
//
// Worker mode is entered when hubctl STARTS — a running hub cannot grow a worker — so the very first
// launch after enabling it must be a cold restart. This script performs that restart *from outside the
// hub's process tree*, which is what makes it safe to run from an agent living inside the hub it is
// about to kill: it is spawned via WMI (parent = the WMI provider host), so tearing down the hub tree
// cannot take the relauncher with it.
//
// Sequence: wait (so the requesting turn finishes streaming into the journal) -> kill the hubctl/hub/worker
// tree -> wait for the port to free -> relaunch hubctl with HUB_WORKER=1 -> health-check.
// If worker mode fails to come up, it FALLS BACK to the original no-worker launch, so a failed upgrade
// leaves a working hub rather than a dead app. Every step is appended to data/relaunch.log, and a machine
// readable verdict lands in data/relaunch-status.json.
//
// It never touches the vite dev server or anything that isn't the hub tree.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const HUB = path.join(REPO, 'apps', 'hub')
const DATA = path.join(REPO, 'data')
const LOG = path.join(DATA, 'relaunch.log')
const STATUS = path.join(DATA, 'relaunch-status.json')
const PORT = 7777
const argDelay = process.argv.indexOf('--delay-ms')
const DELAY_MS = argDelay > -1 ? Number(process.argv[argDelay + 1]) : 45000

fs.mkdirSync(DATA, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(LOG, line) } catch { /* ignore */ }
  process.stdout.write(line)
}
function health() {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/health', method: 'GET', timeout: 3000 }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(null) } })
    })
    r.on('error', () => resolve(null))
    r.on('timeout', () => { r.destroy(); resolve(null) })
    r.end()
  })
}
const workerPipeUp = () => {
  try { return fs.readdirSync('\\\\.\\pipe\\').some((p) => String(p).includes('allmyagents-worker')) } catch { return false }
}

/** Every node process that is part of the hub tree — hubctl (incl. its pnpm wrappers), the hub, the worker.
 *  Deliberately excludes this relauncher and anything else (the vite dev server keeps running). */
function hubTreePids() {
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: 'utf8' }
  )
  let rows = []
  try {
    const parsed = JSON.parse(ps.stdout || '[]')
    rows = Array.isArray(parsed) ? parsed : [parsed]
  } catch { return [] }
  return rows
    .filter((r) => {
      const cmd = String(r?.CommandLine ?? '')
      if (!cmd || /relaunch-worker/.test(cmd)) return false // never ourselves
      return /hubctl/i.test(cmd) || /apps[\\/]hub[\\/]src[\\/]index\.ts/i.test(cmd) || /agentWorker/i.test(cmd)
    })
    .map((r) => Number(r.ProcessId))
    .filter(Boolean)
}

async function waitForPortFree(ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!(await health())) return true
    await sleep(500)
  }
  return false
}

async function waitForHealthy(ms = 120000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const h = await health()
    if (h?.boot === 'complete') return h
    await sleep(1000)
  }
  return null
}

function launch(withWorker) {
  const env = { ...process.env }
  for (const k of ['HUB_SUPERVISED', 'HUB_PORT', 'HUB_WORKER_SOCKET', 'HUB_DATA_DIR', 'HUB_FIXED_PORT', 'HUB_PROFILES_DIR', 'HUB_RESTART_MAX_DEFER_MS']) delete env[k]
  if (withWorker) env.HUB_WORKER = '1'
  else delete env.HUB_WORKER
  const out = fs.openSync(path.join(DATA, withWorker ? 'hubctl-worker.log' : 'hubctl-fallback.log'), 'a')
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/hubctl.ts'], {
    cwd: HUB,
    env,
    detached: true, //     survives this relauncher exiting
    stdio: ['ignore', out, out],
  })
  child.unref()
  return child.pid
}

const verdict = { ok: false, mode: null, startedAt: new Date().toISOString() }
try {
  log(`=== relaunch into worker mode requested; waiting ${DELAY_MS}ms so the requesting turn finishes ===`)
  await sleep(DELAY_MS)

  const before = await health()
  log(`live hub before: ${JSON.stringify(before)}`)
  const pids = hubTreePids()
  log(`killing hub tree: ${pids.join(', ') || '(none found)'}`)
  for (const pid of pids) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
    log(`  taskkill ${pid} -> ${(r.stdout || r.stderr || '').trim().slice(0, 120)}`)
  }
  const freed = await waitForPortFree()
  log(`port ${PORT} free: ${freed}`)
  await sleep(1500) // let the old worker's named pipe close before the new one claims it

  const pid = launch(true)
  log(`relaunched hubctl WITH worker mode (pid ${pid})`)
  const h = await waitForHealthy()
  const pipe = workerPipeUp()
  log(`health: ${JSON.stringify(h)} | worker pipe up: ${pipe}`)

  if (h?.boot === 'complete' && pipe) {
    verdict.ok = true
    verdict.mode = 'worker'
    verdict.hub = h
    verdict.workerPipe = true
    log('=== SUCCESS: hub is live in WORKER MODE — live turns now survive a hub restart ===')
  } else {
    log('!!! worker-mode hub did not come up healthy — FALLING BACK to the previous launch shape')
    for (const p of hubTreePids()) spawnSync('taskkill', ['/PID', String(p), '/T', '/F'])
    await waitForPortFree()
    await sleep(1500)
    const fbPid = launch(false)
    const fb = await waitForHealthy()
    log(`fallback hubctl (pid ${fbPid}) health: ${JSON.stringify(fb)}`)
    verdict.ok = !!fb
    verdict.mode = fb ? 'fallback-no-worker' : 'dead'
    verdict.hub = fb
    verdict.workerPipe = false
  }
} catch (err) {
  verdict.mode = 'error'
  verdict.error = err instanceof Error ? err.stack : String(err)
  log(`!!! relaunch threw: ${verdict.error}`)
}
verdict.finishedAt = new Date().toISOString()
try { fs.writeFileSync(STATUS, JSON.stringify(verdict, null, 2)) } catch { /* ignore */ }
log(`=== verdict: ${JSON.stringify({ ok: verdict.ok, mode: verdict.mode })} ===`)
process.exit(verdict.ok ? 0 : 1)
