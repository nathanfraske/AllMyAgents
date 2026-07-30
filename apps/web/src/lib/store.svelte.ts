import { api, bootstrapDesktopHubToken, HUB_WS, getHubToken, setHubToken } from './api'
import { settings } from './settings.svelte'
import { alertDialog } from './dialog.svelte'
import {
  loadLastLayout,
  saveLastLayout,
  loadQueues,
  saveQueues,
  type PersistedLayout,
  type QueuedEntry,
} from './uiState'
import { rowFate } from './fleetMerge'
import { isChatBusy, nextOrderKey, orderChats, type ChatOrderFacts } from './chatOrder'
import { extractCodexReasoning } from './codexGroup'
import { attachmentsFromPayload, type AttachmentMeta } from './attachments'
import type { AgentOutcome } from './agentTree'
import type { ApprovalRecord, FleetSite, HistoryItem, HistoryPage, HubEvent, HubPrefs, HubStreamMessage, ProfileInfo, ProjectInfo, QuestionRecord, ReplayComplete, ReplayStart, ScanResult, SessionRecord, UsageSnapshot } from './api'

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
  /** Durable metadata consumed by TaskStrip but intentionally omitted from the transcript. */
  taskBoardOnly?: boolean
  /** For a `tool` item: the vendor correlation id. A spawned agent's items point back at it via `agentId`. */
  toolUseId?: string
  /** When the tool_result arrived — the only honest end-time for a spawned agent (its duration). */
  toolResultTs?: string
  /**
   * Sub-agent attribution from the vendor lifecycle: Claude supplies `parent_tool_use_id`; Codex supplies
   * a child thread id which the hub adapter preserves as `agentThreadId`. Set only for work produced inside
   * a spawned agent; undefined for the main thread. See agentTree.ts.
   */
  agentId?: string
  /** The spawned agent's type + task, also carried on the envelope (e.g. `general-purpose`). */
  subagentType?: string
  taskDescription?: string
  /**
   * --- Vendor sub-agent lifecycle, merged onto the SPAWN tool item. ---
   * Claude uses `task_started` / `task_progress` / `task_notification`; Codex uses child
   * `turn/started` / `turn/completed`. These are structured lifecycle facts, never inferred from prose.
   * All optional so older journals degrade to what their rows can honestly support.
   */
  agentTaskId?: string
  agentOutcome?: AgentOutcome
  agentOutcomeTs?: string
  agentSummary?: string
  agentProgressTs?: string
  agentLastTool?: string
  agentToolUses?: number
  reflex?: boolean
  status?: string
  // True for a turn reconstructed from the vendor transcript on open (imported chats), vs a live/
  // journaled event. Drives condensed rendering + a "history" affordance; carries no precise ts.
  historical?: boolean
  /**
   * Presentation only: the item rebuilt state before the socket's replay-complete boundary, so it must
   * not play the "new transcript item" enter animation. It remains a normal, fully rendered item.
   */
  replayed?: boolean
  // Inter-agent bus message (kind: 'bus'): whether this session sent or received it, the other
  // party's label, and an optional subject. `text` holds the message body.
  busDir?: 'sent' | 'received'
  busPeer?: string
  // The counterparty's SESSION ID (recipient for sent, sender for received) so the transcript can show
  // their vendor logo — resolved from the session record at render time (undefined for a broadcast, or a
  // teammate whose chat no longer exists → the blurb renders with no logo rather than a broken mark).
  busPeerId?: string
  busSubject?: string
  // Files/images attached to a user message. METADATA ONLY — never bytes: the hub journals
  // `{id,name,mime,size}` (bytes live on disk), and the transcript renders images from a hub URL built
  // by attachmentUrl(). This is what lets an attachment from a PRIOR session render after a reload, when
  // any composer-side object URL is long dead.
  attachments?: AttachmentMeta[]
}

export interface SessionView {
  record: SessionRecord
  items: ThreadItem[]
  /** Live recency: the timestamp of the most recent event, whatever it was. Drives the row's clock. */
  lastActivity: string
  /**
   * Recency as of the last time this chat SETTLED — what the sidebar sorts on, and the reason a
   * streaming chat holds its place. It is `lastActivity` frozen for the duration of a turn; see
   * chatOrder.ts for why the two must not be the same field. Optional so a view built by an older
   * code path (or a test fixture) still orders sensibly by falling back to `lastActivity`.
   */
  orderKey?: string
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

/** Project a session view down to the handful of facts ordering is allowed to depend on. */
function orderFacts(v: SessionView): ChatOrderFacts {
  return { id: v.record.id, createdAt: v.record.createdAt, lastActivity: v.lastActivity, orderKey: v.orderKey }
}

/** Is this chat mid-turn? (Its sort key is frozen while it is — see chatOrder.ts.) */
function viewIsBusy(v: SessionView): boolean {
  return isChatBusy({ turnStartedAt: v.turnStartedAt, status: v.record.status })
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

// Exported for tests, which need a FRESH instance per case — the singleton below carries state between
// them. Application code should always use `store`, never construct a second one.
export class HubStore {
  profiles = $state<ProfileInfo[]>([])
  projects = $state<ProjectInfo[]>([])
  sessions = $state<Record<string, SessionView>>({})
  // Agent tools and bus frames use the short, human-facing session id while the roster is keyed by
  // the full UUID. Build every prefix once per roster change so transcript cards do O(1) resolution
  // rather than scanning the whole roster on every render. `null` is an intentional collision marker:
  // an ambiguous prefix must never inherit either teammate's name or vendor.
  private sessionPrefixIndex = $derived.by(() => {
    const prefixes = new Map<string, SessionView | null>()
    for (const [id, view] of Object.entries(this.sessions)) {
      for (let length = 1; length < id.length; length++) {
        const prefix = id.slice(0, length)
        if (!prefixes.has(prefix)) prefixes.set(prefix, view)
        else if (prefixes.get(prefix) !== view) prefixes.set(prefix, null)
      }
    }
    return prefixes
  })
  approvals = $state<ApprovalRecord[]>([])
  questions = $state<QuestionRecord[]>([])
  usage = $state<UsageSnapshot[]>([])
  // Hub-owned ordinary preferences. Shared here so the composer and Settings read the same live value;
  // absent/failed bootstrap keeps the server's default-on behavior rather than disabling steering.
  prefs = $state<HubPrefs>({ chatNamePool: 'everyone', steerMessagesAtToolBoundary: true })
  connected = $state(false)
  needsPairing = $state(false)
  selectedId = $state<string | null>(null)
  /** The read-first project dashboard. Mutually exclusive with visible chat panes. */
  projectViewId = $state<string | null>(null)
  settingsOpen = $state(false)
  // Queued messages survive a refresh: you already committed to sending that text, so losing it because
  // the page reloaded is data loss. Restored from localStorage and re-saved on every mutation.
  queues = $state<Record<string, QueuedEntry[]>>(loadQueues())
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
    return (this.queues[sessionId] ?? []).map((q) => (typeof q === 'string' ? q : q.text))
  }

  enqueue(sessionId: string, text: string, attachments: AttachmentMeta[] = []): void {
    const entry: QueuedEntry = attachments.length ? { text, attachments } : text
    const q = [...(this.queues[sessionId] ?? []), entry]
    this.queues = { ...this.queues, [sessionId]: q }
    saveQueues(this.queues)
  }

  editQueued(sessionId: string, index: number, text: string): void {
    const q = [...(this.queues[sessionId] ?? [])]
    if (index < 0 || index >= q.length) return
    const current = q[index]
    q[index] = typeof current === 'string' ? text : { ...current, text }
    this.queues = { ...this.queues, [sessionId]: q }
    saveQueues(this.queues)
  }

  removeQueued(sessionId: string, index: number): void {
    const q = (this.queues[sessionId] ?? []).filter((_, i) => i !== index)
    this.queues = { ...this.queues, [sessionId]: q }
    saveQueues(this.queues)
  }

  /** Sessions with a queue flush already scheduled for the end of this tick (see scheduleQueueFlush). */
  private readonly pendingFlush = new Set<string>()

  /**
   * Defer the flush to the end of the tick and re-read the session's status before sending, so a status
   * that is immediately superseded within the same batch cannot trigger a send.
   *
   * WHAT THIS DOES NOT DO — and an earlier version of this comment wrongly claimed it did. It is NOT a
   * replay barrier. The WebSocket replays the journal from seq 0 on every connect with no
   * replay-complete marker, and — per `ingest` below — EVERY WebSocket message arrives as its own task,
   * with batching bounded by a frame rather than by the backlog. So a large replay spans many tasks: an
   * old `session/status idle` can end one batch, this timer can fire, and the `active` that says the
   * session is actually busy right now arrives only in a later batch. Deferring narrows the window to a
   * single batch; it does not close it, and under load it will not.
   *
   * THE REAL FIX, still open: the server should emit a non-journal replay-complete control envelope after
   * its synchronous replay loop and before live delivery, and the client must run no mutating replay side
   * effect until it sees that envelope — then re-read the final status once. That envelope is a statement
   * about STREAM position ("everything through seq N has been delivered"), not a second opinion about
   * whether a session is busy, so it does not add another authority; `record.status` stays the only one.
   *
   * The transactional rollback in flushQueue below is independent of this and does hold: whatever causes
   * a send to fail, the text goes back on the queue rather than vanishing.
   */
  private scheduleQueueFlush(sessionId: string): void {
    if (this.pendingFlush.has(sessionId)) return // one flush per session per tick — replay bursts many
    this.pendingFlush.add(sessionId)
    setTimeout(() => {
      this.pendingFlush.delete(sessionId)
      const view = this.sessions[sessionId]
      if (!view || view.record.status !== 'idle') return
      // Require a turn that actually SUCCEEDED, not merely a session that is idle. `idle` is reached by
      // several paths that are not "the previous turn finished and the next one should start": a reopen,
      // a stale-session reconcile after a worker loss, and the unwind of an operator interrupt all land
      // there. Firing queued text on any of them means the operator's Stop, or a crash recovery, silently
      // launches work they never re-authorised — and after a Stop the worktree is already gone, so it
      // would run against a directory that no longer exists.
      //
      // Only a FAILED turn holds the queue. An interrupt does not: the operator ended that turn on
      // purpose and their queued follow-up is usually the reason they interrupted, so making them
      // re-send it by hand is just friction. Requiring success outright (lastTurnOk === true) was too
      // strict — it stranded queued text after every interrupt.
      //
      // A failure still holds, because with a broken worker each send produces another failure, which
      // would flush the next message, and the whole queue drains into the same wall. And a STOPPED chat
      // never reaches here at all: its status is 'stopped', not 'idle', so the guard above already
      // excludes the dangerous case this rule originally existed for (Stop removes the worktree, so
      // auto-restarting would run against a directory that no longer exists).
      if (view.lastTurnOk === false) return
      void this.flushQueue(sessionId)
    }, 0)
  }

  /**
   * Send the head of a session's queue, TRANSACTIONALLY: if the send fails, the text goes back on the
   * queue and the optimistic bubble is withdrawn.
   *
   * This used to dequeue, persist the removal, echo the message, and then `void api.send(...)` without
   * ever looking at the result. `jpost` RESOLVES with `{error}` rather than throwing, so every failure —
   * hub down, worker unavailable, session busy — silently destroyed the queued text while leaving a bubble
   * claiming it had been sent. A reload then removed the bubble too, and the message had never existed
   * anywhere. That is the same divergence ThreadView.send() already handles correctly for direct sends.
   */
  private async flushQueue(sessionId: string): Promise<void> {
    const q = this.queues[sessionId]
    if (!q || q.length === 0) return
    let chosen: QueuedEntry[]
    let rest: QueuedEntry[]
    if (settings.combineQueued) {
      chosen = q
      rest = []
    } else {
      chosen = [q[0] as QueuedEntry]
      rest = q.slice(1)
    }
    const toSend = chosen.map((entry) => (typeof entry === 'string' ? entry : entry.text)).join('\n\n')
    const attachments = chosen.flatMap((entry) =>
      typeof entry === 'string' ? [] : (entry.attachments ?? [])
    )
    this.queues = { ...this.queues, [sessionId]: rest }
    saveQueues(this.queues)
    const key = this.pushUserEcho(sessionId, toSend, attachments)
    const res = (await (attachments.length
      ? api.send(sessionId, toSend, { attachments: attachments.map((a) => a.id) })
      : api.send(sessionId, toSend))) as { error?: string } | undefined
    if (!res?.error) return
    // Put it back at the HEAD so ordering survives, withdraw the echo (which also clears the suppress
    // flag and the thinking spinner), and say so — a queued message must never disappear silently.
    const current = this.queues[sessionId] ?? []
    const restored: QueuedEntry = attachments.length ? { text: toSend, attachments } : toSend
    this.queues = { ...this.queues, [sessionId]: [restored, ...current] }
    saveQueues(this.queues)
    this.removeItem(sessionId, key)
    const view = this.sessions[sessionId]
    if (view) {
      this.push(view, {
        kind: 'note',
        ts: new Date().toISOString(),
        text: `⚠ queued message was not sent (${res.error}) — it is still queued`,
      })
    }
  }

  private ws: WebSocket | null = null

  get sessionList(): SessionView[] {
    // Drafts are local-only until they materialize — keep them out of the sidebar + dashboard.
    //
    // Ordered, not merely filtered, and by the SAME comparator the sidebar's per-group pass uses. Every
    // consumer downstream (the sidebar's bucketing, the dashboard, the pane picker, and the membership
    // snapshot a drag records in `groupSessionIds`) then agrees on one arrangement, so a chat cannot
    // sit in one place on screen and be recorded in another. No manual order at this level: that is
    // per group, and this list spans all of them.
    return orderChats(Object.values(this.sessions).filter((v) => !v.draft), [], orderFacts)
  }

  get selected(): SessionView | null {
    return this.selectedId ? (this.sessions[this.selectedId] ?? null) : null
  }

  // Resolve either a full session id or an unambiguous prefix. This is the single identity lookup for
  // transcript names and vendor marks: unknown and ambiguous prefixes both deliberately return nothing.
  resolveSession(id: string): SessionView | undefined {
    return this.sessions[id] ?? this.sessionPrefixIndex.get(id) ?? undefined
  }

  // Human label for a session id — its title, else the last path segment of its worktree/repo/cwd
  // (same rule the sidebar renders by). '' when the id is unknown or ambiguous. Used by persisted
  // layout snapshots and transcript activity cards so they do not duplicate naming rules.
  sessionLabel(id: string): string {
    const v = this.resolveSession(id)
    if (!v) return ''
    if (v.record.title) return v.record.title
    const p = v.record.worktree ?? v.record.repo ?? v.record.cwd
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
  }

  sessionProvider(id: string): 'claude' | 'codex' | undefined {
    const provider = this.resolveSession(id)?.record.provider
    return provider === 'claude' || provider === 'codex' ? provider : undefined
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

  // Sort a group's already-bucketed sessions: the saved chat order for that group id first, then
  // settled recency for everything the operator never arranged. Called per group by the sidebar.
  // Streaming activity cannot move a row here — see chatOrder.ts.
  orderedChats(groupId: string, sessions: SessionView[]): SessionView[] {
    return orderChats(sessions, this.chatOrder[groupId] ?? [], orderFacts)
  }

  // Full membership of a group (projectId, or '__none__' for unfiled) in the order the sidebar shows
  // it — reorder operates on this, independent of any active sidebar search filter. It must be the
  // rendered order and not raw recency: a drag records the WHOLE group, so a baseline that disagreed
  // with the screen would silently rearrange every row the operator did not touch.
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

  /**
   * Fetch the optional bootstrap data, never throwing, and retry the parts that failed.
   *
   * Split out of init() because it must not be able to prevent connect(). Each call is caught
   * individually so one unavailable endpoint degrades one panel rather than the whole app, and a failure
   * schedules a bounded retry — a hub that was merely still starting will answer a second later, and the
   * operator should not have to reload to find that out.
   */
  private async loadBootstrapData(attempt = 0): Promise<void> {
    let failed = false
    const profiles = await api.profiles().catch(() => null)
    if (profiles) this.profiles = profiles
    else failed = true
    const projects = await api.projects().catch(() => null)
    if (projects) this.projects = projects
    else failed = true
    const prefs = await api.prefs().catch(() => null)
    if (prefs) this.prefs = prefs
    else failed = true
    await this.refreshSideData().catch(() => {
      failed = true
    })
    // Bounded, and only for what actually failed. The WebSocket has its own reconnect loop; this covers
    // the plain GETs, which have none.
    if (failed && attempt < 5) {
      setTimeout(() => void this.loadBootstrapData(attempt + 1), 1000 * (attempt + 1))
    }
  }

  async init(): Promise<void> {
    const t0 = perfNow()
    vlog('init: start')
    // ARM the auto-reopen FIRST, before anything can load sessions. ensure() is what fires it, so if a
    // session arrives before this flag is set (refreshSideData populating the roster, say) the trigger is
    // missed and never comes back — every session is already ensured, so no further ensure() happens.
    // This is deliberately the very first statement for that reason.
    this.autoRestorePending = settings.autoReopenLastChats
    // If the hub enforces a device token and we don't hold a valid one, gate on pairing first.
    await bootstrapDesktopHubToken()
    const auth = await api.auth().catch(() => null)
    if (!auth) {
      setTimeout(() => void this.init(), 1000)
      return
    }
    if (!auth.authed) {
      vlog('init: needs pairing — stop')
      this.needsPairing = true
      return
    }
    // OPTIONAL SIDE DATA MUST NEVER STOP THE SOCKET FROM BEING CREATED.
    //
    // These bootstrap awaits used to be uncaught, and connect() — the ONLY place the WebSocket is ever
    // built — runs after them. App.svelte calls `void store.init()`, so a single transient rejection
    // threw out of init, was swallowed, and left the app with no socket and no retry: permanently blank
    // until a manual reload. On a cold/first launch the hub is still starting while the UI mounts, so
    // that is the EXPECTED ordering rather than a rare race — the app could brick itself on the one run
    // where the operator has the least idea what is wrong.
    //
    // The transport comes up FIRST and is never awaited behind optional data. Catching each fetch was not
    // enough on its own: a hub that accepts the socket but never answers (exactly what a still-starting
    // one does) leaves the await pending forever, so connect() is still never reached and the app is
    // still blank with no retry. Not awaiting removes rejection AND hang in one move, and the side data
    // is genuinely optional — the transcript stream is what the operator is waiting for.
    this.connect()
    void this.loadBootstrapData()
    // Per-chat settings (permission mode, model, thinking effort, title) are rebuilt from replayed
    // `session/created` events, which carry the record AS IT WAS AT CREATION — so a mode you changed
    // later rendered stale on a fresh load. Overlay the hub's CURRENT roster once the replay has
    // landed. Twice, because "the replay has landed" is not an event we get: the second pass catches a
    // slow/large backlog. Cheap (one GET) and idempotent.
    setTimeout(() => void this.syncRecordsFromHub(), 800)
    setTimeout(() => void this.syncRecordsFromHub(), 3000)
    // Belt and braces: if sessions were already loaded above, ensure() has come and gone, so nudge the
    // restore directly. scheduleAutoRestore is idempotent and re-arms itself while the roster is empty.
    this.scheduleAutoRestore()
    vlog(`init: bootstrap dispatched, WS connecting (${msSince(t0)})`)
    // Fire-and-forget: pull the fleet roster and merge any remote machines' projects/sessions
    // read-only. Non-blocking so local render stays instant; a no-node/no-peer hub gets just the
    // local entry and this is a no-op (see refreshFleet).
    this.startFleet()
    // NOTE: we deliberately do NOT scan every project on load — that walked ~/.codex + ~/.claude and
    // read thousands of transcript files per project, pegging the hub for minutes ("stuck scanning").
    // The import prompt now fires lazily, for the ONE project you actually open (see maybePromptImport).
  }

  /**
   * Overlay the hub's CURRENT session roster onto the records the WS replay rebuilt.
   *
   * The client reconstructs sessions from replayed `session/created` events, and that payload is the
   * record as it was AT CREATION. Anything changed afterwards through a dedicated route — the permission
   * mode, model, thinking effort, service tier, title — is only corrected if the matching later event
   * also replays. The hub is authoritative for all of them (specOf feeds these exact fields into every
   * turn), so re-reading /api/sessions is the honest fix rather than trusting event reconstruction.
   *
   * Deliberately does NOT touch `status` or activity: those belong to the live event stream, and
   * stomping them here would resurrect the class of bug where a stale write pins a chat on the wrong
   * state. Settings only.
   */
  async syncRecordsFromHub(): Promise<void> {
    const rows = await api.sessions().catch(() => [] as SessionRecord[])
    if (!Array.isArray(rows)) return
    for (const rec of rows) {
      const v = this.sessions[rec.id]
      if (!v || v.draft) continue // not merged yet (a later pass catches it), or a local draft we own
      v.record.permissionMode = rec.permissionMode
      v.record.model = rec.model
      v.record.effort = rec.effort
      v.record.serviceTier = rec.serviceTier
      v.record.isProjectManager = rec.isProjectManager
      v.record.managerMaxLiveChildren = rec.managerMaxLiveChildren
      v.record.managerPermissionModeCeiling = rec.managerPermissionModeCeiling
      v.record.managerMaxChildPermissionMode = rec.managerMaxChildPermissionMode
      v.record.managerDelegation = rec.managerDelegation
      v.record.managerAllowedProfiles = rec.managerAllowedProfiles
      v.record.managerAllowedModels = rec.managerAllowedModels
      v.record.managerAllowedTools = rec.managerAllowedTools
      v.record.parentSessionId = rec.parentSessionId
      v.record.delegatedAuthorities = rec.delegatedAuthorities
      v.record.delegatedTools = rec.delegatedTools
      if (rec.title) v.record.title = rec.title
    }
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

  async rescanProfiles(): Promise<{ error?: string }> {
    const result = await api.rescanProfiles()
    if ('error' in result) return result
    this.profiles = result
    return {}
  }

  lastProfileId = $state<string | null>(null)
  managerSetupOpen = $state(false)
  managerSetupSessionId = $state<string | null>(null)

  openManagerSetup(sessionId?: string): void {
    this.managerSetupSessionId = sessionId ?? null
    this.managerSetupOpen = true
  }

  closeManagerSetup(): void {
    this.managerSetupOpen = false
    this.managerSetupSessionId = null
  }

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
    this.scheduleAutoRestore() // sessions are arriving — the pending auto-reopen can now resolve ids
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
  async materializeDraft(
    draftId: string,
    text: string,
    deliverAfterSpawn?: (sessionId: string) => Promise<{ ok?: boolean; error?: string }>,
  ): Promise<{ ok?: boolean; error?: string; sessionId?: string }> {
    const draft = this.sessions[draftId]
    if (!draft || !draft.draft) return { error: 'draft is gone' }
    const r = draft.record
    const body: Record<string, unknown> = {
      profileId: r.profileId,
      permissionMode: r.permissionMode ?? settings.defaultPermissionMode,
      useWorktree: draft.draftUseWorktree ?? settings.defaultUseWorktree,
    }
    if (!deliverAfterSpawn) body.prompt = text
    if (r.projectId) body.projectId = r.projectId
    if (r.model) body.model = r.model
    if (r.effort) body.effort = r.effort
    if (r.serviceTier) body.serviceTier = r.serviceTier
    const out = await api.spawn(body)
    if (!out || 'error' in out) {
      return { error: (out as { error?: string } | null)?.error ?? 'failed to start the session' }
    }
    const rec = out as SessionRecord
    if (deliverAfterSpawn) {
      let delivered: { ok?: boolean; error?: string }
      try {
        delivered = await deliverAfterSpawn(rec.id)
      } catch (error) {
        delivered = { error: error instanceof Error ? error.message : 'failed to send attachments' }
      }
      if (delivered.error) {
        // The attachment first-turn transaction created this empty session solely to mint upload ids.
        // Roll it back when upload/send fails so the visible draft remains the one honest retry point.
        // Deletion can be REFUSED when an uploaded file is now recoverable workspace data. In that case
        // keep the spawned chat visible too: hiding it locally would orphan the only route back to the
        // preserved files while the hub correctly keeps the session alive.
        const cleanup = await this.requestSessionDelete(rec.id)
        if (cleanup.ok && this.sessions[rec.id] && !this.basePanes().flat().includes(rec.id)) {
          const { [rec.id]: _failed, ...withoutFailed } = this.sessions
          this.sessions = withoutFailed
        }
        if (!cleanup.ok) {
          this.ensure(rec)
          await alertDialog(
            `The first message failed, and the partially created chat could not be removed. It remains visible because the hub preserved recoverable work.\n\n${cleanup.error}`
          )
        }
        return { error: delivered.error }
      }
    }
    // Swap draft id → real id everywhere it is referenced, then drop the draft.
    const { [draftId]: _drop, ...rest } = this.sessions
    this.sessions = rest
    this.ensure(rec)
    const shouldActivate = settings.autoSwitchToNewChat || this.selectedId === draftId
    if (this.splitPanes.length) {
      const rows = this.splitPanes.map((row) => row.map((x) => (x === draftId ? rec.id : x)))
      if (shouldActivate && rows[0]?.[0] !== rec.id) {
        // App renders splitPanes, not selectedId. Move the new chat into the primary displayed pane and
        // swap the previous primary into the draft's old slot, preserving every open pane without dupes.
        const targetRow = rows.findIndex((row) => row.includes(rec.id))
        const targetCol = targetRow >= 0 ? rows[targetRow]!.indexOf(rec.id) : -1
        if (targetRow >= 0 && targetCol >= 0 && rows[0]?.length) {
          const previousPrimary = rows[0][0]!
          rows[0][0] = rec.id
          rows[targetRow]![targetCol] = previousPrimary
        }
      }
      this.splitPanes = rows
    }
    if (shouldActivate) this.selectedId = rec.id
    this.lastProfileId = rec.profileId
    this.noteSent(rec.id) // immediate "received / thinking" feedback while the first turn spins up
    this.markGlitch(rec.id) // glitch the sidebar label as the chat materializes into its project
    return { ok: true, sessionId: rec.id }
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

  // This is spawn-time intent, never a live-session mutation. Once materialized, the returned record
  // reports the actual checkout and the segmented control is read-only.
  setDraftWorktree(id: string, useWorktree: boolean): void {
    const cur = this.sessions[id]
    if (!cur?.draft || !cur.record.projectId) return
    cur.draftUseWorktree = useWorktree
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
    // jget THROWS now (api.ts): a hub hiccup here used to assign an {error} object and limp on; it would
    // now reject an unguarded load. Keeping the previous list beats blanking the sidebar over one 500.
    const local = await api.projects().catch(() => null)
    if (!local) return
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
    const raw = await api.fleet().catch(() => null)
    // A non-array means we could not learn the roster at all (an older hub with no /api/fleet returns
    // {error}; a token-gated hub returns 401 {error}). buildFleet always returns at least the local
    // entry, so an empty array means the same thing.
    const fleet = Array.isArray(raw) && raw.length ? raw : null
    const hadRemote =
      this.projects.some((p) => p.siteId) || Object.values(this.sessions).some((v) => v.record.siteId)
    if (!fleet) {
      // NEVER wipe merged rows because WE could not ask. Losing the roster is our problem, not evidence
      // that another machine's projects stopped existing — flag them unreachable and keep them.
      if (hadRemote) this.flagRemoteUnreachable()
      return
    }
    this.fleetSites = fleet
    const remoteSites = fleet.filter((s) => !s.local)
    if (!remoteSites.length) {
      // No peers in the roster. If we HAD peers, that is far more likely the mesh node being down than
      // every machine being unpaired at once — keep their rows, flagged unreachable. With no peers and
      // nothing previously merged this is the pure single-machine path: leave local state completely
      // untouched (no reassignments, no reactivity churn), exactly as before this feature.
      if (hadRemote) this.flagRemoteUnreachable()
      return
    }
    const knownSiteIds = new Set(remoteSites.map((s) => s.siteId))
    const onlineSites = remoteSites.filter((s) => s.online)
    const onlineSiteIds = new Set(onlineSites.map((s) => s.siteId))

    const pulled = await Promise.all(
      onlineSites.map(async (site) => {
        const [projects, sessions] = await Promise.all([
          api.projectsFrom(site.baseUrl).catch(() => [] as ProjectInfo[]),
          api.sessionsFrom(site.baseUrl).catch(() => [] as SessionRecord[]),
        ])
        return { site, projects, sessions }
      })
    )

    const remoteProjects: ProjectInfo[] = []
    const seenRemoteSessionIds = new Set<string>()
    for (const { site, projects, sessions } of pulled) {
      for (const p of projects) {
        remoteProjects.push({ ...p, id: `${site.siteId}:${p.id}`, siteId: site.siteId, siteLabel: site.label, siteOnline: true })
      }
      for (const s of sessions) {
        const rec: SessionRecord = {
          ...s,
          id: `${site.siteId}:${s.id}`,
          projectId: s.projectId ? `${site.siteId}:${s.projectId}` : undefined,
          siteId: site.siteId,
          siteLabel: site.label,
          siteOnline: true,
        }
        seenRemoteSessionIds.add(rec.id)
        // ensure() keys by the namespaced id → never collides with a local (raw-id) session. Refresh
        // the view's lastActivity too so the sidebar re-sorts remote rows by their real recency
        // (ensure sets it only on first create, and a remote session has no live WS to bump it).
        const v = this.ensure(rec)
        v.record.siteOnline = true
        v.lastActivity = rec.lastActivity ?? rec.createdAt
        // The sort key follows only while that chat is NOT mid-turn. A remote row has no local turn
        // clock, so without this the poll would step its key every few seconds for as long as it ran —
        // the same thrash as the local case, just at the polling cadence instead of the token cadence.
        if (!viewIsBusy(v)) v.orderKey = v.lastActivity
      }
    }
    // Rows from a machine we could NOT reach are kept exactly as last seen and flagged unreachable —
    // "that box is off", not "your projects are gone". A row is only forgotten when we can actually see
    // its site and it no longer offers it, or when the site left the fleet. See fleetMerge.rowFate.
    const carried = this.projects
      .filter((p) => !!p.siteId && rowFate({ siteId: p.siteId, knownSiteIds, onlineSiteIds, seenNow: false }) === 'mark-offline')
      .map((p) => ({ ...p, siteOnline: false }))
    const localProjects = this.projects.filter((p) => !p.siteId)
    this.projects = [...localProjects, ...remoteProjects, ...carried]

    for (const id of Object.keys(this.sessions)) {
      const v = this.sessions[id]
      const site = v?.record.siteId
      if (!v || !site) continue // local sessions + drafts are never touched here
      const fate = rowFate({ siteId: site, knownSiteIds, onlineSiteIds, seenNow: seenRemoteSessionIds.has(id) })
      if (fate === 'drop') this.removeSessionLocal(id)
      else if (fate === 'mark-offline') v.record.siteOnline = false
    }
  }

  /** Mark every merged remote row unreachable — we lost the roster, which says nothing about whether
   *  those machines are actually up. Keeps the rows visible rather than making work disappear. */
  private flagRemoteUnreachable(): void {
    this.projects = this.projects.map((p) => (p.siteId && p.siteOnline !== false ? { ...p, siteOnline: false } : p))
    for (const v of Object.values(this.sessions)) {
      if (v.record.siteId && v.record.siteOnline !== false) v.record.siteOnline = false
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
    // Same: a failed refresh must leave the accounts we already have, not erase them.
    const refreshed = await api.profiles().catch(() => null) // surface any newly-registered default-home account
    if (refreshed) this.profiles = refreshed
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
    if (this.questions.some((question) => question.sessionId === view.record.id)) {
      return { key: 'question', label: 'awaiting answer' }
    }
    const pending = this.approvals.filter((a) => a.sessionId === view.record.id)
    if (pending.length > 0) {
      return { key: 'approval', label: 'needs approval' }
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
    // Side data is refreshed on a debounce from the event stream, so a transient failure simply means
    // the next event refreshes it. Throwing out of here would take the whole ingest path down.
    const [approvals, questions, usage] = await Promise.all([
      api.approvals().catch(() => null),
      api.questions().catch(() => null),
      api.usage().catch(() => null),
    ])
    if (approvals) this.approvals = approvals
    if (questions) this.questions = questions
    if (usage) this.usage = usage
  }

  async setPrefs(patch: Partial<HubPrefs>): Promise<{ error?: string }> {
    const result = await api.setPrefs(patch)
    if ('error' in result) return result
    this.prefs = result
    return {}
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
  pushUserEcho(sessionId: string, text: string, attachments: AttachmentMeta[] = []): string {
    const v = this.sessions[sessionId]
    if (!v) return ''
    const ts = new Date().toISOString()
    const key = `user:sent:${v.items.length}:${ts}`
    this.push(v, { kind: 'user', ts, text, key, ...(attachments.length ? { attachments } : {}) })
    this.touch(v, ts)
    // Suppress the canonical session/input event (and Codex's own userMessage) that the hub will
    // echo back over the WS, so the optimistic bubble isn't duplicated.
    this.suppressNextUserMsg[sessionId] = true
    return key
  }

  // Push a local-only informational note into a thread — slash-command feedback (/usage output,
  // "model → X", the /compact not-supported reason, argument help). Not journaled: it's a
  // client-side annotation, rendered exactly like the hub's own `note` items (session/mode etc.).
  // Drafts drop these when they materialize into a real session (fresh view), which is fine —
  // the feedback is ephemeral.
  pushLocalNote(sessionId: string, text: string): void {
    const v = this.sessions[sessionId]
    if (!v) return
    const ts = new Date().toISOString()
    this.push(v, { kind: 'note', ts, text })
    this.touch(v, ts)
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

  /**
   * Ask the hub to delete a session and preserve its structured refusal. `jpost` resolves non-2xx
   * responses as `{ error }`, so a catch alone is not a success check. Keeping this seam shared with
   * attachment-transaction cleanup prevents either delete path from orphaning a hub session locally.
   */
  private async requestSessionDelete(
    id: string,
    deleteBrowserData = false,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const out = deleteBrowserData
        ? await api.deleteSession(id, true)
        : await api.deleteSession(id)
      if (out?.ok === true) return { ok: true }
      return { ok: false, error: out?.error?.trim() || 'the hub did not confirm deletion' }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'the hub could not be reached',
      }
    }
  }

  // Delete a chat only after the hub confirms its tombstone. A refusal deliberately leaves every local
  // reference intact and explains where the protected work remains (the hub's reason includes that path).
  async deleteSession(
    id: string,
    deleteBrowserData = false,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const out = await this.requestSessionDelete(id, deleteBrowserData)
    if (!out.ok) {
      await alertDialog(`Chat was not deleted. Its workspace and chat remain available.\n\n${out.error}`)
      return out
    }
    this.removeSessionLocal(id)
    return out
  }

  async deleteProject(
    id: string,
    deleteFiles = false,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const out = await api.deleteProject(id, deleteFiles)
      if (out?.ok !== true) {
        return { ok: false, error: out?.error?.trim() || 'the hub did not confirm deletion' }
      }
      for (const sessionId of out.detachedSessionIds ?? []) {
        const view = this.sessions[sessionId]
        if (view) view.record.projectId = undefined
      }
      for (const sessionId of out.deletedSessionIds ?? []) this.removeSessionLocal(sessionId)
      this.projects = this.projects.filter((project) => project.id !== id)
      if (this.projectViewId === id) this.goHome()
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'the hub could not be reached',
      }
    }
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
    // Only move the selection if the removed chat WAS the one open (or the selection is now dangling).
    // The old test was `!this.selectedId`, which is TRUE on the home screen — so every removal filled the
    // empty selection with sessionList[0], the most recently active chat. Deletions replay from the
    // journal on every reconnect, so each refresh landed you in an unrelated chat instead of home.
    // Being on the home screen is a deliberate state, not a gap to be filled.
    if (this.selectedId === id || (this.selectedId && !this.sessions[this.selectedId])) {
      this.selectedId = this.splitPanes[0]?.[0] ?? null
    }
  }

  private ensure(record: SessionRecord): SessionView {
    const existing = this.sessions[record.id]
    if (existing) {
      existing.record = record
      return existing
    }
    const at = record.lastActivity ?? record.createdAt
    const view: SessionView = { record, items: [], lastActivity: at, orderKey: at, sawReasoning: false }
    // (context/cost fields populated from result + tokenUsage events)
    this.sessions[record.id] = view
    return view
  }

  /** Adopt a control-plane-created session immediately; the websocket's canonical create event remains idempotent. */
  upsertSessionRecord(record: SessionRecord): SessionView {
    return this.ensure(record)
  }

  /**
   * Record activity. `lastActivity` always advances (it is the row's clock); the SORT key only does so
   * when the chat is not mid-turn, which is what keeps the sidebar still while agents stream. Reading
   * `view.lastActivity` before overwriting it means a view that predates `orderKey` freezes at its
   * pre-turn recency rather than at the first event of the turn.
   */
  private touch(view: SessionView, ts: string): void {
    view.orderKey = nextOrderKey(view.orderKey ?? view.lastActivity, ts, viewIsBusy(view))
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

  /**
   * How long the hub has been unreachable, in seconds — 0 whenever it is up.
   *
   * `connected` alone could not answer the question the operator actually had. A hub outage and a
   * sub-second blue-green flip both set it false, so the only honest thing to render from it was a 6px
   * dot; when the hub died for real, the app showed a blank window and a grey dot, and looked broken
   * rather than degraded. Elapsed time separates the two: a restart is over before anyone could read a
   * banner, an outage keeps counting.
   */
  hubDownSeconds = $state(0)
  private downSince: number | null = null
  private downTicker: ReturnType<typeof setInterval> | null = null

  private markConnected(): void {
    this.connected = true
    this.downSince = null
    this.hubDownSeconds = 0
    if (this.downTicker) {
      clearInterval(this.downTicker)
      this.downTicker = null
    }
  }

  /** Idempotent: reconnect attempts fail repeatedly during one outage, and the clock must measure the
   *  outage rather than restarting on every failed retry. */
  private markDisconnected(): void {
    this.connected = false
    if (this.downSince === null) this.downSince = Date.now()
    if (!this.downTicker) {
      this.downTicker = setInterval(() => {
        if (this.downSince !== null) this.hubDownSeconds = Math.round((Date.now() - this.downSince) / 1000)
      }, 1000)
    }
  }

  private connect(): void {
    vlog('ws: connecting (replay from seq 0)')
    this.beginReplayPresentation()
    const ws = new WebSocket(this.wsUrl(0))
    this.ws = ws
    ws.onopen = () => {
      vlog('ws: open')
      this.markConnected()
      if (this.replayPresentationActive) this.scheduleReplayIdleFallback()
    }
    ws.onmessage = (e) => this.ingest(JSON.parse(e.data as string) as HubStreamMessage)
    ws.onclose = () => {
      vlog('ws: closed — reconnecting in 1.5s')
      this.finishReplayPresentation()
      this.markDisconnected()
      setTimeout(() => this.reconnect(), 1500)
    }
  }

  /**
   * Apply one event straight through, isolated so a single bad event can never take down the stream.
   *
   * REVERTED (deliberately): this used to buffer events and flush them on a microtask, to stop a chat
   * visibly re-playing itself line by line after a refresh. That optimisation coincided with events
   * ceasing to reach the UI at all — tool calls and thinking blocks vanishing while the journal kept
   * recording them perfectly — so it is gone. A cosmetic scroll improvement is not worth any risk to the
   * one path that puts agent output on screen. If it is retried, it needs a real test around the flush,
   * not just a code read.
   */
  private pendingEvents: HubStreamMessage[] = []
  private flushScheduled = false
  /** True only while state is rebuilding before the socket's replay-complete boundary. */
  replayPresentationActive = $state(false)
  private applyingReplayedEvent = false
  private replayIdleFallback: ReturnType<typeof setTimeout> | null = null
  private replayHardFallback: ReturnType<typeof setTimeout> | null = null

  /**
   * Arm presentation-only replay mode for a new socket. Journal events still enter the ordinary FIFO
   * and apply on the next frame; `push` merely stamps transcript items they create as replayed.
   *
   * Older hubs do not send the boundary. Resetting the short timer for each event lets their backlog
   * rebuild silently, then returns future traffic to normal after the stream goes quiet. The hard cap
   * guarantees a continuously busy legacy stream can never remain in replay mode forever.
   */
  private beginReplayPresentation(): void {
    this.finishReplayPresentation()
    this.replayPresentationActive = true
    this.replayHardFallback = setTimeout(() => this.finishReplayPresentation(), 10_000)
  }

  private scheduleReplayIdleFallback(): void {
    if (this.replayIdleFallback) clearTimeout(this.replayIdleFallback)
    this.replayIdleFallback = setTimeout(() => this.finishReplayPresentation(), 500)
  }

  private finishReplayPresentation(): void {
    this.replayPresentationActive = false
    if (this.replayIdleFallback) clearTimeout(this.replayIdleFallback)
    if (this.replayHardFallback) clearTimeout(this.replayHardFallback)
    this.replayIdleFallback = null
    this.replayHardFallback = null
  }

  private isReplayStart(message: HubStreamMessage): message is ReplayStart {
    return 'type' in message && message.type === 'replay-start'
  }

  private isReplayComplete(message: HubStreamMessage): message is ReplayComplete {
    return 'type' in message && message.type === 'replay-complete'
  }

  /**
   * A new hub announces boundary support before replay. Once seen, a short legacy timeout must not
   * interrupt a large valid backlog; WebSocket delivery is ordered/reliable, and socket close handles a
   * broken connection. The long cap is only a final guard against a malformed hub that starts but never
   * completes the protocol.
   */
  private confirmReplayProtocol(): void {
    if (this.replayIdleFallback) clearTimeout(this.replayIdleFallback)
    if (this.replayHardFallback) clearTimeout(this.replayHardFallback)
    this.replayIdleFallback = null
    this.replayPresentationActive = true
    this.replayHardFallback = setTimeout(() => this.finishReplayPresentation(), 60_000)
  }

  private ingest(message: HubStreamMessage): void {
    this.pendingEvents.push(message)
    if (this.replayPresentationActive && !this.isReplayStart(message) && !this.isReplayComplete(message)) {
      this.scheduleReplayIdleFallback()
    }
    if (this.flushScheduled) return
    this.flushScheduled = true
    // MUST be a macrotask. queueMicrotask drains at the end of the SAME task that queued it, and every
    // WebSocket message is its own task — so a microtask flush batched exactly ONE event and the
    // transcript still rebuilt itself line by line. Deferring to the next frame lets a whole burst of
    // messages land in `pendingEvents` first, which is the entire point.
    const run = (): void => this.flushEvents()
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run)
      setTimeout(run, 50) // rAF never fires in a hidden/background tab; flushEvents is idempotent
    } else {
      setTimeout(run, 16) // non-browser (tests/SSR): one flush per ~frame
    }
  }

  /**
   * Apply every buffered event in one pass. Public only so a test can drive the flush deterministically
   * instead of racing a microtask.
   *
   * Order is preserved exactly (FIFO), and each event is applied in ISOLATION: the batch has already
   * been dequeued, so one throwing event must not swallow the ones behind it. That isolation is not
   * theoretical caution — when batching first landed without it, a chat's tool calls and thinking blocks
   * silently stopped rendering while the journal kept recording them perfectly. (The eventual culprit
   * that time was a stale wseq guard in the hub, fixed in 7491428 — the batching was innocent, which is
   * why it is back. But the isolation stays.)
   */
  flushEvents(): void {
    this.flushScheduled = false
    const batch = this.pendingEvents
    this.pendingEvents = []
    for (const message of batch) {
      if (this.isReplayStart(message)) {
        this.confirmReplayProtocol()
        continue
      }
      if (this.isReplayComplete(message)) {
        this.finishReplayPresentation()
        continue
      }
      this.applyingReplayedEvent = this.replayPresentationActive
      try {
        this.apply(message)
      } catch (err) {
        console.error('[store] failed to apply event', message?.kind, message?.seq, err)
      } finally {
        this.applyingReplayedEvent = false
      }
    }
  }

  private reconnect(): void {
    vlog(`ws: reconnecting (replay from seq ${this.lastSeq})`)
    this.beginReplayPresentation()
    const ws = new WebSocket(this.wsUrl(this.lastSeq))
    this.ws = ws
    ws.onopen = () => {
      vlog('ws: reopened')
      this.markConnected()
      if (this.replayPresentationActive) this.scheduleReplayIdleFallback()
    }
    ws.onmessage = (e) => this.ingest(JSON.parse(e.data as string) as HubStreamMessage)
    ws.onclose = () => {
      this.finishReplayPresentation()
      this.markDisconnected()
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
    if (
      kind === 'approval/requested' ||
      kind === 'approval/resolved' ||
      kind === 'question/requested' ||
      kind === 'question/resolved' ||
      kind === 'question/recovery-unknown' ||
      kind === 'question/restart-interrupted' ||
      kind.startsWith('usage/')
    ) {
      this.scheduleSideRefresh()
    }

    if (kind === 'profile/auth') {
      const auth = payload as { profileId?: string; status?: 'signed_in' | 'signed_out'; message?: string }
      const profile = this.profiles.find((candidate) => candidate.id === auth.profileId)
      if (profile && auth.status) {
        profile.authStatus = auth.status
        profile.authError = auth.message
      }
    }
    if (kind === 'project/deleted') {
      const id = (payload as { id?: string }).id
      if (id) {
        this.projects = this.projects.filter((project) => project.id !== id)
        if (this.projectViewId === id) this.goHome()
      }
      return
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
        // Skip if we already rendered it optimistically this turn. Attachments are METADATA the hub
        // journaled ({id,name,mime,size}); the transcript renders images by hub URL, never from bytes.
        if (this.suppressNextUserMsg[sessionId]) delete this.suppressNextUserMsg[sessionId]
        else
          this.push(view, {
            kind: 'user',
            ts,
            text: (payload as { text?: string }).text ?? '',
            attachments: attachmentsFromPayload(payload),
          })
        break
      }
      case 'question/recovery-unknown': {
        const message = (payload as { message?: string }).message
        this.push(view, {
          kind: 'note',
          ts,
          text:
            message ??
            'A prior answer could not be verified after recovery. The agent was told to ask again if needed.',
        })
        break
      }
      case 'question/restart-interrupted': {
        const interruption = payload as {
          phase?: 'planned' | 'crash'
          turnBoundary?: 'completed' | 'unknown'
          questionCount?: number
        }
        const count = interruption.questionCount ?? 1
        const noun = count === 1 ? 'question' : 'questions'
        const outcome =
          interruption.phase === 'planned'
            ? interruption.turnBoundary === 'completed'
              ? 'The live Claude callback was released with a system-interruption result, and that exact turn then reached a terminal boundary before restart.'
              : 'The live callback was released, but whether Claude processed the interruption before restart is unknown.'
            : 'The previous provider process was not reachable, so no interruption response was delivered to it.'
        this.push(view, {
          kind: 'note',
          ts,
          text:
            `SYSTEM INTERRUPTION — NOT A USER RESPONSE. The hub restart interrupted ${count} unanswered ${noun}. ` +
            `No answer, cancellation, decline, choice, or preference was supplied. ${outcome}`,
        })
        break
      }
      case 'session/titled': {
        const p = payload as { title?: string; source?: string }
        if (p.title) {
          view.record.title = p.title
          if (p.source === 'user' || p.source === 'auto') view.record.titleSource = p.source
          if (!this.applyingReplayedEvent) {
            this.markGlitch(sessionId) // live auto-name-on-materialize or rename → glitch the sidebar
          }
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
          // Assigned, not passed through nextOrderKey: this is a CORRECTION of history and the true
          // last-turn time is EARLIER than the import time it replaces, so the monotonic rule there
          // would reject exactly the value that makes an imported chat sort where it belongs.
          view.orderKey = p.lastActivity
        }
        break
      }
      case 'bus/sent': {
        // This session sent a message to a teammate / its project.
        const p = payload as { to?: { kind?: string; id?: string }; subject?: string | null; body?: string; recipients?: number }
        const peer = p.to?.kind === 'project' ? `project · ${p.recipients ?? 0} agent(s)` : `agent ${(p.to?.id ?? '').slice(0, 8)}`
        const sentTo = p.to?.kind === 'session' ? p.to.id : undefined // no single vendor for a broadcast
        this.push(view, { kind: 'bus', ts, busDir: 'sent', busPeer: peer, busPeerId: sentTo, busSubject: p.subject ?? undefined, text: p.body ?? '' })
        break
      }
      case 'bus/delivered': {
        // A teammate's message the hub delivered into this session (rendered as a distinct card).
        const p = payload as { fromLabel?: string; fromSession?: string; subject?: string | null; body?: string }
        const peer = p.fromLabel || (p.fromSession ?? '').slice(0, 8)
        this.push(view, { kind: 'bus', ts, busDir: 'received', busPeer: peer, busPeerId: p.fromSession, busSubject: p.subject ?? undefined, text: p.body ?? '' })
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
          // A NEW turn invalidates the previous turn's verdict. Without this the flag was only ever
          // overwritten by a *result*, so a turn that ended without one — a worker loss, a restored-stale
          // sweep, any path that goes straight back to idle — inherited the last turn's `true` and was
          // presented as a green "completed" it never earned.
          view.lastTurnOk = undefined
          // Use the EVENT's timestamp, never `now`. This same event replays from the journal on an app
          // reload or a hub restart, and `Date.now()` would restart the "thinking for…" clock at zero
          // every time — so a turn that genuinely survived a restart (worker mode) looked brand new.
          // The event ts is the real turn start, so the elapsed time stays true across both.
          if (view.turnStartedAt == null) {
            const started = Date.parse(ts)
            view.turnStartedAt = Number.isFinite(started) ? started : Date.now()
          }
        } else if (status === 'idle' || status === 'error' || status === 'stopped') {
          view.turnStartedAt = undefined
        }
        // Flush queued messages when the turn genuinely FINISHED — deferred, so a replayed historical
        // idle cannot send (see scheduleQueueFlush).
        //
        // Deliberately NOT on 'error' any more. That was meant to keep queued messages from being
        // orphaned, but it fired them straight back into whatever had just failed: with the worker
        // unavailable, each send produced another error status, which flushed the next message, and so on
        // until the queue drained into a dead worker. An error boundary should surface the queue for the
        // operator to retry, not spend it. The text stays queued and goes on the next real completion.
        if (status === 'idle') this.scheduleQueueFlush(sessionId)
        break
      }
      case 'session/agent-stop-requested': {
        const p = payload as { targetId?: string; label?: string }
        const who = p.label?.trim() || (p.targetId ? `sub-agent ${p.targetId.slice(0, 8)}` : 'sub-agent')
        this.push(view, { kind: 'note', ts, text: `stop requested for ${who} — work preserved` })
        break
      }
      case 'session/mode': {
        const pm = (payload as { permissionMode?: string }).permissionMode
        if (pm === 'safe' || pm === 'edits' || pm === 'full') view.record.permissionMode = pm
        this.push(view, { kind: 'note', ts, text: `permission mode → ${pm}` })
        break
      }
      case 'browser/capability-enabled':
      case 'browser/capability-disabled': {
        view.record.browserEnabled = kind === 'browser/capability-enabled'
        this.push(view, {
          kind: 'note',
          ts,
          text: kind === 'browser/capability-enabled' ? 'isolated browser enabled' : 'isolated browser disabled',
        })
        break
      }
      case 'browser/navigation-finished': {
        const p = payload as {
          actor?: 'agent' | 'operator'
          final?: { scheme?: string; host?: string; port?: number; path?: string; queryKeys?: string[] }
          ok?: boolean
        }
        const url = p.final
          ? `${p.final.scheme ?? 'https'}://${p.final.host ?? 'unknown'}${p.final.port ? `:${p.final.port}` : ''}${p.final.path ?? '/'}${
              p.final.queryKeys?.length ? `?${p.final.queryKeys.map((key) => `${key}=…`).join('&')}` : ''
            }`
          : 'an unknown page'
        this.push(view, {
          kind: 'note',
          ts,
          text: `browser ${p.actor === 'operator' ? 'operator opened' : 'opened'} ${url}`,
        })
        break
      }
      case 'browser/navigation-failed': {
        const p = payload as {
          actor?: 'agent' | 'operator'
          requested?: { scheme?: string; host?: string; port?: number; path?: string; queryKeys?: string[] }
          errorCode?: string
        }
        const url = p.requested
          ? `${p.requested.scheme ?? 'https'}://${p.requested.host ?? 'unknown'}${p.requested.port ? `:${p.requested.port}` : ''}${p.requested.path ?? '/'}${
              p.requested.queryKeys?.length ? `?${p.requested.queryKeys.map((key) => `${key}=…`).join('&')}` : ''
            }`
          : 'an unknown page'
        this.push(view, {
          kind: 'note',
          ts,
          text: `browser ${p.actor === 'operator' ? 'operator navigation' : 'navigation'} blocked for ${url}`,
        })
        break
      }
      // The hub confirming an "always allow" grant or its revoke. Without this the permission menu only
      // learned about grants on a full record resync, so a tool the operator had just allowed (or just
      // revoked) was missing from the list they were looking at.
      case 'session/tool-allowed':
      case 'session/tool-disallowed': {
        const p = payload as { toolName?: string; allowedTools?: string[] }
        if (p.allowedTools) view.record.allowedTools = p.allowedTools
        this.push(view, {
          kind: 'note',
          ts,
          text:
            kind === 'session/tool-allowed'
              ? `always allowing ${p.toolName} in this chat`
              : `${p.toolName} will ask again`,
        })
        break
      }
      // The hub confirming a per-chat model/effort/tier change. Replayed on reconnect too, so the pills
      // show the persisted truth after a reload or a hub restart — for either vendor.
      case 'session/settings': {
        const p = payload as { model?: string | null; effort?: string | null; serviceTier?: string | null }
        if (p.model !== undefined) view.record.model = p.model ?? undefined
        if (p.effort !== undefined) view.record.effort = p.effort ?? undefined
        if (p.serviceTier !== undefined) view.record.serviceTier = p.serviceTier ?? undefined
        break
      }
      case 'session/project-detached':
        view.record.projectId = undefined
        break
      case 'session/error':
        this.push(view, { kind: 'error', ts, text: (payload as { message: string }).message })
        // Also invalidate the last-turn verdict. Without this, a session-level failure left an EARLIER
        // success standing, so status() kept reporting the stale 'completed' from the previous turn while
        // a red error sat in the transcript.
        view.lastTurnOk = false
        break
      case 'session/worktree-created':
        this.push(view, { kind: 'note', ts, text: `worktree: ${(payload as { worktree: string }).worktree}` })
        break
      // A guardrail firing is the system WORKING, not the turn failing — the agent is told no and usually
      // carries on to succeed. These were rendered as red `error` items, which is a large part of why
      // errors appeared beside output that was perfectly fine. Kept clearly visible, but as notes.
      case 'approval/auto-denied-scope':
        this.push(view, {
          kind: 'note',
          ts,
          text: `⚠ scope guard denied ${(payload as { toolName: string }).toolName}: ${(payload as { reason: string }).reason}`,
        })
        break
      case 'approval/auto-denied-bus':
        this.push(view, {
          kind: 'note',
          ts,
          text: `⚠ bus-turn guard denied ${(payload as { toolName?: string }).toolName ?? 'a risky tool'} — a teammate-message turn can't write practices`,
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
      case 'claude/system':
        this.applyClaudeSystem(view, ts, payload)
        break
      case 'claude/result': {
        const p = payload as {
          is_error?: boolean
          subtype?: string
          result?: string
          errors?: string[]
          terminal_reason?: string
          model?: string
          total_cost_usd?: number
          modelUsage?: Record<string, { inputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; contextWindow?: number }>
        }
        // This used to be `if (p.is_error) push({kind:'error', text: p.result})`, which was wrong twice.
        //
        // 1. THE TEXT WAS ALWAYS EMPTY ON A REAL FAILURE. The SDK has two result shapes: SDKResultSuccess
        //    carries `result: string`, but SDKResultError carries `errors: string[]` and NO `result` field
        //    at all. So every genuine failure rendered a red card with nothing in it, while the actual
        //    reason sat unread in `errors`.
        // 2. AN INTENTIONAL INTERRUPT WAS PAINTED AS A FAILURE. Pressing stop ends the query with
        //    terminal_reason 'aborted_streaming' / 'aborted_tools'. That is the operator getting what they
        //    asked for, not an error — but is_error made it red and set lastTurnOk=false, so the chat
        //    showed a failure next to output that was fine.
        const interrupted = p.terminal_reason === 'aborted_streaming' || p.terminal_reason === 'aborted_tools'
        if (interrupted) {
          this.push(view, { kind: 'note', ts, text: 'interrupted' })
          // UNDEFINED, not true. `lastTurnOk` is a two-state flag standing in for a three-state outcome,
          // and status() renders idle+true as a green "completed" — so marking an interrupt as ok would
          // relabel a turn the operator deliberately cut short as successfully finished, trading one false
          // terminal state for another. Undefined falls through to "ready", which is the honest answer.
          // (The durable fix is an explicit completed|interrupted|failed outcome; this flag cannot hold it.)
          view.lastTurnOk = undefined
        } else if (p.is_error) {
          // Never render a blank error: prefer the structured reasons, then the success-shaped text, then
          // whatever the SDK told us about why the loop ended. Entries are trimmed and empties dropped —
          // `errors: ['']` is length-1, so a `??` chain would accept the empty string and still render a
          // blank card, which is the very bug this branch exists to prevent.
          const fromErrors = (p.errors ?? []).map((e) => String(e).trim()).filter(Boolean).join('\n')
          const text =
            fromErrors || p.result?.trim() || `turn failed (${p.terminal_reason ?? p.subtype ?? 'unknown error'})`
          this.push(view, { kind: 'error', ts, text })
          view.lastTurnOk = false
        } else {
          view.lastTurnOk = true
        }
        view.turnStartedAt = undefined
        if (typeof p.total_cost_usd === 'number') view.costUsd = (view.costUsd ?? 0) + p.total_cost_usd
        if (p.modelUsage) {
          // WINDOW ONLY. `modelUsage` is a per-turn AGGREGATE across every round-trip in the turn, so
          // using it as "context in use" summed each tool call's prompt on top of the last: a real
          // session displayed 4,333.7K against a 1M window — four times the entire context — and the
          // earlier 1562k/1000k was the same thing, smaller. It cannot even fall after a compaction,
          // because it is only written at end-of-turn and is a total rather than an occupancy.
          //
          // Actual occupancy comes from the LATEST assistant message's own usage (applyClaudeAssistant),
          // which is per-request and therefore bounded by the window by construction.
          //
          // Pick the MAIN CONVERSATION model, not max-used. A turn can involve a side model (haiku at
          // 200k alongside opus at 1M); max-picking happened to choose opus here, but a side model with
          // a larger aggregate would have selected the wrong window and quietly rescaled the meter.
          const main = p.model && p.modelUsage[p.model] ? p.modelUsage[p.model] : undefined
          const window = main?.contextWindow ?? Object.values(p.modelUsage).find((m) => m.contextWindow)?.contextWindow
          if (window) view.contextWindow = window
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
      case 'codex/turn/plan/updated': {
        // Codex 0.145 emits the whole current plan on every notification. Preserve every journaled
        // snapshot as a board-only item: TaskStrip gets both the latest state and its change history,
        // while the transcript does not gain a synthetic tool card the vendor never presented there.
        this.push(view, {
          kind: 'tool',
          ts,
          toolName: 'update_plan',
          toolInput: payload,
          taskBoardOnly: true,
        })
        break
      }
      case 'manager/task-assigned': {
        // Manager assignments are durable hub events on the child. Normalize them to the same pure
        // board reducer input as vendor task tools; taskBoardOnly keeps audit metadata out of chat prose.
        this.push(view, {
          kind: 'tool',
          ts,
          toolName: 'ManagerTask',
          toolInput: payload,
          taskBoardOnly: true,
        })
        break
      }
      case 'codex/turn/completed': {
        // Every codex turn ends here; turn.status distinguishes completed | interrupted | failed.
        //
        // `status === undefined` used to count as SUCCESS, so a malformed or unrecognised terminal event
        // rendered a green "completed" — the same false-green as the Claude interrupt path, reached by a
        // different route. Unknown is now neutral: it settles the turn without claiming it worked.
        const status = (payload as { turn?: { status?: string } }).turn?.status
        if (status === 'completed') view.lastTurnOk = true
        else if (status === 'failed') view.lastTurnOk = false
        else view.lastTurnOk = undefined // interrupted, or a status we do not recognise → neither
        view.turnStartedAt = undefined
        break
      }
      case 'codex/subagent/thread/started':
        this.applyCodexSubagentStarted(view, ts, payload)
        break
      case 'codex/subagent/thread/status/changed':
        this.applyCodexSubagentThreadStatus(view, ts, payload)
        break
      case 'codex/subagent/turn/started':
        this.applyCodexSubagentTurnStarted(view, ts, payload)
        break
      case 'codex/subagent/turn/completed':
        this.applyCodexSubagentTurnCompleted(view, ts, payload)
        break
      case 'codex/subagent/item/started':
        // A nested spawn must appear as soon as Codex announces it. Other in-progress child items wait
        // for item/completed, matching the root transcript's existing non-streaming tool-card behavior.
        this.applyCodexSpawnItem(view, ts, payload)
        break
      case 'codex/subagent/item/completed': {
        const p = payload as { agentThreadId?: string }
        this.applyCodexItem(view, ts, payload, p.agentThreadId)
        break
      }
      case 'codex/subagent/item/agentMessage/delta': {
        const p = payload as { agentThreadId?: string; itemId?: string; delta?: string }
        if (p.agentThreadId && p.itemId && typeof p.delta === 'string') {
          this.upsertCodexText(view, ts, p.itemId, p.delta, true, p.agentThreadId)
        }
        break
      }
      case 'session/tokens': {
        const p = payload as { input?: number; output?: number; total?: number }
        const sum = (p.input ?? 0) + (p.output ?? 0)
        view.liveTokens = { input: p.input, output: p.output, total: p.total ?? (sum > 0 ? sum : undefined) }
        break
      }
      case 'codex/item/started':
        // A completed collab spawn call only means Codex launched the child. It is never treated as the
        // child completing; real child lifecycle arrives on codex/subagent/turn/* or agentsStates.
        this.applyCodexSpawnItem(view, ts, payload)
        break
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
    const p = payload as {
      message?: {
        content?: ClaudeBlock[]
        usage?: {
          input_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }
      parent_tool_use_id?: string | null
      subagent_type?: string
      task_description?: string
    }
    // THE CONTEXT METER'S REAL SOURCE. Each assistant message carries the usage of the request that
    // produced it, so input + cache-read + cache-creation IS the prompt that was actually sent — current
    // occupancy, bounded by the window by construction. Taking the latest one means the meter tracks
    // reality, including falling after a compaction, which the previous end-of-turn aggregate could not
    // do at all (it only ever grew, and reached 4x the window on a real session).
    //
    // Cache-read is the bulk of it under prompt caching and is genuinely IN the context, so it must be
    // counted — the mirror-image mistake to the live counter below it, which drops those same fields and
    // therefore reads single digits.
    //
    // Only the MAIN thread: a sub-agent's usage is its own context, not this conversation's.
    const u = p.message?.usage
    if (u && p.parent_tool_use_id == null) {
      const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      if (used > 0) view.contextUsed = used
    }
    const content = p.message?.content
    if (!Array.isArray(content)) return
    // Sub-agent attribution off the envelope: anything produced inside a spawned agent carries the
    // spawning tool_use id (+ its type/task). Undefined here means "the main thread". Threaded onto every
    // item so the agent panel can group a run's activity without touching the hub.
    const agentId = p.parent_tool_use_id ?? undefined
    const subagentType = p.subagent_type
    const taskDescription = p.task_description
    let sawThinkingThisTurn = false
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        this.push(view, { kind: 'assistant', ts, text: block.text, agentId, subagentType, taskDescription })
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        view.sawReasoning = true
        sawThinkingThisTurn = true
        // Claude Code withholds reasoning text on subscription accounts (signature only),
        // so block.thinking is typically empty — render a "reasoned" marker, not fake text.
        this.push(view, { kind: 'thinking', ts, text: (block.thinking ?? '').trim(), agentId, subagentType, taskDescription })
      } else if (block.type === 'tool_use') {
        this.push(view, {
          kind: 'tool',
          ts,
          toolName: block.name,
          toolInput: block.input,
          toolUseId: block.id,
          agentId,
          subagentType,
          taskDescription,
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
          item.toolResultTs = ts // completion time — gives a spawned agent a real duration
        }
      }
    }
  }

  /**
   * The sub-agent lifecycle the UI used to invent.
   *
   * The hub has always forwarded EVERY SDK message as `claude/<type>`, so a sub-agent's real bookends have
   * been sitting in the journal the whole time — but they all arrive as `type: 'system'` with the meaning in
   * `payload.subtype`, and `apply()` dispatches on `kind`. With no `claude/system` case they fell straight
   * through `default: break`. This hub's journal holds 283 `task_started`, 437 `task_progress` and 280
   * `task_notification` rows that were written and then dropped on the floor.
   *
   * What the panel showed instead was inferred from the spawn's tool_result — which for a backgrounded
   * agent is a launch ACK, so every sub-agent read "done" the instant it started and the ack's internal
   * metadata was rendered as its report. The signal was never missing; it was never read.
   *
   * Merged ONTO THE SPAWN ITEM rather than pushed as new items: these are facts about a tool call we
   * already have (`tool_use_id` is the spawn's own id), exactly as `applyClaudeUser` merges the
   * tool_result. That keeps the transcript free of lifecycle noise and needs no new ItemKind. Safe because
   * `task_started` is journaled AFTER the assistant message carrying the tool_use block (verified: 9/9
   * spawns, 3-4 seq later), so the item always exists by the time these land.
   *
   * Background Bash tasks emit the same subtypes; they are self-filtering, since their `tool_use_id`
   * belongs to a Bash tool item and agentTree only ever reads these fields off an Agent/Task spawn.
   */
  private applyClaudeSystem(view: SessionView, ts: string, payload: unknown): void {
    const p = payload as {
      subtype?: string
      task_id?: string
      tool_use_id?: string
      status?: string
      summary?: string
      subagent_type?: string
      last_tool_name?: string
      usage?: { tool_uses?: number }
      patch?: { status?: string }
    }
    // `claude/system` is a firehose (this journal: ~5k `thinking_tokens` rows to 1k task rows). Bail before
    // touching items for everything that is not a task bookend.
    //
    // `background_tasks_changed` is deliberately NOT one of them. The SDK describes it as a level signal
    // carrying ids only — "do not correlate it with the edge stream" — and notes nothing is emitted at CLI
    // startup, so a snapshot replayed out of a journal can wedge a run as permanently live. The edge
    // stream below is the correlatable truth; a level we cannot reset would be worse than no signal.
    const st = p.subtype
    if (st !== 'task_started' && st !== 'task_progress' && st !== 'task_notification' && st !== 'task_updated') return

    // `tool_use_id` is present on nearly every row and is the direct key; `task_updated` never carries one
    // and a handful of `stopped` notifications omit it, so the task id learned from an earlier row is the
    // fallback. Without it, a killed agent would never lose its "running" dot.
    const item =
      (p.tool_use_id ? view.items.find((i) => i.key === `tool:${p.tool_use_id}`) : undefined) ??
      (p.task_id ? view.items.find((i) => i.agentTaskId === p.task_id) : undefined)
    if (!item) return

    if (p.task_id) item.agentTaskId = p.task_id
    if (st === 'task_started') {
      item.agentProgressTs = ts
      if (p.subagent_type) item.subagentType = p.subagent_type
      return
    }
    if (st === 'task_progress') {
      item.agentProgressTs = ts
      if (p.last_tool_name) item.agentLastTool = p.last_tool_name
      if (typeof p.usage?.tool_uses === 'number') item.agentToolUses = p.usage.tool_uses
      return
    }
    // Terminal. `task_notification.status` is the vendor's word; `task_updated.patch.status` is the same
    // fact on a wire-safe patch (and spells a kill `killed`). Only terminal values are applied — a patch
    // that merely says `running`/`paused` must never clear an outcome we already have.
    const raw = st === 'task_notification' ? p.status : p.patch?.status
    const outcome: AgentOutcome | undefined =
      raw === 'completed' ? 'completed' : raw === 'failed' ? 'failed' : raw === 'stopped' || raw === 'killed' ? 'stopped' : undefined
    if (!outcome) return
    item.agentOutcome = outcome
    item.agentOutcomeTs = ts
    // The vendor's summary IS the agent's report (thousands of characters of real findings on a completed
    // run) — the thing the launch-ack blob was standing in for.
    if (p.summary) item.agentSummary = p.summary
  }

  /** Create or enrich the synthetic Agent tool item consumed by the vendor-neutral agent tree. Its id is
   * the Codex CHILD THREAD id, because every item and lifecycle event from that child carries this id. */
  private upsertCodexSpawn(
    view: SessionView,
    ts: string,
    agentThreadId: string,
    parentAgentId: string | undefined,
    description: string | undefined,
    subagentType: string | undefined
  ): ThreadItem {
    const key = `tool:${agentThreadId}`
    let spawn = view.items.find((item) => item.key === key)
    const currentInput =
      spawn?.toolInput && typeof spawn.toolInput === 'object'
        ? (spawn.toolInput as Record<string, unknown>)
        : {}
    const toolInput: Record<string, unknown> = {
      ...currentInput,
      // spawnAgent is asynchronous by protocol. This drives only the panel's "background" chip; it is
      // never used as evidence that the child finished.
      run_in_background: true,
    }
    if (description) toolInput.description = description
    if (subagentType) toolInput.subagent_type = subagentType
    if (!spawn) {
      spawn = this.push(view, {
        kind: 'tool',
        ts,
        toolName: 'Agent',
        toolInput,
        toolUseId: agentThreadId,
        agentId: parentAgentId,
        subagentType,
        taskDescription: description,
        key,
      })
    } else {
      spawn.toolInput = toolInput
      if (parentAgentId) spawn.agentId = parentAgentId
      if (description) spawn.taskDescription = description
      if (subagentType) spawn.subagentType = subagentType
    }
    return spawn
  }

  /** Read a structured collab spawn item. The 0.145 generated bindings say `collabAgentToolCall`; the
   * bundled README still documents the previous `collabToolCall` spelling, so both meet here. */
  private applyCodexSpawnItem(view: SessionView, ts: string, payload: unknown): void {
    const p = payload as { threadId?: string; agentThreadId?: string; item?: Record<string, unknown> }
    const item = p.item
    if (!item || (item.type !== 'collabAgentToolCall' && item.type !== 'collabToolCall')) return
    const tool = item.tool
    if (tool !== 'spawnAgent' && tool !== 'spawn_agent') {
      this.applyCodexAgentStates(view, ts, item)
      return
    }
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string')
      : [item.newThreadId, item.receiverThreadId].filter((id): id is string => typeof id === 'string')
    const sender = typeof item.senderThreadId === 'string' ? item.senderThreadId : p.agentThreadId
    const parentAgentId = sender && sender !== p.threadId ? sender : undefined
    const description = typeof item.prompt === 'string' && item.prompt.trim() ? item.prompt : undefined
    for (const receiver of receivers) {
      this.upsertCodexSpawn(view, ts, receiver, parentAgentId, description, undefined).agentProgressTs = ts
    }
    // This is the target agents' structured state, not the spawn call's own status. A spawn call normally
    // completes while the child state is still running, which is precisely why item.status is ignored.
    this.applyCodexAgentStates(view, ts, item)
  }

  private applyCodexAgentStates(view: SessionView, ts: string, item: Record<string, unknown>): void {
    if (!item.agentsStates || typeof item.agentsStates !== 'object') return
    for (const [agentThreadId, value] of Object.entries(item.agentsStates as Record<string, unknown>)) {
      const state =
        value && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'string'
          ? (value as { status: string }).status
          : undefined
      const spawn = view.items.find((candidate) => candidate.key === `tool:${agentThreadId}`)
      if (!spawn || !state) continue
      if (state === 'pendingInit' || state === 'running') {
        spawn.agentOutcome = undefined
        spawn.agentOutcomeTs = undefined
        spawn.agentProgressTs = ts
      } else if (state === 'completed') {
        spawn.agentOutcome = 'completed'
        spawn.agentOutcomeTs = ts
      } else if (state === 'errored' || state === 'notFound') {
        spawn.agentOutcome = 'failed'
        spawn.agentOutcomeTs = ts
      } else if (state === 'interrupted' || state === 'shutdown') {
        spawn.agentOutcome = 'stopped'
        spawn.agentOutcomeTs = ts
      }
    }
  }

  private applyCodexSubagentStarted(view: SessionView, ts: string, payload: unknown): void {
    const p = payload as {
      threadId?: string
      agentThreadId?: string
      parentThreadId?: string
      thread?: { preview?: string; agentRole?: string; agentNickname?: string }
    }
    if (!p.agentThreadId) return
    const parentAgentId = p.parentThreadId && p.parentThreadId !== p.threadId ? p.parentThreadId : undefined
    const role = p.thread?.agentRole ?? p.thread?.agentNickname
    const spawn = this.upsertCodexSpawn(view, ts, p.agentThreadId, parentAgentId, p.thread?.preview, role)
    spawn.agentProgressTs = ts
  }

  private applyCodexSubagentThreadStatus(view: SessionView, ts: string, payload: unknown): void {
    const p = payload as { agentThreadId?: string; status?: { type?: string } }
    if (!p.agentThreadId) return
    const spawn = view.items.find((item) => item.key === `tool:${p.agentThreadId}`)
    if (!spawn) return
    if (p.status?.type === 'active') {
      spawn.agentOutcome = undefined
      spawn.agentOutcomeTs = undefined
      spawn.agentProgressTs = ts
    } else if (p.status?.type === 'systemError') {
      spawn.agentOutcome = 'failed'
      spawn.agentOutcomeTs = ts
    }
    // `idle` is not success: a child can be idle between sendInput calls. Only a completed turn or a
    // CollabAgentState supplies a terminal task outcome.
  }

  private applyCodexSubagentTurnStarted(view: SessionView, ts: string, payload: unknown): void {
    const p = payload as { threadId?: string; agentThreadId?: string; parentThreadId?: string }
    if (!p.agentThreadId) return
    const parentAgentId = p.parentThreadId && p.parentThreadId !== p.threadId ? p.parentThreadId : undefined
    const spawn = this.upsertCodexSpawn(view, ts, p.agentThreadId, parentAgentId, undefined, undefined)
    spawn.agentOutcome = undefined
    spawn.agentOutcomeTs = undefined
    spawn.agentProgressTs = ts
  }

  private applyCodexSubagentTurnCompleted(view: SessionView, ts: string, payload: unknown): void {
    const p = payload as {
      threadId?: string
      agentThreadId?: string
      parentThreadId?: string
      turn?: { id?: string; status?: string; error?: { message?: string } | null }
    }
    if (!p.agentThreadId) return
    const parentAgentId = p.parentThreadId && p.parentThreadId !== p.threadId ? p.parentThreadId : undefined
    const spawn = this.upsertCodexSpawn(view, ts, p.agentThreadId, parentAgentId, undefined, undefined)
    const status = p.turn?.status
    const outcome: AgentOutcome | undefined =
      status === 'completed'
        ? 'completed'
        : status === 'failed'
          ? 'failed'
          : status === 'interrupted'
            ? 'stopped'
            : undefined
    if (!outcome) return
    spawn.agentOutcome = outcome
    spawn.agentOutcomeTs = ts
    // Intentional parity boundary: Claude's task_notification includes a separate terminal `summary`;
    // Codex 0.145's child turn lifecycle does not. Its report is the ordinary agentMessage item stream
    // already attributed to this child, so copying a collab result/message here would duplicate output
    // and recreate the meaningless "returned blob" bug. The panel therefore shows Codex's real activity
    // and real terminal state, with no synthetic result block.
    if (outcome === 'failed') {
      const message = p.turn?.error?.message?.trim()
      if (message) {
        this.push(view, {
          kind: 'error',
          ts,
          text: message,
          agentId: p.agentThreadId,
          key: `codex:subagent-error:${p.turn?.id ?? p.agentThreadId}`,
        })
      }
    }
  }

  private applyCodexItem(view: SessionView, ts: string, payload: unknown, agentId?: string): void {
    const item = (payload as { item?: Record<string, unknown> }).item
    if (!item) return
    const type = item.type as string
    if (type === 'collabAgentToolCall' || type === 'collabToolCall') {
      this.applyCodexSpawnItem(view, ts, payload)
      return
    }
    if (type === 'subAgentActivity') {
      this.applyCodexSubagentActivity(view, ts, item, agentId)
      return
    }
    if (type === 'agentMessage') {
      // Same item id as the streamed deltas — replace, never duplicate.
      this.upsertCodexText(view, ts, item.id as string, (item.text as string) ?? '', false, agentId)
    } else if (type === 'reasoning') {
      if (!agentId) view.sawReasoning = true
      // The reasoning text lives in the item's `summary`/`content` ARRAYS, not a flat `text` — and the
      // app-server only fills them when the turn asked for a reasoning summary (see the adapter note in
      // codexGroup.ts / the report). extractCodexReasoning returns '' for a genuinely empty row, so the
      // UI shows an honest empty state instead of a "(reasoning)" placeholder that never gets content.
      // Keyed by the item id so a later item/started/completed for the same reasoning replaces, not dups.
      const rid = item.id as string | undefined
      this.push(view, {
        kind: 'reasoning',
        ts,
        text: extractCodexReasoning(item),
        agentId,
        key: rid ? `codex:reasoning:${rid}` : undefined,
      })
    } else if (type === 'userMessage') {
      // Ignored — the user's message is rendered from the canonical session/input event; echoing
      // Codex's own userMessage here too would duplicate it.
    } else if (type === 'commandExecution') {
      this.push(view, {
        kind: 'tool',
        ts,
        toolName: 'command',
        toolInput: item.command ?? item,
        toolResult: item.aggregatedOutput as string | undefined,
        agentId,
      })
    } else if (type === 'fileChange') {
      this.push(view, { kind: 'tool', ts, toolName: 'fileChange', toolInput: item, agentId })
    } else if (type === 'mcpToolCall') {
      this.push(view, {
        kind: 'tool',
        ts,
        toolName: `mcp:${String(item.tool ?? '')}`,
        toolInput: item,
        agentId,
      })
    }
  }

  /**
   * Codex 0.145's first parent/child edge is a completed `subAgentActivity` item on the PARENT thread.
   * It is lifecycle metadata, not transcript output, so merge it onto the synthetic spawn and never
   * render the item (or its path/id fields) as an agent report.
   *
   * The tagged source defines the meanings precisely: `started` follows spawn, `interacted` follows a
   * successful parent-to-child message/follow-up, and `interrupted` follows the interrupt operation.
   * There is deliberately no `completed` kind. Successful/failed completion therefore comes only from
   * the subscribed child's `turn/completed` or a structured CollabAgentState, never from text or timing.
   */
  private applyCodexSubagentActivity(
    view: SessionView,
    ts: string,
    item: Record<string, unknown>,
    parentAgentId: string | undefined
  ): void {
    const agentThreadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : undefined
    if (!agentThreadId) return
    const path = typeof item.agentPath === 'string' ? item.agentPath : undefined
    const pathLeaf = path?.split('/').filter(Boolean).at(-1)
    const description = pathLeaf?.replace(/[_-]+/g, ' ')
    const spawn = this.upsertCodexSpawn(view, ts, agentThreadId, parentAgentId, description, undefined)
    const kind = item.kind
    if (kind === 'started' || kind === 'interacted') {
      // A follow-up can legitimately restart an interrupted child, so this real communication edge makes
      // it working again. It is not completion: `interacted` means input was delivered, not work returned.
      spawn.agentOutcome = undefined
      spawn.agentOutcomeTs = undefined
      spawn.agentProgressTs = ts
    } else if (kind === 'interrupted') {
      spawn.agentOutcome = 'stopped'
      spawn.agentOutcomeTs = ts
    }
  }

  // Upsert a Codex agent message by its item id: streamed deltas (append) and the final
  // item/completed (replace) target the same item, so the message renders exactly once.
  private upsertCodexText(
    view: SessionView,
    ts: string,
    itemId: string,
    text: string,
    append: boolean,
    agentId?: string
  ): void {
    const key = `codex:${itemId}`
    const item = view.items.find((i) => i.key === key)
    if (item) {
      item.text = append ? (item.text ?? '') + text : text
      if (agentId) item.agentId = agentId
    } else this.push(view, { kind: 'assistant', ts, text, key, agentId })
  }

  private push(view: SessionView, item: Partial<ThreadItem> & { kind: ItemKind; ts: string }): ThreadItem {
    const complete = {
      key: item.key ?? `i${view.items.length}:${item.ts}`,
      replayed: item.replayed ?? this.applyingReplayedEvent,
      ...item,
    } as ThreadItem
    view.items.push(complete)
    return complete
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
    if (newestTs && (!view.record.lastActivity || newestTs > view.lastActivity)) {
      view.lastActivity = newestTs
      view.orderKey = newestTs // same correction-of-history case as session/activity above
    }
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
    this.projectViewId = null
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
    this.projectViewId = null
  }

  /**
   * Open the project-wide read model after a team launch. Keep the prior chat layout available through
   * Back, but never render it underneath the dashboard or make ProjectView pretend to be another pane.
   */
  openProjectView(projectId: string): void {
    if (this.selectedId || this.splitPanes.length) {
      this.lastLayout = { selectedId: this.selectedId, splitPanes: this.splitPanes.map((r) => [...r]) }
    }
    this.selectedId = null
    this.splitPanes = []
    this.projectViewId = projectId
  }

  goBack(): void {
    if (!this.lastLayout) return
    this.projectViewId = null
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
    this.autoRestorePending = false // an explicit dismissal must not be overridden by the auto-reopen
  }

  // --- Auto-reopen the last layout ---------------------------------------------------------------
  // Armed in init(), fired from ensure() once the WS replay has actually delivered sessions. Debounced
  // so we restore against the WHOLE roster rather than whichever session happened to arrive first.
  private autoRestorePending = false
  private autoRestoreTimer: ReturnType<typeof setTimeout> | null = null

  private scheduleAutoRestore(attempt = 0): void {
    if (!this.autoRestorePending || this.autoRestoreTimer) return
    this.autoRestoreTimer = setTimeout(() => {
      this.autoRestoreTimer = null
      if (!this.autoRestorePending) return
      // Never override a chat the operator already opened themselves during startup.
      if (this.selectedId || this.splitPanes.length) {
        this.autoRestorePending = false
        return
      }
      if (this.restorableLayout && Object.keys(this.sessions).length > 0) {
        this.autoRestorePending = false
        this.restoreLastLayout()
        return
      }
      // Roster not populated yet. RETRY rather than waiting to be nudged: sessions can arrive from the WS
      // replay, a roster fetch, or the fleet merge, and tying the trigger to one of those paths is what
      // made the first two attempts at this silently never fire. ~10s of retries, then give up and leave
      // the manual "Reopen" offer intact.
      if (attempt < 40) this.scheduleAutoRestore(attempt + 1)
      else this.autoRestorePending = false
    }, 250)
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
    if (base.length === 0) {
      // From the dashboard there is nothing to split — just open the chat.
      this.selectedId = id
      this.splitPanes = []
      return
    }

    // An ID already present in the grid is a MOVE, never a copy. Drop zones are measured against the
    // frozen PRE-MOVE geometry, so remove the source first and compensate indexes for any row / column
    // that disappeared. New IDs still follow the same insertion path below.
    let source: { r: number; c: number } | null = null
    for (let r = 0; r < base.length && !source; r++) {
      const c = base[r]!.indexOf(id)
      if (c >= 0) source = { r, c }
    }

    const rows = base.map((r) => [...r])
    if (source) {
      // A one-pane row dropped into its own column can only describe its current position.
      if (zone.kind === 'col' && zone.row === source.r && rows[source.r]!.length === 1) return
      rows[source.r]!.splice(source.c, 1)
    }

    if (zone.kind === 'row') {
      let at = Math.max(0, Math.min(zone.row, base.length))
      if (source && rows[source.r]!.length === 0) {
        rows.splice(source.r, 1)
        if (source.r < at) at--
      }
      at = Math.max(0, Math.min(at, rows.length))
      rows.splice(at, 0, [id])
    } else {
      let r = Math.max(0, Math.min(zone.row, base.length - 1))
      let at = zone.col
      if (source?.r === r && at > source.c) at--
      if (source && rows[source.r]!.length === 0) {
        rows.splice(source.r, 1)
        if (source.r < r) r--
      }
      r = Math.max(0, Math.min(r, rows.length - 1))
      const row = rows[r]!
      at = Math.max(0, Math.min(at, row.length))
      row.splice(at, 0, id)
    }

    // Retain the exact array identity for a self-drop: no pane remount, transition flicker or redundant
    // persistence write when the normalised destination is the position the pane already occupies.
    if (
      source &&
      rows.length === base.length &&
      rows.every((row, r) => row.length === base[r]!.length && row.every((pane, c) => pane === base[r]![c]))
    ) return
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
