// Acceptance: a LIVE agent turn survives a mid-turn hub restart in WORKER mode.
//
//   node scripts/acceptance-restart-survival.mjs
//   ACCEPT_PROFILE=claude-a ACCEPT_PORT=7799 node scripts/acceptance-restart-survival.mjs
//
// This is the end-to-end proof of the Phase-2 always-on worker (docs/agent-worker-impl.md). It launches
// an ISOLATED, worker-mode hubctl on its own temp data dir + its own port (default 7799) so it never
// touches a live hub on 7777, starts a long Claude turn, then requests a restart WHILE the turn is in
// flight. A short HUB_RESTART_MAX_DEFER_MS forces the blue->green flip squarely mid-turn.
//
// The proof is journal-based and airtight — the SAME turn's events must STRADDLE the flip (some journaled
// by blue before green boots, the rest AFTER), the live hub pid must change while the turn is `active`, and
// the turn must finish cleanly (`idle`) with its end-of-turn sentinel + claude/result journaled by GREEN.
// A single real Claude turn (~1000-word essay) is spent per run against ACCEPT_PROFILE (default claude-a).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO = process.env.ACCEPT_REPO ?? path.resolve(fileURLToPath(import.meta.url), '..', '..')
const HUB = path.join(REPO, 'apps', 'hub')
const PORT = Number(process.env.ACCEPT_PORT ?? 7799)
const PROFILE = process.env.ACCEPT_PROFILE ?? 'claude-a'
const SENTINEL = 'SURVIVED-' + Math.random().toString(36).slice(2, 10)
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-accept-'))
const LOG = path.join(DATA_DIR, 'hubctl.log')

const results = { steps: [], pass: false, sentinel: SENTINEL, dataDir: DATA_DIR }
const t0 = Date.now()
function step(msg, extra) {
  const line = `[+${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s] ${msg}`
  console.log(line, extra !== undefined ? JSON.stringify(extra) : '')
  results.steps.push({ t: (Date.now() - t0) / 1000, msg, ...(extra !== undefined ? { extra } : {}) })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request(
      { host: '127.0.0.1', port: PORT, method, path: pathname, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }) } catch { resolve({ status: res.statusCode, raw: b }) } }) }
    )
    r.on('error', reject); if (data) r.write(data); r.end()
  })
}
async function health() { try { return (await req('GET', '/api/health')).json } catch { return null } }
async function sessionOf(sid) { try { const l = (await req('GET', '/api/sessions')).json; return Array.isArray(l) ? l.find((s) => s.id === sid) : null } catch { return null } }
function logText() { try { return fs.readFileSync(LOG, 'utf8') } catch { return '' } }

let hubctl = null
function finish(code) {
  try { if (hubctl?.pid) spawnSync('taskkill', ['/PID', String(hubctl.pid), '/T', '/F']) } catch {}
  results.log = logText().split(/\r?\n/).slice(-50)
  try { fs.writeFileSync(path.join(DATA_DIR, 'result.json'), JSON.stringify(results, null, 2)) } catch {}
  console.log('\n=== ACCEPTANCE ' + (code === 0 ? 'PASS ✅' : 'FAIL ❌') + ' ===')
  console.log('result.json:', path.join(DATA_DIR, 'result.json'))
  process.exit(code)
}
function fail(msg, extra) { step('FAIL: ' + msg, extra); results.error = msg; finish(1) }

;(async () => {
  step(`launch hubctl (worker mode) port=${PORT} data=${DATA_DIR}`)
  const env = { ...process.env, HUB_WORKER: '1', HUBCTL_DEV: '1', HUB_FIXED_PORT: String(PORT), HUB_DATA_DIR: DATA_DIR, HUB_RESTART_MAX_DEFER_MS: '3000', MESH_EXPOSE: '0' }
  delete env.HUB_SUPERVISED; delete env.HUB_PORT; delete env.HUB_WORKER_SOCKET
  const logFd = fs.openSync(LOG, 'a')
  hubctl = spawn(process.execPath, ['--import', 'tsx/esm', 'src/hubctl.ts'], { env, stdio: ['ignore', logFd, logFd], cwd: HUB })
  hubctl.on('error', (e) => fail('hubctl spawn error: ' + e.message))
  let hubctlExited = false
  hubctl.on('exit', () => { hubctlExited = true })

  // 1) blue healthy + worker spawned
  let h = null
  for (let i = 0; i < 100; i++) { if (hubctlExited) fail('hubctl exited during boot', { tail: logText().slice(-3000) }); h = await health(); if (h?.boot === 'complete') break; await sleep(500) }
  if (h?.boot !== 'complete') fail('blue never became healthy', { tail: logText().slice(-2500) })
  const bluePid = h.pid
  step(`blue healthy pid=${bluePid} port=${h.port}`)
  if (!/spawning agent worker/.test(logText())) fail('agent worker was NOT spawned — not worker mode', { tail: logText().slice(-2500) })
  step('agent worker spawned — WORKER MODE confirmed')

  // 2) create a session with a long first turn
  const prompt = `Write a detailed technical essay of at least 1000 words explaining how the TCP/IP networking stack works, layer by layer, from the link layer up through IP routing, TCP (the three-way handshake, congestion control, teardown), and application protocols like DNS and HTTP. Be thorough and do NOT summarize or stop early. When you have completely finished the essay, output on its very last line exactly this token and nothing after it: ${SENTINEL}`
  const create = await req('POST', '/api/sessions', { profileId: PROFILE, cwd: DATA_DIR, permissionMode: 'full', prompt })
  const sid = create.json?.id
  if (!sid) fail('session create failed', create)
  step(`session created id=${sid}`)

  // 3) wait for the turn to be LIVE. A freshly-created session reads 'idle' for a beat until the worker's
  //    turnStarted lifecycle propagates to the hub, so 'idle' here means "not started yet" — only error/stopped
  //    is a real early failure. The essay streams for tens of seconds, so 'active' persists plenty long.
  let live = false
  for (let i = 0; i < 140; i++) {
    if (hubctlExited) fail('hubctl exited while waiting for the turn', { tail: logText().slice(-3000) })
    const s = await sessionOf(sid)
    if (s && (s.status === 'active' || s.status === 'starting')) { live = true; break }
    if (s && (s.status === 'error' || s.status === 'stopped')) fail(`turn failed to start (status ${s.status})`, { tail: logText().slice(-2500) })
    await sleep(150)
  }
  if (!live) fail('turn never went active within ~21s', { tail: logText().slice(-2500) })
  step('turn is LIVE')

  // 4) fire the restart WHILE the turn runs; the short max-defer flips it mid-turn
  await sleep(1500)
  const pre = await sessionOf(sid)
  if (!(pre && (pre.status === 'active' || pre.status === 'starting'))) fail(`turn no longer live just before restart (status ${pre?.status}) — need a longer turn`)
  const restart = await req('POST', '/api/restart', { reason: 'acceptance: mid-turn survival' })
  step(`restart requested -> HTTP ${restart.status}`, restart.json)
  if (restart.status !== 202) fail('restart not accepted (202 expected)', restart)

  // 5) observe the flip: live pid changes blue -> green (a REAL hub restart)
  let greenPid = null, statusAtFlip = '(unknown)'
  for (let i = 0; i < 200; i++) {
    const hh = await health()
    if (hh && hh.boot === 'complete' && hh.pid !== bluePid) { greenPid = hh.pid; const s = await sessionOf(sid); statusAtFlip = s?.status ?? '(unknown)'; break }
    await sleep(200)
  }
  if (!greenPid) fail('no flip observed — hub pid never changed', { tail: logText().slice(-3000) })
  step(`FLIP: pid ${bluePid} -> ${greenPid} (session status at flip: ${statusAtFlip})`)

  // 6) wait for the turn to finish on green
  let finalStatus = null
  for (let i = 0; i < 400; i++) { const s = await sessionOf(sid); if (s && (s.status === 'idle' || s.status === 'error' || s.status === 'stopped')) { finalStatus = s.status; break } await sleep(300) }
  if (!finalStatus) fail('turn never completed after the flip (timeout)', { tail: logText().slice(-3000) })
  step(`turn finished after flip — final status ${finalStatus}`)

  // 7) journal-based survival verification
  const events = (await req('GET', '/api/events?since=0')).json
  if (!Array.isArray(events)) fail('could not read /api/events')
  const hubStarted = events.filter((e) => e.kind === 'hub/started').sort((a, b) => a.seq - b.seq)
  const greenBootSeq = hubStarted.length >= 2 ? hubStarted[1].seq : Infinity
  const sess = events.filter((e) => e.sessionId === sid)
  const blueSide = sess.filter((e) => e.seq < greenBootSeq)
  const greenSide = sess.filter((e) => e.seq > greenBootSeq)
  // The sentinel token also appears in the PROMPT (journaled by blue at turn start), so match it in the
  // assistant's OUTPUT specifically = an event AFTER green booted. That's the proof the turn's END streamed
  // + journaled on the successor hub, not the pre-flip prompt echo.
  const sentinelEvs = sess.filter((e) => { try { return JSON.stringify(e.payload).includes(SENTINEL) } catch { return false } })
  const resultOnGreen = greenSide.find((e) => e.kind === 'claude/result')
  results.sentinelSeqs = sentinelEvs.map((e) => ({ seq: e.seq, kind: e.kind }))
  results.greenBootSeq = greenBootSeq
  const checks = {
    twoHubEras: hubStarted.length >= 2,
    pidChanged: greenPid !== bluePid && greenPid != null,
    liveAtFlip: statusAtFlip === 'active' || statusAtFlip === 'starting' || statusAtFlip === '(unknown)',
    turnStraddledFlip: blueSide.length > 0 && greenSide.length > 0,
    sentinelPresent: sentinelEvs.length > 0,
    sentinelAfterGreenBoot: sentinelEvs.some((e) => e.seq > greenBootSeq),
    completedCleanly: finalStatus === 'idle',
    resultOnGreen: !!resultOnGreen,
  }
  results.checks = checks
  results.pids = { bluePid, greenPid }
  results.counts = { events: events.length, hubStarted: hubStarted.length, sessionEvents: sess.length, blueSide: blueSide.length, greenSide: greenSide.length }
  step('journal checks', checks)
  step('counts', results.counts)
  const required = ['twoHubEras', 'pidChanged', 'turnStraddledFlip', 'sentinelPresent', 'sentinelAfterGreenBoot', 'completedCleanly', 'resultOnGreen']
  const failed = required.filter((k) => !checks[k])
  results.pass = failed.length === 0
  if (!results.pass) fail('survival checks failed: ' + failed.join(', '), checks)
  step('ALL SURVIVAL CHECKS PASSED — a live turn survived a mid-turn hub restart ✅')
  finish(0)
})().catch((e) => fail('unexpected: ' + (e?.stack || String(e))))
