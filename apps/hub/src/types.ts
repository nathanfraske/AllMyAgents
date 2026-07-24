export type Provider = 'claude' | 'codex'

export interface Profile {
  id: string
  provider: Provider
  dir: string
}

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
}

export type SessionStatus = 'starting' | 'active' | 'idle' | 'stopped' | 'error'

export interface SessionRecord {
  id: string
  profileId: string
  provider: Provider
  projectId?: string
  cwd: string
  repo?: string
  worktree?: string
  branch?: string
  status: SessionStatus
  vendorSessionId?: string
  model?: string
  effort?: string
  serviceTier?: string
  permissionMode?: 'safe' | 'edits' | 'full'
  // Human-facing name shown in the sidebar. Auto-derived from the first prompt (titleSource:'auto')
  // and overridable by the user (titleSource:'user', which freezes auto-naming). Absent → the UI
  // falls back to the worktree/cwd basename.
  title?: string
  titleSource?: 'auto' | 'user'
  createdAt: string
}

export interface HubEvent {
  seq: number
  ts: string
  sessionId: string | null
  kind: string
  payload: unknown
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timeout'

export interface ApprovalRecord {
  id: string
  sessionId: string
  kind: string
  payload: unknown
  status: ApprovalStatus
  createdAt: string
}

export interface ClaudeLimitInfo {
  status?: string
  rateLimitType?: string
  resetsAt?: number
  overageStatus?: string
  overageResetsAt?: number
  isUsingOverage?: boolean
}

export interface CodexLimitInfo {
  usedPercent?: number
  windowDurationMins?: number
  resetsAt?: number
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string }
  spendControlReached?: boolean
  rateLimitReachedType?: string | null
  planType?: string
}

export interface ClaudeUsageLine {
  label: string
  percent: number
  resets: string
  resetsAt?: number
}

export interface UsageSnapshot {
  profileId: string
  provider: Provider
  updatedAt: string
  claude?: ClaudeLimitInfo
  claudeUsage?: ClaudeUsageLine[]
  codex?: CodexLimitInfo
  totalCostUsd?: number
  blocked: boolean
  blockedReason?: string
}

export type OveragePolicy = 'block' | 'warn' | 'allow'

export interface MeshConfig {
  /**
   * Expose the loopback hub as an AllMyStuff "site" so other PCs on the owner's mesh can reach
   * it. Default OFF: the hub grants full control, so exposure is opt-in until the device-token
   * gate lands (see DESIGN D13.1). The hub itself always stays bound to 127.0.0.1 — the local
   * AllMyStuff node dials loopback and tunnels; we never bind a routable interface.
   */
  enable?: boolean
  /** Display label fleet peers see for this site (e.g. in their AllMyStuff Sites tab). */
  label?: string
}

export interface SecurityConfig {
  /**
   * Require a device token on every /api + /ws request. Off by default (pure-loopback local use
   * is fine behind the origin guard); turn it on for fleet/remote exposure — a genuinely remote
   * device must then present the token to reach the hub. See deviceToken.ts.
   */
  requireToken?: boolean
}

export interface HubConfig {
  overage?: Record<string, OveragePolicy>
  mesh?: MeshConfig
  security?: SecurityConfig
}
