import { api, HUB_WS, getHubToken, setHubToken } from './api'
import { settings } from './settings.svelte'
import { alertDialog } from './dialog.svelte'
import { loadLastLayout, saveLastLayout, type PersistedLayout } from './uiState'
import type { ApprovalRecord, FleetSite, HistoryItem, HistoryPage, HubEvent, ProfileInfo, ProjectInfo, ScanResult, SessionRecord, UsageSnapshot } from './api'

// Verbose client tracing — on in dev, compiled out of prod builds. Toggle off in dev by setting
// localStorage['ama:verbose'] = '0'. Surfaces the load/connect/replay/scan milestones so a stall is
// visible in the console instead of a mystery freeze.
const VERBOSE = (() => {
  try {
    const dev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
    return dev && localStorage.getItem('ama:verbose') !== '0'
  } catch {
    return false
  }
})()
function vlog(...args: unknown[]): void {
  if (VERBOSE) console.info('%c[ama]', 'color:#c026d3', ...args)
}
function perfNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
function msSince(t0: number): string {
  return `${Math.round(perfNow() - t0)}ms`
}

export interface StatusInfo {
  key: string
  label: string
}

export type ItemKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'reasoning'
  | 'status'
  | 'error'
  | 'note'
  | 'bus'

export interface ThreadItem {
  key: string
  kind: ItemKind
  ts: string
  text?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: string
  toolError?: boolean
  reflex?: boolean
  status?: string
  // True for a turn reconstructed from the vendor transcript on open (imported chats), vs a live/
  // journaled event. Drives condensed rendering + a "history" affordance; carries no precise ts.
  historical?: boolean
  // Inter-agent bus message (kind: 'bus'): whether this session sent or received it, the other
  // party's label, and an optional subject. `text` holds the message body.
  busDir?: 'sent' | 'received'
  busPeer?: string
  busSubject?: string
}

export interface SessionView {
  record: SessionRecord
  items: ThreadItem[]
  lastActivity: string
  sawReasoning: boolean
  lastTurnOk?: boolean
  contextUsed?: number
  contextWindow?: number
  costUsd?: number
  // When the current in-flight turn began (ms epoch); undefined when idle. Drives the
  // "received / thinking" indicator + elapsed timer.
  turnStartedAt?: number
  // Latest token usage the provider reported for the running turn (realtime counter).
  liveTokens?: { input?: number; output?: number; total?: number }
  // A local-only DRAFT chat: opened by "new chat" but NOT yet spawned on the hub (no session,
  // no worktree). Excluded from `sessionList`, so it never shows in the sidebar/dashboard; it is
  // reached only as the open pane via `sessions[id]`. It materializes into a real session on the
  // first send. `draftUseWorktree` is the pre-spawn worktree intent (there is no real worktree
  // path yet) — passed as `useWorktree` when the draft is finally spawned.
  draft?: boolean
  draftUseWorktree?: boolean
  // Imported-chat history (loaded on open from the vendor transcript). `loadingHistory` gates a
  // spinner; `historyOlderCursor` is the byte offset for "load older" (null when fully loaded).
  loadingHistory?: boolean
  historyOlderCursor?: number | null
}

interface ClaudeBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

// Where a dragged chat will land in the 2D pane layout: a new COLUMN inside an existing
// row (left/right drop), or a whole new ROW (top/bottom drop).
export type DropZone =
  | { kind: 'col'; row: number; col: number }
  | { kind: 'row'; row: number }

function asText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : ((c as { text?: string }).text ?? JSON.stringify(c))))
      .join('\n')
  }
  return JSON.stringify(content)
}

// --- Sidebar ordering (persisted) ---------------------------------------------------------------
// The user can hand-arrange PROJECT groups and the CHAT rows within each group by dragging. We
// persist only the chosen order as id lists under namespaced localStorage keys (same convention as
// `allmyagents.sidebarWidth`) and re-apply them when building the sidebar. Ids missing from a saved
// list keep their natural order (projects: hub order; chats: recency) and are appended after the
// known ones, so a freshly created project/chat is never dropped.
const ORDER_PROJECTS_KEY = 'allmyagents.order.projects'
const ORDER_CHATS_PREFIX = 'allmyagents.order.chats.'
// Projects for which the user chose "don't ask again" on the import prompt (persisted set of ids).
const IMPORT_DISMISSED_KEY = 'allmyagents.import.dismissed'

function loadOrder(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const arr = JSON.parse(raw) as unknown
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    /* ignore */
  }
  return []
}

function saveOrder(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

function loadDismissed(): Set<string> {
  return new Set(loadOrder(IMPORT_DISMISSED_KEY))
}

// Load every persisted chat order up front by scanning the namespaced keys, so saved arrangements
// apply on the first render after a reload — not only after a group is touched again.
function loadChatOrders(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(ORDER_CHATS_PREFIX)) out[k.slice(ORDER_CHATS_PREFIX.length)] = loadOrder(k)
    }
  } catch {
    /* ignore */
  }
  return out
}

// Stable-sort `items` by a saved id order. Ids not present in `order` keep their incoming relative
// order and land after the known ones — never dropped.
function applyOrder<T>(items: T[], order: string[], idOf: (x: T) => string): T[] {
  if (order.length === 0) return items
  const pos = new Map(order.map((id, i) => [id, i]))
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const pa = pos.get(idOf(a.item)) ?? Infinity
      const pb = pos.get(idOf(b.item)) ?? Infinity
      return pa === pb ? a.i - b.i : pa - pb
    })
    .map((x) => x.item)
}

// Move `fromId` to sit where `toId` currently is. Inserting at toId's original index lands the item
// before the target when dragging up and after it when dragging down — the natural drag-reorder
// feel. Returns the SAME array reference when nothing changes, so callers can skip no-op writes.
function moveInto(ids: string[], fromId: string, toId: string): string[] {
  const from = ids.indexOf(fromId)
  const to = ids.indexOf(toId)
  if (from < 0 || to < 0 || from === to) return ids
  const next = ids.slice()
  next.splice(from, 1)
  next.splice(to, 0, fromId)
  return next
}

class HubStore {
  profiles = $state<ProfileInfo[]>([])
  projects = $state<ProjectInfo[]>([])
  sessions = $state<Record<string, SessionView>>({})
  approvals = $state<ApprovalRecord[]>([])
  usage = $state<UsageSnapshot[]>([])
  connected = $state(false)
  needsPairing = $state(false)
  selectedId = $state<string | null>(null)
  settingsOpen = $state(false)
  queues = $state<Record<string, string[]>>({})
  // Persisted sidebar arrangement: ordered project ids, and ordered chat ids keyed by group id
  // ('__none__' for the Unfiled group). Reorder methods update these + localStorage; the sidebar
  // reads `orderedProjects` / `orderedChats` to apply them.
  projectOrder = $state<string[]>(loadOrder(ORDER_PROJECTS_KEY))
  chatOrder = $state<Record<string, string[]>>(loadChatOrders())
  // One-shot flags: suppress a Codex `userMessage` event when we've already echoed it optimistically.
  private suppressNextUserMsg: Record<string, boolean> = {}
  // id -> ms timestamp of the last time a chat MATERIALIZED (draft → real) or was (re)TITLED.
  // The sidebar watches this to play a brief glitch on that row's label, then clears it.
  recentlyChanged = $state<Record<string, number>>({})
  lastSeq = 0
  // --- Unified fleet view (first cut, read-only) -----------------------------------------------
  // The fleet roster from GET /api/fleet (this hub + reachable co-owned peers). In the single-machine
  // case this is just the local entry, so nothing below changes the UI. Remote sites' projects +
  // sessions are POLLED read-only and merged into `projects`/`sessions` with `${siteId}:` id
  // namespacing + a site tag for the sidebar badge; the LOCAL hub keeps its live WS + apply() as-is.
  fleetSites = $state<FleetSite[]>([])
  private fleetTimer: ReturnType<typeof setInterval> | null = null

  // --- Import prompt ---------------------------------------------------------------------------
  // Which project's "import existing chats" panel is open (id + folder path, plus an optional
  // pre-fetched scan so the auto-prompt path doesn't scan twice). Single source of truth read by
  // the sidebar; set by the create flow, the per-project button, and the open-project auto-prompt.
  importPanelFor = $state<{ projectId: string; path: string; preloaded?: ScanResult } | null>(null)
  // Projects the user said "don't ask again" for (persisted) — never auto-prompted again.
  importDismissed = $state<Set<string>>(loadDismissed())
  // Projects already auto-scanned this session, so the open-project prompt fires at most once each.
  private importChecked = new Set<string>()

  queueFor(sessionId: string): string[] {
    return this.queues[sessionId] ?? []
  }

  enqueue(sessionId: string, text: string): void {
    const q = [...(this.queues[sessionId] ?? []), text]
    this.queues = { ...this.queues, [sessionId]: q }
  }

  editQueued(sessionId: string, index: number, text: string): void {
    const q = [...(this.queues[sessionId] ?? [])]
    if (index < 0 || index >= q.length) return
    q[index] = text
    this.queues = { ...this.queues, [sessionId]: q }
  }

  removeQueued(sessionId: string, index: number): void {
    const q = (this.queues[sessionId] ?? []).filter((_, i) => i !== index)
    this.queues = { ...this.queues, [sessionId]: q }
  }

  private flushQueue(sessionId: string): void {
    const q = this.queues[sessionId]
    if (!q || q.length === 0) return
    let toSend: string
    let rest: string[]
    if (settings.combineQueued) {
      toSend = q.join('\n\n')
      rest = []
    } else {
      toSend = q[0] as string
      rest = q.slice(1)
    }
    this.queues = { ...this.queues, [sessionId]: rest }
    this.pushUserEcho(sessionId, toSend) // show the flushed queued message in the transcript
    void api.send(sessionId, toSend)
  }

  private ws: WebSocket | null = null

  get sessionList(): SessionView[] {
    // Drafts are local-only until they materialize — keep them out of the sidebar + dashboard.
    return Object.values(this.sessions)
      .filter((v) => !v.draft)
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  }

  get selected(): SessionView | null {
    return this.selectedId ? (this.sessions[this.selectedId] ?? null) : null
  }

  // Human label for a session id — its title, else the last path segment of its worktree/repo/cwd
  // (same rule the sidebar renders by). '' when the id is unknown. Used by the persisted-layout
  // snapshot and the restore offer so they can name a session without duplicating the logic.
  sessionLabel(id: string): string {
    const v = this.sessions[id]
    if (!v) return ''
    if (v.record.title) return v.record.title
    const p = v.record.worktree ?? v.record.repo ?? v.record.cwd
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
  }

  get pendingBySession(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const a of this.approvals) out[a.sessionId] = (out[a.sessionId] ?? 0) + 1
    return out
  }

  // --- Sidebar ordering -----------------------------------------------------------------------
  // Projects in the user's saved order; new/unknown projects appended in hub order.
  get orderedProjects(): ProjectInfo[] {
    return applyOrder(this.projects, this.projectOrder, (p) => p.id)
  }

  // Sort a group's already-bucketed sessions by the saved chat order for that group id. New/unknown
  // chats keep their incoming (recency) order after the saved ones. Called per group by the sidebar.
  orderedChats(groupId: string, sessions: SessionView[]): SessionView[] {
    return applyOrder(sessions, this.chatOrder[groupId] ?? [], (s) => s.record.id)
  }

  // Full membership of a group (projectId, or '__none__' for unfiled) in recency order — reorder
  // operates on this, independent of any active sidebar search filter.
  private groupSessionIds(groupId: string): string[] {
    return this.sessionList.filter((s) => (s.record.projectId ?? '__none__') === groupId).map((s) => s.record.id)
  }

  // Drag-reorder a PROJECT group: move `fromId` to `toId`'s slot, persist, stay reactive.
  reorderProjects(fromId: string, toId: string): void {
    const cur = applyOrder(this.projects.map((p) => p.id), this.projectOrder, (id) => id)
    const next = moveInto(cur, fromId, toId)
    if (next === cur) return
    this.projectOrder = next
    saveOrder(ORDER_PROJECTS_KEY, next)
  }

  // Drag-reorder a CHAT row within its group: move `fromId` to `toId`'s slot, persist, stay reactive.
  reorderChats(groupId: string, fromId: string, toId: string): void {
    const cur = applyOrder(this.groupSessionIds(groupId), this.chatOrder[groupId] ?? [], (id) => id)
    const next = moveInto(cur, fromId, toId)
    if (next === cur) return
    this.chatOrder = { ...this.chatOrder, [groupId]: next }
    saveOrder(ORDER_CHATS_PREFIX + groupId, next)
  }

  async init(): Promise<void> {
    const t0 = perfNow()
    vlog('init: start')
    // If the hub enforces a device token and we don't hold a valid one, gate on pairing first.
    const auth = await api.auth().catch(() => ({ requireToken: false, authed: true }))
    if (auth.requireToken && !auth.authed && !getHubToken()) {
      vlog('init: needs pairing — stop')
      this.needsPairing = true
      return
    }
    await api.mesh().catch(() => undefined) // bootstrap: capture the token while the hub hands it out
    this.profiles = await api.profiles()
    this.projects = await api.projects()
    vlog(`init: ${this.profiles.length} profiles, ${this.projects.length} projects (${msSince(t0)})`)
    await this.refreshSideData()
    vlog(`init: side data loaded (${msSince(t0)}) — connecting WS`)
    this.connect()
    // Fire-and-forget: pull the fleet roster and merge any remote machines' projects/sessions
    // read-only. Non-blocking so local render stays instant; a no-node/no-peer hub gets just the
    // local entry and this is a no-op (see refreshFleet).
    this.startFleet()
    // NOTE: we deliberately do NOT scan every project on load — that walked ~/.codex + ~/.claude and
    // read thousands of transcript files per project, pegging the hub for minutes ("stuck scanning").
    // The import prompt now fires lazily, for the ONE project you actually open (see maybePromptImport).
  }

  // Pair this device by pasting a token (from another device's Settings → Mesh), then load.
  async pair(token: string): Promise<void> {
    setHubToken(token.trim())
    const auth = await api.auth().catch(() => ({ requireToken: true, authed: false }))
    if (auth.authed || !auth.requireToken) {
      this.needsPairing = false
      await this.init()
    } else {
      setHubToken('') // reject an invalid token so a bad paste doesn't linger and lock the client
    }
  }

  async rescanProfiles(): Promise<void> {
    this.profiles = await api.rescanProfiles()
  }

  lastProfileId = $state<string | null>(null)

  defaultProfileId(): string | undefined {
    if (settings.defaultAccount && this.profiles.some((p) => p.id === settings.defaultAccount)) return settings.defaultAccount
    if (this.lastProfileId && this.profiles.some((p) => p.id === this.lastProfileId)) return this.lastProfileId
    return this.profiles[0]?.id
  }

  // Open a new chat as a LOCAL DRAFT — no `api.spawn`, no hub session, no worktree. The draft
  // becomes the active pane where the composer picks account/model/worktree and the first prompt
  // is typed; it materializes into a real session on the first send (see `materializeDraft`).
  // Applies the same defaults the old immediate-spawn path did (detached-chat defaults when no
  // project, default model per provider, default worktree preference).
  async newSession(profileId?: string, projectId?: string, useWorktree?: boolean): Promise<void> {
    const pid = profileId ?? this.defaultProfileId()
    if (!pid) {
      this.settingsOpen = true
      return
    }
    const profile = this.profiles.find((p) => p.id === pid)
    const model = profile?.provider === 'codex' ? settings.defaultCodexModel : settings.defaultClaudeModel
    // A chat opened without an explicit project is "detached/unfiled" — apply the operator's
    // detached-chat defaults: a default destination project (else stays Unfiled) and a mode.
    const detached = !projectId
    const destProject = projectId ?? (detached ? (settings.detachedDefaultProjectId ?? undefined) : undefined)
    const now = new Date().toISOString()
    const id = `draft:${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
    const view: SessionView = {
      record: {
        id,
        profileId: pid,
        provider: profile?.provider ?? 'claude',
        projectId: destProject,
        cwd: '',
        status: 'idle',
        model: model || undefined,
        permissionMode: detached ? settings.detachedDefaultMode : settings.defaultPermissionMode,
        createdAt: now,
      },
      items: [],
      lastActivity: now,
      sawReasoning: false,
      draft: true,
      draftUseWorktree: useWorktree ?? settings.defaultUseWorktree,
    }
    this.sessions[id] = view
    this.lastProfileId = pid
    this.select(id) // opens the draft as the active pane (and discards any prior unsent draft)
  }

  // A draft's composer writes its chosen account/model/traits/mode straight into the draft record
  // (no hub round-trip) — the picks are read back out of the record when the draft materializes.
  updateDraft(id: string, patch: Partial<SessionRecord>): void {
    const v = this.sessions[id]
    if (!v || !v.draft) return
    Object.assign(v.record, patch)
  }

  // First send on a draft: spawn the real session with this prompt, then swap the draft's pane
  // over to it seamlessly. On error, keep the draft intact and hand the error back to the composer
  // (same pattern as a failed `api.send`). The first user message is rendered exactly once from the
  // hub's canonical `session/input` echo — `session/created` precedes it, so the view always exists
  // by the time it lands (no optimistic echo needed, no duplicate).
  async materializeDraft(draftId: string, text: string): Promise<{ ok?: boolean; error?: string }> {
    const draft = this.sessions[draftId]
    if (!draft || !draft.draft) return { error: 'draft is gone' }
    const r = draft.record
    const body: Record<string, unknown> = {
      profileId: r.profileId,
      permissionMode: r.permissionMode ?? settings.defaultPermissionMode,
      useWorktree: draft.draftUseWorktree ?? settings.defaultUseWorktree,
      prompt: text,
    }
    if (r.projectId) body.projectId = r.projectId
    if (r.model) body.model = r.model
    if (r.effort) body.effort = r.effort
    if (r.serviceTier) body.serviceTier = r.serviceTier
    const out = await api.spawn(body)
    if (!out || 'error' in out) {
      return { error: (out as { error?: string } | null)?.error ?? 'failed to start the session' }
    }
    const rec = out as SessionRecord
    // Swap draft id → real id everywhere it is referenced, then drop the draft.
    const { [draftId]: _drop, ...rest } = this.sessions
    this.sessions = rest
    this.ensure(rec)
    if (this.selectedId === draftId) this.selectedId = rec.id
    if (this.splitPanes.length) {
      this.splitPanes = this.splitPanes.map((row) => row.map((x) => (x === draftId ? rec.id : x)))
    }
    this.lastProfileId = rec.profileId
    this.noteSent(rec.id) // immediate "received / thinking" feedback while the first turn spins up
    this.markGlitch(rec.id) // glitch the sidebar label as the chat materializes into its project
    return { ok: true }
  }

  // Flag a chat id as just-materialized/renamed so the sidebar can play a one-shot glitch on it.
  private markGlitch(id: string): void {
    this.recentlyChanged = { ...this.recentlyChanged, [id]: Date.now() }
  }

  // Drop an unsent draft from local state. Callers (select-away, closePane) have already moved the
  // selection/panes off it, so this only needs to remove it from the roster — nothing to clean up
  // on the hub, since a draft was never spawned there.
  private discardDraft(id: string): void {
    if (!this.sessions[id]?.draft) return
    const { [id]: _drop, ...rest } = this.sessions
    this.sessions = rest
  }

  // Only a fresh project chat (no real turns yet) can switch worktree mode — the worktree is
  // created at spawn, so changing it means re-spawning.
  canToggleWorktree(view: SessionView): boolean {
    if (!view.record.projectId) return false
    return !view.items.some((i) => i.kind === 'user' || i.kind === 'assistant')
  }

  // Flip worktree ⇄ direct before the first message. For a DRAFT this is just a local intent flip
  // (the worktree is created at spawn). For a real empty chat it re-creates it (legacy path; real
  // sessions always carry the first prompt now, so `canToggleWorktree` is effectively draft-only).
  async toggleWorktree(): Promise<void> {
    const cur = this.selectedId ? this.sessions[this.selectedId] : null
    if (!cur || !this.canToggleWorktree(cur)) return
    if (cur.draft) {
      cur.draftUseWorktree = !cur.draftUseWorktree
      return
    }
    const next = !cur.record.worktree
    await api.stop(cur.record.id).catch(() => undefined)
    this.removeSessionLocal(cur.record.id)
    await this.newSession(cur.record.profileId, cur.record.projectId, next)
  }

  // Swap the account "at will". Empty chat → seamless re-create under the new account.
  // A chat with history → PORT: carry the conversation context + working files into a fresh
  // session on the target account (auth is per-account, so we move the work, not the auth).
  async useAccount(profileId: string): Promise<void> {
    const cur = this.selectedId ? this.sessions[this.selectedId] : null
    if (!cur) {
      await this.newSession(profileId)
      return
    }
    if (cur.record.profileId === profileId) return
    // A DRAFT has no hub session yet — reconfigure it in place (no re-spawn, no port). Reset the
    // model/traits to the new provider's defaults, since the old slug is invalid cross-provider.
    if (cur.draft) {
      const profile = this.profiles.find((p) => p.id === profileId)
      if (!profile) return
      cur.record.profileId = profileId
      cur.record.provider = profile.provider
      cur.record.model = (profile.provider === 'codex' ? settings.defaultCodexModel : settings.defaultClaudeModel) || undefined
      cur.record.effort = undefined
      cur.record.serviceTier = undefined
      this.lastProfileId = profileId
      return
    }
    const isEmpty = cur.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length === 0
    if (isEmpty) {
      await api.stop(cur.record.id).catch(() => undefined)
      await this.newSession(profileId, cur.record.projectId)
    } else {
      await this.portTo(profileId)
    }
  }

  private buildTranscript(view: SessionView): string {
    const lines: string[] = []
    for (const it of view.items) {
      if (it.kind === 'user') lines.push(`User: ${it.text ?? ''}`)
      else if (it.kind === 'assistant') lines.push(`Assistant: ${it.text ?? ''}`)
      else if (it.kind === 'tool') lines.push(`[tool call: ${it.toolName ?? ''}]`)
    }
    let t = lines.join('\n\n')
    if (t.length > 8000) t = '…(earlier context trimmed)…\n\n' + t.slice(-8000)
    return t
  }

  // Port the current conversation to a new session under `profileId`, reusing the same
  // working directory (files travel) and seeding the target agent with the transcript.
  // The original chat is left intact as a snapshot.
  async portTo(profileId: string): Promise<void> {
    const cur = this.selectedId ? this.sessions[this.selectedId] : null
    if (!cur) return
    const cwd = cur.record.worktree ?? cur.record.cwd
    const transcript = this.buildTranscript(cur)
    const prompt =
      `You are taking over a conversation that was running on a different account. The working ` +
      `directory and files are unchanged. Here is the context so far:\n\n${transcript}\n\n` +
      `Briefly confirm you have the context, then wait for the next instruction.`
    const body: Record<string, unknown> = { profileId, cwd, prompt }
    if (cur.record.projectId) body.projectId = cur.record.projectId
    const out = await api.spawn(body)
    if (out && !('error' in out)) {
      this.lastProfileId = profileId
      this.select((out as { id: string }).id)
    } else if (out && 'error' in out) {
      void alertDialog(out.error)
    }
  }

  async refreshProjects(): Promise<void> {
    // Preserve any merged REMOTE fleet projects (tagged with siteId) — a local refresh must not drop
    // the other machines' rows. Local projects (no siteId) come fresh from this hub.
    const local = await api.projects()
    const remote = this.projects.filter((p) => p.siteId)
    this.projects = [...local, ...remote]
  }

  // --- Unified fleet view (first cut, read-only) -----------------------------------------------
  // Poll the fleet roster and merge each REMOTE, ONLINE site's projects + sessions. Started
  // fire-and-forget from init(); a periodic refresh keeps remote rosters roughly current (remote
  // sites have no live WS in this first cut — that fan-out is the full drive-remote (L) work).
  private startFleet(): void {
    if (this.fleetTimer) return // already running (init() can re-run after pairing)
    void this.refreshFleet()
    this.fleetTimer = setInterval(() => void this.refreshFleet(), 20000)
  }

  // Fetch /api/fleet, then for every remote+online site pull its /api/projects + /api/sessions and
  // merge them with `${siteId}:` id-namespacing (origin attribution + collision-safety) and a site
  // tag for the sidebar badge. The LOCAL entry is skipped here — it stays on its existing base + live
  // WS. Byte-identical to today when there are no remote sites and none were previously merged.
  // TODO(full drive-remote, L): open a WS per remote site (per-site seq cursors) + route mutations
  //   (spawn/send/steer/stop/mode/approve/rename/delete) to the owning site's base + token, instead
  //   of this read-only poll. See docs/mesh-unified-fleet.md §5.
  async refreshFleet(): Promise<void> {
    const raw = await api.fleet().catch(() => [] as FleetSite[])
    // Coerce a non-array (an older hub with no /api/fleet returns {error}; a token-gated hub returns
    // 401 {error}) so a bad shape can't throw out of this fire-and-forget refresh. Empty / failure →
    // treat as local-only and don't wipe anything already merged on a transient blip.
    const fleet = Array.isArray(raw) ? raw : []
    if (fleet.length) this.fleetSites = fleet
    const remotes = fleet.filter((s) => !s.local && s.online)
    const hadRemote =
      this.projects.some((p) => p.siteId) || Object.values(this.sessions).some((v) => v.record.siteId)
    // Pure single-machine path: nothing remote now, nothing merged before → leave local state
    // completely untouched (no reassignments, no reactivity churn), exactly as before this feature.
    if (remotes.length === 0 && !hadRemote) return

    const pulled = await Promise.all(
      remotes.map(async (site) => {
        const [projects, sessions] = await Promise.all([
          api.projectsFrom(site.baseUrl).catch(() => [] as ProjectInfo[]),
          api.sessionsFrom(site.baseUrl).catch(() => [] as SessionRecord[]),
        ])
        return { site, projects, sessions }
      })
    )

    const localProjects = this.projects.filter((p) => !p.siteId)
    const remoteProjects: ProjectInfo[] = []
    const seenRemoteSessionIds = new Set<string>()
    for (const { site, projects, sessions } of pulled) {
      for (const p of projects) {
        remoteProjects.push({ ...p, id: `${site.siteId}:${p.id}`, siteId: site.siteId, siteLabel: site.label })
      }
      for (const s of sessions) {
        const rec: SessionRecord = {
          ...s,
          id: `${site.siteId}:${s.id}`,
          projectId: s.projectId ? `${site.siteId}:${s.projectId}` : undefined,
          siteId: site.siteId,
          siteLabel: site.label,
        }
        seenRemoteSessionIds.add(rec.id)
        // ensure() keys by the namespaced id → never collides with a local (raw-id) session. Refresh
        // the view's lastActivity too so the sidebar re-sorts remote rows by their real recency
        // (ensure sets it only on first create, and a remote session has no live WS to bump it).
        const v = this.ensure(rec)
        v.lastActivity = rec.lastActivity ?? rec.createdAt
      }
    }
    this.projects = [...localProjects, ...remoteProjects]
    // Drop remote sessions that vanished (site went offline, or the chat was deleted there). Only
    // ever touches rows tagged with a siteId — local sessions + drafts are left alone.
    for (const id of Object.keys(this.sessions)) {
      const v = this.sessions[id]
      if (v?.record.siteId && !seenRemoteSessionIds.has(id)) this.removeSessionLocal(id)
    }
  }

  // Adopt the selected existing vendor chats into a project. The hub persists them and journals
  // `session/created` + `session/titled`, so they also arrive over the WS (ensure() is idempotent);
  // we optimistically ensure the returned records for instant feedback and refresh the project
  // roster + account list (a default-home import registers ~/.claude/~/.codex as a profile, which
  // then appears in the picker). Returns counts for a toast/summary. Errors surface as { imported: 0 }.
  async importChats(projectId: string, vendorSessionIds: string[]): Promise<{ imported: number; skipped: number }> {
    const out = await api.importChats(projectId, vendorSessionIds)
    if (!out || 'error' in out) return { imported: 0, skipped: 0 }
    for (const rec of out.imported) {
      this.ensure(rec)
      this.markGlitch(rec.id)
    }
    await this.refreshProjects()
    this.profiles = await api.profiles() // surface any newly-registered default-home account
    return { imported: out.imported.length, skipped: out.skipped }
  }

  // --- Import prompt ---------------------------------------------------------------------------
  openImportPanel(projectId: string, path: string, preloaded?: ScanResult): void {
    this.importPanelFor = { projectId, path, preloaded }
  }
  closeImportPanel(): void {
    this.importPanelFor = null
  }
  // "Don't ask again" for a project: persist the dismissal and close the panel.
  dismissImport(projectId: string): void {
    const next = new Set(this.importDismissed)
    next.add(projectId)
    this.importDismissed = next
    saveOrder(IMPORT_DISMISSED_KEY, [...next])
    if (this.importPanelFor?.projectId === projectId) this.closeImportPanel()
  }

  // Scan one project (at most once per session) and auto-open the import panel if it has un-imported
  // chats and the user hasn't dismissed it. Non-blocking, quiet on empty. Used by the open-project
  // and expand gestures — a gentle inline prompt, never a modal.
  async maybePromptImport(projectId: string, path: string): Promise<void> {
    if (!path || this.importDismissed.has(projectId) || this.importChecked.has(projectId)) return
    if (this.importPanelFor) return // a panel is already up — don't stack
    this.importChecked.add(projectId)
    const t0 = perfNow()
    vlog(`scan: start ${path}`)
    const res = await api.scanProject(path)
    if (!res || 'error' in res) {
      vlog(`scan: failed ${path} (${msSince(t0)})`, res && 'error' in res ? res.error : '')
      return
    }
    const importable = res.chats.filter((c) => !c.alreadyImported).length
    vlog(`scan: done ${path} — ${res.chats.length} chats, ${importable} importable (${msSince(t0)})`)
    if (importable > 0 && !this.importPanelFor) this.openImportPanel(projectId, path, res)
  }

  // On load, quietly scan each non-dismissed project and pop the prompt for the FIRST one that has
  // un-imported chats (bounded; stops at the first hit). Fire-and-forget from init().
  async runImportChecks(): Promise<void> {
    for (const p of this.projects.slice(0, 20)) {
      if (this.importPanelFor) return // already prompting — leave the rest for their own gestures
      await this.maybePromptImport(p.id, p.path)
    }
  }

  status(view: SessionView): StatusInfo {
    const pending = this.approvals.filter((a) => a.sessionId === view.record.id)
    if (pending.length > 0) {
      const isQuestion = pending.some((a) => {
        const tool = (a.payload as { toolName?: string } | null)?.toolName ?? a.kind
        return /AskUserQuestion|ExitPlanMode|elicitation|user.input/i.test(String(tool))
      })
      return isQuestion ? { key: 'question', label: 'awaiting answer' } : { key: 'approval', label: 'needs approval' }
    }
    switch (view.record.status) {
      case 'starting':
        return { key: 'starting', label: 'starting' }
      case 'active':
        return { key: 'working', label: 'working' }
      case 'error':
        return { key: 'error', label: 'error' }
      case 'stopped':
        return { key: 'stopped', label: 'stopped' }
      case 'idle':
        return view.lastTurnOk ? { key: 'completed', label: 'completed' } : { key: 'idle', label: 'ready' }
      default:
        return { key: 'idle', label: view.record.status }
    }
  }

  async refreshSideData(): Promise<void> {
    this.approvals = await api.approvals()
    this.usage = await api.usage()
  }

  // Trailing debounce for refreshSideData — collapses a burst of usage/approval events (esp. the
  // journal replay on connect) into ONE refresh 300ms after the last one, instead of one fetch-pair
  // per event. Without this, load fired 500+ requests and wedged the whole client.
  private sideRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private rosterFetchInFlight = false
  private scheduleSideRefresh(): void {
    if (this.sideRefreshTimer) clearTimeout(this.sideRefreshTimer)
    this.sideRefreshTimer = setTimeout(() => {
      this.sideRefreshTimer = null
      void this.refreshSideData()
    }, 300)
  }

  // Optimistically mark a turn as started the instant the user sends — immediate "received /
  // thinking" feedback, before the hub's first status event lands. Resets the live token count.
  noteSent(sessionId: string): void {
    const v = this.sessions[sessionId]
    if (!v) return
    v.turnStartedAt = Date.now()
    v.liveTokens = undefined
  }

  // Optimistically render the user's message the instant it's sent. Claude never echoes user
  // text back as an event (only tool results), so without this the transcript jumps straight to
  // the reply. For Codex we set a one-shot suppress flag so its own userMessage event doesn't
  // double the bubble. Returns the item key so a failed send can roll it back.
  pushUserEcho(sessionId: string, text: string): string {
    const v = this.sessions[sessionId]
    if (!v) return ''
    const ts = new Date().toISOString()
    const key = `user:sent:${v.items.length}:${ts}`
    this.push(v, { kind: 'user', ts, text, key })
    this.touch(v, ts)
    // Suppress the canonical session/input event (and Codex's own userMessage) that the hub will
    // echo back over the WS, so the optimistic bubble isn't duplicated.
    this.suppressNextUserMsg[sessionId] = true
    return key
  }

  // Roll back an optimistic item (e.g. when the send failed).
  removeItem(sessionId: string, key: string): void {
    const v = this.sessions[sessionId]
    if (!v) return
    const i = v.items.findIndex((it) => it.key === key)
    if (i >= 0) v.items.splice(i, 1)
    delete this.suppressNextUserMsg[sessionId]
    // The fresh send failed — clear the in-flight markers so the thinking spinner doesn't stick.
    v.turnStartedAt = undefined
    v.liveTokens = undefined
  }

  // Delete a chat: tell the hub (which stops it + writes a tombstone), then drop it locally.
  async deleteSession(id: string): Promise<void> {
    await api.deleteSession(id).catch(() => undefined)
    this.removeSessionLocal(id)
  }

  // Rename a chat optimistically (freezes auto-naming). The canonical session/titled echo re-applies
  // the same value — a visual no-op — so no suppress bookkeeping is needed; only rollback on error.
  renameSession(id: string, title: string): void {
    const v = this.sessions[id]
    if (!v) return
    const clean = title.trim()
    if (!clean) return
    const prev = { title: v.record.title, source: v.record.titleSource }
    v.record.title = clean
    v.record.titleSource = 'user'
    void api.rename(id, clean).then((r) => {
      if (r && 'error' in r && r.error) {
        v.record.title = prev.title
        v.record.titleSource = prev.source
      }
    })
  }

  // Remove a session from all local state: the roster, its queue, any panes it occupies, and
  // the selection. Idempotent — also runs when a `session/deleted` event arrives from the hub.
  private removeSessionLocal(id: string): void {
    if (this.sessions[id]) {
      const { [id]: _drop, ...rest } = this.sessions
      this.sessions = rest
    }
    if (this.queues[id]) {
      const { [id]: _q, ...restQ } = this.queues
      this.queues = restQ
    }
    if (this.splitPanes.length) {
      const rows = this.splitPanes.map((r) => r.filter((x) => x !== id))
      this.commit(rows)
    }
    if (!this.selectedId || !this.sessions[this.selectedId]) {
      this.selectedId = this.splitPanes[0]?.[0] ?? this.sessionList[0]?.record.id ?? null
    }
  }

  private ensure(record: SessionRecord): SessionView {
    const existing = this.sessions[record.id]
    if (existing) {
      existing.record = record
      return existing
    }
    const view: SessionView = { record, items: [], lastActivity: record.lastActivity ?? record.createdAt, sawReasoning: false }
    // (context/cost fields populated from result + tokenUsage events)
    this.sessions[record.id] = view
    return view
  }

  private touch(view: SessionView, ts: string): void {
    view.lastActivity = ts
  }

  private wsBase(): string {
    // Desktop app → loopback hub directly; browser (dev) → same origin, proxied by Vite.
    return HUB_WS || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  }
  private wsUrl(since: number): string {
    const t = getHubToken()
    return `${this.wsBase()}/ws?since=${since}${t ? `&token=${encodeURIComponent(t)}` : ''}`
  }

  private connect(): void {
    vlog('ws: connecting (replay from seq 0)')
    const ws = new WebSocket(this.wsUrl(0))
    this.ws = ws
    ws.onopen = () => {
      vlog('ws: open')
      this.connected = true
    }
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data as string) as HubEvent
      this.apply(event)
    }
    ws.onclose = () => {
      vlog('ws: closed — reconnecting in 1.5s')
      this.connected = false
      setTimeout(() => this.reconnect(), 1500)
    }
  }

  private reconnect(): void {
    vlog(`ws: reconnecting (replay from seq ${this.lastSeq})`)
    const ws = new WebSocket(this.wsUrl(this.lastSeq))
    this.ws = ws
    ws.onopen = () => {
      vlog('ws: reopened')
      this.connected = true
    }
    ws.onmessage = (e) => this.apply(JSON.parse(e.data as string) as HubEvent)
    ws.onclose = () => {
      this.connected = false
      setTimeout(() => this.reconnect(), 1500)
    }
  }

  // Verbose-only: count events in a replay/live burst and log a one-line summary once it settles,
  // so a big or slow replay is visible in the console (never logs single live events).
  private replayCount = 0
  private replayStart = 0
  private replayTimer: ReturnType<typeof setTimeout> | null = null
  private noteReplay(): void {
    if (!VERBOSE) return
    if (this.replayCount === 0) this.replayStart = perfNow()
    this.replayCount++
    if (this.replayTimer) clearTimeout(this.replayTimer)
    this.replayTimer = setTimeout(() => {
      if (this.replayCount > 3) vlog(`replay: applied ${this.replayCount} events in ${msSince(this.replayStart)}`)
      this.replayCount = 0
      this.replayTimer = null
    }, 250)
  }

  private apply(event: HubEvent): void {
    if (event.seq <= this.lastSeq) return
    this.lastSeq = event.seq
    this.noteReplay()
    const { sessionId, kind, ts, payload } = event

    // Approvals + usage are re-fetched, but COALESCED: a journal replay surfaces hundreds of
    // usage/approval events in one burst, and firing refreshSideData() per event stormed the hub with
    // 500+ requests and saturated the browser's ~6-connection pool, so the roster never populated and
    // any new request (a project scan) stalled behind them. Debounced to a single refresh per burst.
    if (kind === 'approval/requested' || kind === 'approval/resolved' || kind.startsWith('usage/')) {
      this.scheduleSideRefresh()
    }

    if (!sessionId) return

    if (kind === 'session/created') {
      this.ensure(payload as SessionRecord)
      return
    }
    if (kind === 'session/deleted') {
      this.removeSessionLocal((payload as { id?: string }).id ?? sessionId)
      return
    }
    const view = this.sessions[sessionId]
    if (!view) {
      // Event for a session we haven't seen created yet — fetch the roster lazily, but COALESCED: a
      // replay burst would otherwise fire one full /api/sessions per unseen event. One in-flight max.
      if (!this.rosterFetchInFlight) {
        this.rosterFetchInFlight = true
        void api
          .sessions()
          .then((list) => {
            for (const r of list) this.ensure(r)
          })
          .finally(() => {
            this.rosterFetchInFlight = false
          })
      }
      return
    }

    switch (kind) {
      case 'session/input': {
        // The canonical user message (journaled by the hub, so it replays + is timestamped).
        // Skip if we already rendered it optimistically this turn.
        if (this.suppressNextUserMsg[sessionId]) delete this.suppressNextUserMsg[sessionId]
        else this.push(view, { kind: 'user', ts, text: (payload as { text?: string }).text ?? '' })
        break
      }
      case 'session/titled': {
        const p = payload as { title?: string; source?: string }
        if (p.title) {
          view.record.title = p.title
          if (p.source === 'user' || p.source === 'auto') view.record.titleSource = p.source
          this.markGlitch(sessionId) // auto-name-on-materialize or a rename → glitch the sidebar label
        }
        break
      }
      case 'session/activity': {
        // Real last-turn time backfilled for an imported chat (hub-side, on first history read). Apply
        // it so the sidebar shows/sorts by real recency even across a refresh (this replays from seq 0).
        const p = payload as { lastActivity?: string }
        if (p.lastActivity) {
          view.record.lastActivity = p.lastActivity
          view.lastActivity = p.lastActivity
        }
        break
      }
      case 'bus/sent': {
        // This session sent a message to a teammate / its project.
        const p = payload as { to?: { kind?: string; id?: string }; subject?: string | null; body?: string; recipients?: number }
        const peer = p.to?.kind === 'project' ? `project · ${p.recipients ?? 0} agent(s)` : `agent ${(p.to?.id ?? '').slice(0, 8)}`
        this.push(view, { kind: 'bus', ts, busDir: 'sent', busPeer: peer, busSubject: p.subject ?? undefined, text: p.body ?? '' })
        break
      }
      case 'bus/delivered': {
        // A teammate's message the hub delivered into this session (rendered as a distinct card).
        const p = payload as { fromLabel?: string; fromSession?: string; subject?: string | null; body?: string }
        const peer = p.fromLabel || (p.fromSession ?? '').slice(0, 8)
        this.push(view, { kind: 'bus', ts, busDir: 'received', busPeer: peer, busSubject: p.subject ?? undefined, text: p.body ?? '' })
        break
      }
      case 'memory/recalled': {
        // The hub auto-surfaced relevant memories into this turn's context (memory.ts recall).
        const p = payload as { count?: number; titles?: string[] }
        const n = p.count ?? 0
        this.push(view, { kind: 'note', ts, text: `✦ recalled ${n} memor${n === 1 ? 'y' : 'ies'}${p.titles?.length ? ' — ' + p.titles.join(', ') : ''}` })
        break
      }
      case 'session/status': {
        const status = (payload as { status: string }).status
        view.record.status = status
        this.push(view, { kind: 'status', ts, status })
        // Turn timing for the thinking indicator: a turn is in flight while active/starting,
        // settled otherwise. Keep an already-set start time (from the optimistic send).
        if (status === 'active' || status === 'starting') {
          if (view.turnStartedAt == null) view.turnStartedAt = Date.now()
        } else if (status === 'idle' || status === 'error' || status === 'stopped') {
          view.turnStartedAt = undefined
        }
        // Flush on idle (turn done) or error (so queued messages aren't orphaned).
        if (status === 'idle' || status === 'error') this.flushQueue(sessionId)
        break
      }
      case 'session/mode': {
        const pm = (payload as { permissionMode?: string }).permissionMode
        if (pm === 'safe' || pm === 'edits' || pm === 'full') view.record.permissionMode = pm
        this.push(view, { kind: 'note', ts, text: `permission mode → ${pm}` })
        break
      }
      case 'session/error':
        this.push(view, { kind: 'error', ts, text: (payload as { message: string }).message })
        break
      case 'session/worktree-created':
        this.push(view, { kind: 'note', ts, text: `worktree: ${(payload as { worktree: string }).worktree}` })
        break
      case 'approval/auto-denied-scope':
        this.push(view, {
          kind: 'error',
          ts,
          text: `scope guard denied ${(payload as { toolName: string }).toolName}: ${(payload as { reason: string }).reason}`,
        })
        break
      case 'approval/auto-denied-bus':
        this.push(view, {
          kind: 'error',
          ts,
          text: `bus-turn guard denied ${(payload as { toolName?: string }).toolName ?? 'a risky tool'} — a teammate-message turn can't write practices`,
        })
        break
      case 'practice/wrote':
      case 'practice/edited': {
        const p = payload as { scope?: string; title?: string }
        this.push(view, {
          kind: 'note',
          ts,
          text: `✦ ${kind === 'practice/wrote' ? 'recorded' : 'edited'} practice [${p.scope ?? '?'}]${p.title ? ' — ' + p.title : ''}`,
        })
        break
      }
      case 'claude/assistant':
        this.applyClaudeAssistant(view, ts, payload)
        break
      case 'claude/user':
        this.applyClaudeUser(view, ts, payload)
        break
      case 'claude/result': {
        const p = payload as {
          is_error?: boolean
          result?: string
          total_cost_usd?: number
          modelUsage?: Record<string, { inputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; contextWindow?: number }>
        }
        if (p.is_error) this.push(view, { kind: 'error', ts, text: p.result })
        view.lastTurnOk = !p.is_error
        view.turnStartedAt = undefined
        if (typeof p.total_cost_usd === 'number') view.costUsd = (view.costUsd ?? 0) + p.total_cost_usd
        if (p.modelUsage) {
          let best: { used: number; window: number } | null = null
          for (const m of Object.values(p.modelUsage)) {
            const used = (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0)
            if (m.contextWindow && (!best || used > best.used)) best = { used, window: m.contextWindow }
          }
          if (best) {
            view.contextUsed = best.used
            view.contextWindow = best.window
          }
        }
        break
      }
      case 'codex/thread/tokenUsage/updated': {
        const tu = (payload as { tokenUsage?: { last?: { inputTokens?: number; totalTokens?: number }; modelContextWindow?: number } }).tokenUsage
        const used = tu?.last?.inputTokens ?? tu?.last?.totalTokens
        if (typeof used === 'number') view.contextUsed = used
        if (typeof tu?.modelContextWindow === 'number') view.contextWindow = tu.modelContextWindow
        break
      }
      case 'codex/turn/completed': {
        const status = (payload as { turn?: { status?: string } }).turn?.status
        view.lastTurnOk = status === 'completed' || status === undefined
        view.turnStartedAt = undefined
        break
      }
      case 'session/tokens': {
        const p = payload as { input?: number; output?: number; total?: number }
        const sum = (p.input ?? 0) + (p.output ?? 0)
        view.liveTokens = { input: p.input, output: p.output, total: p.total ?? (sum > 0 ? sum : undefined) }
        break
      }
      case 'codex/item/completed':
        this.applyCodexItem(view, ts, payload)
        break
      case 'codex/item/agentMessage/delta': {
        const p = payload as { itemId?: string; delta?: string }
        if (p.itemId && typeof p.delta === 'string') this.upsertCodexText(view, ts, p.itemId, p.delta, true)
        break
      }
      default:
        break
    }
    // `session/activity` carries the REAL (older) last-turn time for an imported chat, and a
    // title/rename is not fresh activity — neither may bump lastActivity to the event's "now" time,
    // which regressed imported chats to "just now" on import + on open.
    if (kind !== 'session/activity' && kind !== 'session/titled') this.touch(view, ts)
  }

  private applyClaudeAssistant(view: SessionView, ts: string, payload: unknown): void {
    const content = (payload as { message?: { content?: ClaudeBlock[] } }).message?.content
    if (!Array.isArray(content)) return
    let sawThinkingThisTurn = false
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        this.push(view, { kind: 'assistant', ts, text: block.text })
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        view.sawReasoning = true
        sawThinkingThisTurn = true
        // Claude Code withholds reasoning text on subscription accounts (signature only),
        // so block.thinking is typically empty — render a "reasoned" marker, not fake text.
        this.push(view, { kind: 'thinking', ts, text: (block.thinking ?? '').trim() })
      } else if (block.type === 'tool_use') {
        this.push(view, {
          kind: 'tool',
          ts,
          toolName: block.name,
          toolInput: block.input,
          reflex: !sawThinkingThisTurn && !view.sawReasoning,
          key: `tool:${block.id}`,
        })
      }
    }
  }

  private applyClaudeUser(view: SessionView, ts: string, payload: unknown): void {
    const content = (payload as { message?: { content?: ClaudeBlock[] } }).message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type === 'tool_result') {
        const item = view.items.find((i) => i.key === `tool:${block.tool_use_id}`)
        if (item) {
          item.toolResult = asText(block.content)
          item.toolError = block.is_error === true
        }
      }
    }
  }

  private applyCodexItem(view: SessionView, ts: string, payload: unknown): void {
    const item = (payload as { item?: Record<string, unknown> }).item
    if (!item) return
    const type = item.type as string
    if (type === 'agentMessage') {
      // Same item id as the streamed deltas — replace, never duplicate.
      this.upsertCodexText(view, ts, item.id as string, (item.text as string) ?? '', false)
    } else if (type === 'reasoning') {
      view.sawReasoning = true
      this.push(view, { kind: 'reasoning', ts, text: (item.text as string) ?? '(reasoning)' })
    } else if (type === 'userMessage') {
      // Ignored — the user's message is rendered from the canonical session/input event; echoing
      // Codex's own userMessage here too would duplicate it.
    } else if (type === 'commandExecution') {
      this.push(view, { kind: 'tool', ts, toolName: 'command', toolInput: item.command ?? item, toolResult: item.aggregatedOutput as string | undefined })
    } else if (type === 'fileChange') {
      this.push(view, { kind: 'tool', ts, toolName: 'fileChange', toolInput: item })
    } else if (type === 'mcpToolCall') {
      this.push(view, { kind: 'tool', ts, toolName: `mcp:${String(item.tool ?? '')}`, toolInput: item })
    }
  }

  // Upsert a Codex agent message by its item id: streamed deltas (append) and the final
  // item/completed (replace) target the same item, so the message renders exactly once.
  private upsertCodexText(view: SessionView, ts: string, itemId: string, text: string, append: boolean): void {
    const key = `codex:${itemId}`
    const item = view.items.find((i) => i.key === key)
    if (item) item.text = append ? (item.text ?? '') + text : text
    else this.push(view, { kind: 'assistant', ts, text, key })
  }

  private push(view: SessionView, item: Partial<ThreadItem> & { kind: ItemKind; ts: string }): void {
    view.items.push({ key: item.key ?? `i${view.items.length}:${item.ts}`, ...item } as ThreadItem)
  }

  // Sessions whose vendor history we've already pulled (or decided not to), so opening a chat repeatedly
  // doesn't refetch. Cleared for a session only if it's removed.
  private historyPulled = new Set<string>()

  private toThreadItem(h: HistoryItem, key: string, fallbackTs: string): ThreadItem {
    return { key, kind: h.kind, ts: h.ts ?? fallbackTs, text: h.text, toolName: h.toolName, toolInput: h.toolInput, toolResult: h.toolResult, toolError: h.toolError, historical: true }
  }

  // Lazily pull an IMPORTED chat's on-disk transcript the first time it's opened and prepend it above
  // any live turns — so the thread shows real history instead of an empty pane. Hub-native chats skip
  // this (their history already replays over the WS). Never clobbers a thread that already has content.
  async ensureHistory(id: string): Promise<void> {
    const view = this.sessions[id]
    if (!view || this.historyPulled.has(id)) return
    // A REMOTE fleet session has no local transcript to pull — its history + live stream live on its
    // owning hub (the full drive-remote (L) work). Mark it pulled so opening it is a clean no-op,
    // never a namespaced-id fetch against THIS hub. See docs/mesh-unified-fleet.md §5.
    if (view.record.siteId) {
      this.historyPulled.add(id)
      return
    }
    if (!view.record.imported && !view.record.vendorSessionId) return
    // Already has real turns (live session, or history loaded) — nothing to backfill.
    if (view.items.some((i) => i.kind === 'user' || i.kind === 'assistant')) {
      this.historyPulled.add(id)
      return
    }
    this.historyPulled.add(id)
    view.loadingHistory = true
    const page = await api.history(id).catch(() => null)
    view.loadingHistory = false
    if (!page || !page.items.length) return
    const ts = view.record.createdAt
    const hist = page.items.map((h, i) => this.toThreadItem(h, `hist:${i}`, ts))
    view.items = [...hist, ...view.items] // prepend history; live turns (if any) stay below
    view.historyOlderCursor = page.hasOlder ? page.olderCursor : null
    // Reflect the real last-turn time in the sidebar (time + recency sort) the moment history loads —
    // fixes an imported chat that showed/sorted by its import time. For an existing import (no stored
    // lastActivity) override outright, since the real last-turn time is EARLIER than the import time.
    const newestTs = hist[hist.length - 1]?.ts
    if (newestTs && (!view.record.lastActivity || newestTs > view.lastActivity)) view.lastActivity = newestTs
  }

  // Page OLDER history above what's shown (the "load older" affordance for long imported chats).
  async loadOlderHistory(id: string): Promise<void> {
    const view = this.sessions[id]
    if (!view || view.historyOlderCursor == null || view.loadingHistory) return
    const cursor = view.historyOlderCursor
    view.loadingHistory = true
    const page: HistoryPage | null = await api.history(id, cursor).catch(() => null)
    view.loadingHistory = false
    if (!page) return
    const older = page.items.map((h, i) => this.toThreadItem(h, `hist:o${cursor}:${i}`, view.record.createdAt))
    view.items = [...older, ...view.items] // older turns go above everything already shown
    view.historyOlderCursor = page.hasOlder ? page.olderCursor : null
  }

  select(id: string): void {
    this.restorableLayout = null // opening a chat directly supersedes the pending restore offer
    const prev = this.selectedId
    this.selectedId = id
    void this.ensureHistory(id)
    // In split mode, selecting from the sidebar drives the first (primary) pane (row 0, col 0).
    if (this.splitPanes.length) {
      const rows = this.splitPanes.map((r) => [...r])
      if (rows[0] && rows[0].length) rows[0][0] = id
      else rows.unshift([id])
      this.splitPanes = rows
    }
    // Navigating away from an unsent draft that is no longer shown anywhere discards it (nothing
    // to clean up on the hub). Keeps repeated "new chat" from leaking unreachable drafts.
    if (prev && prev !== id && this.sessions[prev]?.draft && !this.basePanes().flat().includes(prev)) {
      this.discardDraft(prev)
    }
  }

  // --- Split / multi-pane layout (2D) ---
  // The main area is a vertical stack of ROWS; each row is a horizontal set of panes
  // (COLUMNS). `splitPanes` is therefore rows-of-session-ids. Empty = not split (a single
  // pane derived from `selectedId`); the single-row case reproduces the old horizontal split.
  splitPanes = $state<string[][]>([])
  lastLayout = $state<{ selectedId: string | null; splitPanes: string[][] } | null>(null)

  // Cross-restart "reopen your last session" OFFER. Loaded from localStorage at construction (so
  // it's ready before the first render, same as the order fields) and surfaced on the home screen
  // by the Dashboard. We deliberately do NOT auto-apply it — no auto-jump into the last chat.
  // `restoreLastLayout()` applies it on the operator's click; `dismissRestore()` hides it; opening
  // any chat directly clears it (see `select` / `dropAt`).
  restorableLayout = $state<PersistedLayout | null>(loadLastLayout())

  // Canonical 2D structure for rendering + index math. Reads $state so it stays reactive.
  get panes(): string[][] {
    return this.basePanes()
  }

  // Home to the dashboard, remembering the current chat/pane layout so it can be restored.
  goHome(): void {
    if (this.selectedId || this.splitPanes.length) {
      this.lastLayout = { selectedId: this.selectedId, splitPanes: this.splitPanes.map((r) => [...r]) }
    }
    this.selectedId = null
    this.splitPanes = []
  }

  goBack(): void {
    if (!this.lastLayout) return
    this.selectedId = this.lastLayout.selectedId
    this.splitPanes = this.lastLayout.splitPanes.map((r) => [...r])
    this.lastLayout = null
  }

  // --- Cross-restart layout persistence --------------------------------------------------------
  // (Re)load the persisted "reopen last session" offer WITHOUT auto-selecting anything — the home
  // screen stays home. The constructor already does this once; exposed as a method so it's directly
  // unit-testable (the singleton is built at import, before a test can seed localStorage).
  hydrateRestorableLayout(): void {
    this.restorableLayout = loadLastLayout()
  }

  // Persist the CURRENT open layout for the next launch — but only a MEANINGFUL one (a real chat is
  // open or split). Unspawned drafts are dropped (they don't survive a restart), and the empty home
  // layout is never written, so the "reopen last session" offer survives even when the operator ends
  // on the home screen (mirrors goHome's in-memory lastLayout policy). Called reactively from App.
  persistCurrentLayout(): void {
    const isReal = (id: string): boolean => !id.startsWith('draft:')
    const rows = this.splitPanes.map((r) => r.filter(isReal)).filter((r) => r.length > 0)
    const selectedId = this.selectedId && isReal(this.selectedId) ? this.selectedId : (rows[0]?.[0] ?? null)
    if (!selectedId) return // home, or only an unspawned draft open — keep the last real layout
    const splitPanes = rows.map((r) => [...r])
    const paneCount = splitPanes.length > 0 ? splitPanes.reduce((n, r) => n + r.length, 0) : 1
    saveLastLayout({ selectedId, splitPanes, title: this.sessionLabel(selectedId), paneCount })
  }

  // Accept the offer: reopen the selected chat + split panes the operator had last time. Sessions
  // that no longer exist are skipped; if none survive we stay on the home screen. Clears the offer
  // either way. This is the ONLY path that turns the persisted layout into an active selection.
  restoreLastLayout(): void {
    const l = this.restorableLayout
    this.restorableLayout = null
    if (!l) return
    const exists = (id: string): boolean => !!this.sessions[id]
    const rows = l.splitPanes.map((r) => r.filter(exists)).filter((r) => r.length > 0)
    if (rows.length > 0) {
      this.splitPanes = rows.map((r) => [...r])
      this.selectedId = rows[0]![0]!
    } else if (l.selectedId && exists(l.selectedId)) {
      this.splitPanes = []
      this.selectedId = l.selectedId
    } else {
      return // nothing survived the restart — stay on the home screen
    }
    for (const id of this.basePanes().flat()) void this.ensureHistory(id)
  }

  // Dismiss the offer for this session (the persisted layout is left intact — a later restart still
  // offers the operator's most recent real layout).
  dismissRestore(): void {
    this.restorableLayout = null
  }

  // drag-to-split: the session being dragged and the live drop zone (column or new row).
  dragSession = $state<string | null>(null)
  dropZone = $state<DropZone | null>(null)

  endDragSession(): void {
    this.dragSession = null
    this.dropZone = null
  }

  private basePanes(): string[][] {
    if (this.splitPanes.length) return this.splitPanes
    return this.selectedId ? [[this.selectedId]] : []
  }

  // Map a row-major flat pane index (what ThreadView is handed) to a (row, col) coordinate.
  private coord(flat: number): { r: number; c: number } | null {
    const rows = this.basePanes()
    let i = flat
    for (let r = 0; r < rows.length; r++) {
      const len = rows[r]!.length
      if (i < len) return { r, c: i }
      i -= len
    }
    return null
  }

  // Normalise a candidate layout: drop empty rows, then collapse to a single pane when only
  // one remains (so closing back down to one chat leaves split mode, as before).
  private commit(rows: string[][]): void {
    const cleaned = rows.filter((r) => r.length > 0)
    const total = cleaned.reduce((n, r) => n + r.length, 0)
    if (total <= 1) {
      this.splitPanes = []
      // Collapse to the single remaining pane, or clear to the dashboard when the last closes.
      this.selectedId = cleaned[0]?.[0] ?? null
    } else {
      this.splitPanes = cleaned
      this.selectedId = cleaned[0]?.[0] ?? this.selectedId
    }
  }

  // Place a dragged chat according to the computed drop zone.
  dropAt(zone: DropZone, id: string): void {
    this.restorableLayout = null // opening/splitting a chat supersedes the pending restore offer
    const base = this.basePanes()
    // Already open in a pane → don't spawn a duplicate view of the same chat (dragging an
    // already-open chat back into the panes was creating a second identical pane).
    if (base.some((row) => row.includes(id))) return
    if (base.length === 0) {
      // From the dashboard there is nothing to split — just open the chat.
      this.selectedId = id
      this.splitPanes = []
      return
    }
    const rows = base.map((r) => [...r])
    if (zone.kind === 'row') {
      const at = Math.max(0, Math.min(zone.row, rows.length))
      rows.splice(at, 0, [id])
    } else {
      const r = Math.max(0, Math.min(zone.row, rows.length - 1))
      const row = rows[r]!
      const at = Math.max(0, Math.min(zone.col, row.length))
      row.splice(at, 0, id)
    }
    this.commit(rows)
  }

  // Split button: add a second column to the last row (horizontal split, as before).
  startSplit(): void {
    const base = this.basePanes()
    if (base.length === 0) return
    const flat = base.flat()
    // Only split when there's a *different* chat to show — never duplicate the sole chat into
    // two panes.
    const other = this.sessionList.find((v) => !flat.includes(v.record.id))?.record.id
    if (!other) return
    const rows = base.map((r) => [...r])
    rows[rows.length - 1]!.push(other)
    this.commit(rows)
  }

  setPaneSession(index: number, id: string): void {
    const co = this.coord(index)
    if (!co) return
    const rows = this.basePanes().map((r) => [...r])
    rows[co.r]![co.c] = id
    if (co.r === 0 && co.c === 0) this.selectedId = id
    this.commit(rows)
  }

  closePane(index: number): void {
    const co = this.coord(index)
    if (!co) return
    const rows = this.basePanes().map((r) => [...r])
    const closedId = rows[co.r]?.[co.c] ?? null
    rows[co.r]!.splice(co.c, 1)
    this.commit(rows)
    // Closing the last pane that showed a DRAFT discards it (X-ing out an unsent chat is local-only).
    if (closedId && this.sessions[closedId]?.draft && !this.basePanes().flat().includes(closedId)) {
      this.discardDraft(closedId)
    }
  }
}

export const store = new HubStore()

// Dev-only handle for debugging/automation in the browser console.
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as { __hubStore: HubStore }).__hubStore = store
}
