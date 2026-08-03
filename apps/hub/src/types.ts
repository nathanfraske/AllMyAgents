import type { ChatNamePool } from './title.js'

export type Provider = 'claude' | 'codex'

export interface Profile {
  id: string
  /** Operator-facing alias. The immutable id remains the credential/session ownership key. */
  displayName?: string
  provider: Provider
  dir: string
  available?: boolean
  unavailableReason?: string
  ownerPort?: number
  authStatus?: 'signed_in' | 'signed_out'
  authError?: string
}

export interface Project {
  id: string
  name: string
  path: string
  /**
   * Absent means the hub's own OS filesystem (legacy rows stay byte-for-byte compatible).
   * WSL rows persist the concrete distro name and distro-native path; "default distro" is never stored.
   */
  location?: {
    kind: 'wsl'
    distro: string
    linuxPath: string
  }
  createdAt: string
}

export type SessionStatus = 'starting' | 'active' | 'idle' | 'stopped' | 'error'
export type DelegatedAuthority = 'commit' | 'push'
export type RemoteDeviceCapability = 'read' | 'write' | 'terminal'

/** Operator-owned capability grant for one chat. Device pairing alone never creates one. */
export interface RemoteDeviceGrant {
  siteId: string
  /** Stable root ids advertised by the target hub; never caller-chosen absolute paths. */
  rootIds: string[]
  capabilities: RemoteDeviceCapability[]
}

export interface WorkspacePressure {
  level: 'warning' | 'critical'
  totalBytes: number
  artifactBytes: number
  artifactGroups: Array<{ name: string; bytes: number }>
  reasons: Array<'workspace-size' | 'build-artifacts' | 'low-disk'>
  /** True means byte counts are lower bounds because the bounded scan stopped early. */
  partial: boolean
  observedAt: string
  freeBytes?: number
  lastNotifiedAt?: string
}

export interface ManagerAgentType {
  id: string
  name: string
  purpose: string
  selection: 'fixed' | 'usage-aware'
  /** Fixed roles use one profile; usage-aware roles let the hub choose among this operator-granted set. */
  profileId?: string
  profileIds?: string[]
  model?: string
  effort?: string
}

export interface SessionRecord {
  id: string
  profileId: string
  provider: Provider
  /** Hub-minted application overseer role. Public session creation can never set this flag. */
  isOverseer?: boolean
  projectId?: string
  cwd: string
  repo?: string
  worktree?: string
  /** Latest bounded managed-workspace pressure observation, persisted for agent and operator visibility. */
  workspacePressure?: WorkspacePressure
  /** Concrete WSL filesystem plus distro-native paths. Host-facing fields above remain UNC projections. */
  wslDistro?: string
  executionCwd?: string
  executionRepo?: string
  branch?: string
  /** What the caller asked for when creating a project chat. Kept separately from `worktree`, which is
   * the outcome, so the UI can report an override/fallback instead of pretending Project was chosen. */
  worktreeRequested?: boolean
  /** Human-readable reason a requested worktree was not created. Absent when intent and outcome agree. */
  worktreeFallbackReason?: string
  /** Exact commit the isolated worktree branched from. Persisted so stale-base checks never have to guess. */
  baseCommit?: string
  /** Fully-qualified branch ref the base commit came from (for example refs/heads/main). */
  baseRef?: string
  status: SessionStatus
  vendorSessionId?: string
  model?: string
  effort?: string
  serviceTier?: string
  permissionMode?: 'safe' | 'edits' | 'full'
  /** An authenticated, explicit operator choice for this one chat. It bypasses manager ceilings without
   *  silently widening the manager's reusable grant for every other child. */
  permissionModeOperatorOverride?: boolean
  /** Highest mode this one managed chat may receive after an explicit operator override. Unlike the
   *  manager-wide child ceiling, this does not grant the same authority over sibling chats. */
  permissionModeOperatorOverrideCeiling?: 'safe' | 'edits' | 'full'
  /** Tool names the operator chose "always allow" for in THIS chat, so they stop being prompted for them.
   *  Consulted by the hub's approval policy (approvals.setAutoApprove), which is the single chokepoint both
   *  the worker and in-process executors funnel through — so adding one takes effect immediately, mid-turn,
   *  with no worker respawn. Per-chat by design: a blanket global allowlist is a much bigger blast radius. */
  allowedTools?: string[]
  /** Exact remote machines/roots this chat may use through the AllMyAgents device tools. */
  remoteDeviceGrants?: RemoteDeviceGrant[]
  /** App-owned browser capability. Safe default is OFF when absent. The profile remains session-keyed. */
  browserEnabled?: boolean
  /** Public http(s) origins approved for this exact session. Values are canonical URL origins. */
  browserOriginGrants?: string[]
  /** Separate owner grant for loopback/private/link-local web origins. Safe default is OFF. */
  browserLocalNetworkEnabled?: boolean
  /** Allows explicit, approval-bound creation of additional tabs for this session only. */
  browserTabsEnabled?: boolean
  /** Allows approval-bound downloads into this session's inert, quota-bound native store. */
  browserDownloadsEnabled?: boolean
  /** Whether this session has created a persistent isolated profile directory. */
  browserProfileRetained?: boolean
  /** Operator-granted project-manager role. Agents can consume this marker but never set it. */
  isProjectManager?: boolean
  /** Bounded direct-child capacity for a manager. Absent is never interpreted as unlimited. */
  managerMaxLiveChildren?: number
  /** The operator's ceiling: authorities this manager may grant to its own direct children. */
  managerDelegation?: DelegatedAuthority[]
  /** Profiles (agent/account types) this manager may choose for children. Empty/absent means none. */
  managerAllowedProfiles?: string[]
  /** Explicit model slugs the manager may request per child profile. Omitted models use that profile's default. */
  managerAllowedModels?: Record<string, string[]>
  /** Exact executable tool names this manager may grant to children (for example Bash or WebFetch). */
  managerAllowedTools?: string[]
  /** Operator-defined worker briefs the manager may request by name. */
  managerAgentTypes?: ManagerAgentType[]
  /** Editable launch brief retained with the grant so the operator can reconstruct what was handed over. */
  managerStartingPrompt?: string
  /** Editable orientation portion of the launch brief, kept separate from the operator's task in the UI. */
  managerOrientationBrief?: string
  /** The task the operator assigned at launch. Blank means acknowledge, self-test tooling, and halt. */
  managerOperatorTask?: string
  /** Session-scoped operator instructions rematerialized into CLAUDE.md/AGENTS.md for every later turn. */
  managerStandingInstructions?: string
  /** Operator grant allowing this manager to decide pending approvals for its own direct children. */
  managerCanApproveChildren?: boolean
  /** Maximum permission mode the operator granted to this manager itself. Bounded changes may narrow it;
   *  a separately authenticated per-chat operator override may exceed it without rewriting the grant. */
  managerPermissionModeCeiling?: 'safe' | 'edits' | 'full'
  /** Maximum permission mode a manager may assign to direct children. Missing legacy grants fail closed to safe. */
  managerMaxChildPermissionMode?: 'safe' | 'edits' | 'full'
  /** Durable session lineage for sidebar nesting and hub-originated child reports. */
  parentSessionId?: string
  /** Authorities this child received from its manager, still subject to the manager's live ceiling. */
  delegatedAuthorities?: DelegatedAuthority[]
  /** Exact tool names granted to this child, still subject to the manager's live ceiling. */
  delegatedTools?: string[]
  // Human-facing name shown in the sidebar. Auto-derived from the first prompt (titleSource:'auto')
  // and overridable by the user (titleSource:'user', which freezes auto-naming). Absent → the UI
  // falls back to the worktree/cwd basename.
  title?: string
  /** Operator-authored team role/description. Identity stays in `title`; this is quieter context. */
  role?: string
  /** Exact operator-defined manager agent type selected for this child. Kept separately from `role`
   *  because the live manager roster must reconstruct the actual type rather than infer from prose. */
  agentTypeId?: string
  agentTypeName?: string
  /** 'generated' → a scientist surname assigned at creation; kept until the operator renames it, so a
   *  chat's name never changes under them. 'auto' → derived from the first prompt (legacy path, still
   *  used for imported/untitled records). 'user' → an explicit rename, which freezes naming entirely. */
  titleSource?: 'auto' | 'user' | 'generated'
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

/** Non-journal WebSocket control envelope separating replayed state from subsequent live events. */
export interface ReplayStart {
  type: 'replay-start'
  generation: number
  highWater: number
  resetFloorSeq: number
}

export interface ReplayComplete {
  type: 'replay-complete'
  lastSeq: number
  generation: number
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
  /**
   * Extra REMOTE ports to try when discovering peer hubs, beyond the well-known 7777.
   *
   * A machine that already has something on 7777 — very much including a second AllMyAgents — runs its
   * hub on another port, and then exposing its site correctly is not enough: discovery only ever asks
   * peers for 7777, so the hub stays invisible. The peer's real port cannot be read from here
   * (`site_remote_list` replies with an async `allmystuff://node-sites` event the control socket cannot
   * capture), so the operator names the ports their other machines use.
   *
   * e.g. `"mesh": { "peerPorts": [7778, 7900] }`. Ignored values: anything not a whole port number.
   */
  peerPorts?: number[]
}

export interface SecurityConfig {
  /**
   * Legacy key retained for config-file compatibility. Authentication is now always required;
   * `false` no longer disables the operator control-plane boundary.
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
 * Owner preferences: choices about how the hub presents itself, with no safety dimension at all.
 *
 * Separate from FeaturesConfig (which turns hub BEHAVIOUR on and off) and emphatically not Danger Zone —
 * nothing here trades safety for autonomy, so hiding it behind that section's deliberate reveal would
 * misrepresent it. `PrefsConfig` is the on-disk / API shape (optional); `HubPrefs` is the resolved
 * runtime object index.ts fills defaults into and shares by reference.
 */
export interface PrefsConfig {
  /** Which pool a new chat's name is drawn from. Absent → DEFAULT_CHAT_NAME_POOL. See title.ts. */
  chatNamePool?: ChatNamePool
  /** Deliver new operator/bus input into a running turn at its next tool boundary. Absent means ON. */
  steerMessagesAtToolBoundary?: boolean
  /** Default presentation for file writes and diffs. Absent or invalid means minimal. */
  fileWriteDiffDensity?: FileWriteDiffDensity
}

export type FileWriteDiffDensity = 'minimal' | 'summary' | 'verbose'

export function asFileWriteDiffDensity(value: unknown): FileWriteDiffDensity {
  return value === 'summary' || value === 'verbose' ? value : 'minimal'
}

/** Resolved owner preferences (always present; index.ts fills defaults from PrefsConfig). */
export interface HubPrefs {
  chatNamePool: ChatNamePool
  steerMessagesAtToolBoundary: boolean
  // index.ts always resolves this; optional only so SessionManager's untouched legacy fallback literal
  // remains source-compatible when constructed directly by tests or embedders.
  fileWriteDiffDensity?: FileWriteDiffDensity
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
   * Opt out of live worktree collision warnings. Default OFF (safe): when two active agents write the
   * same file, the later writer gets one direct steer naming the other agent and path.
   */
  disableWorktreeCollisionWarnings?: boolean
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
  // default OFF → restart_hub waits on operator approval
  autoApproveRestart?: boolean
  /**
   * Re-enable claude.ai cloud MCP connectors for managed Claude sessions. Default OFF (safe): the hub
   * writes `disableClaudeAiConnectors: true` into each managed claude profile's settings.json so the SDK
   * suppresses cloud connectors — no egress to vendor connectors by default. ON allows them.
   */
  enableClaudeConnectors?: boolean
  /**
   * Make a chat's permission mode authoritative for EVERY turn, whoever started it — a teammate's bus
   * message, a monitor firing, anything. Default OFF, which keeps the clamp: a non-operator turn runs at
   * most `edits` and never auto-approves.
   *
   * ON is the operator saying "Full Access means full access". The reasoning against it is real — a
   * teammate agent can be wrong or prompt-injected, and this hands it whatever the chat was granted with
   * nobody watching — but so is the reasoning for it: silently downgrading a mode the operator explicitly
   * chose makes the picker lie, and an unattended agent that stops dead on a prompt nobody sees is its own
   * kind of failure. This is a single-owner tool; the mode picker is the guardrail, and this flag decides
   * whether it means what it says.
   */
  fullAccessAnyOrigin?: boolean
}

/** Resolved Danger Zone flags (both always present; index.ts fills defaults from DangerConfig). */
export interface DangerFlags {
  // default OFF (absent means false) keeps collision warnings enabled.
  disableWorktreeCollisionWarnings?: boolean
  busCanUseRiskyTools: boolean
  autoApprovePractices: boolean
  // default OFF → restart_hub waits on operator approval
  autoApproveRestart?: boolean
  // default OFF (absent → treated as false) → managed claude profiles get disableClaudeAiConnectors=true.
  // Only READ in index.ts (boot) + server.ts (toggle) via the shared danger object index.ts fully populates;
  // optional so the many DangerFlags literals (worker + tests) that don't set it still typecheck.
  enableClaudeConnectors?: boolean
  // default OFF (absent → treated as false) → non-operator turns stay clamped and never auto-approve.
  // ON makes the chat's mode authoritative for every origin. Always read as `=== true` so an unset flag
  // in any of the literals scattered across the worker + tests is the SAFE value, never the permissive one.
  fullAccessAnyOrigin?: boolean
}

export interface HubConfig {
  overage?: Record<string, OveragePolicy>
  /** Human-facing aliases keyed by immutable managed-profile id. */
  profileNames?: Record<string, string>
  mesh?: MeshConfig
  security?: SecurityConfig
  features?: FeaturesConfig
  prefs?: PrefsConfig
  danger?: DangerConfig
  /** Durable outside the journal so the designated account remains knowable during DB preflight failure. */
  overseer?: OverseerConfig
}

export interface OverseerConfig {
  profileId?: string
  sessionId?: string
  updatedAt?: string
}
