import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { WebSocketServer, WebSocket } from 'ws'
import type { ApprovalService } from './approvals.js'
import type { Journal } from './journal.js'
import type { ProjectStore } from './projects.js'
import type { SessionManager } from './sessions.js'
import type { UsageMonitor } from './usage.js'
import type { MeshSite } from './meshSite.js'
import type { InstructionStore } from './instructions.js'
import type { AgentBus } from './bus.js'
import type { MemoryStore } from './memory.js'
import type { PracticeStore } from './practices.js'
import { tokenMatches } from './deviceToken.js'
import { pickFolder } from './native.js'
import { computeStats } from './stats.js'
import { buildFleet, probeHubHealth } from './fleet.js'
import { startLogin, awaitLogin, credentialsExist } from './loginLauncher.js'
import { readProjectConfig } from './importScan.js'
import { pickableProfiles, setClaudeConnectorPolicy } from './profiles.js'
import { asFileWriteDiffDensity } from './types.js'
import type { DangerFlags, HubEvent, HubPrefs, Profile, Provider } from './types.js'
import type { Executor } from './executor.js'
import type { RestartState } from './restartController.js'
import { SCHEMA_VERSION } from './restartHandshake.js'
import { AttachmentInputError, attachmentLimitForMime, isClaudeImageMime } from './attachments.js'
import { GitHubImportService } from './githubImport.js'

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>AllMyAgents hub</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1.5rem; background: #14141a; color: #e4e4ec; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 1.25rem; }
  input, select, textarea, button { font: inherit; background: #1e1e28; color: inherit; border: 1px solid #3a3a4a; border-radius: 6px; padding: .35rem .55rem; }
  button { cursor: pointer; } button:hover { border-color: #6a6a8a; }
  button.ok { border-color: #2e7d4f; } button.no { border-color: #8d3535; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: .35rem 0; }
  #sessions li, #approvals li, #usage li { margin: .3rem 0; }
  #events { background: #0e0e14; border: 1px solid #2a2a38; border-radius: 6px; padding: .75rem; height: 34vh; overflow-y: auto; font-family: ui-monospace, monospace; font-size: .78rem; white-space: pre-wrap; word-break: break-all; }
  .k { color: #8ab4f8; } .muted { color: #888; } .warn { color: #f0a35e; } .bad { color: #e06c6c; }
  code { background: #1e1e28; padding: 0 .25rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>AllMyAgents hub — P1</h1>
<div class="row">
  <select id="profile"></select>
  <input id="repo" size="28" placeholder="git repo (optional → worktree)">
  <input id="cwd" size="24" placeholder="cwd (if no repo)">
  <input id="model" size="18" placeholder="model (default)">
  <select id="effort">
    <option value="">effort: default</option>
    <option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option>
  </select>
  <select id="pmode">
    <option value="">mode: safe (ask)</option>
    <option value="edits">edits free</option>
    <option value="full">full access</option>
  </select>
  <input id="prompt" size="40" placeholder="first prompt">
  <button onclick="spawnSession()">spawn</button>
</div>
<h2>Usage</h2>
<ul id="usage"></ul>
<h2>Pending approvals</h2>
<ul id="approvals"><li class="muted">none</li></ul>
<h2>Sessions</h2>
<ul id="sessions"></ul>
<div class="row">
  <input id="target" size="34" placeholder="session id">
  <input id="text" size="46" placeholder="message">
  <button onclick="sendInput()">send</button>
</div>
<h2>Event stream</h2>
<div id="events"></div>
<script>
async function j(url, opts) { const r = await fetch(url, opts); return r.json() }
async function loadProfiles() {
  const profiles = await j('/api/profiles')
  document.getElementById('profile').innerHTML =
    profiles.map(p => '<option value="' + p.id + '">' + p.id + ' (' + p.provider + ')</option>').join('')
}
async function refreshSessions() {
  const sessions = await j('/api/sessions')
  document.getElementById('sessions').innerHTML = sessions.map(s =>
    '<li><code>' + s.id.slice(0, 8) + '</code> ' + s.profileId +
    ' — <b>' + s.status + '</b>' +
    (s.model ? ' <span class="muted">' + s.model + (s.effort ? '/' + s.effort : '') + '</span>' : '') +
    ' <span class="muted">' + (s.worktree || s.cwd) + '</span>' +
    ' <button onclick="pick(\\'' + s.id + '\\')">select</button>' +
    ' <button onclick="act(\\'' + s.id + '\\',\\'interrupt\\')">interrupt</button>' +
    ' <button class="no" onclick="act(\\'' + s.id + '\\',\\'stop\\')">stop</button></li>'
  ).join('') || '<li class="muted">none yet</li>'
}
async function refreshApprovals() {
  const approvals = await j('/api/approvals')
  document.getElementById('approvals').innerHTML = approvals.map(a =>
    '<li><span class="warn">' + a.kind + '</span> <span class="muted">' + a.sessionId.slice(0, 8) + '</span> ' +
    '<code>' + JSON.stringify(a.payload).slice(0, 160) + '</code> ' +
    '<button class="ok" onclick="decide(\\'' + a.id + '\\',true)">allow</button> ' +
    '<button class="no" onclick="decide(\\'' + a.id + '\\',false)">deny</button></li>'
  ).join('') || '<li class="muted">none</li>'
}
async function refreshUsage() {
  const usage = await j('/api/usage')
  document.getElementById('usage').innerHTML = usage.map(u => {
    let bits = []
    if (u.claude) bits.push((u.claude.rateLimitType || 'window') + ': ' + (u.claude.status || '?') +
      (u.claude.resetsAt ? ', resets ' + new Date(u.claude.resetsAt * 1000).toLocaleString() : '') +
      (u.claude.isUsingOverage ? ' <span class="bad">USING OVERAGE</span>' : ''))
    if (u.codex) bits.push('weekly ' + (u.codex.usedPercent ?? '?') + '% used' +
      (u.codex.resetsAt ? ', resets ' + new Date(u.codex.resetsAt * 1000).toLocaleString() : '') +
      ', credits: ' + (u.codex.credits && u.codex.credits.hasCredits ? u.codex.credits.balance : 'none'))
    if (typeof u.totalCostUsd === 'number') bits.push('$' + u.totalCostUsd.toFixed(4) + ' this hub run')
    return '<li><b>' + u.profileId + '</b> <span class="muted">' + u.provider + '</span> — ' +
      (bits.join(' · ') || '<span class="muted">no data yet</span>') +
      (u.blocked ? ' <span class="bad">BLOCKED: ' + u.blockedReason + '</span>' : '') + '</li>'
  }).join('')
}
function pick(id) { document.getElementById('target').value = id }
async function act(id, verb) { await j('/api/sessions/' + id + '/' + verb, { method: 'POST' }); refreshSessions() }
async function decide(id, approve) {
  await j('/api/approvals/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve }) })
  refreshApprovals()
}
async function spawnSession() {
  const v = id => document.getElementById(id).value
  const body = { profileId: v('profile'), repo: v('repo') || undefined, cwd: v('cwd') || undefined,
    model: v('model') || undefined, effort: v('effort') || undefined, permissionMode: v('pmode') || undefined,
    prompt: v('prompt') || undefined }
  const out = await j('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (out.error) alert(out.error)
  refreshSessions()
}
async function sendInput() {
  const id = document.getElementById('target').value
  const text = document.getElementById('text').value
  if (!id || !text) return
  const out = await j('/api/sessions/' + id + '/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
  if (out.error) alert(out.error)
  document.getElementById('text').value = ''
}
function connectEvents() {
  const box = document.getElementById('events')
  const ws = new WebSocket('ws://' + location.host + '/ws?since=0')
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data)
    const line = document.createElement('div')
    const payload = JSON.stringify(ev.payload)
    line.innerHTML = '<span class="muted">' + ev.ts.slice(11, 19) + '</span> <span class="k">' + ev.kind + '</span> ' +
      (ev.sessionId ? '<span class="muted">' + ev.sessionId.slice(0, 8) + '</span> ' : '') +
      (payload.length > 300 ? payload.slice(0, 300) + '…' : payload)
    box.appendChild(line)
    box.scrollTop = box.scrollHeight
    if (ev.kind.startsWith('session/')) refreshSessions()
    if (ev.kind.startsWith('approval/')) refreshApprovals()
    if (ev.kind.startsWith('usage/')) refreshUsage()
  }
  ws.onclose = () => setTimeout(connectEvents, 2000)
}
loadProfiles(); refreshSessions(); refreshApprovals(); refreshUsage(); connectEvents()
setInterval(refreshUsage, 30000)
</script>
</body>
</html>`

function json(res: http.ServerResponse, value: unknown, status = 200): void {
  // A SECOND RESPONSE FOR ONE REQUEST MUST NOT KILL THE HUB.
  //
  // writeHead on a response that already sent headers throws ERR_HTTP_HEADERS_SENT. Thrown from inside a
  // request handler that is not awaited by anything, Node treats it as an uncaught exception and ends the
  // process — so one malformed exchange took down the whole hub, and with it every agent in the fleet.
  //
  // That is not hypothetical. It happened on the operator's machine: a handler streamed a response and the
  // catch-all then tried to write a JSON error over it, the hub exited code 1, and because that build
  // predated hubctl's reviveLiveHub the supervisor exited too. The app sat there with no hub, no error and
  // no recovery. Today's supervisor would respawn it — but a hub that survives is better than a hub that
  // is resurrected, because the resurrection still drops every in-flight turn.
  //
  // Double-responding is a bug wherever it happens, and this guard does not hide it: the request is
  // already answered, so the caller has its result, and the stray second write is what gets dropped.
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/**
 * A request body is CLIENT input, so a malformed one is a 400, not a 500.
 *
 * This used to `JSON.parse` unguarded, so `{ not json` threw out of the handler and the catch-all
 * answered 500 — "the server broke" for what is plainly a bad request. That misreads the fault, and it
 * puts an unhandled throw on the request path of a hub that agents drive automatically. This project
 * has already been bricked once by an unguarded JSON.parse (a malformed journal row crash-looping the
 * app), which is reason enough not to leave another one on a public route.
 *
 * {@link BadRequestError} is caught by the handler and turned into a 400.
 */
class BadRequestError extends Error {}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new BadRequestError(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`)
  }
  // A JSON body may legally be a string, number, or array; every caller here indexes it as an object,
  // so anything else would read as a silent bag of undefineds rather than an error.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestError('body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export class PayloadTooLargeError extends Error {}

/**
 * Read a raw upload with a real streaming limit. Content-Length is only an early rejection hint: a client
 * can omit or understate it, so every received chunk advances the authoritative byte count and buffering
 * stops immediately once that count crosses the cap.
 */
export function readRawBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > limit) {
    req.resume()
    return Promise.reject(new PayloadTooLargeError(`attachment exceeds the ${limit}-byte limit`))
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('aborted', onAborted)
      req.off('error', onError)
    }
    const fail = (err: Error, drain = false): void => {
      if (settled) return
      settled = true
      cleanup()
      if (drain) {
        req.on('error', () => {})
        req.resume()
      }
      reject(err)
    }
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.length
      if (total > limit) {
        fail(new PayloadTooLargeError(`attachment exceeds the ${limit}-byte limit`), true)
        return
      }
      chunks.push(bytes)
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks, total))
    }
    const onAborted = (): void => fail(new BadRequestError('upload was aborted'))
    const onError = (err: Error): void => fail(err)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('aborted', onAborted)
    req.on('error', onError)
  })
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BadRequestError(`${field} must be an array of ids`)
  }
  return value
}

// The hub has full control and (for now) no auth, so a browser request from an unknown web
// origin must be refused — otherwise any site the user visits could drive the loopback hub
// (spawn a full-access agent, read the journal). Allowed: no Origin (curl / non-browser /
// same-origin navigations), the packaged desktop app (tauri.localhost), and any LOOPBACK origin
// — the dev server, the hub's own served UI, and mesh peers, which all reach it via localhost.
// A drive-by page's Origin is its own domain, never loopback, so this closes the CSRF/RCE vector.
// (A real device token — DESIGN D12/D13.1 — is the follow-up; this is the immediate guard.)
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true
  if (origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost') return true
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

/**
 * Reject requests whose Host header isn't loopback (or the desktop origin). This is the companion
 * to the origin guard that closes DNS rebinding: an attacker page whose domain is rebound to
 * 127.0.0.1 still sends its OWN domain in Host, never `localhost` — and browsers omit Origin on
 * same-origin GETs, so the origin guard alone can't stop the read. A missing Host is refused.
 */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false
  const name = host.toLowerCase().replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1' || name === 'tauri.localhost'
}

/** Extract a device token from an Authorization: Bearer header or the x-hub-token header. */
function bearerToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const x = req.headers['x-hub-token']
  return typeof x === 'string' ? x : undefined
}

function attachmentDisposition(name: string): string {
  let unicode = ''
  let fallback = ''
  for (const char of name) {
    const point = char.codePointAt(0)!
    const scalar = point >= 0xd800 && point <= 0xdfff ? '\ufffd' : char
    unicode += scalar
    if (point < 0x20 || point > 0x7e || point === 0x7f) fallback += '_'
    else if (char === '"' || char === '\\') fallback += `\\${char}`
    else fallback += char
  }
  const encoded = encodeURIComponent(unicode).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${fallback || 'attachment'}"; filename*=UTF-8''${encoded}`
}

export interface ServerOptions {
  port: number
  defaultCwd: string
  /** The managed-profiles root (HUB_PROFILES_DIR or repo profiles/) — where the login flow creates a new
   *  profile dir. Threaded from index.ts so it stays in lockstep with where the hub SCANS profiles. */
  profilesDir: string
  journal: Journal
  sessions: SessionManager
  profiles: Profile[]
  approvals: ApprovalService
  usage: UsageMonitor
  projects: ProjectStore
  instructions: InstructionStore
  bus: AgentBus
  memory: MemoryStore
  practices: PracticeStore
  /** Live Danger Zone flags — the same object SessionManager reads; mutated + persisted on POST. */
  danger: DangerFlags
  /** Live owner preferences — same shared-reference trick as `danger`, so a change applies to the next
   *  chat without a restart. */
  prefs: HubPrefs
  rescanProfiles: () => Profile[]
  mesh: MeshSite
  deviceToken: string
  requireToken: boolean
  /** Extra remote ports to try when discovering peer hubs (config.mesh.peerPorts). See BuildFleetDeps. */
  meshPeerPorts?: readonly number[]
  /** Shared secret authenticating the Codex agent-tool bridge → hub calls (POST /internal/agent-tool).
   *  Undefined disables the route (no Codex bridge configured). Distinct from the device token. */
  agentToolSecret?: string
  /** Blue-green restart state (shared with RestartController): /api/health, the draining 503 guard,
   *  live-socket tracking so a retire can free the port, and the promote EADDRINUSE gate. */
  restartState: RestartState
  /** The execution seam (docs/agent-worker-impl.md §4.4). Only its `pushDanger?` is used here — to push a
   *  Danger Zone change to the worker's cached danger. In-process it has no pushDanger, so the call below
   *  is a no-op; flag-off behavior is unchanged. */
  executor: Executor
  /** THE path index.ts loaded config from (`<HUB_DATA_DIR ?? repoRoot/data>/config.json`), passed in
   *  rather than re-derived, so a persisted Danger Zone toggle lands in the file the hub actually reads
   *  back at boot. Deriving it here is what silently broke persistence in the installed app. */
  configPath: string
}

/**
 * Merge a top-level block into the hub's config.json (preserving every other key) so a setting the
 * operator changed survives a restart. Returns null on success, or the failure message.
 *
 * TAKES THE REAL CONFIG PATH, and this is the whole bug it exists to fix. Its caller used to derive its
 * own path as `<repoRoot>/data/config.json` while index.ts READ from `<dataDir>/config.json`, where
 * dataDir is `HUB_DATA_DIR ?? <repoRoot>/data`. Those agree only when HUB_DATA_DIR is unset — i.e. in
 * dev. The installed desktop app always sets it, so every Danger Zone toggle was written to a file the
 * hub never reads (and, from an installed app, to a repo directory that may not exist or be writable at
 * all — the best-effort catch then swallowed that silently). The operator flipped a switch, the UI echoed
 * it back because the in-memory flag really had changed, and the setting was gone on the next restart.
 * Every settings block goes through this one function so a second setting cannot reintroduce that bug
 * by hand-rolling its own read-merge-write.
 *
 * Assigns the block WHOLE rather than merging into the existing one: turning a flag off has to actually
 * turn it off, and a deep merge would leave the stale `true` in place.
 *
 * Best-effort by design — an unwritable config must never fail the operator's request — but it reports
 * the failure rather than swallowing it, so the caller can journal it under its own kind.
 */
function patchConfig(configPath: string, key: string, block: unknown): string | null {
  try {
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    } catch {
      /* no config yet — start fresh */
    }
    cfg[key] = block
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2))
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Persist the Danger Zone flags.
 *
 * Spreads the whole object rather than listing fields: `enableClaudeConnectors` was once simply left out
 * of a hand-written list and so reverted on every restart, even in dev. Adding a flag is exactly the
 * moment that silent failure would recur.
 *
 * The journal kind stays specific to this block — an operator reading the journal needs to know WHICH
 * setting will not survive the next restart, not merely that some write failed.
 */
export function persistDanger(configPath: string, danger: DangerFlags, journal: Journal): void {
  const err = patchConfig(configPath, 'danger', { ...danger })
  if (err) journal.append(null, 'config/danger-persist-failed', { path: configPath, message: err })
}

/** Persist the owner preferences. Same path, same best-effort contract, its own journal kind. */
export function persistPrefs(
  configPath: string,
  prefs: Pick<HubPrefs, 'chatNamePool' | 'steerMessagesAtToolBoundary'> & Partial<Pick<HubPrefs, 'fileWriteDiffDensity'>>,
  journal: Journal
): void {
  const err = patchConfig(configPath, 'prefs', { ...prefs })
  if (err) journal.append(null, 'config/prefs-persist-failed', { path: configPath, message: err })
}

export function startServer(opts: ServerOptions): http.Server {
  const { port, defaultCwd, profilesDir, journal, sessions, profiles, approvals, usage, projects, instructions, bus, memory, practices, danger, prefs, rescanProfiles, mesh, deviceToken, requireToken, meshPeerPorts, agentToolSecret, restartState, executor, configPath } = opts
  // Runtime repositories live beside the journal/config under HUB_DATA_DIR, never in the shipped hub
  // payload or profiles tree. GitHubImportService keeps auth entirely inside an existing `gh` session.
  const github = new GitHubImportService(
    path.join(path.dirname(configPath), 'repositories'),
    (name, projectPath) => projects.create(name, projectPath)
  )

  const server = http.createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const { method } = req
      const origin = req.headers.origin
      // Refuse browser requests from unknown web origins (drive-by CSRF/RCE guard — see
      // originAllowed). Non-browser and same-origin callers send no Origin and pass through.
      if (!originAllowed(origin)) {
        json(res, { error: 'forbidden origin' }, 403)
        return
      }
      // DNS-rebinding guard: the Host must be loopback/desktop (a rebound attacker domain isn't).
      if (!hostAllowed(req.headers.host)) {
        json(res, { error: 'forbidden host' }, 403)
        return
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
        res.setHeader('Access-Control-Allow-Headers', 'content-type, x-filename, authorization, x-hub-token')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      }
      if (method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      const authed = tokenMatches(deviceToken, bearerToken(req))
      // Public probe so an unpaired client can learn whether pairing is required (never gated).
      if (method === 'GET' && url.pathname === '/api/auth') {
        json(res, { requireToken, authed })
        return
      }
      // Public health probe — the supervisor health-checks a booting green hub with this before any
      // port handoff. `boot:'complete'` only once sessions.boot() has run (restartState.booted).
      if (method === 'GET' && url.pathname === '/api/health') {
        json(res, {
          boot: restartState.booted ? 'complete' : 'booting',
          restoredSessions: sessions.list().length,
          schemaVersion: SCHEMA_VERSION,
          pid: process.pid,
          // The port we are ACTUALLY listening on, not the boot port. A promoted green booted on an
          // ephemeral port (HUB_PORT=0) and then re-listened on the fixed public port, so the boot value
          // would report `0` for the rest of that hub's life (the known-broken health path in the alpha
          // plan — observed live on a promoted green). Falls back to the boot port before the listener is up.
          port: (server.address() as { port?: number } | null)?.port ?? port,
        })
        return
      }
      // Codex agent-tool bridge → hub. The stdio MCP bridge codex spawns per thread posts each tool
      // call here; the hub resolves the calling Codex session (by profileId + the bridge child's cwd)
      // and runs the shared tool body under that identity + the same ACL/gating as the Claude path.
      // Gated by the bridge secret (NOT the device token — this is a hub-internal loopback channel);
      // the origin/host guards above already require a loopback caller.
      if (method === 'POST' && url.pathname === '/internal/agent-tool') {
        if (!agentToolSecret || !tokenMatches(agentToolSecret, bearerToken(req))) {
          json(res, { error: 'forbidden' }, 403)
          return
        }
        const body = await readBody(req)
        const profileId = str(body.profileId)
        const cwd = str(body.cwd)
        const toolName = str(body.tool)
        if (!profileId || !cwd || !toolName) {
          json(res, { error: 'missing profileId, cwd, or tool' }, 400)
          return
        }
        const text = await sessions.execAgentTool(profileId, cwd, toolName, body.args)
        json(res, { text })
        return
      }
      // Device-token gate (opt-in). When on, every /api call must present a valid token.
      if (requireToken && !authed && url.pathname.startsWith('/api/')) {
        json(res, { error: 'device token required', requireToken: true }, 401)
        return
      }
      if (method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE)
        return
      }
      if (method === 'GET' && url.pathname === '/api/profiles') {
        // The manager also carries ~/.claude + ~/.codex as INTERNAL bindings so imported chats can
        // resume against their real vendor homes. They are not AllMyAgents accounts or spawn targets.
        json(res, pickableProfiles(sessions.listProfiles()))
        return
      }
      if (method === 'POST' && url.pathname === '/api/profiles/rescan') {
        rescanProfiles() // pick up any newly-added managed logins under profiles/*
        json(res, pickableProfiles(sessions.listProfiles()))
        return
      }
      // A profile's custom slash commands (<configDir>/commands/*.md) — the SAME files the Claude
      // Agent SDK expands at turn time. Feeds the composer's `/` command picker; the mapped built-ins
      // are added client-side (they're hub-feature actions, not on-disk files). Empty for a Codex
      // profile (no command dir) or an unknown id.
      const commandsMatch = /^\/api\/profiles\/([^/]+)\/commands$/.exec(url.pathname)
      if (method === 'GET' && commandsMatch) {
        json(res, sessions.listCommands(decodeURIComponent(commandsMatch[1] as string)))
        return
      }
      // One-click add-account: launches the vendor login in a visible terminal, then
      // long-polls until the credentials file appears (login done) or times out.
      if (method === 'POST' && url.pathname === '/api/accounts/login') {
        const body = await readBody(req)
        const provider = body.provider
        const name = String(body.name ?? '')
        if (provider !== 'claude' && provider !== 'codex') {
          json(res, { ok: false, error: 'provider must be claude|codex' }, 400)
          return
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          json(res, { ok: false, error: 'name must match ^[a-zA-Z0-9_-]+$' }, 400)
          return
        }
        const profileDir = path.join(profilesDir, name)
        if (credentialsExist(provider as Provider, profileDir)) {
          json(res, { ok: false, error: `profiles/${name} already has ${provider} credentials` }, 409)
          return
        }
        if (!startLogin(provider as Provider, profileDir)) {
          // No reliable way to pop a visible terminal here (Linux/other — Windows and macOS both
          // launch one); hand back the manual command so the operator can finish the flow by hand.
          json(
            res,
            {
              ok: false,
              platform: process.platform,
              manual: `pnpm login:${provider} profiles/${name}`,
              error:
                'auto-launch is available on Windows and macOS — run the manual command in a terminal, then Rescan accounts',
            },
            501
          )
          return
        }
        // Cap under any inbound-request timeout so the long-poll response always lands.
        const added = await awaitLogin(provider as Provider, profileDir, { timeoutMs: 270_000 })
        if (added) {
          const list = rescanProfiles()
          const profile = list.find((p) => p.id === name)
          json(res, { ok: true, added: profile?.id ?? name, provider })
        } else {
          json(res, {
            ok: false,
            launched: true,
            timedOut: true,
            manual: `pnpm login:${provider} profiles/${name}`,
            error: 'login not detected in time — finish the sign-in in the opened window, then click Rescan accounts',
          })
        }
        return
      }
      if (method === 'POST' && url.pathname === '/api/pick-folder') {
        const picked = await pickFolder()
        json(res, { path: picked })
        return
      }
      if (method === 'GET' && url.pathname === '/api/projects') {
        json(res, projects.list())
        return
      }
      // Optional GitHub import. Capability detection is intentionally lazy: a GitHub-less/offline first
      // run never invokes `gh`, makes a network request, or waits on this feature.
      if (method === 'GET' && url.pathname === '/api/github/capability') {
        json(res, await github.capability())
        return
      }
      if (method === 'GET' && url.pathname === '/api/github/repositories') {
        try {
          json(res, await github.repositories())
        } catch (error) {
          json(res, { error: error instanceof Error ? error.message : String(error) }, 503)
        }
        return
      }
      if (method === 'POST' && url.pathname === '/api/github/clones') {
        const body = await readBody(req)
        try {
          json(res, github.start(String(body.nameWithOwner ?? '')), 202)
        } catch (error) {
          json(res, { error: error instanceof Error ? error.message : String(error) }, 400)
        }
        return
      }
      const githubCloneMatch = /^\/api\/github\/clones\/([^/]+)$/.exec(url.pathname)
      if (method === 'GET' && githubCloneMatch) {
        const job = github.job(githubCloneMatch[1] as string)
        if (!job) {
          json(res, { error: 'GitHub clone job not found.' }, 404)
          return
        }
        json(res, job)
        return
      }
      if (method === 'POST' && url.pathname === '/api/projects') {
        const body = await readBody(req)
        const project = projects.create(String(body.name ?? ''), String(body.path ?? ''))
        json(res, project)
        return
      }
      // Project import — PREVIEW: scan a folder for existing Claude/Codex conversations across every
      // profile whose recorded cwd belongs to it. Read-only (bounded head reads); nothing is written
      // or sent anywhere. Body-based (not a query string) to match /api/projects + Windows paths.
      if (method === 'POST' && url.pathname === '/api/projects/scan') {
        const body = await readBody(req)
        const p = str(body.path)
        if (!p) {
          json(res, { error: 'path required' }, 400)
          return
        }
        json(res, await sessions.scanForImport(p))
        return
      }
      // Project import — COMMIT: adopt the selected vendor chats as hub sessions under the project.
      // They appear in the sidebar (auto-named, filed under the project) over the same /ws path a
      // native session uses, and resume the real vendor transcript on first send.
      const importMatch = /^\/api\/projects\/([^/]+)\/import$/.exec(url.pathname)
      if (method === 'POST' && importMatch) {
        const project = projects.get(importMatch[1] as string)
        if (!project) {
          json(res, { error: `unknown project: ${importMatch[1]}` }, 404)
          return
        }
        const body = await readBody(req)
        const ids = Array.isArray(body.vendorSessionIds)
          ? body.vendorSessionIds.filter((x): x is string => typeof x === 'string')
          : []
        const result = await sessions.importChats(project.id, project.path, ids)
        json(res, result)
        return
      }
      // A project's EXECUTABLE config (MCP servers + hooks) and whether it is currently approved to run.
      // Read-only; surfaces the actual commands (not just names) so the operator can decide, and reports
      // `trusted` by comparing the on-disk fingerprint to the approved one (so an edited/swapped config
      // reads untrusted even if it was approved before). This is the "show what's being imported" surface.
      const configMatch = /^\/api\/projects\/([^/]+)\/config$/.exec(url.pathname)
      if (method === 'GET' && configMatch) {
        const project = projects.get(configMatch[1] as string)
        if (!project) {
          json(res, { error: `unknown project: ${configMatch[1]}` }, 404)
          return
        }
        const config = readProjectConfig(project.path)
        json(res, {
          config, // includes config.unmodeled (why it can't be approved) + config.fingerprint
          fingerprint: config.fingerprint,
          hasExecutableConfig: config.fingerprint !== null,
          // Cannot be approved while non-empty: the config has surfaces we can't fully verify (fail closed).
          unverifiable: config.unmodeled,
          approvedFingerprint: projects.approvedFingerprint(project.id) ?? null,
          // Assessed against the project dir here (a view). The AUTHORITATIVE per-turn check runs against
          // the session's real cwd (isConfigTrusted(id, record.cwd)) in specOf.
          trusted: projects.isConfigTrusted(project.id, project.path),
        })
        return
      }
      // Operator APPROVES a project's current executable config (the authenticated operator action IS the
      // consent — no gate here, mirroring /api/restart). Pins the approval to the config's content
      // fingerprint, so it survives a move but breaks on a swap/edit. REFUSED when the config has surfaces
      // we cannot fully verify (config.unmodeled) — approving those would falsely assure the operator that
      // what they saw is what runs. Until an approval exists, adapters/claude.ts gates the project's MCP + hooks.
      const approveMatch = /^\/api\/projects\/([^/]+)\/approve-config$/.exec(url.pathname)
      if (method === 'POST' && approveMatch) {
        const project = projects.get(approveMatch[1] as string)
        if (!project) {
          json(res, { error: `unknown project: ${approveMatch[1]}` }, 404)
          return
        }
        const config = readProjectConfig(project.path)
        const result = projects.approveConfig(project.id)
        if (result.unverifiable.length > 0) {
          journal.append(null, 'project/config-approve-refused', { projectId: project.id, unverifiable: result.unverifiable })
          json(
            res,
            { approved: false, error: 'cannot approve: this project has configuration this version cannot fully verify', unverifiable: result.unverifiable },
            409
          )
          return
        }
        journal.append(null, 'project/config-approved', {
          projectId: project.id,
          fingerprint: result.fingerprint,
          mcpServers: config.mcpServers.map((s) => ({ name: s.name, command: s.command })),
          hookCommands: config.hookCommands,
        })
        json(res, { approved: result.approved, fingerprint: result.fingerprint, config })
        return
      }
      const revokeConfigMatch = /^\/api\/projects\/([^/]+)\/revoke-config$/.exec(url.pathname)
      if (method === 'POST' && revokeConfigMatch) {
        const project = projects.get(revokeConfigMatch[1] as string)
        if (!project) {
          json(res, { error: `unknown project: ${revokeConfigMatch[1]}` }, 404)
          return
        }
        projects.revokeConfig(project.id)
        journal.append(null, 'project/config-revoked', { projectId: project.id })
        json(res, { ok: true })
        return
      }
      // Operator profile + scoped instructions, materialized into each agent at spawn.
      if (method === 'GET' && url.pathname === '/api/instructions') {
        json(res, instructions.list())
        return
      }
      if (method === 'POST' && url.pathname === '/api/instructions') {
        const body = await readBody(req)
        const scope = str(body.scope)
        if (!scope) {
          json(res, { error: 'scope required' }, 400)
          return
        }
        instructions.set(scope, String(body.content ?? ''))
        json(res, instructions.list())
        return
      }
      // Agent-authored practices — operator review surface. GET lists them (optionally filtered by
      // ?scope=) with provenance so the owner can audit what the fleet has taught itself; the revoke
      // route below deletes one. Practices are WRITTEN by agents (via the gated practice_* tools),
      // never here — this is visibility + kill-switch, per the safe-defaults model.
      if (method === 'GET' && url.pathname === '/api/practices') {
        const scope = str(url.searchParams.get('scope') ?? undefined)
        json(res, practices.list({ scopes: scope ? [scope] : undefined }))
        return
      }
      const practiceRevokeMatch = /^\/api\/practices\/([^/]+)\/revoke$/.exec(url.pathname)
      if (method === 'POST' && practiceRevokeMatch) {
        const pid = practiceRevokeMatch[1] as string
        const existing = practices.get(pid)
        practices.remove(pid)
        // Journal the revoke (append-only audit) even though the row is hard-deleted.
        journal.append(null, 'practice/revoked', { id: pid, scope: existing?.scope ?? null, title: existing?.title ?? null })
        json(res, { ok: !!existing }, existing ? 200 : 404)
        return
      }
      // Owner preferences — ordinary settings with no safety dimension, so they get their own route
      // rather than riding on /api/config/danger:
      // putting a cosmetic choice behind the Danger Zone's deliberate reveal would misrepresent both.
      // Same shape as the danger routes otherwise — POST mutates the shared object in place, so the next
      // chat is named from the new pool without a restart, then persists it to the hub's real config.
      if (method === 'GET' && url.pathname === '/api/config/prefs') {
        json(res, { ...prefs })
        return
      }
      if (method === 'POST' && url.pathname === '/api/config/prefs') {
        const body = await readBody(req)
        // Same shape check the danger route does on its booleans: a value the generator does not
        // understand is IGNORED, not coerced. Coercing would let a malformed or version-skewed request
        // quietly reset a pool the owner did choose, back through the default, to 'everyone'.
        if (body.chatNamePool === 'women' || body.chatNamePool === 'everyone') prefs.chatNamePool = body.chatNamePool
        if (typeof body.steerMessagesAtToolBoundary === 'boolean') {
          prefs.steerMessagesAtToolBoundary = body.steerMessagesAtToolBoundary
        }
        if (
          body.fileWriteDiffDensity === 'minimal'
          || body.fileWriteDiffDensity === 'summary'
          || body.fileWriteDiffDensity === 'verbose'
        ) {
          prefs.fileWriteDiffDensity = asFileWriteDiffDensity(body.fileWriteDiffDensity)
        }
        persistPrefs(configPath, prefs, journal)
        journal.append(null, 'config/prefs', { ...prefs })
        json(res, { ...prefs })
        return
      }
      // Danger Zone toggles — safe-default guardrail switches the owner can flip (this is an MIT,
      // single-owner tool). GET reads the live flags; POST merges + persists them to data/config.json
      // and mutates the shared object in place so SessionManager's gating sees the change immediately.
      if (method === 'GET' && url.pathname === '/api/config/danger') {
        json(res, { ...danger })
        return
      }
      if (method === 'POST' && url.pathname === '/api/config/danger') {
        const body = await readBody(req)
        if (typeof body.disableWorktreeCollisionWarnings === 'boolean') {
          danger.disableWorktreeCollisionWarnings = body.disableWorktreeCollisionWarnings
        }
        if (typeof body.busCanUseRiskyTools === 'boolean') danger.busCanUseRiskyTools = body.busCanUseRiskyTools
        if (typeof body.autoApprovePractices === 'boolean') danger.autoApprovePractices = body.autoApprovePractices
        if (typeof body.autoApproveRestart === 'boolean') danger.autoApproveRestart = body.autoApproveRestart
        if (typeof body.fullAccessAnyOrigin === 'boolean') danger.fullAccessAnyOrigin = body.fullAccessAnyOrigin
        if (typeof body.enableClaudeConnectors === 'boolean') {
          danger.enableClaudeConnectors = body.enableClaudeConnectors
          // Re-apply to managed claude profiles' settings.json so the SDK picks up the change on the next
          // turn (managed profiles only — never ~/.claude). Best-effort; safe default is OFF (suppressed).
          setClaudeConnectorPolicy(profiles, body.enableClaudeConnectors)
        }
        persistDanger(configPath, danger, journal)
        // Keep the worker's cached danger() live in worker mode (§4.4). No-op in-process (the in-process
        // executor reads the shared `danger` object directly and implements no pushDanger).
        executor.pushDanger?.(danger)
        journal.append(null, 'config/danger', { ...danger })
        json(res, { ...danger })
        return
      }
      // Operator "Restart hub" (Settings → Maintenance). The authenticated operator action IS the
      // approval, so no gate here (the danger gate is only on the AGENT restart_hub tool). Forwards to
      // the hubctl supervisor via the injected signal; 503 when unsupervised (plain/standalone hub).
      if (method === 'POST' && url.pathname === '/api/restart') {
        const body = await readBody(req)
        const accepted = sessions.requestRestart(str(body.reason) || 'operator requested', undefined)
        if (!accepted) {
          json(res, { error: 'restart unavailable — hub is not running under the supervisor' }, 503)
          return
        }
        json(res, { accepted: true }, 202)
        return
      }
      // Shared agent memory — operator view (all scopes unless ?scope=), and curate notes.
      if (method === 'GET' && url.pathname === '/api/memory') {
        const scope = str(url.searchParams.get('scope') ?? undefined)
        const q = str(url.searchParams.get('q') ?? undefined)
        const scopes = scope ? [scope] : undefined
        json(res, q ? memory.search(q, { scopes }) : memory.list({ scopes }))
        return
      }
      if (method === 'POST' && url.pathname === '/api/memory') {
        const body = await readBody(req)
        const scope = str(body.scope)
        const title = str(body.title)
        const bodyText = str(body.body)
        if (!scope || !title || !bodyText) {
          json(res, { error: 'scope, title, body required' }, 400)
          return
        }
        const tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined
        json(res, memory.write({ scope, title, body: bodyText, tags }))
        return
      }
      // Inter-agent bus history — operator visibility (the transcript itself renders from journal events).
      if (method === 'GET' && url.pathname === '/api/bus') {
        json(res, bus.history({ project: str(url.searchParams.get('project') ?? undefined), sessionId: str(url.searchParams.get('session') ?? undefined) }))
        return
      }
      if (method === 'GET' && url.pathname === '/api/sessions') {
        json(res, sessions.listForApi())
        return
      }
      if (method === 'GET' && url.pathname === '/api/approvals') {
        json(res, approvals.pending())
        return
      }
      if (method === 'GET' && url.pathname === '/api/usage') {
        json(res, usage.list())
        return
      }
      if (method === 'GET' && url.pathname === '/api/stats') {
        json(res, computeStats(journal.db, projects))
        return
      }
      // Mesh site status — lets the UI show the address other fleet PCs use to reach this hub.
      // Includes the device token when the caller is local/authed, so it can be copied to pair
      // another device (withheld from unauthenticated callers once enforcement is on).
      if (method === 'GET' && url.pathname === '/api/mesh') {
        json(res, { ...mesh.status(), requireToken, token: !requireToken || authed ? deviceToken : undefined })
        return
      }
      // Unified-across-mesh fleet roster (read-only, first cut — docs/mesh-unified-fleet.md). Always
      // returns THIS hub as the local entry. Peer ports come from presence-advertised sites in the
      // node's session snapshot, so non-default ports are exact and no-hub machines get no map/probe.
      // `/api/health` distinguishes an online hub from a cached advert for a sleeping machine.
      // Fail-soft + fast with no node/no peers; gated by requireToken like every /api/* route.
      if (method === 'GET' && url.pathname === '/api/fleet') {
        const m = mesh.status()
        const sites = await buildFleet({
          localSiteId: m.siteId,
          localLabel: m.label,
          localBaseUrl: `http://127.0.0.1:${m.port}`,
          roster: () => mesh.ownedRoster(),
          peerSites: () => mesh.peerSites(),
          siteMap: (node, p) => mesh.siteMap(node, p),
          probeHealth: (baseUrl) => probeHubHealth(baseUrl, 1500),
          extraPorts: meshPeerPorts,
        })
        json(res, sites)
        return
      }
      // Runtime toggle for exposing the hub as an AllMyStuff site. Registers/deregisters to match.
      if (method === 'POST' && url.pathname === '/api/mesh') {
        const body = await readBody(req)
        const status = await mesh.setEnabled(body.enable === true)
        journal.append(null, 'mesh/site', status)
        json(res, status)
        return
      }
      if (method === 'POST' && url.pathname === '/api/usage/refresh') {
        await usage.refreshNow()
        json(res, usage.list())
        return
      }
      if (method === 'GET' && url.pathname === '/api/events') {
        // Page the full backlog from `since` (not just the first 2000 rows) so a caller polling
        // over HTTP gets the same complete, gap-free history the WS replay delivers.
        json(res, [...journal.replay(Number(url.searchParams.get('since') ?? 0))])
        return
      }
      if (method === 'POST' && url.pathname === '/api/sessions') {
        // Don't let a create land on a hub that's retiring in a blue-green flip — it would spawn a
        // vendor child about to be killed. The client retries against green after the ~sub-second flip.
        if (restartState.draining) {
          json(res, { error: 'restarting' }, 503)
          return
        }
        const body = await readBody(req)
        const initialAttachments = stringArray(body.attachments, 'attachments')
        if (initialAttachments.length) {
          // Uploads are session-owned and the upload route therefore needs the server-generated id.
          // Refuse instead of pretending create-with-prompt consumed ids that cannot yet belong to it;
          // clients create the empty session, upload to its id, then POST /input as the first prompt.
          throw new BadRequestError('create the session before uploading attachments, then send the first prompt via /input')
        }
        const pm = str(body.permissionMode)
        // Validate the profile HERE rather than letting sessions.create throw into the catch-all. An
        // unknown profile id is a bad request — the caller named an account that does not exist — and
        // answering 500 told the UI the hub had broken, which is both wrong and unactionable. The list
        // is included because the realistic causes are a typo and a stale client whose account list
        // predates a rescan, and both are answered by seeing what actually exists.
        const requestedProfile = String(body.profileId ?? '')
        if (!profiles.some((p) => p.id === requestedProfile)) {
          json(
            res,
            { error: `unknown profile: ${requestedProfile || '(none given)'}`, known: profiles.map((p) => p.id) },
            400
          )
          return
        }
        const record = await sessions.create(requestedProfile, {
          cwd: str(body.cwd),
          repo: str(body.repo),
          projectId: str(body.projectId),
          prompt: str(body.prompt),
          model: str(body.model),
          effort: str(body.effort),
          serviceTier: str(body.serviceTier),
          permissionMode: pm === 'safe' || pm === 'edits' || pm === 'full' ? pm : undefined,
          useWorktree: typeof body.useWorktree === 'boolean' ? body.useWorktree : undefined,
        })
        json(res, record)
        return
      }
      const attachmentUploadMatch = /^\/api\/sessions\/([^/]+)\/attachments$/.exec(url.pathname)
      if (method === 'POST' && attachmentUploadMatch) {
        const sessionId = attachmentUploadMatch[1] as string
        if (!sessions.list().some((record) => record.id === sessionId)) {
          json(res, { error: `unknown session: ${sessionId}` }, 404)
          return
        }
        const rawName = req.headers['x-filename']
        if (typeof rawName !== 'string' || !rawName.trim()) throw new BadRequestError('x-filename is required')
        const mime = String(req.headers['content-type'] ?? 'application/octet-stream')
          .split(';', 1)[0]!
          .trim()
          .toLowerCase() || 'application/octet-stream'
        if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) || mime.length > 255) {
          throw new BadRequestError('content-type must be a valid media type')
        }
        const bytes = await readRawBody(req, attachmentLimitForMime(mime))
        if (bytes.length === 0) throw new BadRequestError('attachment is empty')
        json(res, await sessions.storeAttachment(sessionId, rawName, mime, bytes))
        return
      }
      const attachmentGetMatch = /^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname)
      if (method === 'GET' && attachmentGetMatch) {
        const attachment = sessions.attachment(attachmentGetMatch[1] as string, attachmentGetMatch[2] as string)
        if (!attachment) {
          json(res, { error: 'attachment not found' }, 404)
          return
        }
        // Only inert raster formats render inside the privileged hub origin. SVG stays a download even
        // though it is `image/*`: it can execute script, so adding it to this allowlist would hand an upload
        // the same-origin authority to spawn agents, read journals, and change settings.
        const inline = isClaudeImageMime(attachment.mime)
        res.writeHead(200, {
          'content-type': attachment.mime,
          'content-length': attachment.size,
          'content-disposition': inline ? 'inline' : attachmentDisposition(attachment.name),
          'content-security-policy': "default-src 'none'; sandbox",
          'x-content-type-options': 'nosniff',
        })
        try {
          await pipeline(fs.createReadStream(attachment.path), res)
        } catch (err) {
          // A client can cancel a large image after headers are sent. Do not let the catch-all attempt a
          // second JSON response (ERR_HTTP_HEADERS_SENT); close this response and keep the hub healthy.
          if (!res.headersSent) throw err
          res.destroy()
        }
        return
      }
      const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(url.pathname)
      if (method === 'POST' && approvalMatch) {
        const body = await readBody(req)
        const found = approvals.resolve(approvalMatch[1] as string, body.approve === true)
        json(res, { ok: found }, found ? 200 : 404)
        return
      }
      const modeMatch = /^\/api\/sessions\/([^/]+)\/mode$/.exec(url.pathname)
      if (method === 'POST' && modeMatch) {
        const body = await readBody(req)
        const m = str(body.permissionMode)
        if (m !== 'safe' && m !== 'edits' && m !== 'full') {
          json(res, { error: 'permissionMode must be safe|edits|full' }, 400)
          return
        }
        sessions.setMode(modeMatch[1] as string, m)
        json(res, { ok: true })
        return
      }
      // Operator control-plane only: there is deliberately no corresponding agent tool. The role marker
      // is the trust boundary that unlocks spawn_agent; models may consume it but can never promote a
      // session. Every grant/revoke is persisted on the session record and journaled by SessionManager.
      const managerMatch = /^\/api\/sessions\/([^/]+)\/project-manager$/.exec(url.pathname)
      if (method === 'POST' && managerMatch) {
        // This role grant is stronger than ordinary local API writes, so it always requires the owner
        // device capability even when broad local API token enforcement is disabled.
        if (!authed) {
          json(res, { error: 'operator device token required' }, 403)
          return
        }
        const body = await readBody(req)
        if (typeof body.enabled !== 'boolean') {
          json(res, { error: 'enabled must be boolean' }, 400)
          return
        }
        const rawDelegation = stringArray(body.delegation, 'delegation')
        const allowedProfiles = stringArray(body.allowedProfiles, 'allowedProfiles')
        const rawAllowedModels = body.allowedModels
        const allowedModels: Record<string, string[]> = {}
        if (rawAllowedModels !== undefined) {
          if (!rawAllowedModels || typeof rawAllowedModels !== 'object' || Array.isArray(rawAllowedModels)) {
            json(res, { error: 'allowedModels must map profile ids to model lists' }, 400)
            return
          }
          for (const [profileId, models] of Object.entries(rawAllowedModels as Record<string, unknown>)) {
            if (!Array.isArray(models) || models.some((model) => typeof model !== 'string')) {
              json(res, { error: `allowedModels.${profileId} must be a list of model names` }, 400)
              return
            }
            allowedModels[profileId] = models as string[]
          }
        }
        const allowedTools = stringArray(body.allowedTools, 'allowedTools')
        if (rawDelegation.some((authority) => authority !== 'commit' && authority !== 'push')) {
          json(res, { error: 'delegation may contain only commit and push' }, 400)
          return
        }
        const max =
          body.maxLiveChildren === undefined ? undefined : Number(body.maxLiveChildren)
        if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 16)) {
          json(res, { error: 'maxLiveChildren must be a whole number from 1 to 16' }, 400)
          return
        }
        const record = sessions.configureProjectManager(
          managerMatch[1] as string,
          {
            enabled: body.enabled,
            maxLiveChildren: max,
            delegation: rawDelegation as Array<'commit' | 'push'>,
            allowedProfiles,
            allowedModels,
            allowedTools,
          },
          'operator'
        )
        json(res, record)
        return
      }
      // "Always allow <tool> in this chat" / its undo. The approval prompt only ever offered approve-once,
      // so a long task re-prompted for the same tool forever and any missed prompt failed closed. The grant
      // is read by sessions.isAutoApproved via the hub's approval policy, so it applies to the very next
      // tool call — including one already mid-turn — with no worker respawn.
      const allowToolMatch = /^\/api\/sessions\/([^/]+)\/allow-tool$/.exec(url.pathname)
      if (method === 'POST' && allowToolMatch) {
        const body = await readBody(req)
        const toolName = str(body.toolName)
        if (!toolName) {
          json(res, { error: 'toolName is required' }, 400)
          return
        }
        const record =
          body.allow === false
            ? sessions.disallowTool(allowToolMatch[1] as string, toolName)
            : sessions.allowTool(allowToolMatch[1] as string, toolName)
        json(res, record)
        return
      }
      // Per-chat model / thinking effort / service tier, written through the moment it is picked so the
      // choice belongs to the RECORD (surviving a pane switch, an app reload, and a hub restart) rather
      // than to the composer component. specOf feeds these to both vendors. '' clears back to default.
      const settingsMatch = /^\/api\/sessions\/([^/]+)\/settings$/.exec(url.pathname)
      if (method === 'POST' && settingsMatch) {
        const body = await readBody(req)
        const patch: { model?: string; effort?: string; serviceTier?: string } = {}
        if (body.model !== undefined) patch.model = String(body.model ?? '')
        if (body.effort !== undefined) patch.effort = String(body.effort ?? '')
        if (body.serviceTier !== undefined) patch.serviceTier = String(body.serviceTier ?? '')
        json(res, sessions.setSettings(settingsMatch[1] as string, patch))
        return
      }
      // Mandatory synchronous gate for a Project Manager (or future push UI): do not begin an
      // integration operation until this returns 200. A 409 names the exact stale files/commits; the
      // check itself never rebases, merges, pushes, pauses, or otherwise touches the agent worktree.
      const integrationCheckMatch = /^\/api\/sessions\/([^/]+)\/integration-check$/.exec(url.pathname)
      if (method === 'POST' && integrationCheckMatch) {
        const result = await sessions.checkWorktreeIntegration(integrationCheckMatch[1] as string)
        json(res, result, result.ok ? 200 : 409)
        return
      }
      const steerMatch = /^\/api\/sessions\/([^/]+)\/steer$/.exec(url.pathname)
      if (method === 'POST' && steerMatch) {
        const body = await readBody(req)
        await sessions.steer(
          steerMatch[1] as string,
          String(body.text ?? ''),
          stringArray(body.attachments, 'attachments')
        )
        json(res, { ok: true })
        return
      }
      // On-demand context compaction (the `/compact` built-in). Honest stub: no driver exposes a
      // programmatic compaction trigger yet (see SessionManager.compact for the spike write-up), so
      // this reports { supported: false, reason } and the UI surfaces that instead of silently
      // no-op'ing. 501 so a caller can feature-detect. TODO(compaction): wire when a driver ships it.
      const compactMatch = /^\/api\/sessions\/([^/]+)\/compact$/.exec(url.pathname)
      if (method === 'POST' && compactMatch) {
        const result = await sessions.compact(compactMatch[1] as string)
        json(res, result, result.supported ? 200 : 501)
        return
      }
      // Rename a session (auto-naming override). sanitizeTitle in rename() is the trust boundary.
      const titleMatch = /^\/api\/sessions\/([^/]+)\/title$/.exec(url.pathname)
      if (method === 'POST' && titleMatch) {
        const body = await readBody(req)
        const t = str(body.title)
        if (!t) {
          json(res, { error: 'title required' }, 400)
          return
        }
        sessions.rename(titleMatch[1] as string, t)
        json(res, { ok: true })
        return
      }
      // On-demand vendor transcript history for an imported chat (bounded tail; `before` byte cursor
      // pages older). Read-only; empty for hub-native sessions (their history replays over the WS).
      const historyMatch = /^\/api\/sessions\/([^/]+)\/history$/.exec(url.pathname)
      if (method === 'GET' && historyMatch) {
        try {
          const before = url.searchParams.get('before')
          const page = await sessions.readHistory(historyMatch[1] as string, {
            beforeByte: before && before !== '' ? Number(before) : undefined,
          })
          json(res, page)
        } catch (e) {
          json(res, { error: e instanceof Error ? e.message : 'history failed' }, 404)
        }
        return
      }
      const deleteMatch = /^\/api\/sessions\/([^/]+)\/delete$/.exec(url.pathname)
      if (method === 'POST' && deleteMatch) {
        const result = await sessions.delete(deleteMatch[1] as string)
        json(res, result, result.ok ? 200 : 404)
        return
      }
      const agentInterrupt = /^\/api\/sessions\/([^/]+)\/agents\/interrupt$/.exec(url.pathname)
      if (method === 'POST' && agentInterrupt) {
        const body = await readBody(req)
        const targetId = str(body.targetId)
        if (!targetId) throw new BadRequestError('sub-agent targetId is required')
        await sessions.interruptAgent(agentInterrupt[1] as string, targetId, str(body.label))
        json(res, { ok: true })
        return
      }
      const sessionAction = /^\/api\/sessions\/([^/]+)\/(input|interrupt|stop|reopen)$/.exec(url.pathname)
      if (method === 'POST' && sessionAction) {
        const id = sessionAction[1] as string
        const verb = sessionAction[2] as string
        if (verb === 'input') {
          const body = await readBody(req)
          await sessions.send(
            id,
            String(body.text ?? ''),
            {
              model: str(body.model),
              effort: body.effort === undefined ? undefined : String(body.effort),
              serviceTier: body.serviceTier === undefined ? undefined : String(body.serviceTier),
            },
            stringArray(body.attachments, 'attachments')
          )
        } else if (verb === 'interrupt') {
          await sessions.interrupt(id)
        } else if (verb === 'reopen') {
          // The inverse of stop(): revive a stopped/errored session to idle so it's usable + bus-reachable
          // again. Returns the resulting status so the caller can confirm the transition (404 if unknown id).
          const r = sessions.reopen(id)
          json(res, r, r.ok ? 200 : 404)
          return
        } else {
          await sessions.stop(id)
        }
        json(res, { ok: true })
        return
      }
      json(res, { error: 'not found' }, 404)
    } catch (err) {
      // Bad input is the CLIENT's fault: answer 400 so a caller can tell "I sent nonsense" from "the
      // hub is broken". Reserving 500 for genuine server faults also keeps it meaningful as a signal —
      // a 500 in the log should be worth investigating, not routine noise from a fuzzed route.
      if (err instanceof BadRequestError) {
        json(res, { error: err.message }, 400)
        return
      }
      if (err instanceof PayloadTooLargeError) {
        json(res, { error: err.message }, 413)
        return
      }
      if (err instanceof AttachmentInputError) {
        json(res, { error: err.message }, 400)
        return
      }
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  // Same origin guard for the event stream — a foreign page must not be able to open /ws and
  // read the journal. Non-browser clients (no Origin) and loopback/desktop origins are allowed.
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info: { origin?: string; req: http.IncomingMessage }) => {
      if (!originAllowed(info.origin)) return false
      if (!hostAllowed(info.req.headers.host)) return false
      if (!requireToken) return true
      const wsUrl = new URL(info.req.url ?? '/ws', 'http://localhost')
      return tokenMatches(deviceToken, wsUrl.searchParams.get('token') ?? undefined)
    },
  })
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/ws', 'http://localhost')
    // Replay the ENTIRE backlog from `since` (paged inside replay() so a huge journal isn't loaded
    // at once), then attach the live listener — all synchronously, with no `await` between the last
    // replayed event and journal.on(), so no live event can slip into the gap or be sent twice. The
    // client additionally dedups on seq <= lastSeq, covering any reconnect overlap.
    for (const event of journal.replay(Number(url.searchParams.get('since') ?? 0))) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
    }
    const listener = (event: HubEvent): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
    }
    journal.on('event', listener)
    ws.on('close', () => journal.off('event', listener))
  })

  // Track live sockets so a blue-green drain can destroy them and free the fixed port promptly (WS
  // connections are long-lived and would otherwise keep the listener open). See RestartController.drain.
  server.on('connection', (socket) => {
    restartState.sockets.add(socket)
    socket.on('close', () => restartState.sockets.delete(socket))
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // During a promote re-listen the RestartController's own once('error') handler owns this (it
      // signals promote-failed → the supervisor rolls back to blue). Don't also exit here.
      if (restartState.promoting) return
      console.error(`[hub] port ${port} is already in use — is another hub instance running? (set HUB_PORT to override)`)
      process.exit(1)
    }
    throw err
  })
  server.listen(port, '127.0.0.1')
  return server
}
