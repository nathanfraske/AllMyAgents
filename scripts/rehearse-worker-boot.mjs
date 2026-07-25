// Pre-flight rehearsal for entering worker mode on a LIVE install.
//
//   node scripts/rehearse-worker-boot.mjs
//
// Boots the CURRENT hub code under worker mode against a COPY of the real journal, on an isolated port
// (7799) — never touching the live hub on 7777. Answers the one question that matters before killing a
// running hub you depend on: *will it come back up?* Specifically that (a) hubctl spawns the agent worker,
// (b) the hub boots to `complete` with the new wiring, (c) it restores the real session roster through the
// worker-mode attach path (not the in-process reconcile), and (d) health reports the true port.
//
// Uses the REAL profiles dir on purpose: profile credentials must never be copied (a copied Codex
// auth.json can rotate the single-use refresh token and break the original login).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const HUB = path.join(REPO, 'apps', 'hub')
const PORT = Number(process.env.REHEARSE_PORT ?? 7799)
const LIVE_DB = path.join(REPO, 'data', 'hub.db')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-rehearse-'))
const log = path.join(tmp, 'hubctl.log')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(pathname) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET' }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(null) } })
    })
    r.on('error', () => resolve(null))
    r.end()
  })
}

// Copy the journal (+ WAL/SHM so a hot database copies consistently enough to boot).
let liveSessions = 0
for (const suffix of ['', '-wal', '-shm']) {
  const src = LIVE_DB + suffix
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, 'hub.db' + suffix))
}
try {
  const live = await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: 7777, path: '/api/sessions', method: 'GET' }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve([]) } })
    })
    r.on('error', () => resolve([]))
    r.end()
  })
  liveSessions = Array.isArray(live) ? live.length : 0
} catch { /* live hub not reachable — only the copy matters */ }

console.log(`rehearsing worker-mode boot on :${PORT} (data copy: ${tmp}; live roster: ${liveSessions})`)
const env = {
  ...process.env,
  HUB_WORKER: '1',
  HUBCTL_DEV: '1',
  HUB_FIXED_PORT: String(PORT),
  HUB_DATA_DIR: tmp,
  MESH_EXPOSE: '0',
}
delete env.HUB_SUPERVISED
delete env.HUB_PORT
delete env.HUB_WORKER_SOCKET
const fd = fs.openSync(log, 'a')
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/hubctl.ts'], { env, stdio: ['ignore', fd, fd], cwd: HUB })

let health = null
for (let i = 0; i < 120; i++) {
  health = await get('/api/health')
  if (health?.boot === 'complete') break
  await sleep(500)
}
const text = (() => { try { return fs.readFileSync(log, 'utf8') } catch { return '' } })()

// Is the worker endpoint actually up? The endpoint SHAPE is platform-specific (workerTransport.ts
// `defaultWorkerSocket`): a Windows named pipe, which is listed out of the `\\.\pipe\` namespace, vs.
// a POSIX unix-domain socket, which is an ordinary file under the data dir. Check the right one — on
// macOS the pipe listing simply throws, which would have silently failed this check forever.
const workerEndpointUp = (() => {
  if (process.platform === 'win32') {
    try {
      return fs.readdirSync('\\\\.\\pipe\\').some((p) => String(p).includes('allmyagents-worker'))
    } catch { return false }
  }
  try {
    return fs.statSync(path.join(tmp, 'worker.sock')).isSocket()
  } catch { return false }
})()

const checks = {
  hubBooted: health?.boot === 'complete',
  workerSpawned: /spawning agent worker/.test(text),
  workerPipeUp: workerEndpointUp,
  restoredRoster: typeof health?.restoredSessions === 'number' && health.restoredSessions > 0,
  // The health-port fix: blue binds the fixed port directly, so this must be the real port, never 0.
  healthPortCorrect: health?.port === PORT,
  noFatalInLog: !/failed to spawn|Cannot find module|SyntaxError|ERR_MODULE_NOT_FOUND/i.test(text),
}
console.log('health:', JSON.stringify(health))
console.log('checks:', JSON.stringify(checks, null, 1))
if (liveSessions) console.log(`restored ${health?.restoredSessions} of the live roster's ${liveSessions} sessions`)

// Tear the rehearsal tree down. Windows: `taskkill /T /F` walks the PID tree. POSIX: hubctl was NOT
// spawned detached, so it is not a group leader here — SIGTERM it instead and let its own signal
// handler group-kill the hubs + worker it spawned (hubctl.ts `teardown`), then SIGKILL as a backstop.
if (child.pid) {
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch { /* ignore */ }
  } else {
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await sleep(1500)
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
}
await sleep(1200) // let the worker endpoint close before anything else claims it

const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
if (bad.length) {
  console.log('\n=== REHEARSAL FAILED ❌ — do NOT restart the live hub ===')
  console.log('failed:', bad.join(', '))
  console.log('log tail:\n' + text.slice(-2500))
  process.exit(1)
}
console.log('\n=== REHEARSAL PASSED ✅ — the new code boots under worker mode against the real journal ===')
process.exit(0)
