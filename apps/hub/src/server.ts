import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
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
import { startLogin, awaitLogin, credentialsExist } from './loginLauncher.js'
import type { DangerFlags, HubEvent, Profile, Provider } from './types.js'

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
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
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

export interface ServerOptions {
  port: number
  defaultCwd: string
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
  rescanProfiles: () => Profile[]
  mesh: MeshSite
  deviceToken: string
  requireToken: boolean
}

// Merge the Danger Zone flags into data/config.json (preserving every other config key) so a toggle
// survives a hub restart. Best-effort — a persist failure leaves the in-memory flag set (live) but
// unsaved; it never throws into the request path.
function persistDanger(repoRoot: string, danger: DangerFlags): void {
  try {
    const p = path.join(repoRoot, 'data', 'config.json')
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    } catch {
      /* no config yet — start fresh */
    }
    cfg.danger = { busCanUseRiskyTools: danger.busCanUseRiskyTools, autoApprovePractices: danger.autoApprovePractices }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
  } catch {
    /* persistence is best-effort */
  }
}

export function startServer(opts: ServerOptions): http.Server {
  const { port, defaultCwd, journal, sessions, profiles, approvals, usage, projects, instructions, bus, memory, practices, danger, rescanProfiles, mesh, deviceToken, requireToken } = opts
  // Same location index.ts scans for profiles (repoRoot/profiles); defaultCwd is repoRoot.
  const profilesDir = path.join(defaultCwd, 'profiles')

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
        res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
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
        // The manager's view = managed profiles/* PLUS the registered default vendor homes, so the
        // user's main ~/.claude / ~/.codex accounts (which imported chats bind to) show in the picker.
        json(res, sessions.listProfiles())
        return
      }
      if (method === 'POST' && url.pathname === '/api/profiles/rescan') {
        rescanProfiles() // pick up any newly-added managed logins under profiles/*
        json(res, sessions.listProfiles())
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
        if (process.platform !== 'win32') {
          // Headless daemon can't reliably pop a terminal off-Windows; hand back the manual command.
          json(
            res,
            {
              ok: false,
              platform: process.platform,
              manual: `pnpm login:${provider} profiles/${name}`,
              error: 'auto-launch is Windows-only — run the manual command in a terminal, then Rescan accounts',
            },
            501
          )
          return
        }
        startLogin(provider as Provider, profileDir)
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
      // Danger Zone toggles — safe-default guardrail switches the owner can flip (this is an MIT,
      // single-owner tool). GET reads the live flags; POST merges + persists them to data/config.json
      // and mutates the shared object in place so SessionManager's gating sees the change immediately.
      if (method === 'GET' && url.pathname === '/api/config/danger') {
        json(res, { ...danger })
        return
      }
      if (method === 'POST' && url.pathname === '/api/config/danger') {
        const body = await readBody(req)
        if (typeof body.busCanUseRiskyTools === 'boolean') danger.busCanUseRiskyTools = body.busCanUseRiskyTools
        if (typeof body.autoApprovePractices === 'boolean') danger.autoApprovePractices = body.autoApprovePractices
        persistDanger(defaultCwd, danger)
        journal.append(null, 'config/danger', { ...danger })
        json(res, { ...danger })
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
        json(res, sessions.list())
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
        const body = await readBody(req)
        const pm = str(body.permissionMode)
        const record = await sessions.create(String(body.profileId ?? ''), {
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
      const steerMatch = /^\/api\/sessions\/([^/]+)\/steer$/.exec(url.pathname)
      if (method === 'POST' && steerMatch) {
        const body = await readBody(req)
        await sessions.steer(steerMatch[1] as string, String(body.text ?? ''))
        json(res, { ok: true })
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
      const deleteMatch = /^\/api\/sessions\/([^/]+)\/delete$/.exec(url.pathname)
      if (method === 'POST' && deleteMatch) {
        const result = await sessions.delete(deleteMatch[1] as string)
        json(res, result, result.ok ? 200 : 404)
        return
      }
      const sessionAction = /^\/api\/sessions\/([^/]+)\/(input|interrupt|stop)$/.exec(url.pathname)
      if (method === 'POST' && sessionAction) {
        const id = sessionAction[1] as string
        const verb = sessionAction[2] as string
        if (verb === 'input') {
          const body = await readBody(req)
          await sessions.send(id, String(body.text ?? ''), {
            model: str(body.model),
            effort: body.effort === undefined ? undefined : String(body.effort),
            serviceTier: body.serviceTier === undefined ? undefined : String(body.serviceTier),
          })
        } else if (verb === 'interrupt') {
          await sessions.interrupt(id)
        } else {
          await sessions.stop(id)
        }
        json(res, { ok: true })
        return
      }
      json(res, { error: 'not found' }, 404)
    } catch (err) {
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

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[hub] port ${port} is already in use — is another hub instance running? (set HUB_PORT to override)`)
      process.exit(1)
    }
    throw err
  })
  server.listen(port, '127.0.0.1')
  return server
}
