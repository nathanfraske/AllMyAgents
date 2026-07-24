export interface ProfileInfo {
  id: string
  provider: 'claude' | 'codex'
}

export interface ProjectInfo {
  id: string
  name: string
  path: string
  createdAt: string
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
  title?: string
  titleSource?: string
  // Adopted from an existing vendor transcript via project-import (vs. spawned by the hub).
  imported?: boolean
  createdAt: string
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

export interface ScanResult {
  path: string
  chats: ImportableChat[]
  byProfile: Record<string, number>
  scannedProfiles: string[]
  warnings: string[]
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

async function jget<T>(url: string): Promise<T> {
  const res = await fetch(HUB_HTTP + url, { headers: authHeaders() })
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
  // Project import: preview existing vendor chats under a folder, then adopt the selected ones.
  scanProject: (path: string) => jpost<ScanResult | { error: string }>('/api/projects/scan', { path }),
  importChats: (projectId: string, vendorSessionIds: string[]) =>
    jpost<ImportResult | { error: string }>(`/api/projects/${projectId}/import`, { vendorSessionIds }),
  sessions: () => jget<SessionRecord[]>('/api/sessions'),
  approvals: () => jget<ApprovalRecord[]>('/api/approvals'),
  usage: () => jget<UsageSnapshot[]>('/api/usage'),
  refreshUsage: () => jpost<UsageSnapshot[]>('/api/usage/refresh'),
  spawn: (body: Record<string, unknown>) => jpost<SessionRecord | { error: string }>('/api/sessions', body),
  send: (id: string, text: string, extra: Record<string, unknown> = {}) =>
    jpost<{ ok?: boolean; error?: string }>(`/api/sessions/${id}/input`, { text, ...extra }),
  steer: (id: string, text: string) =>
    jpost<{ ok?: boolean; error?: string }>(`/api/sessions/${id}/steer`, { text }),
  interrupt: (id: string) => jpost(`/api/sessions/${id}/interrupt`),
  stop: (id: string) => jpost(`/api/sessions/${id}/stop`),
  deleteSession: (id: string) => jpost<{ ok?: boolean; error?: string }>(`/api/sessions/${id}/delete`),
  setMode: (id: string, permissionMode: string) => jpost(`/api/sessions/${id}/mode`, { permissionMode }),
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
  bus: (opts: { project?: string; session?: string } = {}) => {
    const p = new URLSearchParams()
    if (opts.project) p.set('project', opts.project)
    if (opts.session) p.set('session', opts.session)
    const qs = p.toString()
    return jget<BusMessage[]>(`/api/bus${qs ? `?${qs}` : ''}`)
  },
}
