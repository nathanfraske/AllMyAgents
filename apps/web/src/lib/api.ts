export interface ProfileInfo {
  id: string
  provider: 'claude' | 'codex'
}

export interface ProjectInfo {
  id: string
  name: string
  path: string
  createdAt: string
  // Fleet origin (CLIENT-INJECTED by the store's fleet merge — the hub never sends these). Set only
  // for a project pulled from a REMOTE fleet site; its `id` is namespaced `${siteId}:${realId}`.
  // Absent → this hub's own (local) project, shown unbadged exactly as before.
  siteId?: string
  siteLabel?: string
  /** Whether that machine answered the last roster probe. False = last-known rows, machine unreachable. */
  siteOnline?: boolean
}

export interface SessionRecord {
  id: string
  profileId: string
  provider: 'claude' | 'codex'
  projectId?: string
  cwd: string
  repo?: string
  worktree?: string
  branch?: string
  status: string
  vendorSessionId?: string
  model?: string
  effort?: string
  serviceTier?: string
  permissionMode?: string
  /** Tools the operator chose "always allow" for in this chat. Shown (and revocable) in the permission menu. */
  allowedTools?: string[]
  title?: string
  titleSource?: string
  // Adopted from an existing vendor transcript via project-import (vs. spawned by the hub).
  imported?: boolean
  // Real last-turn time of an imported transcript — the sidebar shows/sorts by this, not import time.
  lastActivity?: string
  createdAt: string
  // Fleet origin (CLIENT-INJECTED by the store's fleet merge — the hub never sends these). Set only
  // for a session pulled from a REMOTE fleet site; both `id` and `projectId` are namespaced
  // `${siteId}:${realId}`. Absent → this hub's own (local) session, shown unbadged as before.
  siteId?: string
  siteLabel?: string
  /** Whether that machine answered the last roster probe. False = last-known row, machine unreachable. */
  siteOnline?: boolean
}

// One existing Claude/Codex conversation found on disk that can be adopted under a project.
export interface ImportableChat {
  provider: 'claude' | 'codex'
  vendorSessionId: string
  profileId: string
  cwd: string
  title: string
  firstPrompt?: string
  aiTitle?: string
  lastActivity: string
  messageCount: number
  model?: string
  gitBranch?: string
  sizeBytes: number
  transcriptPath: string
  alreadyImported: boolean
}

export interface ProjectConfig {
  mcpServers: { name: string; transport: 'stdio' | 'http' | 'sse'; hasSecrets: boolean }[]
  hooks: string[]
  hasPermissions: boolean
  memoryFiles: { name: string; bytes: number }[]
  sources: string[]
}

export interface ScanResult {
  path: string
  chats: ImportableChat[]
  byProfile: Record<string, number>
  scannedProfiles: string[]
  config: ProjectConfig
  warnings: string[]
}

// One render-ready turn from an imported chat's on-disk transcript (mirrors the hub's HistoryItem).
export interface HistoryItem {
  kind: 'user' | 'assistant' | 'reasoning' | 'tool'
  text?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: string
  toolError?: boolean
  ts?: string
}

export interface HistoryPage {
  items: HistoryItem[]
  /** Byte offset to pass back as `before` to page OLDER; null at the file start. */
  olderCursor: number | null
  hasOlder: boolean
}

export interface ImportResult {
  imported: SessionRecord[]
  skipped: number
  notFound: string[]
}

export interface ApprovalRecord {
  id: string
  sessionId: string
  kind: string
  payload: unknown
  status: string
  createdAt: string
}

export interface ClaudeUsageLine {
  label: string
  percent: number
  resets: string
  resetsAt?: number
}

export interface UsageSnapshot {
  profileId: string
  provider: string
  updatedAt: string
  claude?: {
    status?: string
    rateLimitType?: string
    resetsAt?: number
    isUsingOverage?: boolean
  }
  claudeUsage?: ClaudeUsageLine[]
  codex?: {
    usedPercent?: number
    windowDurationMins?: number
    resetsAt?: number
    credits?: { hasCredits?: boolean; balance?: string }
  }
  totalCostUsd?: number
  blocked: boolean
  blockedReason?: string
}

export interface HubEvent {
  seq: number
  ts: string
  sessionId: string | null
  kind: string
  payload: unknown
}

// In the packaged desktop app the frontend is served from tauri.localhost, so relative URLs
// never reach the hub. Detect the Tauri webview and target the loopback hub directly. In the
// browser (dev) the base stays empty and Vite's proxy forwards /api and /ws to the hub.
const inTauri =
  typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
export const HUB_HTTP = inTauri ? 'http://127.0.0.1:7777' : ''
export const HUB_WS = inTauri ? 'ws://127.0.0.1:7777' : ''

// Device token (localStorage-backed). Sent as a Bearer header on every request and as ?token= on
// the WebSocket. Empty until the hub hands it over during the pre-enforcement window, or the user
// pairs a remote device by pasting it.
let hubToken = (typeof localStorage !== 'undefined' && localStorage.getItem('hub.token')) || ''
export function getHubToken(): string {
  return hubToken
}
export function setHubToken(t: string): void {
  hubToken = t
  try {
    localStorage.setItem('hub.token', t)
  } catch {
    /* ignore */
  }
}
function authHeaders(): Record<string, string> {
  return hubToken ? { authorization: `Bearer ${hubToken}` } : {}
}

// `base` defaults to the single local hub (HUB_HTTP); the fleet merge passes a REMOTE site's mapped
// loopback base (http://localhost:<localPort>) to pull that machine's read-only roster.
// TODO(full drive-remote, L): a remote site under `requireToken` needs ITS OWN token here — today we
// reuse the single local `hubToken` (fine while enforcement is off, the first-cut assumption).
async function jget<T>(url: string, base: string = HUB_HTTP): Promise<T> {
  const res = await fetch(base + url, { headers: authHeaders() })
  return res.json() as Promise<T>
}

async function jpost<T>(url: string, body?: unknown): Promise<T> {
  try {
    const res = await fetch(HUB_HTTP + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    try {
      return JSON.parse(text) as T
    } catch {
      // Non-JSON response (e.g. a 500 page) — surface a clean error rather than throwing.
      return { error: text.slice(0, 200) || `HTTP ${res.status}` } as T
    }
  } catch (e) {
    // Network failure (hub unreachable) — return an error the caller renders, never an unhandled reject.
    return { error: e instanceof Error ? e.message : 'network error' } as T
  }
}

export interface LoginResult {
  ok: boolean
  added?: string
  provider?: string
  launched?: boolean
  timedOut?: boolean
  platform?: string
  manual?: string
  error?: string
}

export interface DayStat {
  date: string
  turns: number
  cost: number
  projects: Record<string, { turns: number; cost: number }>
}
export interface StatsResult {
  days: DayStat[]
  totalTurns: number
  totalCost: number
  totalSessions: number
}

export interface MeshStatus {
  enabled: boolean
  nodePresent: boolean
  exposed: boolean
  port: number
  label: string
  siteId: string
  socketPath: string
  peerUrl: string
  error?: string
  checkedAt?: string
  requireToken?: boolean
  token?: string
}

// One machine in the unified fleet view (GET /api/fleet). `local:true` is THIS hub. For a remote
// site, `baseUrl` is a loopback port the mesh maps to that peer's hub; the store pulls its
// /api/projects + /api/sessions when `online`, namespacing every id with `${siteId}:`.
export interface FleetSite {
  siteId: string
  label: string
  local: boolean
  baseUrl: string
  online: boolean
}

export interface Instruction {
  scope: string
  content: string
  updatedAt: string
}

export interface Memory {
  id: string
  scope: string
  title: string
  body: string
  tags: string[]
  fromSession: string | null
  fromProfile: string | null
  createdAt: string
  updatedAt: string
}

// An agent-authored working convention, materialized into future agents' instructions at spawn.
export interface Practice {
  id: string
  scope: string
  title: string
  body: string
  fromSession: string | null
  fromProfile: string | null
  createdAt: string
  updatedAt: string
}

// Danger Zone toggles — safe-default guardrail switches (all default false / OFF).
export interface DangerFlags {
  busCanUseRiskyTools: boolean
  autoApprovePractices: boolean
  autoApproveRestart?: boolean
  enableClaudeConnectors?: boolean
}

export interface BusMessage {
  id: string
  groupId: string
  ts: string
  fromSession: string
  fromProfile: string
  fromLabel: string
  project: string | null
  toKind: 'session' | 'project'
  toId: string
  toSession: string
  subject: string | null
  body: string
  delivered: boolean
  readAt: string | null
}

// One custom slash command a profile exposes on disk (<configDir>/commands/*.md), enumerated by the
// hub. Feeds the composer's `/` picker alongside the client-defined built-ins.
export interface CommandInfo {
  name: string
  description: string
}

// Result of the `/compact` built-in. `supported:false` (+ reason) today — no driver exposes an
// on-demand compaction trigger yet (the hub returns 501); the composer surfaces the reason.
export interface CompactResult {
  supported?: boolean
  reason?: string
  error?: string
}

export const api = {
  profiles: () => jget<ProfileInfo[]>('/api/profiles'),
  stats: () => jget<StatsResult>('/api/stats'),
  rescanProfiles: () => jpost<ProfileInfo[]>('/api/profiles/rescan'),
  login: (provider: 'claude' | 'codex', name: string) =>
    jpost<LoginResult>('/api/accounts/login', { provider, name }),
  pickFolder: () => jpost<{ path: string }>('/api/pick-folder'),
  projects: () => jget<ProjectInfo[]>('/api/projects'),
  createProject: (name: string, path: string) =>
    jpost<ProjectInfo | { error: string }>('/api/projects', { name, path }),
  // --- Unified fleet view (first cut, read-only) ---
  // The fleet roster: this hub + every reachable co-owned peer's hub, badged by machine.
  fleet: () => jget<FleetSite[]>('/api/fleet'),
  // Pull a roster from an ARBITRARY site base (a remote fleet site's mapped loopback base), not just
  // the hard-wired local hub — how the store aggregates remote machines read-only.
  projectsFrom: (base: string) => jget<ProjectInfo[]>('/api/projects', base),
  sessionsFrom: (base: string) => jget<SessionRecord[]>('/api/sessions', base),
  // Project import: preview existing vendor chats under a folder, then adopt the selected ones.
  scanProject: (path: string) => jpost<ScanResult | { error: string }>('/api/projects/scan', { path }),
  importChats: (projectId: string, vendorSessionIds: string[]) =>
    jpost<ImportResult | { error: string }>(`/api/projects/${projectId}/import`, { vendorSessionIds }),
  sessions: () => jget<SessionRecord[]>('/api/sessions'),
  // On-demand vendor transcript history for an imported chat (bounded tail; `before` byte cursor pages older).
  history: (id: string, before?: number) =>
    jget<HistoryPage>(`/api/sessions/${id}/history${before != null ? `?before=${before}` : ''}`),
  approvals: () => jget<ApprovalRecord[]>('/api/approvals'),
  usage: () => jget<UsageSnapshot[]>('/api/usage'),
  refreshUsage: () => jpost<UsageSnapshot[]>('/api/usage/refresh'),
  spawn: (body: Record<string, unknown>) => jpost<SessionRecord | { error: string }>('/api/sessions', body),
  send: (id: string, text: string, extra: Record<string, unknown> = {}) =>
    jpost<{ ok?: boolean; error?: string }>(`/api/sessions/${id}/input`, { text, ...extra }),
  steer: (id: string, text: string) =>
    jpost<{ ok?: boolean; error?: string }>(`/api/sessions/${id}/steer`, { text }),
  // A profile's on-disk custom slash commands (for the `/` command picker).
  commands: (profileId: string) => jget<CommandInfo[]>(`/api/profiles/${encodeURIComponent(profileId)}/commands`),
  // Request on-demand context compaction (the `/compact` built-in). See CompactResult.
  compact: (id: string) => jpost<CompactResult>(`/api/sessions/${id}/compact`),
  interrupt: (id: string) => jpost(`/api/sessions/${id}/interrupt`),
  stop: (id: string) => jpost(`/api/sessions/${id}/stop`),
  // The inverse of stop(): revive a stopped/errored chat to idle so it's usable again (composer frees,
  // bus-reachable). Fixes stop() being a permanent one-way brick.
  reopen: (id: string) => jpost<{ ok?: boolean; status?: string; error?: string }>(`/api/sessions/${id}/reopen`),
  deleteSession: (id: string) => jpost<{ ok?: boolean; error?: string }>(`/api/sessions/${id}/delete`),
  setMode: (id: string, permissionMode: string) => jpost(`/api/sessions/${id}/mode`, { permissionMode }),
  /** "Always allow this tool in this chat" (allow=false revokes). Takes effect on the next tool call. */
  allowTool: (id: string, toolName: string, allow = true) =>
    jpost<SessionRecord>(`/api/sessions/${id}/allow-tool`, { toolName, allow }),
  /** Persist a per-chat model / thinking effort / service tier immediately (survives reload + restart). */
  setSettings: (id: string, patch: { model?: string; effort?: string; serviceTier?: string }) =>
    jpost<SessionRecord>(`/api/sessions/${id}/settings`, patch),
  decide: (id: string, approve: boolean) => jpost(`/api/approvals/${id}`, { approve }),
  mesh: async (): Promise<MeshStatus> => {
    const m = await jget<MeshStatus>('/api/mesh')
    if (m.token) setHubToken(m.token) // bootstrap: capture the token while the hub still hands it out
    return m
  },
  setMesh: (enable: boolean) => jpost<MeshStatus>('/api/mesh', { enable }),
  auth: () => jget<{ requireToken: boolean; authed: boolean }>('/api/auth'),
  instructions: () => jget<Instruction[]>('/api/instructions'),
  setInstructions: (scope: string, content: string) => jpost<Instruction[]>('/api/instructions', { scope, content }),
  rename: (id: string, title: string) => jpost<{ ok?: boolean; error?: string }>(`/api/sessions/${id}/title`, { title }),
  memory: (scope?: string) => jget<Memory[]>(`/api/memory${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`),
  searchMemory: (q: string, scope?: string) =>
    jget<Memory[]>(`/api/memory?q=${encodeURIComponent(q)}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`),
  writeMemory: (scope: string, title: string, body: string, tags?: string[]) =>
    jpost<Memory | { error: string }>('/api/memory', { scope, title, body, tags }),
  // Agent-authored practices — operator review + revoke (writes come from agents via gated tools).
  practices: () => jget<Practice[]>('/api/practices'),
  revokePractice: (id: string) => jpost<{ ok?: boolean; error?: string }>(`/api/practices/${id}/revoke`),
  // Danger Zone toggles.
  danger: () => jget<DangerFlags>('/api/config/danger'),
  setDanger: (patch: Partial<DangerFlags>) => jpost<DangerFlags>('/api/config/danger', patch),
  // Operator "Restart hub" — forwards to the supervisor (202 accepted); 503 {error} when unsupervised.
  restartHub: () => jpost<{ accepted?: boolean; error?: string }>('/api/restart', { reason: 'operator' }),
  bus: (opts: { project?: string; session?: string } = {}) => {
    const p = new URLSearchParams()
    if (opts.project) p.set('project', opts.project)
    if (opts.session) p.set('session', opts.session)
    const qs = p.toString()
    return jget<BusMessage[]>(`/api/bus${qs ? `?${qs}` : ''}`)
  },
}
