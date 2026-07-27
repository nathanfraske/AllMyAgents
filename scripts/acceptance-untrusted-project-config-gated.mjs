// SECURITY REGRESSION (fail-first): an UNAPPROVED project's executable config (hooks / .mcp.json)
// must NOT auto-run when the hub opens it. "Do not silently enable executable configuration from an
// untrusted directory."
//
// STATUS TODAY: FAILS (exit 1). The Claude SDK auto-loads project .mcp.json + .claude/settings.json
// hooks from cwd by default (settingSources omitted = all; .mcp.json not strict), and the hub sets
// neither strictMcpConfig nor managedSettings.disableAllHooks — so opening (or importing) ANY folder
// silently runs its hooks (arbitrary code) and connects its MCP servers, with zero operator consent.
// The fix (safe default in adapters/claude.ts: strictMcpConfig:true + managedSettings.disableAllHooks,
// keeping settingSources so CLAUDE.md/operator instructions still load; relax only for an
// operator-approved project) flips this to exit 0.
//
// Physical evidence: a temp NON-git project with a SessionStart hook that writes a marker file, and a
// .mcp.json. Open it in the sandbox (project + session, useWorktree:false so cwd = project path). The
// property asserted: the hook did NOT fire and the project MCP server was NOT loaded. Sandbox 7788,
// never 7777.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const PORT = Number(process.env.PROBE_PORT ?? 7788)
if (PORT === 7777) throw new Error('refusing 7777')
const PROFILE = process.env.PROBE_PROFILE ?? 'claude-a'
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-proj-'))
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
const sessionOf = async (sid) => { const r = await req('GET', '/api/sessions'); const l = r?.json; return Array.isArray(l) ? l.find((s) => s.id === sid) : null }

;(async () => {
  // A SessionStart hook writing a marker; a .mcp.json declaring a (bogus but well-formed) stdio server.
  fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true })
  const cmd = process.platform === 'win32' ? `echo HOOKFIRED> "${MARKER.replace(/\\/g, '\\\\')}"` : `echo HOOKFIRED > '${MARKER}'`
  fs.writeFileSync(path.join(PROJ, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: cmd }] }] } }, null, 2))
  fs.writeFileSync(path.join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { probe_srv: { command: 'node', args: ['-e', 'setTimeout(()=>{},1e9)'] } } }, null, 2))

  const proj = await req('POST', '/api/projects', { name: 'probe-native-cfg', path: PROJ })
  const pid = proj?.json?.id
  if (!pid) { console.log(JSON.stringify({ error: 'project create failed', proj })); process.exit(2) }
  const create = await req('POST', '/api/sessions', { profileId: PROFILE, projectId: pid, useWorktree: false, permissionMode: 'safe', prompt: 'Reply with only: hi' })
  const sid = create?.json?.id
  if (!sid) { console.log(JSON.stringify({ error: 'session create failed', create })); process.exit(2) }
  const cwd = create.json.cwd

  // Wait for the SessionStart hook to fire (it runs before/at turn start) and the init event to land.
  let hookFired = false
  for (let i = 0; i < 40; i++) { await sleep(1000); if (fs.existsSync(MARKER)) { hookFired = true; break } const s = await sessionOf(sid); if (s && s.status === 'idle' && i > 4) break }
  await sleep(1500)
  hookFired = hookFired || fs.existsSync(MARKER)

  const events = (await req('GET', '/api/events?since=0'))?.json ?? []
  const sess = events.filter((e) => e.sessionId === sid)
  const initEv = sess.find((e) => { try { return e.kind === 'claude/system' && e.payload?.subtype === 'init' } catch { return false } })
  const mcpListed = initEv ? JSON.stringify(initEv.payload).includes('probe_srv') : false
  const initMcp = initEv?.payload?.mcp_servers ?? initEv?.payload?.mcpServers ?? '(no init or no field)'

  // PROPERTY: an unapproved project's executable config must NOT auto-run.
  const gated = !hookFired && !mcpListed
  console.log('\n=== UNTRUSTED PROJECT CONFIG GATED ' + (gated ? 'PASS ✅' : 'FAIL ❌ (silently auto-ran — security hole)') + ' ===', JSON.stringify({
    gated,
    cwdIsProjectPath: cwd === PROJ, cwd,
    HOOK_fired: hookFired,           // project .claude/settings.json hook ran => project settings loaded + EXECUTED from cwd
    MCP_listed_in_init: mcpListed,   // project .mcp.json server present in the SDK init => .mcp.json loaded
    initMcpServers: initMcp,
    project: PROJ,
  }, null, 2))
  process.exit(gated ? 0 : 1)
})().catch((e) => { console.error('FATAL', e); process.exit(2) })
