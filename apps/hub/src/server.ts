import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { ApprovalService } from './approvals.js'
import type { Journal } from './journal.js'
import type { SessionManager } from './sessions.js'
import type { UsageMonitor } from './usage.js'
import type { HubEvent, Profile } from './types.js'

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>AiAgentApp hub</title>
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
<h1>AiAgentApp hub — P1</h1>
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

export interface ServerOptions {
  port: number
  defaultCwd: string
  journal: Journal
  sessions: SessionManager
  profiles: Profile[]
  approvals: ApprovalService
  usage: UsageMonitor
}

export function startServer(opts: ServerOptions): http.Server {
  const { port, journal, sessions, profiles, approvals, usage } = opts

  const server = http.createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const { method } = req
      if (method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE)
        return
      }
      if (method === 'GET' && url.pathname === '/api/profiles') {
        json(res, profiles.map((p) => ({ id: p.id, provider: p.provider })))
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
      if (method === 'POST' && url.pathname === '/api/usage/refresh') {
        await usage.refreshNow()
        json(res, usage.list())
        return
      }
      if (method === 'GET' && url.pathname === '/api/events') {
        json(res, journal.since(Number(url.searchParams.get('since') ?? 0)))
        return
      }
      if (method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readBody(req)
        const pm = str(body.permissionMode)
        const record = await sessions.create(String(body.profileId ?? ''), {
          cwd: str(body.cwd),
          repo: str(body.repo),
          prompt: str(body.prompt),
          model: str(body.model),
          effort: str(body.effort),
          permissionMode: pm === 'safe' || pm === 'edits' || pm === 'full' ? pm : undefined,
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
      const sessionAction = /^\/api\/sessions\/([^/]+)\/(input|interrupt|stop)$/.exec(url.pathname)
      if (method === 'POST' && sessionAction) {
        const id = sessionAction[1] as string
        const verb = sessionAction[2] as string
        if (verb === 'input') {
          const body = await readBody(req)
          await sessions.send(id, String(body.text ?? ''), { model: str(body.model), effort: str(body.effort) })
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

  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/ws', 'http://localhost')
    for (const event of journal.since(Number(url.searchParams.get('since') ?? 0))) {
      ws.send(JSON.stringify(event))
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
