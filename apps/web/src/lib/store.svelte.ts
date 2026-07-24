import { api, HUB_WS } from './api'
import { settings } from './settings.svelte'
import type { ApprovalRecord, HubEvent, ProfileInfo, ProjectInfo, SessionRecord, UsageSnapshot } from './api'

export interface StatusInfo {
  key: string
  label: string
}

export type ItemKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'reasoning' | 'status' | 'error' | 'note'

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

class HubStore {
  profiles = $state<ProfileInfo[]>([])
  projects = $state<ProjectInfo[]>([])
  sessions = $state<Record<string, SessionView>>({})
  approvals = $state<ApprovalRecord[]>([])
  usage = $state<UsageSnapshot[]>([])
  connected = $state(false)
  selectedId = $state<string | null>(null)
  settingsOpen = $state(false)
  queues = $state<Record<string, string[]>>({})
  lastSeq = 0

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
    void api.send(sessionId, toSend)
  }

  private ws: WebSocket | null = null

  get sessionList(): SessionView[] {
    return Object.values(this.sessions).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  }

  get selected(): SessionView | null {
    return this.selectedId ? (this.sessions[this.selectedId] ?? null) : null
  }

  get pendingBySession(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const a of this.approvals) out[a.sessionId] = (out[a.sessionId] ?? 0) + 1
    return out
  }

  async init(): Promise<void> {
    this.profiles = await api.profiles()
    this.projects = await api.projects()
    await this.refreshSideData()
    this.connect()
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

  // Guards against a second spawn while one is in flight — rapid + clicks were creating
  // multiple agents. Not $state; it's a control flag, not rendered.
  private creating = false

  // Open an empty chat immediately — no prompt up front; the composer configures the rest.
  // Applies the user's settings defaults (permission mode, default model per provider).
  async newSession(profileId?: string, projectId?: string): Promise<void> {
    if (this.creating) return
    const pid = profileId ?? this.defaultProfileId()
    if (!pid) {
      this.settingsOpen = true
      return
    }
    this.creating = true
    try {
      const profile = this.profiles.find((p) => p.id === pid)
      const model = profile?.provider === 'codex' ? settings.defaultCodexModel : settings.defaultClaudeModel
      const body: Record<string, unknown> = { profileId: pid, permissionMode: settings.defaultPermissionMode }
      if (projectId) body.projectId = projectId
      if (model) body.model = model
      const out = await api.spawn(body)
      if (out && !('error' in out)) {
        // Seed the view optimistically so we navigate to the new chat right away instead of
        // racing the session/created event (that race was the "didn't take me there" symptom).
        this.ensure(out as SessionRecord)
        this.lastProfileId = pid
        this.select((out as { id: string }).id)
      } else if (out && 'error' in out) {
        alert(out.error)
      }
    } finally {
      this.creating = false
    }
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
      alert(out.error)
    }
  }

  async refreshProjects(): Promise<void> {
    this.projects = await api.projects()
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

  // Optimistically mark a turn as started the instant the user sends — immediate "received /
  // thinking" feedback, before the hub's first status event lands. Resets the live token count.
  noteSent(sessionId: string): void {
    const v = this.sessions[sessionId]
    if (!v) return
    v.turnStartedAt = Date.now()
    v.liveTokens = undefined
  }

  // Delete a chat: tell the hub (which stops it + writes a tombstone), then drop it locally.
  async deleteSession(id: string): Promise<void> {
    await api.deleteSession(id).catch(() => undefined)
    this.removeSessionLocal(id)
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
    const view: SessionView = { record, items: [], lastActivity: record.createdAt, sawReasoning: false }
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

  private connect(): void {
    const ws = new WebSocket(`${this.wsBase()}/ws?since=0`)
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
    }
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data as string) as HubEvent
      this.apply(event)
    }
    ws.onclose = () => {
      this.connected = false
      setTimeout(() => this.reconnect(), 1500)
    }
  }

  private reconnect(): void {
    const ws = new WebSocket(`${this.wsBase()}/ws?since=${this.lastSeq}`)
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
    }
    ws.onmessage = (e) => this.apply(JSON.parse(e.data as string) as HubEvent)
    ws.onclose = () => {
      this.connected = false
      setTimeout(() => this.reconnect(), 1500)
    }
  }

  private apply(event: HubEvent): void {
    if (event.seq <= this.lastSeq) return
    this.lastSeq = event.seq
    const { sessionId, kind, ts, payload } = event

    if (kind === 'approval/requested' || kind === 'approval/resolved') {
      void this.refreshSideData()
    }
    if (kind.startsWith('usage/')) {
      void this.refreshSideData()
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
      // event for a session we haven't seen created yet — fetch the roster lazily
      void api.sessions().then((list) => {
        for (const r of list) this.ensure(r)
      })
      return
    }

    switch (kind) {
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
    this.touch(view, ts)
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
      this.push(view, { kind: 'user', ts, text: asText(item.content) })
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

  select(id: string): void {
    this.selectedId = id
    // In split mode, selecting from the sidebar drives the first (primary) pane (row 0, col 0).
    if (this.splitPanes.length) {
      const rows = this.splitPanes.map((r) => [...r])
      if (rows[0] && rows[0].length) rows[0][0] = id
      else rows.unshift([id])
      this.splitPanes = rows
    }
  }

  // --- Split / multi-pane layout (2D) ---
  // The main area is a vertical stack of ROWS; each row is a horizontal set of panes
  // (COLUMNS). `splitPanes` is therefore rows-of-session-ids. Empty = not split (a single
  // pane derived from `selectedId`); the single-row case reproduces the old horizontal split.
  splitPanes = $state<string[][]>([])
  lastLayout = $state<{ selectedId: string | null; splitPanes: string[][] } | null>(null)

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
    const base = this.basePanes()
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
    const other = this.sessionList.find((v) => !flat.includes(v.record.id))?.record.id ?? flat[flat.length - 1]
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
    rows[co.r]!.splice(co.c, 1)
    this.commit(rows)
  }
}

export const store = new HubStore()

// Dev-only handle for debugging/automation in the browser console.
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as { __hubStore: HubStore }).__hubStore = store
}
