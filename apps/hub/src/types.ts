export type Provider = 'claude' | 'codex'

export interface Profile {
  id: string
  provider: Provider
  dir: string
}

export type SessionStatus = 'starting' | 'active' | 'idle' | 'stopped' | 'error'

export interface SessionRecord {
  id: string
  profileId: string
  provider: Provider
  cwd: string
  repo?: string
  worktree?: string
  status: SessionStatus
  vendorSessionId?: string
  model?: string
  effort?: string
  permissionMode?: 'safe' | 'edits' | 'full'
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

export interface HubConfig {
  overage?: Record<string, OveragePolicy>
}
