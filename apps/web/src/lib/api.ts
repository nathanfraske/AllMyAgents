/**
 * What the hub returns for an uploaded attachment (its upload route responds with exactly these fields
 * that a client should use). It is NOT the web's `AttachmentMeta` (that adds a client-derived `kind`,
 * which the hub does not send) — deliberately only what actually comes back. `id` is what send/steer
 * reference. The composer derives `kind` from `mime` itself (see attachments.ts) when it needs it.
 */
export interface AttachmentRef {
  id: string
  name: string
  mime: string
  size: number
}

export interface RecoveryNotice {
  planId: string
  generation: string
  snapshotMaxSeq: string
  snapshotEventHighWater: string
  quarantineDir: string
  recordedAt: string
}

export interface ProfileInfo {
  id: string
  /** Editable operator-facing alias; id remains the immutable account key. */
  displayName?: string
  provider: 'claude' | 'codex'
  available?: boolean
  unavailableReason?: string
  ownerPort?: number
  authStatus?: 'signed_in' | 'signed_out'
  authError?: string
  siteId?: string
  siteLabel?: string
  siteOnline?: boolean
}

export interface ProjectInfo {
  id: string
  name: string
  path: string
  createdAt: string
  location?: {
    kind: 'wsl'
    distro: string
    linuxPath: string
  }
  locationAvailable?: boolean
  locationUnavailableReason?: string
  // Fleet origin (CLIENT-INJECTED by the store's fleet merge — the hub never sends these). Set only
  // for a project pulled from a REMOTE fleet site; its `id` is namespaced `${siteId}:${realId}`.
  // Absent → this hub's own (local) project, shown unbadged exactly as before.
  siteId?: string
  siteLabel?: string
  /** Whether that machine answered the last roster probe. False = last-known rows, machine unreachable. */
  siteOnline?: boolean
}

export interface ProjectDraftValidation {
  valid: true
  name: string
  path: string
  location?: ProjectInfo['location']
}

export interface WslDistroInfo {
  name: string
  version: 1 | 2
  state: 'running' | 'stopped'
  isDefault: boolean
}

export interface WslCapability {
  supported: boolean
  reason?: string
  distros: WslDistroInfo[]
  docker: {
    available: boolean
    reason?: string
  }
}

export interface ProjectDeletionInspection {
  projectId: string
  projectPath: string
  sessions: Array<{
    id: string
    title: string
    status: string
    cwd: string
  }>
  changes: Array<{
    kind: 'uncommitted' | 'untracked'
    path: string
    checkoutPath: string
    sessionId?: string
  }>
  localCommits: Array<{
    hash: string
    subject: string
    checkoutPath: string
    sessionId?: string
  }>
  worktrees: Array<{
    sessionId: string
    title: string
    path: string
    branch?: string
    status: string
  }>
  inspectionErrors: Array<{ path: string; message: string }>
}

export interface ProjectDeletionResult {
  ok?: boolean
  error?: string
  detachedSessionIds?: string[]
  deletedSessionIds?: string[]
}

export type WorktreeChangeKind = 'uncommitted' | 'committed' | 'both'

export interface WorktreeProjectActivity {
  projectId: string
  observedAt: string | null
  agents: Array<{
    sessionId: string
    label: string
    branch: string | null
    worktree: string
    files: Array<{ file: string; kind: WorktreeChangeKind }>
    baseCommit: string
    mainCommit: string
    commitsBehind: number
    diverged: boolean
  }>
  risks: Array<{
    risk: 'concurrent-write' | 'stale-base'
    file: string
    sessionIds: string[]
    commitsBehind: number
    mainAdvance: Array<{ commit: string; subject: string }>
  }>
}

export interface GitHubCapability {
  available: boolean
  reason?: string
}

export interface GitHubRepository {
  nameWithOwner: string
  name: string
  description: string
  private: boolean
  archived: boolean
  defaultBranch: string | null
  updatedAt: string
  supported: boolean
  unsupportedReason?: string
}

export interface GitHubCloneJob {
  id: string
  repository: Pick<GitHubRepository, 'nameWithOwner' | 'name' | 'private'>
  status: 'queued' | 'cloning' | 'validating' | 'complete' | 'failed' | 'cancelled'
  progress: {
    stage: 'queued' | 'cloning' | 'validating' | 'complete'
    percent?: number
    message: string
  }
  createdAt: string
  updatedAt: string
  project?: ProjectInfo
  error?: string
  destination?: { kind: 'local' } | { kind: 'wsl'; distro: string }
}

export interface SessionRecord {
  id: string
  profileId: string
  provider: 'claude' | 'codex'
  isOverseer?: boolean
  projectId?: string
  cwd: string
  repo?: string
  worktree?: string
  workspacePressure?: WorkspacePressure
  branch?: string
  /** Spawn intent, distinct from the actual `worktree` outcome. */
  worktreeRequested?: boolean
  /** Why a requested worktree was not created; absent when intent and outcome agree. */
  worktreeFallbackReason?: string
  status: string
  vendorSessionId?: string
  model?: string
  effort?: string
  serviceTier?: string
  permissionMode?: string
  permissionModeOperatorOverride?: boolean
  permissionModeOperatorOverrideCeiling?: 'safe' | 'edits' | 'full'
  /** Tools the operator chose "always allow" for in this chat. Shown (and revocable) in the permission menu. */
  allowedTools?: string[]
  remoteDeviceGrants?: RemoteDeviceGrant[]
  browserEnabled?: boolean
  isProjectManager?: boolean
  managerMaxLiveChildren?: number
  managerDelegation?: Array<'commit' | 'push'>
  managerAllowedProfiles?: string[]
  managerAllowedModels?: Record<string, string[]>
  managerAllowedTools?: string[]
  managerAgentTypes?: ManagerAgentType[]
  managerStartingPrompt?: string
  managerOrientationBrief?: string
  managerOperatorTask?: string
  managerStandingInstructions?: string
  managerCanApproveChildren?: boolean
  managerPermissionModeCeiling?: 'safe' | 'edits' | 'full'
  managerMaxChildPermissionMode?: 'safe' | 'edits' | 'full'
  parentSessionId?: string
  delegatedAuthorities?: Array<'commit' | 'push'>
  delegatedTools?: string[]
  title?: string
  /** Operator-authored team role/description; the generated scientist identity remains in `title`. */
  role?: string
  agentTypeId?: string
  agentTypeName?: string
  titleSource?: string
  // Adopted from an existing vendor transcript via project-import (vs. spawned by the hub).
  imported?: boolean
  // Real last-turn time of an imported transcript — the sidebar shows/sorts by this, not import time.
  lastActivity?: string
  createdAt: string
  /**
   * Unread teammate (bus) messages queued for this session — undelivered mail the operator can't
   * otherwise see. Set by the hub sessions API (Bose). OPTIONAL: an older hub (or before that change
   * deploys) omits it, in which case the sidebar renders NO badge — never a zero/NaN. It reflects the
   * hub's pending count, so it updates live as mail is delivered and does not guess delivery timing.
   * NOTE: field name to be confirmed against Bose's exact shape; read via unreadMail.ts so a rename is
   * a one-line change and a missing/misnamed field degrades to "no badge", not a crash.
   */
  unreadFromTeammates?: number
  // Fleet origin (CLIENT-INJECTED by the store's fleet merge — the hub never sends these). Set only
  // for a session pulled from a REMOTE fleet site; both `id` and `projectId` are namespaced
  // `${siteId}:${realId}`. Absent → this hub's own (local) session, shown unbadged as before.
  siteId?: string
  siteLabel?: string
  /** Whether that machine answered the last roster probe. False = last-known row, machine unreachable. */
  siteOnline?: boolean
}

export interface ManagerAgentType {
  id: string
  name: string
  purpose: string
  selection: 'fixed' | 'usage-aware'
  profileId?: string
  profileIds?: string[]
  model?: string
  effort?: string
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
  mcpServers: { name: string; transport: 'stdio' | 'http' | 'sse'; hasSecrets: boolean; command?: string }[]
  hooks: string[]
  hookCommands: {
    event: string
    command: string
    args?: string[]
    shell?: 'bash' | 'powershell'
    condition?: string
    timeout?: number
    background?: boolean
  }[]
  hasPermissions: boolean
  memoryFiles: { name: string; bytes: number }[]
  sources: string[]
  unmodeled: string[]
  fingerprint: string | null
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

export interface QuestionOption {
  label: string
  description: string
  /** Inert plain text only. The host never renders SDK preview content as HTML. */
  preview?: string
}

export interface QuestionPrompt {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface QuestionRecord {
  id: string
  sessionId: string
  questions: QuestionPrompt[]
  status: 'pending' | 'answered' | 'cancelled' | 'aborted'
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

export interface ReplayResetRequired {
  type: 'replay-reset-required'
  reason:
    | 'baseline-required'
    | 'generation-changed'
    | 'invalid-cursor'
    | 'tail-too-large'
    | 'client-queue-overflow'
  checkpoint: {
    version: 1
    generation: number
    cursor: number
    resetFloorSeq: number
  }
}

export type HubStreamMessage = HubEvent | ReplayStart | ReplayComplete | ReplayResetRequired

export interface ReplayBaseline {
  version: 1
  generation: number
  highWaterSeq: number
  resetFloorSeq: number
  sessions: SessionRecord[]
  projects: ProjectInfo[]
  journalCompaction: JournalCompactionStatus | null
}

export interface JournalCompactionStatus {
  operationId: string
  phase: 'started' | 'progress' | 'completed' | 'failed' | 'unobservable'
  startedAt: string
  updatedAt: string
  rowsDeleted: number
  payloadBytesDeleted: number
  detail: string
}

export interface JournalHistoryPage {
  events: HubEvent[]
  olderCursor: number | null
  hasOlder: boolean
  encodedBytes: number
  checkpointGeneration: number
}

// In the packaged desktop app the frontend is served from tauri.localhost, so relative URLs
// never reach the hub. Detect the Tauri webview and target the loopback hub directly. In the
// browser (dev) the base stays empty and Vite's proxy forwards /api and /ws to the hub.
const inTauri =
  typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
const desktopHubPort =
  import.meta.env.DEV && import.meta.env.VITE_HUB_PORT ? import.meta.env.VITE_HUB_PORT : '7777'
export const HUB_HTTP = inTauri ? `http://127.0.0.1:${desktopHubPort}` : ''
export const HUB_WS = inTauri ? `ws://127.0.0.1:${desktopHubPort}` : ''

// Device token (localStorage-backed). Sent as a Bearer header on every request and as ?token= on
// the WebSocket. The desktop obtains it from its OS-owned data directory; remote devices normally
// exchange a short-lived, one-use code for it. It is never bootstrapped over unauthenticated HTTP.
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
function authHeaders(token = hubToken): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

export interface WorkspacePressure {
  level: 'warning' | 'critical'
  totalBytes: number
  artifactBytes: number
  artifactGroups: Array<{ name: string; bytes: number }>
  reasons: Array<'workspace-size' | 'build-artifacts' | 'low-disk'>
  partial: boolean
  observedAt: string
  freeBytes?: number
  lastNotifiedAt?: string
}

/**
 * Remote hubs deliberately do not share this hub's device token. A token is paired once per fleet
 * site and kept in browser-local storage, exactly like the local device token. The fleet directory
 * supplies reachability only; it never transports a credential.
 */
const fleetTargets = new Map<string, FleetSite>()
const fleetTokenKey = (siteId: string): string => `hub.fleet-token.${encodeURIComponent(siteId)}`

export function configureFleetSites(sites: FleetSite[]): void {
  // Keep last-known targets for the lifetime of this renderer. A peer can disappear from discovery
  // while its last-known chats and queued messages remain visible; forgetting its prefix would make a
  // namespaced remote id fall through to the LOCAL hub. A stale remote URL fails safely, while local
  // misrouting could mutate the wrong machine. A returning peer overwrites the mapping below.
  for (const site of sites) if (!site.local) fleetTargets.set(site.siteId, site)
}

export function getFleetSiteToken(siteId: string): string {
  try {
    return localStorage.getItem(fleetTokenKey(siteId)) ?? ''
  } catch {
    return ''
  }
}

export function setFleetSiteToken(siteId: string, token: string): void {
  try {
    const key = fleetTokenKey(siteId)
    if (token.trim()) localStorage.setItem(key, token.trim())
    else localStorage.removeItem(key)
  } catch {
    /* ignore unavailable storage; the pairing check will remain explicit */
  }
}

export interface HubResourceTarget {
  id: string
  baseUrl: string
  token: string
  site?: FleetSite
}

/** Resolve a namespaced fleet resource without ever treating an arbitrary colon as a site prefix. */
export function resolveHubResource(id: string): HubResourceTarget {
  for (const site of fleetTargets.values()) {
    const prefix = `${site.siteId}:`
    if (id.startsWith(prefix)) {
      return { id: id.slice(prefix.length), baseUrl: site.baseUrl, token: getFleetSiteToken(site.siteId), site }
    }
  }
  return { id, baseUrl: HUB_HTTP, token: hubToken }
}

export function fleetWebSocketUrl(site: FleetSite, since: number, generation: number): string {
  const base = new URL(site.baseUrl)
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  base.pathname = '/ws'
  base.search = ''
  base.searchParams.set('since', String(since))
  base.searchParams.set('generation', String(generation))
  const token = getFleetSiteToken(site.siteId)
  if (token) base.searchParams.set('token', token)
  return base.toString()
}

interface TauriInvokeBridge {
  invoke?<T>(command: string, args?: Record<string, unknown>): Promise<T>
}

/** Acquire the local desktop's capability through native IPC. Plain browsers intentionally get none. */
export async function bootstrapDesktopHubToken(): Promise<boolean> {
  if (!inTauri) return false
  const g = (typeof window !== 'undefined' ? window : globalThis) as unknown as {
    __TAURI__?: { core?: TauriInvokeBridge }
    __TAURI_INTERNALS__?: TauriInvokeBridge
  }
  const invoke = g.__TAURI__?.core?.invoke ?? g.__TAURI_INTERNALS__?.invoke
  if (!invoke) return false
  try {
    const token = String(await invoke<string>('hub_device_token')).trim()
    if (token.length < 32) return false
    setHubToken(token)
    return true
  } catch {
    return false
  }
}

/**
 * A hub response that is not usable as data: a non-2xx status, a body that will not parse as JSON, or a
 * network failure. Thrown by `jget`; carried inside `jpost`'s returned error. `status` is the HTTP
 * status (0 for a network or pre-response failure) so a caller can branch on it.
 */
export class HubHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'HubHttpError'
  }
}

/**
 * The single place a hub response becomes a typed result. `ok:false` NEVER carries `data`, so an error
 * body can never be read as if it were `T` — the whole point of this transport. Before it existed, a
 * token-gated peer's 401 `{error}` was handed back as a `SessionRecord[]` (the store then iterated a
 * non-array), and a 404 on an approval was JSON-parsed and returned as though the write had succeeded.
 *
 * A non-2xx is `ok:false` with the body's `error` field when present, else an HTTP summary. A body that
 * will not parse as JSON is a failure EVEN on a 2xx: the hub only ever answers its API in JSON, so
 * text/HTML is a proxy error page or a truncated response, not data.
 */
type HttpResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string }

async function request<T>(
  method: string,
  url: string,
  base: string,
  body?: unknown,
  expectedStatuses: readonly number[] = [],
  signal?: AbortSignal,
  token = hubToken,
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { ...authHeaders(token) }
  if (method !== 'GET') headers['content-type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(base + url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' }
  }
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    return { ok: false, status: res.status, error: text.slice(0, 200) || `HTTP ${res.status}` }
  }
  if (!res.ok && !expectedStatuses.includes(res.status)) {
    const bodyError =
      parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `HTTP ${res.status}`
    return { ok: false, status: res.status, error: bodyError }
  }
  return { ok: true, status: res.status, data: parsed as T }
}

// `base` defaults to the local hub. Fleet calls pass the mapped remote base and that site's separately
// paired token explicitly; a local capability is never replayed against another machine.
//
// THROWS `HubHttpError` on any non-usable response. Every GET call site in the store already wraps this
// in `.catch(...)` (roster pulls fall back to [], a failed /api/fleet probe to null) — those guards
// only appeared to work before because an error body was resolved as fake data and the catch never
// fired, which is why a token-gated peer rendered ONLINE while its 401 roster body was iterated.
async function jget<T>(url: string, base: string = HUB_HTTP, signal?: AbortSignal, token = hubToken): Promise<T> {
  const r = await request<T>('GET', url, base, undefined, [], signal, token)
  if (!r.ok) throw new HubHttpError(r.error, r.status)
  return r.data
}

// POST callers are typed `T | { error: string }` and render `error` inline (the composer, the settings
// panels), so a failure is RETURNED in that shape rather than thrown. `!res.ok` now counts as a failure:
// a 401/404 body used to be parsed and returned as though the write succeeded, so a denied approval or a
// rejected settings write looked accepted.
async function jpost<T>(url: string, body?: unknown): Promise<T> {
  const r = await request<T>('POST', url, HUB_HTTP, body)
  if (!r.ok) return { error: r.error } as T
  return r.data
}

async function exchangePairingCode(
  code: string,
  base: string = HUB_HTTP,
): Promise<{ token?: string; error?: string }> {
  // Deliberately send no saved capability: this is the sole unauthenticated exchange endpoint.
  const r = await request<{ token?: string }>('POST', '/api/pair', base, { code }, [], undefined, '')
  return r.ok ? r.data : { error: r.error }
}

async function jdelete<T>(url: string): Promise<T> {
  const r = await request<T>('DELETE', url, HUB_HTTP)
  if (!r.ok) return { error: r.error } as T
  return r.data
}

async function routedGet<T>(id: string, path: (rawId: string) => string, signal?: AbortSignal): Promise<T> {
  const target = resolveHubResource(id)
  return jget<T>(path(target.id), target.baseUrl, signal, target.token)
}

async function routedPost<T>(id: string, path: (rawId: string) => string, body?: unknown): Promise<T> {
  const target = resolveHubResource(id)
  const r = await request<T>('POST', path(target.id), target.baseUrl, body, [], undefined, target.token)
  if (!r.ok) return { error: r.error } as T
  return r.data
}

async function routedPostExpected<T>(
  id: string,
  path: (rawId: string) => string,
  body: unknown,
  expectedStatuses: readonly number[],
): Promise<T> {
  const target = resolveHubResource(id)
  const r = await request<T>(
    'POST', path(target.id), target.baseUrl, body, expectedStatuses, undefined, target.token,
  )
  if (!r.ok) return { error: r.error } as T
  return r.data
}

async function routedDelete<T>(id: string, path: (rawId: string) => string): Promise<T> {
  const target = resolveHubResource(id)
  const r = await request<T>('DELETE', path(target.id), target.baseUrl, undefined, [], undefined, target.token)
  if (!r.ok) return { error: r.error } as T
  return r.data
}

function namespaceSessionResult(target: HubResourceTarget, value: SessionRecord | ApiError): SessionRecord | ApiError {
  if (!target.site || 'error' in value) return value
  return {
    ...value,
    id: `${target.site.siteId}:${value.id}`,
    profileId: `${target.site.siteId}:${value.profileId}`,
    projectId: value.projectId ? `${target.site.siteId}:${value.projectId}` : undefined,
    parentSessionId: value.parentSessionId ? `${target.site.siteId}:${value.parentSessionId}` : undefined,
    managerAllowedProfiles: value.managerAllowedProfiles?.map((id) => `${target.site!.siteId}:${id}`),
    managerAllowedModels: value.managerAllowedModels
      ? Object.fromEntries(Object.entries(value.managerAllowedModels).map(([id, models]) => [`${target.site!.siteId}:${id}`, models]))
      : undefined,
    managerAgentTypes: value.managerAgentTypes?.map((agentType) => ({
      ...agentType,
      profileId: agentType.profileId ? `${target.site!.siteId}:${agentType.profileId}` : undefined,
      profileIds: agentType.profileIds?.map((id) => `${target.site!.siteId}:${id}`),
    })),
    siteId: target.site.siteId,
    siteLabel: target.site.label,
    siteOnline: true,
  }
}

function namespaceProjectResult(target: HubResourceTarget, value: ProjectInfo | ApiError): ProjectInfo | ApiError {
  if (!target.site || 'error' in value) return value
  return {
    ...value,
    id: `${target.site.siteId}:${value.id}`,
    siteId: target.site.siteId,
    siteLabel: target.site.label,
    siteOnline: true,
  }
}

async function routedSessionPost(
  id: string,
  path: (rawId: string) => string,
  body?: unknown,
): Promise<SessionRecord | ApiError> {
  const target = resolveHubResource(id)
  const r = await request<SessionRecord | ApiError>(
    'POST', path(target.id), target.baseUrl, body, [], undefined, target.token,
  )
  return namespaceSessionResult(target, r.ok ? r.data : { error: r.error })
}

export const LOGIN_HTTP_TIMEOUT_MS = 8_000

async function boundedLoginRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const abortFromCaller = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = setTimeout(() => controller.abort(), LOGIN_HTTP_TIMEOUT_MS)
  try {
    try {
      const result = await request<T>(
        method,
        url,
        HUB_HTTP,
        body,
        [],
        controller.signal,
      )
      if (!result.ok) return { error: result.error } as T
      return result.data
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'network error',
      } as T
    }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

// Some POSTs use a non-2xx status as a deliberate, typed outcome rather than a transport failure. Keep
// that exception explicit at the call site so ordinary 401/404/409 responses still collapse to {error}.
async function jpostExpected<T>(
  url: string,
  body: unknown,
  expectedStatuses: readonly number[]
): Promise<T> {
  const r = await request<T>('POST', url, HUB_HTTP, body, expectedStatuses)
  if (!r.ok) return { error: r.error } as T
  return r.data
}

export interface LoginResult {
  ok: boolean
  loginId?: string
  profileId?: string
  added?: string
  provider?: string
  status?: 'capturing' | 'waiting' | 'settling' | 'complete' | 'failed' | 'cancelled' | 'timed-out'
  url?: string
  code?: string
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
  /** Client-derived credential state; never supplied by the fleet directory itself. */
  authState?: 'paired' | 'pairing-required' | 'error'
  authError?: string
}

export type RemoteDeviceCapability = 'read' | 'write' | 'terminal'

export interface RemoteDeviceGrant {
  siteId: string
  rootIds: string[]
  capabilities: RemoteDeviceCapability[]
}

export interface DeviceRootPolicy {
  id: string
  label: string
  path: string
  environment?: { kind: 'wsl'; distro: string }
  read: boolean
  write: boolean
  terminal: boolean
}

export interface RemoteExecutionEnvironment {
  id: string
  kind: 'host' | 'wsl'
  label: string
  platform: string
  arch?: string
  shell: string
  distro?: string
  state?: 'running' | 'stopped'
  version?: 1 | 2
  isDefault?: boolean
}

export interface DeviceExecutorCapabilities {
  enabled: boolean
  platform: string
  arch: string
  hostname: string
  /** Added after the host-only executor shipped; absent on an older peer capability response. */
  environments?: RemoteExecutionEnvironment[]
  roots: DeviceRootPolicy[]
}

export interface FleetConnectionPublic {
  siteId: string
  label: string
  updatedAt: string
  paired: true
}

export interface RemoteDeviceCatalogEntry extends FleetConnectionPublic {
  connected: boolean
  error?: string
  capabilities?: DeviceExecutorCapabilities
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

/** Which pool new chats are named from. Two choices by design — there is no men-only option. */
export type ChatNamePool = 'women' | 'everyone'
export type FileWriteDiffDensity = 'minimal' | 'summary' | 'verbose'

/**
 * Owner preferences — plain settings with no safety dimension, so they live outside the Danger Zone.
 *
 * Hub-side rather than in the local `settings` store because the HUB generates a chat's name, from its
 * session id, at the moment the chat is created. A browser-local copy could not be read there, and two
 * devices disagreeing about the pool would produce chats named from whichever one happened to spawn them.
 */
export interface HubPrefs {
  chatNamePool: ChatNamePool
  steerMessagesAtToolBoundary: boolean
  /** Optional while bootstrap is using its pre-fetch fallback; the hub always returns a resolved value. */
  fileWriteDiffDensity?: FileWriteDiffDensity
}

export interface OverseerStatus {
  configured: boolean
  profileId?: string
  sessionId?: string
  session?: SessionRecord
  available: boolean
}

export interface ApiError {
  error: string
}

// Danger Zone toggles — safe-default guardrail switches (all default false / OFF).
export interface DangerFlags {
  disableWorktreeCollisionWarnings?: boolean
  busCanUseRiskyTools: boolean
  autoApprovePractices: boolean
  autoApproveRestart?: boolean
  enableClaudeConnectors?: boolean
  fullAccessAnyOrigin?: boolean
}

export interface WorktreeIntegrationCheck {
  ok: boolean
  disabled: boolean
  baseCommit?: string
  mainCommit?: string
  baseRef?: string | null
  commitsBehind?: number
  diverged?: boolean
  staleFiles?: Array<{
    file: string
    kind: 'uncommitted' | 'committed' | 'both'
    commits: Array<{ commit: string; subject: string }>
  }>
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

export interface BrowserStatus {
  enabled: boolean
  available: boolean
  reason?: string
  retainedProfile: boolean
  publicOriginGrants: string[]
  localNetworkEnabled: boolean
  tabsEnabled: boolean
  downloadsEnabled: boolean
}

export const api = {
  replayBaseline: () => jget<ReplayBaseline>('/api/replay-baseline'),
  profiles: () => jget<ProfileInfo[]>('/api/profiles'),
  stats: () => jget<StatsResult>('/api/stats'),
  // Account refresh is part of the login lifecycle, so it obeys the same transport bound as every
  // login/status/cancel request. The optional outer signal also lets the whole-attempt deadline stop it.
  rescanProfiles: (signal?: AbortSignal) =>
    boundedLoginRequest<ProfileInfo[] | ApiError>(
      'POST',
      '/api/profiles/rescan',
      undefined,
      signal,
    ),
  renameProfile: (id: string, displayName: string) =>
    jpost<ProfileInfo | ApiError>(
      `/api/profiles/${encodeURIComponent(id)}/name`,
      { displayName },
    ),
  login: (
    provider: 'claude' | 'codex',
    name: string,
    reauth: boolean,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) =>
    boundedLoginRequest<LoginResult>('POST', '/api/accounts/login', {
      provider,
      name,
      reauth,
      idempotencyKey,
    }, signal),
  loginForProfile: (name: string, idempotencyKey: string, signal?: AbortSignal) =>
    boundedLoginRequest<LoginResult>(
      'GET',
      `/api/accounts/login/profile/${encodeURIComponent(name)}?key=${encodeURIComponent(idempotencyKey)}`,
      undefined,
      signal,
    ),
  loginStatus: (id: string, signal?: AbortSignal) =>
    boundedLoginRequest<LoginResult>(
      'GET',
      `/api/accounts/login/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  cancelLogin: (id: string, signal?: AbortSignal) =>
    boundedLoginRequest<LoginResult>(
      'DELETE',
      `/api/accounts/login/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  pickFolder: () => jpost<{ path: string }>('/api/pick-folder'),
  wslCapability: () => jget<WslCapability>('/api/wsl/capability'),
  projects: () => jget<ProjectInfo[]>('/api/projects'),
  projectActivity: async (projectId: string) => {
    const target = resolveHubResource(projectId)
    const value = await routedGet<WorktreeProjectActivity>(projectId, (id) => `/api/projects/${encodeURIComponent(id)}/activity`)
    if (!target.site) return value
    const prefix = (id: string): string => `${target.site!.siteId}:${id}`
    return {
      ...value,
      projectId: prefix(value.projectId),
      agents: value.agents.map((agent) => ({ ...agent, sessionId: prefix(agent.sessionId) })),
      risks: value.risks.map((risk) => ({ ...risk, sessionIds: risk.sessionIds.map(prefix) })),
    }
  },
  inspectProjectDeletion: async (projectId: string) => {
    const target = resolveHubResource(projectId)
    const value = await routedGet<ProjectDeletionInspection>(projectId, (id) => `/api/projects/${encodeURIComponent(id)}/deletion`)
    if (!target.site) return value
    const prefix = (id: string): string => `${target.site!.siteId}:${id}`
    return {
      ...value,
      projectId: prefix(value.projectId),
      sessions: value.sessions.map((session) => ({ ...session, id: prefix(session.id) })),
      changes: value.changes.map((change) => ({ ...change, sessionId: change.sessionId ? prefix(change.sessionId) : undefined })),
      localCommits: value.localCommits.map((commit) => ({ ...commit, sessionId: commit.sessionId ? prefix(commit.sessionId) : undefined })),
      worktrees: value.worktrees.map((worktree) => ({ ...worktree, sessionId: prefix(worktree.sessionId) })),
    }
  },
  deleteProject: async (projectId: string, deleteFiles = false) => {
    const target = resolveHubResource(projectId)
    const value = await routedDelete<ProjectDeletionResult>(
      projectId,
      (id) => `/api/projects/${encodeURIComponent(id)}${deleteFiles ? '?deleteFiles=true' : ''}`,
    )
    if (!target.site) return value
    const prefix = (id: string): string => `${target.site!.siteId}:${id}`
    return {
      ...value,
      detachedSessionIds: value.detachedSessionIds?.map(prefix),
      deletedSessionIds: value.deletedSessionIds?.map(prefix),
    }
  },
  validateProject: (name: string, path: string, distro?: string) =>
    jpost<ProjectDraftValidation | { error: string }>('/api/projects/validate', {
      name,
      path,
      ...(distro ? { distro } : {}),
    }),
  createProject: (name: string, path: string, distro?: string) =>
    jpost<ProjectInfo | { error: string }>('/api/projects', {
      name,
      path,
      ...(distro ? { distro } : {}),
    }),
  updateProject: async (id: string, patch: { name: string }) => {
    const target = resolveHubResource(id)
    const value = await routedPost<ProjectInfo | ApiError>(id, (raw) => `/api/projects/${encodeURIComponent(raw)}/settings`, patch)
    return namespaceProjectResult(target, value)
  },
  createManagedProject: (name: string, distro?: string) =>
    jpost<ProjectInfo | { error: string }>('/api/projects/managed', {
      name,
      ...(distro ? { distro } : {}),
    }),
  githubCapability: () => jget<GitHubCapability>('/api/github/capability'),
  githubRepositories: () => jget<GitHubRepository[]>('/api/github/repositories'),
  startGitHubClone: (nameWithOwner: string, distro?: string) =>
    jpost<GitHubCloneJob | { error: string }>('/api/github/clones', {
      nameWithOwner,
      ...(distro ? { distro } : {}),
    }),
  githubClone: (id: string) => jget<GitHubCloneJob>(`/api/github/clones/${encodeURIComponent(id)}`),
  // --- Unified fleet view ---
  // The fleet roster: this hub + every reachable co-owned peer's hub, badged by machine.
  fleet: () => jget<FleetSite[]>('/api/fleet'),
  // Authenticate, bootstrap, and refresh an arbitrary mapped fleet hub with its own paired token.
  authFrom: (site: FleetSite) =>
    jget<{ requireToken: boolean; authed: boolean }>('/api/auth', site.baseUrl, undefined, getFleetSiteToken(site.siteId)),
  replayBaselineFrom: (site: FleetSite) =>
    jget<ReplayBaseline>('/api/replay-baseline', site.baseUrl, undefined, getFleetSiteToken(site.siteId)),
  projectsFrom: (site: FleetSite) =>
    jget<ProjectInfo[]>('/api/projects', site.baseUrl, undefined, getFleetSiteToken(site.siteId)),
  sessionsFrom: (site: FleetSite) =>
    jget<SessionRecord[]>('/api/sessions', site.baseUrl, undefined, getFleetSiteToken(site.siteId)),
  profilesFrom: (site: FleetSite) =>
    jget<ProfileInfo[]>('/api/profiles', site.baseUrl, undefined, getFleetSiteToken(site.siteId)),
  approvalsFrom: (site: FleetSite) =>
    jget<ApprovalRecord[]>('/api/approvals', site.baseUrl, undefined, getFleetSiteToken(site.siteId)),
  questionsFrom: (site: FleetSite) =>
    jget<QuestionRecord[]>('/api/questions', site.baseUrl, undefined, getFleetSiteToken(site.siteId)),
  usageFrom: (site: FleetSite) =>
    jget<UsageSnapshot[]>('/api/usage', site.baseUrl, undefined, getFleetSiteToken(site.siteId)),
  saveFleetConnection: (siteId: string, label: string, token: string) =>
    jpost<FleetConnectionPublic | ApiError>('/api/fleet/connections', { siteId, label, token }),
  removeFleetConnection: (siteId: string) =>
    jpost<{ ok?: boolean; removed?: boolean; error?: string }>(`/api/fleet/connections/${encodeURIComponent(siteId)}/remove`, {}),
  fleetConnections: () => jget<FleetConnectionPublic[]>('/api/fleet/connections'),
  // Project import: preview existing vendor chats under a folder, then adopt the selected ones.
  scanProject: (path: string, projectId?: string) => {
    const target = resolveHubResource(projectId ?? '')
    return request<ScanResult | { error: string }>(
      'POST', '/api/projects/scan', target.baseUrl, { path }, [], undefined, target.token,
    ).then((result) => result.ok ? result.data : { error: result.error })
  },
  importChats: async (projectId: string, vendorSessionIds: string[]) => {
    const target = resolveHubResource(projectId)
    const value = await routedPost<ImportResult | { error: string }>(
      projectId,
      (id) => `/api/projects/${encodeURIComponent(id)}/import`,
      { vendorSessionIds },
    )
    if (!target.site || 'error' in value) return value
    return {
      ...value,
      imported: value.imported.map((session) =>
        namespaceSessionResult(target, session) as SessionRecord,
      ),
    }
  },
  sessions: (signal?: AbortSignal) => jget<SessionRecord[]>('/api/sessions', HUB_HTTP, signal),
  // On-demand vendor transcript history for an imported chat (bounded tail; `before` byte cursor pages older).
  history: (id: string, before?: number, signal?: AbortSignal) =>
    routedGet<HistoryPage>(
      id,
      (raw) => `/api/sessions/${encodeURIComponent(raw)}/history${before != null ? `?before=${before}` : ''}`,
      signal,
    ),
  journalHistory: (id: string, generation: number, before?: number, signal?: AbortSignal) => {
    const query = new URLSearchParams({ generation: String(generation) })
    if (before != null) query.set('before', String(before))
    return routedGet<JournalHistoryPage>(
      id,
      (raw) => `/api/sessions/${encodeURIComponent(raw)}/journal-history?${query.toString()}`,
      signal,
    )
  },
  approvals: () => jget<ApprovalRecord[]>('/api/approvals'),
  questions: () => jget<QuestionRecord[]>('/api/questions'),
  recoveryNotices: () => jget<RecoveryNotice[]>('/api/recovery-notices'),
  dismissRecoveryNotice: (planId: string) =>
    jpost<{ ok?: boolean; error?: string }>(
      `/api/recovery-notices/${encodeURIComponent(planId)}/dismiss`,
      {}
    ),
  usage: () => jget<UsageSnapshot[]>('/api/usage'),
  refreshUsage: () => jpost<UsageSnapshot[] | ApiError>('/api/usage/refresh'),
  // NOTE: spawn does NOT take `attachments`. Uploads are session-owned (their id is minted by the upload
  // route against an existing session), so the hub REFUSES attachments on create (server.ts) — the first
  // message with attachments is: spawn an empty session (no prompt) → uploadAttachment(id, file) per file
  // → send(id, prompt, { attachments: ids }).
  spawn: (body: Record<string, unknown>) => {
    const projectId = typeof body.projectId === 'string' ? body.projectId : ''
    const target = resolveHubResource(projectId)
    if (!target.site) return jpost<SessionRecord | { error: string }>('/api/sessions', body)
    const profile = typeof body.profileId === 'string' ? resolveHubResource(body.profileId) : null
    return request<SessionRecord | { error: string }>(
      'POST',
      '/api/sessions',
      target.baseUrl,
      {
        ...body,
        projectId: target.id,
        ...(profile?.site?.siteId === target.site.siteId ? { profileId: profile.id } : {}),
      },
      [],
      undefined,
      target.token,
    ).then((r) => namespaceSessionResult(target, r.ok ? r.data : { error: r.error }))
  },
  // `attachments` is an array of attachment IDs (from uploadAttachment), NOT the metadata objects — the
  // hub resolves ids to the stored files (server.ts stringArray: "must be an array of ids").
  send: (id: string, text: string, extra: { model?: string; effort?: string; serviceTier?: string; attachments?: string[] } = {}) =>
    routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/input`, { text, ...extra }),
  steer: (id: string, text: string, attachments?: string[]) =>
    routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/steer`, { text, ...(attachments?.length ? { attachments } : {}) }),
  /**
   * Upload ONE file's raw bytes to a session and get back its stored {@link AttachmentMeta} (id used to
   * reference it on the next send/steer), or `{ error }` on failure. Bespoke transport — NOT jpost — the
   * body is raw bytes, not JSON: content-type carries the mime and `x-filename` the name, matching the hub
   * upload route. Like jpost it RESOLVES `{ error }` rather than throwing, so the composer must surface a
   * failed upload AT the composer: a file that silently fails to attach is the same class of bug as one
   * that silently fails to reach the vendor. The hub enforces the real per-mime size cap while streaming.
   */
  async uploadAttachment(sessionId: string, file: File): Promise<AttachmentRef | { error: string }> {
    const target = resolveHubResource(sessionId)
    const url = `${target.baseUrl}/api/sessions/${encodeURIComponent(target.id)}/attachments`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          ...authHeaders(target.token),
          'content-type': file.type || 'application/octet-stream',
          // The hub reads x-filename verbatim as the stored name. HTTP header values are Latin-1, so a
          // filename with characters fetch cannot put in a header rejects here and surfaces as { error }.
          'x-filename': file.name,
        },
        body: file,
      })
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'network error' }
    }
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      return { error: text.slice(0, 200) || `HTTP ${res.status}` }
    }
    if (!res.ok) {
      const err =
        parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `HTTP ${res.status}`
      return { error: err }
    }
    return parsed as AttachmentRef
  },
  // A profile's on-disk custom slash commands (for the `/` command picker).
  commands: (profileId: string) =>
    routedGet<CommandInfo[]>(profileId, (raw) => `/api/profiles/${encodeURIComponent(raw)}/commands`),
  // Request on-demand context compaction (the `/compact` built-in). See CompactResult.
  compact: (id: string) => routedPost<CompactResult>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/compact`),
  interrupt: (id: string) => routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/interrupt`),
  interruptAgent: (id: string, targetId: string, label?: string) =>
    routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/agents/interrupt`, { targetId, label }),
  stop: (id: string) => routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/stop`),
  // The inverse of stop(): revive a stopped/errored chat to idle so it's usable again (composer frees,
  // bus-reachable). Fixes stop() being a permanent one-way brick.
  reopen: (id: string) => routedPost<{ ok?: boolean; status?: string; error?: string }>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/reopen`),
  deleteSession: (id: string, deleteBrowserData = false) =>
    routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/delete`, { deleteBrowserData }),
  setMode: (id: string, permissionMode: string, operatorOverride = false) =>
    routedPost<{ ok: boolean } | ApiError>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/mode`, {
      permissionMode,
      operatorOverride,
    }),
  browserStatus: (id: string) =>
    routedGet<BrowserStatus>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/browser`),
  setBrowserEnabled: (id: string, enabled: boolean) =>
    routedPost<BrowserStatus | ApiError>(
      id,
      (raw) => `/api/sessions/${encodeURIComponent(raw)}/browser`,
      { enabled },
    ),
  setBrowserLocalNetwork: (id: string, enabled: boolean) =>
    routedPost<BrowserStatus | ApiError>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/browser/local-network`, { enabled }),
  setBrowserTabs: (id: string, enabled: boolean) =>
    routedPost<BrowserStatus | ApiError>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/browser/tabs`, { enabled }),
  setBrowserDownloads: (id: string, enabled: boolean) =>
    routedPost<BrowserStatus | ApiError>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/browser/downloads`, { enabled }),
  revokeBrowserOrigin: (id: string, origin: string) =>
    routedPost<BrowserStatus | ApiError>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/browser/origins/revoke`, { origin }),
  showBrowser: (id: string) =>
    routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/browser/show`),
  clearBrowser: (id: string) =>
    routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/browser/clear`),
  configureProjectManager: (
    id: string,
    config: {
      enabled: boolean
      maxLiveChildren?: number
      delegation?: Array<'commit' | 'push'>
      allowedProfiles?: string[]
      allowedModels?: Record<string, string[]>
      allowedTools?: string[]
      agentTypes?: ManagerAgentType[]
      startingPrompt?: string
      orientationBrief?: string
      operatorTask?: string
      standingInstructions?: string
      canApproveChildren?: boolean
      permissionMode?: 'safe' | 'edits' | 'full'
      maxChildPermissionMode?: 'safe' | 'edits' | 'full'
    }
  ) => {
    const target = resolveHubResource(id)
    const stripProfile = (profileId: string): string => {
      const profile = resolveHubResource(profileId)
      return profile.site?.siteId === target.site?.siteId ? profile.id : profileId
    }
    return routedSessionPost(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/project-manager`, {
      ...config,
      allowedProfiles: config.allowedProfiles?.map(stripProfile),
      allowedModels: config.allowedModels
        ? Object.fromEntries(Object.entries(config.allowedModels).map(([profileId, models]) => [stripProfile(profileId), models]))
        : undefined,
      agentTypes: config.agentTypes?.map((agentType) => ({
        ...agentType,
        profileId: agentType.profileId ? stripProfile(agentType.profileId) : undefined,
        profileIds: agentType.profileIds?.map(stripProfile),
      })),
    })
  },
  /** "Always allow this tool in this chat" (allow=false revokes). Takes effect on the next tool call. */
  allowTool: (id: string, toolName: string, allow = true) =>
    routedSessionPost(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/allow-tool`, { toolName, allow }),
  remoteDeviceCatalog: (id: string) =>
    routedGet<RemoteDeviceCatalogEntry[]>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/remote-devices`),
  setRemoteDeviceGrants: (id: string, grants: RemoteDeviceGrant[]) =>
    routedSessionPost(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/remote-devices`, { grants }),
  /** Persist a per-chat model / thinking effort / service tier immediately (survives reload + restart). */
  setSettings: (id: string, patch: { model?: string; effort?: string; serviceTier?: string }) =>
    routedSessionPost(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/settings`, patch),
  /** Mandatory pre-push/pre-merge check; `ok:false` means main touched files this branch changes. */
  checkIntegration: (id: string) =>
    routedPostExpected<WorktreeIntegrationCheck | ApiError>(
      id,
      (raw) => `/api/sessions/${encodeURIComponent(raw)}/integration-check`,
      {},
      [409]
    ),
  // Typed so a caller can tell an accepted decision (200 { ok:true }) from a 404/401/network failure
  // ({ error }) — the approval UI must NOT clear a pending prompt it never actually resolved.
  decide: (id: string, approve: boolean) => routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/approvals/${encodeURIComponent(raw)}`, { approve }),
  answerQuestion: (id: string, answers: Record<string, string>) =>
    routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/questions/${encodeURIComponent(raw)}`, {
      answers,
    }),
  cancelQuestion: (id: string) =>
    routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/questions/${encodeURIComponent(raw)}`, {
      cancel: true,
    }),
  mesh: () => jget<MeshStatus>('/api/mesh'),
  deviceExecutor: () => jget<DeviceExecutorCapabilities>('/api/device-executor'),
  setDeviceExecutor: (enabled: boolean, roots: Array<Omit<DeviceRootPolicy, 'id'> & { id?: string }>) =>
    jpost<DeviceExecutorCapabilities | ApiError>('/api/device-executor', { enabled, roots }),
  revealDeviceToken: () => jpost<{ token?: string; error?: string }>('/api/device-token/reveal'),
  issuePairingCode: () =>
    jpost<{ code?: string; expiresAt?: string; error?: string }>('/api/pairing-code'),
  exchangePairingCode,
  setMesh: (enable: boolean) => jpost<MeshStatus | ApiError>('/api/mesh', { enable }),
  auth: () => jget<{ requireToken: boolean; authed: boolean }>('/api/auth'),
  instructions: () => jget<Instruction[]>('/api/instructions'),
  setInstructions: (scope: string, content: string) =>
    jpost<Instruction[] | ApiError>('/api/instructions', { scope, content }),
  rename: (id: string, title: string) => routedPost<{ ok?: boolean; error?: string }>(id, (raw) => `/api/sessions/${encodeURIComponent(raw)}/title`, { title }),
  memory: (scope?: string) => jget<Memory[]>(`/api/memory${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`),
  searchMemory: (q: string, scope?: string) =>
    jget<Memory[]>(`/api/memory?q=${encodeURIComponent(q)}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`),
  writeMemory: (scope: string, title: string, body: string, tags?: string[]) =>
    jpost<Memory | { error: string }>('/api/memory', { scope, title, body, tags }),
  // Agent-authored practices — operator review + revoke (writes come from agents via gated tools).
  practices: () => jget<Practice[]>('/api/practices'),
  revokePractice: (id: string) => jpost<{ ok?: boolean; error?: string }>(`/api/practices/${id}/revoke`),
  // Owner preferences (hub-side settings that are not safety switches).
  prefs: () => jget<HubPrefs>('/api/config/prefs'),
  setPrefs: (patch: Partial<HubPrefs>) => jpost<HubPrefs | ApiError>('/api/config/prefs', patch),
  overseer: () => jget<OverseerStatus>('/api/overseer'),
  configureOverseer: (profileId: string) => jpost<OverseerStatus | ApiError>('/api/overseer', { profileId }),
  // Danger Zone toggles.
  danger: () => jget<DangerFlags>('/api/config/danger'),
  setDanger: (patch: Partial<DangerFlags>) => jpost<DangerFlags | ApiError>('/api/config/danger', patch),
  // Operator "Restart hub" — forwards to the supervisor (202 accepted); 503 {error} when unsupervised.
  restartHub: () => jpost<{ accepted?: boolean } | ApiError>('/api/restart', { reason: 'operator' }),
  bus: (opts: { project?: string; session?: string } = {}) => {
    const p = new URLSearchParams()
    if (opts.project) p.set('project', opts.project)
    if (opts.session) p.set('session', opts.session)
    const qs = p.toString()
    return jget<BusMessage[]>(`/api/bus${qs ? `?${qs}` : ''}`)
  },
}
