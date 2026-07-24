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
  status: string
  vendorSessionId?: string
  model?: string
  effort?: string
  serviceTier?: string
  permissionMode?: string
  createdAt: string
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

async function jget<T>(url: string): Promise<T> {
  const res = await fetch(url)
  return res.json() as Promise<T>
}

async function jpost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json() as Promise<T>
}

export const api = {
  profiles: () => jget<ProfileInfo[]>('/api/profiles'),
  rescanProfiles: () => jpost<ProfileInfo[]>('/api/profiles/rescan'),
  pickFolder: () => jpost<{ path: string }>('/api/pick-folder'),
  projects: () => jget<ProjectInfo[]>('/api/projects'),
  createProject: (name: string, path: string) =>
    jpost<ProjectInfo | { error: string }>('/api/projects', { name, path }),
  sessions: () => jget<SessionRecord[]>('/api/sessions'),
  approvals: () => jget<ApprovalRecord[]>('/api/approvals'),
  usage: () => jget<UsageSnapshot[]>('/api/usage'),
  refreshUsage: () => jpost<UsageSnapshot[]>('/api/usage/refresh'),
  spawn: (body: Record<string, unknown>) => jpost<SessionRecord | { error: string }>('/api/sessions', body),
  send: (id: string, text: string, extra: Record<string, unknown> = {}) =>
    jpost<{ ok?: boolean; error?: string }>(`/api/sessions/${id}/input`, { text, ...extra }),
  interrupt: (id: string) => jpost(`/api/sessions/${id}/interrupt`),
  stop: (id: string) => jpost(`/api/sessions/${id}/stop`),
  setMode: (id: string, permissionMode: string) => jpost(`/api/sessions/${id}/mode`, { permissionMode }),
  decide: (id: string, approve: boolean) => jpost(`/api/approvals/${id}`, { approve }),
}
