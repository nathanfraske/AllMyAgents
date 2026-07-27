// ACCEPTANCE / SECURITY REGRESSION: a `safe` chat MUST gate a Bash tool call — the real SDK must invoke
// the hub's canUseTool, an approval must be requested, and Bash must NOT run unprompted.
//
// Why this exists as an END-TO-END test: claudePermissionWiring.test.ts mocks the SDK's query() and only
// checks the OPTIONS we hand it (that we install a canUseTool and never pass our mode as the SDK's
// permissionMode). It cannot see whether the REAL SDK actually INVOKES that callback — so it stays green
// even if gating is broken by an SDK version bump, a streaming-input contract change, a permissionMode
// default flip, or a stale worker. This runs a REAL safe-mode Bash turn through a fresh worker-mode
// hubctl + the real SDK and asserts the tool was gated. Exit 0 = gated (correct); exit 1 = UNGATED (bug).
//
// Isolated worker-mode hubctl on a spare port (default 7791), own temp data dir, real managed profiles via
// HUB_PROFILES_DIR (set it to the repo's profiles/). NEVER 7777. Fresh hubctl => a fresh worker that loads
// current source (a long-running worker survives hub restarts and would otherwise run stale code — the
// most likely explanation for a live "safe ran Bash" sighting that source review cannot reproduce).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const HUB = path.join(REPO, 'apps', 'hub')
const PORT = Number(process.env.PROBE_PORT ?? 7791)
const PROFILE = process.env.PROBE_PROFILE ?? 'claude-a'
if (PORT === 7777) throw new Error('refusing 7777')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-safegate-'))
const WORK = path.join(DATA_DIR, 'work'); fs.mkdirSync(WORK, { recursive: true })
const PROFILES = process.env.HUB_PROFILES_DIR || path.join(REPO, 'profiles')
const LOG = path.join(DATA_DIR, 'hubctl.log')
const SENT = 'SAFEGATE-' + Math.random().toString(36).slice(2, 8)
const FILE = 'safemode_probe.txt'
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
const logText = () => { try { return fs.readFileSync(LOG, 'utf8') } catch { return '' } }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
function killTree(child) { if (!child?.pid) return; if (process.platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch {} return } try { child.kill('SIGTERM') } catch {}; sleepSync(1500); try { child.kill('SIGKILL') } catch {} }

let hubctl = null
const finish = (code, res) => { killTree(hubctl); console.log('\n=== SAFE MODE GATES BASH ' + (code === 0 ? 'PASS ✅' : 'FAIL ❌ (ungated — security regression)') + ' ===', JSON.stringify(res, null, 2)); process.exit(code) }

;(async () => {
  step(`launch worker-mode hubctl port=${PORT} profiles=${PROFILES}`)
  const env = { ...process.env, HUB_WORKER: '1', HUBCTL_DEV: '1', HUB_FIXED_PORT: String(PORT), HUB_DATA_DIR: DATA_DIR, HUB_PROFILES_DIR: PROFILES, MESH_EXPOSE: '0' }
  delete env.HUB_SUPERVISED; delete env.HUB_PORT; delete env.HUB_WORKER_SOCKET
  const logFd = fs.openSync(LOG, 'a')
  hubctl = spawn(process.execPath, ['--import', 'tsx/esm', 'src/hubctl.ts'], { env, stdio: ['ignore', logFd, logFd], cwd: HUB })
  hubctl.on('error', (e) => finish(1, { error: 'hubctl spawn: ' + e.message }))
  let h = null
  for (let i = 0; i < 160; i++) { h = await health(); if (h?.boot === 'complete') break; await sleep(500) }
  if (h?.boot !== 'complete') finish(1, { error: 'never healthy', tail: logText().slice(-2500) })
  if (!/spawning agent worker/.test(logText())) finish(1, { error: 'NOT worker mode', tail: logText().slice(-1500) })
  step('worker mode confirmed')

  const prompt = `Use the Bash tool to run exactly this command, nothing else: echo ${SENT} > ${FILE} . Do not ask me first; just run it.`
  const create = await req('POST', '/api/sessions', { profileId: PROFILE, cwd: WORK, permissionMode: 'safe', prompt })
  const sid = create?.json?.id
  if (!sid) finish(1, { error: 'session create failed', create })
  if (create.json.permissionMode !== 'safe') finish(1, { error: 'mode not safe', record: create.json })

  // Wait for the turn to either run Bash (bug) or park on an approval (correct).
  let filePresent = false
  for (let i = 0; i < 45; i++) { await sleep(1000); if (fs.existsSync(path.join(WORK, FILE))) { filePresent = true; break } const s = await sessionOf(sid); const pend = (await req('GET', '/api/approvals'))?.json ?? []; if (Array.isArray(pend) && pend.some((a) => a.sessionId === sid)) break; if (s && s.status === 'idle' && i > 4) break }
  await sleep(1000)
  filePresent = filePresent || fs.existsSync(path.join(WORK, FILE))
  const s = await sessionOf(sid)
  const pend = (await req('GET', '/api/approvals'))?.json ?? []
  const pendingForUs = Array.isArray(pend) ? pend.filter((a) => a.sessionId === sid) : []
  const events = (await req('GET', '/api/events?since=0'))?.json ?? []
  const sess = events.filter((e) => e.sessionId === sid)
  const approvalEvents = sess.filter((e) => e.kind.startsWith('approval/')).map((e) => e.kind)

  // GATED: Bash did not run unprompted — an approval was requested (or is pending) and the file is absent.
  const gated = !filePresent && (approvalEvents.length > 0 || pendingForUs.length > 0)
  finish(gated ? 0 : 1, {
    property: 'safe mode requires approval before Bash runs',
    gated, sid, modeConfirmed: create.json.permissionMode, fileWritten: filePresent,
    approvalEvents, pendingApprovals: pendingForUs.length, finalStatus: s?.status ?? '(gone)', dataDir: DATA_DIR,
  })
})().catch((e) => finish(1, { error: 'unexpected ' + (e?.stack || String(e)) }))
