// ACCEPTANCE (the consent half): once the operator APPROVES a project's config, its hooks and .mcp.json
// must actually load — the feature is "config comes along WITH consent", not "config disabled". Guards
// the full seam: adapters/claude.ts relaxes the gate only when ClaudeTurnOptions.trustProjectConfig is
// true, which SessionManager.specOf sets from ProjectStore.isConfigTrusted. It was fail-first (red)
// before that seam existed; it now passes. Its complement, acceptance-untrusted-project-config-gated.mjs,
// must stay green throughout — an UNapproved project is always gated.
//
// Self-launches an isolated worker-mode hubctl on a spare port (fresh worker => current source). It
// creates a NON-git project with a SessionStart hook + .mcp.json, calls POST /approve-config (operator
// consent), then spawns a session and asserts the hook FIRED and the MCP server loaded. NEVER 7777.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const HUB = path.join(REPO, 'apps', 'hub')
const PORT = Number(process.env.PROBE_PORT ?? 7789)
const PROFILE = process.env.PROBE_PROFILE ?? 'claude-a'
if (PORT === 7777) throw new Error('refusing 7777')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-appr-'))
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-apprproj-'))
const PROFILES = process.env.HUB_PROFILES_DIR || path.join(REPO, 'profiles')
const LOG = path.join(DATA_DIR, 'hubctl.log')
const MARKER = path.join(PROJ, 'hook_marker.txt')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function req(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }) } catch { resolve({ status: res.statusCode, raw: b }) } }) })
    r.on('error', () => resolve(null)); if (data) r.write(data); r.end()
  })
}
const health = async () => (await req('GET', '/api/health'))?.json ?? null
const sessionOf = async (sid) => { const l = (await req('GET', '/api/sessions'))?.json; return Array.isArray(l) ? l.find((s) => s.id === sid) : null }
const logText = () => { try { return fs.readFileSync(LOG, 'utf8') } catch { return '' } }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
function killTree(child) { if (!child?.pid) return; if (process.platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch {} return } try { child.kill('SIGTERM') } catch {}; sleepSync(1500); try { child.kill('SIGKILL') } catch {} }

let hubctl = null
const finish = (code, res) => { killTree(hubctl); console.log('\n=== APPROVED PROJECT CONFIG LOADS ' + (code === 0 ? 'PASS ✅' : 'FAIL ❌ (approved config did not load — seam not wired yet)') + ' ===', JSON.stringify(res, null, 2)); process.exit(code) }

;(async () => {
  fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true })
  const cmd = process.platform === 'win32' ? `echo HOOKFIRED> "${MARKER.replace(/\\/g, '\\\\')}"` : `echo HOOKFIRED > '${MARKER}'`
  fs.writeFileSync(path.join(PROJ, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: cmd }] }] } }))
  fs.writeFileSync(path.join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { probe_srv: { command: 'node', args: ['-e', 'setTimeout(()=>{},1e9)'] } } }))

  const env = { ...process.env, HUB_WORKER: '1', HUBCTL_DEV: '1', HUB_FIXED_PORT: String(PORT), HUB_DATA_DIR: DATA_DIR, HUB_PROFILES_DIR: PROFILES, MESH_EXPOSE: '0' }
  delete env.HUB_SUPERVISED; delete env.HUB_PORT; delete env.HUB_WORKER_SOCKET
  hubctl = spawn(process.execPath, ['--import', 'tsx/esm', 'src/hubctl.ts'], { env, stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')], cwd: HUB })
  hubctl.on('error', (e) => finish(1, { error: 'hubctl spawn: ' + e.message }))
  let h = null
  for (let i = 0; i < 160; i++) { h = await health(); if (h?.boot === 'complete') break; await sleep(500) }
  if (h?.boot !== 'complete') finish(1, { error: 'never healthy', tail: logText().slice(-2000) })

  const proj = await req('POST', '/api/projects', { name: 'approved-cfg', path: PROJ })
  const pid = proj?.json?.id
  if (!pid) finish(1, { error: 'project create failed', proj })
  // OPERATOR CONSENT: approve the project's current executable config.
  const approve = await req('POST', `/api/projects/${pid}/approve-config`)
  if (!approve?.json?.approved) finish(1, { error: 'approve-config did not approve', approve })
  const status = await req('GET', `/api/projects/${pid}/config`)
  if (!status?.json?.trusted) finish(1, { error: 'project not trusted after approve', status: status?.json })

  const create = await req('POST', '/api/sessions', { profileId: PROFILE, projectId: pid, useWorktree: false, permissionMode: 'safe', prompt: 'Reply with only: hi' })
  const sid = create?.json?.id
  if (!sid) finish(1, { error: 'session create failed', create })

  let hookFired = false
  for (let i = 0; i < 40; i++) { await sleep(1000); if (fs.existsSync(MARKER)) { hookFired = true; break } const s = await sessionOf(sid); if (s && s.status === 'idle' && i > 4) break }
  await sleep(1500); hookFired = hookFired || fs.existsSync(MARKER)
  const events = (await req('GET', '/api/events?since=0'))?.json ?? []
  const sess = events.filter((e) => e.sessionId === sid)
  const initEv = sess.find((e) => e.kind === 'claude/system' && e.payload?.subtype === 'init')
  const mcpListed = initEv ? JSON.stringify(initEv.payload).includes('probe_srv') : false

  // PROPERTY: an APPROVED project's config actually loads (hook fires AND the MCP server is present).
  const loaded = hookFired && mcpListed
  finish(loaded ? 0 : 1, { loaded, approved: true, HOOK_fired: hookFired, MCP_listed_in_init: mcpListed, note: 'requires the specOf seam (isConfigTrusted -> spec.trustProjectConfig)' })
})().catch((e) => finish(1, { error: 'unexpected ' + (e?.stack || String(e)) }))
