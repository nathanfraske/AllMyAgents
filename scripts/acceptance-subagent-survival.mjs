// ITEM 1 — prove (or refute) that a live turn's SUB-AGENT survives a hub restart.
// docs/agent-worker-impl.md §3.4 marks this "reasoned, not demonstrated". This demonstrates it.
//
// Isolated worker-mode hubctl on its OWN port + temp data dir (never 7777, never the shared 7788
// sandbox). A chat spawns a general-purpose SUB-AGENT that writes numbered files on a timer (physical
// evidence). Mid-flight we blue->green flip the hub. We then check three things:
//   (A) files keep appearing THROUGH and AFTER the flip     -> the sub-agent subtree survived physically
//   (B) sub-agent events (parent_tool_use_id != null) land AFTER green booted -> its output reached the transcript post-restart
//   (C) the parent turn completes idle with claude/result on green
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const HUB = path.join(REPO, 'apps', 'hub')
const PORT = Number(process.env.PROBE_PORT ?? 7796)
const PROFILE = process.env.PROBE_PROFILE ?? 'claude-a'
const SENT = 'SUBSURV-' + Math.random().toString(36).slice(2, 8)
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-subsurv-'))
const WORK = path.join(DATA_DIR, 'work')
fs.mkdirSync(WORK, { recursive: true })
const LOG = path.join(DATA_DIR, 'hubctl.log')
const t0 = Date.now()
const step = (m, x) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`, x !== undefined ? JSON.stringify(x) : '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }) } catch { resolve({ status: res.statusCode, raw: b }) } }) })
    r.on('error', reject); if (data) r.write(data); r.end()
  })
}
const health = async () => { try { return (await req('GET', '/api/health')).json } catch { return null } }
const sessionOf = async (sid) => { try { const l = (await req('GET', '/api/sessions')).json; return Array.isArray(l) ? l.find((s) => s.id === sid) : null } catch { return null } }
const logText = () => { try { return fs.readFileSync(LOG, 'utf8') } catch { return '' } }
const stepFiles = () => { try { return fs.readdirSync(WORK).filter((f) => f.startsWith('step-')).sort() } catch { return [] } }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
function killTree(child) { if (!child?.pid) return; if (process.platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch {} return } try { child.kill('SIGTERM') } catch {}; sleepSync(1500); try { child.kill('SIGKILL') } catch {} }

let hubctl = null
const finish = (code, res) => { killTree(hubctl); console.log('\n=== ITEM 1 ' + (code === 0 ? 'PASS ✅' : 'RESULT') + ' ===', JSON.stringify(res, null, 2)); process.exit(code) }

;(async () => {
  step(`launch worker-mode hubctl port=${PORT} data=${DATA_DIR}`)
  const env = { ...process.env, HUB_WORKER: '1', HUBCTL_DEV: '1', HUB_FIXED_PORT: String(PORT), HUB_DATA_DIR: DATA_DIR, HUB_RESTART_MAX_DEFER_MS: '2000', MESH_EXPOSE: '0' }
  delete env.HUB_SUPERVISED; delete env.HUB_PORT; delete env.HUB_WORKER_SOCKET
  const logFd = fs.openSync(LOG, 'a')
  hubctl = spawn(process.execPath, ['--import', 'tsx/esm', 'src/hubctl.ts'], { env, stdio: ['ignore', logFd, logFd], cwd: HUB })
  hubctl.on('error', (e) => finish(1, { error: 'hubctl spawn: ' + e.message }))

  let h = null
  for (let i = 0; i < 120; i++) { h = await health(); if (h?.boot === 'complete') break; await sleep(500) }
  if (h?.boot !== 'complete') finish(1, { error: 'blue never healthy', tail: logText().slice(-2000) })
  const bluePid = h.pid
  if (!/spawning agent worker/.test(logText())) finish(1, { error: 'not worker mode', tail: logText().slice(-2000) })
  step(`blue healthy pid=${bluePid} — worker mode confirmed`)

  // The sub-agent runs a shell loop writing 18 files, one every ~2.5s (~45s total) — long enough to
  // straddle a flip. Each file's content carries the sentinel so we can attribute it.
  const prompt =
    `You MUST use the Task tool to launch ONE sub-agent (subagent_type "general-purpose"). Do NOT do the work yourself. ` +
    `Give the sub-agent EXACTLY this instruction: "Run this single bash command and then report the count of files created: ` +
    `for i in $(seq -w 1 18); do echo ${SENT}-$i > step-$i.txt; sleep 2.5; done". ` +
    `After the sub-agent finishes, reply with the last line exactly: ${SENT}-DONE`
  const create = await req('POST', '/api/sessions', { profileId: PROFILE, cwd: WORK, permissionMode: 'full', prompt })
  const sid = create.json?.id
  if (!sid) finish(1, { error: 'create failed', create })
  step(`session ${sid} — waiting for the sub-agent to start writing files`)

  // Wait until files begin appearing (sub-agent live).
  let began = false
  for (let i = 0; i < 160; i++) { if (stepFiles().length >= 1) { began = true; break } const s = await sessionOf(sid); if (s && (s.status === 'error' || s.status === 'stopped')) finish(1, { error: 'turn failed early ' + s.status, tail: logText().slice(-2000) }); await sleep(500) }
  if (!began) finish(1, { error: 'no files appeared in ~80s — sub-agent never started', tail: logText().slice(-3000) })
  const filesBeforeFlip = stepFiles().length
  step(`sub-agent LIVE — ${filesBeforeFlip} file(s) so far; firing blue->green restart`)

  // Flip mid-flight.
  const restart = await req('POST', '/api/restart', { reason: 'item1: sub-agent survival' })
  if (restart.status !== 202) finish(1, { error: 'restart not accepted', restart })
  let greenPid = null
  for (let i = 0; i < 200; i++) { const hh = await health(); if (hh?.boot === 'complete' && hh.pid !== bluePid) { greenPid = hh.pid; break } await sleep(150) }
  if (!greenPid) finish(1, { error: 'no flip', tail: logText().slice(-3000) })
  const filesAtFlip = stepFiles().length
  step(`FLIP pid ${bluePid}->${greenPid}; ${filesAtFlip} files at flip`)
  const greenBootMs = Date.now() - t0

  // Watch files keep growing after the flip.
  let sawGrowthAfterFlip = false
  for (let i = 0; i < 8; i++) { await sleep(2500); if (stepFiles().length > filesAtFlip) { sawGrowthAfterFlip = true; break } }
  step(`files after flip growing: ${sawGrowthAfterFlip} (now ${stepFiles().length})`)

  // Wait for the parent turn to complete.
  let finalStatus = null
  for (let i = 0; i < 300; i++) { const s = await sessionOf(sid); if (s && (s.status === 'idle' || s.status === 'error' || s.status === 'stopped')) { finalStatus = s.status; break } await sleep(500) }
  const files = stepFiles()
  step(`parent turn final status ${finalStatus}; ${files.length} files on disk`)

  // Journal analysis.
  const events = (await req('GET', '/api/events?since=0')).json
  const hubStarted = (events || []).filter((e) => e.kind === 'hub/started').sort((a, b) => a.seq - b.seq)
  const greenBootSeq = hubStarted.length >= 2 ? hubStarted[1].seq : Infinity
  const sess = (events || []).filter((e) => e.sessionId === sid)
  const subAgentEvents = sess.filter((e) => { try { return e.payload && e.payload.parent_tool_use_id != null } catch { return false } })
  const subAgentAfterGreen = subAgentEvents.filter((e) => e.seq > greenBootSeq)
  const doneAfterGreen = sess.filter((e) => e.seq > greenBootSeq && (() => { try { return JSON.stringify(e.payload).includes(SENT + '-DONE') } catch { return false } })())
  const resultOnGreen = sess.find((e) => e.seq > greenBootSeq && e.kind === 'claude/result')

  const checks = {
    workerMode: true,
    flipObserved: greenPid !== bluePid,
    filesSurvivedSubtree: sawGrowthAfterFlip, // (A) subtree kept writing across/after the flip
    allFilesWritten: files.length === 18,
    subAgentEventsAfterGreen: subAgentAfterGreen.length > 0, // (B) sub-agent output journaled post-restart
    parentCompletedIdle: finalStatus === 'idle', // (C)
    resultOnGreen: !!resultOnGreen,
  }
  const pass = checks.flipObserved && checks.filesSurvivedSubtree && checks.subAgentEventsAfterGreen && checks.parentCompletedIdle
  finish(pass ? 0 : 2, {
    sentinel: SENT, bluePid, greenPid, finalStatus,
    filesBeforeFlip, filesAtFlip, filesFinal: files.length,
    greenBootSeq, subAgentEventsTotal: subAgentEvents.length, subAgentEventsAfterGreen: subAgentAfterGreen.length,
    doneAfterGreen: doneAfterGreen.length, checks, dataDir: DATA_DIR,
  })
})().catch((e) => finish(1, { error: 'unexpected ' + (e?.stack || String(e)) }))
