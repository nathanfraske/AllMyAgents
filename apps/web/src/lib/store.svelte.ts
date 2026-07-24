import { api } from './api'
import type { ApprovalRecord, HubEvent, ProfileInfo, SessionRecord, UsageSnapshot } from './api'

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
  contextUsed?: number
  contextWindow?: number
  costUsd?: number
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
  sessions = $state<Record<string, SessionView>>({})
  approvals = $state<ApprovalRecord[]>([])
  usage = $state<UsageSnapshot[]>([])
  connected = $state(false)
  selectedId = $state<string | null>(null)
  lastSeq = 0

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
    await this.refreshSideData()
    this.connect()
  }

  async refreshSideData(): Promise<void> {
    this.approvals = await api.approvals()
    this.usage = await api.usage()
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

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws?since=0`)
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
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws?since=${this.lastSeq}`)
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
        const p = payload as { usage?: { total_tokens?: number; input_tokens?: number }; contextWindow?: number; modelContextWindow?: number }
        const used = p.usage?.total_tokens ?? p.usage?.input_tokens
        const win = p.contextWindow ?? p.modelContextWindow
        if (typeof used === 'number') view.contextUsed = used
        if (typeof win === 'number') view.contextWindow = win
        break
      }
      case 'codex/item/completed':
        this.applyCodexItem(view, ts, payload)
        break
      case 'codex/item/agentMessage/delta':
        this.appendDelta(view, ts, (payload as { delta: string }).delta)
        break
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
      } else if (block.type === 'thinking') {
        view.sawReasoning = true
        sawThinkingThisTurn = true
        this.push(view, { kind: 'thinking', ts, text: block.thinking || '(redacted by API — thinking not enabled)' })
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
      const id = item.id as string
      const existing = view.items.find((i) => i.key === `codex:${id}`)
      const text = (item.text as string) ?? ''
      if (existing) existing.text = text
      else this.push(view, { kind: 'assistant', ts, text, key: `codex:${id}` })
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

  private appendDelta(view: SessionView, ts: string, delta: string): void {
    const last = view.items[view.items.length - 1]
    if (last && last.kind === 'assistant') last.text = (last.text ?? '') + delta
    else this.push(view, { kind: 'assistant', ts, text: delta })
  }

  private push(view: SessionView, item: Partial<ThreadItem> & { kind: ItemKind; ts: string }): void {
    view.items.push({ key: item.key ?? `i${view.items.length}:${item.ts}`, ...item } as ThreadItem)
  }

  select(id: string): void {
    this.selectedId = id
  }
}

export const store = new HubStore()
