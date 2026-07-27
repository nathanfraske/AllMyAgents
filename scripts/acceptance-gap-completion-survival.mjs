// REGRESSION TEST for task #23: "a turn that COMPLETES during a hub gap loses its output entirely."
//
// STATUS: FAILS today (the bug is live) — the fail-first test for the fix. It asserts the PROPERTY that
// should hold: a turn whose completion lands entirely within a hub gap must still have its output (the
// assistant reply AND claude/result) in the transcript once a fresh hub re-attaches. Exit 0 when the
// property holds (post-fix); exit 1 when the output was lost (the bug today).
//
// DETERMINISTIC by construction — no dependence on respawn timing. We run the pieces ourselves:
//   1. spawn the agent WORKER (survives the whole test),
//   2. spawn hub-A against it, start a short pure-text turn (no tool → no approval confound), wait active,
//   3. SIGKILL hub-A and wait a FIXED 20s with NO hub attached — the worker finishes the turn and buffers
//      the completion (this is the wide gap: crash-loop backoff / slow boot / a longer outage),
//   4. spawn hub-B (same port + data dir + worker socket) — the successor re-attaches to the worker.
// Then assert the completed turn's output is in the journal.
//
// Mechanism (diagnosis): SessionManager.attachWorker (apps/hub/src/sessions.ts ~622-638) seeds a replay
// cursor ONLY for sessions listLive() reports 'active'. A turn finished during the gap reports 'idle'
// (driver.busy=false / activeTurns cleared in agentWorker.ts emitTurnCompleted), so attachWorker takes
// the else-branch (setStatus idle) and never adds it to `since`; executor.attach(since) is therefore never
// asked to replay it, and the buffered claude/result + final assistant events are stranded in the worker's
// WseqBuffer. The worker side (listLive/attach/WseqBuffer) is correct — only the hub's willingness to
// replay an idle-but-unflushed session is missing. Never touches 7777 or the shared 7788 sandbox.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const HUB = path.join(REPO, 'apps', 'hub')
const PORT = Number(process.env.PROBE_PORT ?? 7794)
const PROFILE = process.env.PROBE_PROFILE ?? 'claude-a'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-gapsurv-'))
const WORK = path.join(DATA_DIR, 'work'); fs.mkdirSync(WORK, { recursive: true })
const rand = crypto.randomBytes(4).toString('hex')
const SOCK = process.platform === 'win32' ? `\\\\.\\pipe\\ama-gaptest-${rand}` : path.join(os.tmpdir(), `ama-gaptest-${rand}.sock`)
const t0 = Date.now()
const step = (m, x) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`, x !== undefined ? JSON.stringify(x) : '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function req(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }) } catch { resolve({ status: res.statusCode, raw: b }) } }) })
    r.on('error', () => resolve(null)); if (data) r.write(data); r.end()
  })
}
const health = async () => { const r = await req('GET', '/api/health'); return r?.json ?? null }
const sessionOf = async (sid) => { const r = await req('GET', '/api/sessions'); const l = r?.json; return Array.isArray(l) ? l.find((s) => s.id === sid) : null }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
function hardKill(child) { if (!child?.pid) return; if (process.platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch {} return } try { child.kill('SIGKILL') } catch {} }

const devHub = ['--import', 'tsx/esm', path.join(HUB, 'src', 'index.ts')]
const devWorker = ['--import', 'tsx/esm', path.join(HUB, 'src', 'agentWorker.ts')]
const baseEnv = { ...process.env, HUB_WORKER_SOCKET: SOCK, HUB_DATA_DIR: DATA_DIR, MESH_EXPOSE: '0' }
delete baseEnv.HUB_SUPERVISED; delete baseEnv.HUB_WORKER
function spawnHub() { return spawn(process.execPath, devHub, { env: { ...baseEnv, HUB_PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'], cwd: HUB }) }

let worker = null, hubA = null, hubB = null
const finish = (code, res) => { for (const c of [hubA, hubB, worker]) hardKill(c); console.log('\n=== GAP-COMPLETION SURVIVAL ' + (code === 0 ? 'PASS ✅' : 'FAIL ❌ (bug reproduced)') + ' ===', JSON.stringify(res, null, 2)); process.exit(code) }
async function waitHealthy(pidNot, timeoutMs) { const start = Date.now(); while (Date.now() - start < timeoutMs) { const h = await health(); if (h?.boot === 'complete' && h.pid !== pidNot) return h; await sleep(300) } return null }

;(async () => {
  step(`worker socket ${SOCK}`)
  worker = spawn(process.execPath, devWorker, { env: baseEnv, stdio: ['ignore', 'ignore', 'inherit'], cwd: HUB })
  worker.on('exit', (c, s) => step(`worker exited code=${c} sig=${s}`))
  await sleep(2500) // let the worker bind its listener

  hubA = spawnHub()
  const a = await waitHealthy(undefined, 30000)
  if (!a) finish(1, { error: 'hub-A never healthy' })
  step(`hub-A healthy pid=${a.pid}`)

  const create = await req('POST', '/api/sessions', { profileId: PROFILE, cwd: WORK, permissionMode: 'full', prompt: 'Reply with exactly three short sentences about why the sky is blue. Do not use any tools.' })
  const sid = create?.json?.id
  if (!sid) finish(1, { error: 'session create failed', create })
  let sawActive = false
  for (let i = 0; i < 80; i++) { const s = await sessionOf(sid); if (s && (s.status === 'active' || s.status === 'starting')) { sawActive = true; break } await sleep(80) }
  if (!sawActive) finish(1, { error: 'turn never went active' })
  step(`turn active — killing hub-A; worker will finish the turn during a 20s hub-less gap`)

  hardKill(hubA); hubA = null
  await sleep(20000) // NO hub attached: the worker completes the turn and buffers the completion

  hubB = spawnHub()
  const b = await waitHealthy(a.pid, 40000)
  if (!b) finish(1, { error: 'hub-B never healthy' })
  step(`hub-B healthy pid=${b.pid} — re-attached to the worker`)
  await sleep(9000) // let re-attach + any replay settle

  const s = await sessionOf(sid)
  const events = (await req('GET', '/api/events?since=0'))?.json ?? []
  const sess = events.filter((e) => e.sessionId === sid)
  const assistantOut = sess.some((e) => e.kind === 'claude/assistant')
  const resultPresent = sess.some((e) => e.kind === 'claude/result')
  const survived = assistantOut && resultPresent
  finish(survived ? 0 : 1, {
    property: 'a turn completing during a hub gap keeps its output after re-attach',
    survived, sid, hubAPid: a.pid, hubBPid: b.pid, finalStatus: s?.status ?? '(gone)',
    assistantOut, resultPresent, sessionKinds: [...new Set(sess.map((e) => e.kind))], dataDir: DATA_DIR,
  })
})().catch((e) => finish(1, { error: 'unexpected ' + (e?.stack || String(e)) }))
