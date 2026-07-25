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
  // True when this record was ADOPTED from an existing vendor transcript (Claude Code / Codex) via
  // the project-import flow rather than spawned by the hub. Drives a sidebar badge and the
  // delete-never-unlinks guard (the source transcript is the user's own history — never removed).
  // Optional key → no store migration; absent means hub-native.
  imported?: boolean
  // Absolute path to the source vendor transcript for an imported session — lets the hub read its
  // on-disk history on demand (see transcript.ts). Cached on first lookup for records adopted before
  // this field existed. Optional → no store migration.
  transcriptPath?: string
  // ISO time of the LAST turn in the source transcript (for imported chats) — the sidebar shows/sorts
  // by this so an import reads its real recency, not the moment it was imported. Absent → hub-native.
  lastActivity?: string
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

export interface FeaturesConfig {
  /**
   * Automatic hub-side memory recall: before each turn, surface the memories most relevant to the
   * prompt into the agent's context (so it recalls without calling memory_search). On by default;
   * set false to disable. Benign + helpful, so it's a plain feature flag, not a danger-zone toggle.
   */
  autoMemoryRecall?: boolean
}

/**
 * Danger Zone toggles — SAFE DEFAULTS the owner can flip in Settings to trade safety for autonomy.
 * This is an MIT, self-hosted, single-owner tool, so guardrails are safe defaults + toggles, never
 * un-disable-able hard blocks: provenance, audit, and the kill-switch stay as VISIBILITY, and these
 * flags let the owner go fully permissive. Every toggle defaults OFF (the safe choice).
 *
 * `DangerConfig` is the on-disk / API shape (both optional); `DangerFlags` is the resolved runtime
 * object (both present) that the gating code reads live — see index.ts, sessions.ts, agentTools.ts.
 */
export interface DangerConfig {
  /**
   * Allow risky in-process tools (agent practice writes above account scope — and, in a later slice,
   * hook proposals) to run on BUS turns (turns caused by a semi-trusted teammate message). Default
   * OFF: a teammate's message can never drive a persistence-class write.
   */
  busCanUseRiskyTools?: boolean
  /**
   * Auto-approve agent practice writes/edits to project / global / vendor scope without an operator
   * prompt. Default OFF: those writes (which reshape teammates' or the whole fleet's behavior) wait
   * on operator approval. Writes to the agent's own account scope are always immediate regardless.
   */
  autoApprovePractices?: boolean
}

/** Resolved Danger Zone flags (both always present; index.ts fills defaults from DangerConfig). */
export interface DangerFlags {
  busCanUseRiskyTools: boolean
  autoApprovePractices: boolean
}

export interface HubConfig {
  overage?: Record<string, OveragePolicy>
  mesh?: MeshConfig
  security?: SecurityConfig
  features?: FeaturesConfig
  danger?: DangerConfig
}
