/**
 * Pure planning for old completed-turn rollups.
 *
 * The browser currently has no independent read model for hub-native history: it rebuilds a chat by
 * replaying these event shapes. A physical archive would therefore make old chats disappear for both the
 * current client and a rolled-back hub. This module instead projects noisy completed turns back into the
 * SAME old-client-readable shapes: prose stays prose, while tool/reasoning detail becomes one explicit
 * commandExecution card whose label says that no command was executed.
 *
 * Keeping this pure is deliberate. JSON parsing and string reduction happen in the one-shot maintenance
 * child, outside SQLite's writer transaction; the transaction only applies the already-bounded plan.
 */

export interface JournalHistoryRow {
  seq: number
  ts: string
  session: string
  kind: string
  payload: string
  wseq: number | null
}

export interface JournalHistoryUpdate {
  seq: number
  expectedPayload: string
  payload: string
}

export interface JournalHistoryRollup {
  seq: number
  ts: string
  payload: string
}

export interface JournalHistoryPlan {
  deleteSeqs: number[]
  updates: JournalHistoryUpdate[]
  rollup?: JournalHistoryRollup
  payloadBytesSelected: number
  payloadBytesWritten: number
}

export interface JournalHistoryPlanOptions {
  maxToolTextChars: number
  maxRollupChars: number
  /** Current-state rows that must survive even when they fall inside this old turn. */
  protectedSeqs?: ReadonlySet<number>
}

type JsonObject = Record<string, unknown>

type ToolSummary = {
  id: string
  name: string
  input?: unknown
  result?: unknown
  error?: boolean
  status?: string
  progress?: string
}

type DeltaMessage = {
  seqs: number[]
  firstRow: JournalHistoryRow
  text: string
  completed: boolean
}

const CLAUDE_TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_notification', 'task_updated'])
const CLAUDE_SYSTEM_ROLLUP_SUBTYPES = new Set([
  ...CLAUDE_TASK_SUBTYPES,
  'post_turn_summary',
  'background_tasks_changed',
  'vcs_state_changed',
  'compact_boundary',
  'hook_started',
  'hook_progress',
  'hook_response',
])
const CLAUDE_SYSTEM_TELEMETRY_SUBTYPES = new Set(['thinking_tokens', 'init', 'status'])

function object(value: unknown): JsonObject | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function parseObject(raw: string): JsonObject | undefined {
  try {
    return object(JSON.parse(raw) as unknown)
  } catch {
    // A malformed durable row must fail closed. Journal.since() will surface its __unreadable marker; a
    // maintenance pass must never turn "cannot prove what this was" into "safe to delete".
    return undefined
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function clip(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text
  const marker = `\n\n[AllMyAgents history rollup: ${text.length - maxChars} ${label} characters omitted]\n\n`
  const remaining = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(remaining / 2)
  const tail = Math.floor(remaining / 2)
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ''}`
}

function compactJson(value: unknown): unknown {
  // JSON.parse/stringify also strips prototypes and undefined fields. Inputs came from already-redacted
  // journal JSON; this does not reach back to an unredacted vendor object.
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return String(value)
  }
}

function compactClaudeAssistantPayload(payload: JsonObject, content: unknown[]): string {
  const next: JsonObject = { message: { content } }
  for (const key of ['parent_tool_use_id', 'subagent_type', 'task_description'] as const) {
    if (payload[key] !== undefined) next[key] = payload[key]
  }
  return JSON.stringify(next)
}

function compactClaudeResultPayload(payload: JsonObject): string {
  const next: JsonObject = {}
  for (const key of [
    'is_error',
    'subtype',
    'errors',
    'terminal_reason',
    'total_cost_usd',
    'modelUsage',
  ] as const) {
    if (payload[key] !== undefined) next[key] = payload[key]
  }
  // Successful `result` repeats assistant prose already retained in claude/assistant. On an error it is a
  // UI fallback after `errors`, so keep it only there.
  if (payload.is_error === true && payload.result !== undefined) next.result = payload.result
  return JSON.stringify(next)
}

function compactClaudeBlock(block: JsonObject): JsonObject {
  const type = asString(block.type)
  if (type === 'text') return { type, ...(block.text !== undefined ? { text: block.text } : {}) }
  if (type === 'thinking' || type === 'redacted_thinking') {
    return { type, ...(block.thinking !== undefined ? { thinking: block.thinking } : {}) }
  }
  // Unknown future block types fail safe: retain them byte-for-byte at the semantic JSON level.
  return block
}

function toolId(item: JsonObject, fallback: string): string {
  return asString(item.id) ?? asString(item.tool_use_id) ?? fallback
}

function codexToolName(item: JsonObject): string {
  const type = asString(item.type) ?? 'item'
  if (type === 'commandExecution') return 'command'
  if (type === 'mcpToolCall') return `mcp:${asString(item.tool) ?? asString(item.server) ?? 'tool'}`
  if (type === 'fileChange') return 'fileChange'
  if (type === 'webSearch') return 'webSearch'
  return type
}

function codexToolInput(item: JsonObject): unknown {
  const type = asString(item.type)
  if (type === 'commandExecution') return item.command ?? item
  if (type === 'mcpToolCall') return item.arguments ?? item
  if (type === 'webSearch') return item.query ?? item.action ?? item
  return item
}

function codexToolResult(item: JsonObject): unknown {
  const type = asString(item.type)
  if (type === 'commandExecution') return item.aggregatedOutput
  if (type === 'mcpToolCall') return item.result ?? item.error
  if (type === 'webSearch') return item.results
  return undefined
}

function makeRollupPayload(
  terminalSeq: number,
  terminalKind: string,
  tools: ToolSummary[],
  reasoning: string[],
  finalDiff: string | undefined,
  maxToolTextChars: number,
  maxRollupChars: number
): string | undefined {
  if (tools.length === 0 && reasoning.length === 0 && finalDiff == null) return undefined

  const lines = [
    'AllMyAgents history rollup.',
    'This card is a compact record of an old completed turn; NO COMMAND WAS EXECUTED by this card.',
    `Terminal: ${terminalKind} at journal seq ${terminalSeq}.`,
  ]

  if (tools.length > 0) {
    lines.push('', `Tools (${tools.length}):`)
    tools.forEach((tool, index) => {
      lines.push(`${index + 1}. ${tool.name}${tool.status ? ` [${tool.status}]` : ''}`)
      if (tool.input !== undefined) {
        lines.push('input:', clip(printable(tool.input), maxToolTextChars, 'input'))
      }
      if (tool.result !== undefined) {
        lines.push(
          tool.error ? 'error result:' : 'result:',
          clip(printable(tool.result), maxToolTextChars, 'result')
        )
      }
      if (tool.progress) lines.push(`lifecycle: ${tool.progress}`)
    })
  }
  if (reasoning.length > 0) {
    lines.push('', `Reasoning/detail records (${reasoning.length}):`)
    reasoning.forEach((entry, index) => lines.push(`${index + 1}. ${clip(entry, maxToolTextChars, 'detail')}`))
  }
  if (finalDiff != null) {
    lines.push('', 'Final cumulative diff:', clip(finalDiff, maxToolTextChars, 'diff'))
  }

  const output = clip(lines.join('\n'), maxRollupChars, 'rollup')
  return JSON.stringify({
    threadId: 'allmyagents-history',
    turnId: `history-rollup:${terminalSeq}`,
    item: {
      id: `history-rollup:${terminalSeq}`,
      type: 'commandExecution',
      command: `AllMyAgents history rollup (${tools.length} tool(s), ${reasoning.length} detail record(s); no command executed)`,
      aggregatedOutput: output,
      status: 'completed',
      exitCode: 0,
    },
    __allmyagentsHistoryRollup: true,
  })
}

/**
 * Produce an atomic rewrite plan for one session's events from immediately after its previous terminal
 * through an old terminal (inclusive). Unknown and malformed rows remain untouched.
 */
export function planCompletedTurnHistory(
  rows: JournalHistoryRow[],
  terminalSeq: number,
  terminalKind: string,
  options: JournalHistoryPlanOptions
): JournalHistoryPlan {
  const deleteSeqs = new Set<number>()
  const auditSeqs = new Set<number>()
  const updates: JournalHistoryUpdate[] = []
  const tools = new Map<string, ToolSummary>()
  const toolOrder: string[] = []
  const reasoning: string[] = []
  const deltaMessages = new Map<string, DeltaMessage>()
  let finalDiff: string | undefined

  const getTool = (id: string, name = 'tool'): ToolSummary => {
    let tool = tools.get(id)
    if (!tool) {
      tool = { id, name }
      tools.set(id, tool)
      toolOrder.push(id)
    } else if (tool.name === 'tool' && name !== 'tool') {
      tool.name = name
    }
    return tool
  }

  for (const row of rows) {
    const payload = parseObject(row.payload)
    if (!payload) continue
    if (row.seq === terminalSeq) {
      if (row.kind === 'claude/result') {
        const encoded = compactClaudeResultPayload(payload)
        if (encoded !== row.payload) updates.push({ seq: row.seq, expectedPayload: row.payload, payload: encoded })
      }
      continue
    }

    if (row.kind === 'codex/item/agentMessage/delta') {
      const itemId = asString(payload.itemId)
      const delta = asString(payload.delta)
      if (!itemId || delta == null) continue
      const existing = deltaMessages.get(itemId)
      if (existing) {
        existing.seqs.push(row.seq)
        existing.text += delta
      } else {
        deltaMessages.set(itemId, { seqs: [row.seq], firstRow: row, text: delta, completed: false })
      }
      continue
    }

    if (row.kind === 'codex/item/completed') {
      const item = object(payload.item)
      if (!item) continue
      const type = asString(item.type)
      const id = toolId(item, `codex:${row.seq}`)
      if (type === 'agentMessage') {
        const delta = deltaMessages.get(id)
        if (delta) delta.completed = true
        // The final agentMessage is the authoritative prose replacement and remains an ordinary event.
        continue
      }
      if (type === 'userMessage') {
        // session/input is the canonical, timestamped operator message; the vendor echo is invisible in
        // the current client and would duplicate it if retained as history.
        deleteSeqs.add(row.seq)
        continue
      }
      if (type === 'reasoning') {
        const text = asString(item.text) ?? printable(item.summary ?? '(reasoned)')
        reasoning.push(text)
        deleteSeqs.add(row.seq)
        auditSeqs.add(row.seq)
        continue
      }
      const tool = getTool(id, codexToolName(item))
      tool.input = compactJson(codexToolInput(item))
      const result = codexToolResult(item)
      if (result !== undefined) tool.result = compactJson(result)
      tool.error = item.error != null || item.status === 'failed'
      tool.status = asString(item.status)
      deleteSeqs.add(row.seq)
      auditSeqs.add(row.seq)
      continue
    }

    if (row.kind === 'codex/item/started') {
      const item = object(payload.item)
      if (!item) continue
      const id = toolId(item, `codex:${row.seq}`)
      const type = asString(item.type)
      if (type === 'agentMessage' || type === 'userMessage') {
        deleteSeqs.add(row.seq)
        continue
      }
      const tool = getTool(id, codexToolName(item))
      tool.input ??= compactJson(codexToolInput(item))
      tool.status ??= 'started'
      deleteSeqs.add(row.seq)
      auditSeqs.add(row.seq)
      continue
    }

    if (row.kind === 'codex/item/commandExecution/outputDelta') {
      const id = asString(payload.itemId)
      const delta = asString(payload.delta)
      if (!id || delta == null) continue
      const tool = getTool(id, 'command')
      tool.result = `${typeof tool.result === 'string' ? tool.result : ''}${delta}`
      deleteSeqs.add(row.seq)
      auditSeqs.add(row.seq)
      continue
    }

    if (row.kind === 'codex/turn/diff/updated') {
      const value = payload.diff
      if (value !== undefined) finalDiff = printable(value)
      deleteSeqs.add(row.seq)
      auditSeqs.add(row.seq)
      continue
    }

    if (row.kind === 'claude/assistant') {
      const message = object(payload.message)
      const content = message?.content
      if (!Array.isArray(content)) continue
      const kept: unknown[] = []
      let changed = false
      for (let index = 0; index < content.length; index += 1) {
        const block = object(content[index])
        if (block?.type !== 'tool_use') {
          kept.push(block ? compactClaudeBlock(block) : content[index])
          continue
        }
        changed = true
        const id = asString(block.id) ?? `claude:${row.seq}:${index}`
        const tool = getTool(id, asString(block.name) ?? 'tool')
        tool.input = compactJson(block.input)
        auditSeqs.add(row.seq)
      }
      if (kept.length === 0) {
        if (changed) deleteSeqs.add(row.seq)
      } else {
        const encoded = compactClaudeAssistantPayload(payload, kept)
        if (encoded !== row.payload) updates.push({ seq: row.seq, expectedPayload: row.payload, payload: encoded })
      }
      continue
    }

    if (row.kind === 'claude/user') {
      const message = object(payload.message)
      const content = message?.content
      if (!Array.isArray(content)) continue
      const kept: unknown[] = []
      let changed = false
      for (let index = 0; index < content.length; index += 1) {
        const block = object(content[index])
        if (block?.type !== 'tool_result') {
          kept.push(content[index])
          continue
        }
        changed = true
        const id = asString(block.tool_use_id) ?? `claude-result:${row.seq}:${index}`
        const tool = getTool(id)
        tool.result = compactJson(block.content)
        tool.error = block.is_error === true
        auditSeqs.add(row.seq)
      }
      if (!changed) continue
      if (kept.length === 0) {
        deleteSeqs.add(row.seq)
      } else {
        const next = {
          ...payload,
          message: {
            ...message,
            content: kept,
          },
        }
        const encoded = JSON.stringify(next)
        if (encoded !== row.payload) updates.push({ seq: row.seq, expectedPayload: row.payload, payload: encoded })
      }
      continue
    }

    if (row.kind === 'claude/system') {
      const subtype = asString(payload.subtype)
      if (subtype && CLAUDE_TASK_SUBTYPES.has(subtype)) {
        const id = asString(payload.tool_use_id)
        if (id) {
          const tool = getTool(id)
          const status = asString(payload.status) ?? asString(object(payload.patch)?.status)
          const lastTool = asString(payload.last_tool_name)
          const summary = asString(payload.summary)
          tool.progress = [subtype, status, lastTool, summary].filter(Boolean).join(' · ')
          auditSeqs.add(row.seq)
        } else {
          // task_updated does not always carry tool_use_id. Keep the fact in the generic detail section
          // instead of throwing away an unpaired lifecycle edge.
          reasoning.push(`claude/system/${subtype}: ${printable(payload)}`)
          auditSeqs.add(row.seq)
        }
      }
      if (subtype && CLAUDE_SYSTEM_ROLLUP_SUBTYPES.has(subtype)) {
        if (!CLAUDE_TASK_SUBTYPES.has(subtype)) {
          reasoning.push(`claude/system/${subtype}: ${printable(payload)}`)
          auditSeqs.add(row.seq)
        }
        deleteSeqs.add(row.seq)
      } else if (subtype && CLAUDE_SYSTEM_TELEMETRY_SUBTYPES.has(subtype)) {
        // These are known non-transcript snapshots/counters. Unknown future subtypes deliberately remain:
        // sharing the `claude/system` envelope is not enough evidence that a new payload is disposable.
        deleteSeqs.add(row.seq)
      }
      continue
    }

    if (
      row.kind === 'claude/tool_progress' ||
      row.kind === 'claude/rate_limit_event' ||
      row.kind === 'claude/stream_event' ||
      row.kind === 'codex/thread/status/changed' ||
      row.kind === 'codex/account/rateLimits/updated' ||
      row.kind === 'codex/serverRequest/resolved'
    ) {
      // Completed-turn telemetry: neither transcript nor current authority. Unknown kinds intentionally
      // do not enter this branch, so a new vendor event fails safe by remaining durable.
      deleteSeqs.add(row.seq)
    }

    if (row.kind === 'codex/thread/tokenUsage/updated' || row.kind === 'session/tokens') {
      if (!options.protectedSeqs?.has(row.seq)) deleteSeqs.add(row.seq)
      continue
    }

    if (
      row.kind === 'codex/request/mcpServer/elicitation/request' ||
      row.kind === 'codex/request/item/commandExecution/requestApproval' ||
      row.kind === 'codex/request/item/fileChange/requestApproval' ||
      row.kind === 'codex/request/item/tool/call' ||
      row.kind === 'approval/auto-approved' ||
      row.kind === 'codex/stderr' ||
      row.kind === 'codex/turn/plan/updated'
    ) {
      reasoning.push(`${row.kind}: ${printable(payload)}`)
      deleteSeqs.add(row.seq)
      auditSeqs.add(row.seq)
      continue
    }

    if (
      row.kind === 'codex/mcpServer/startupStatus/updated' ||
      row.kind === 'codex/remoteControl/status/changed'
    ) {
      deleteSeqs.add(row.seq)
    }
  }

  for (const [itemId, message] of deltaMessages) {
    if (message.completed) {
      message.seqs.forEach((seq) => deleteSeqs.add(seq))
      continue
    }
    // Interrupted Codex turns can have deltas but no completed agentMessage. Preserve the visible partial
    // prose by coalescing it into the first delta, never by treating "no terminal item" as disposable.
    const firstPayload = parseObject(message.firstRow.payload)
    if (!firstPayload) continue
    const encoded = JSON.stringify({ ...firstPayload, itemId, delta: message.text })
    if (encoded !== message.firstRow.payload) {
      updates.push({
        seq: message.firstRow.seq,
        expectedPayload: message.firstRow.payload,
        payload: encoded,
      })
    }
    message.seqs.slice(1).forEach((seq) => deleteSeqs.add(seq))
  }

  const orderedTools = toolOrder.map((id) => tools.get(id)).filter((tool): tool is ToolSummary => tool != null)
  const rollupPayload = makeRollupPayload(
    terminalSeq,
    terminalKind,
    orderedTools,
    reasoning,
    finalDiff,
    options.maxToolTextChars,
    options.maxRollupChars
  )
  // Reuse the sequence of a row that is already being removed. That keeps the rollup at the exact
  // historical position even for old clients. A mixed Claude assistant row (text + tool_use) is updated,
  // not deleted, so it is not a legal slot. If an interrupted tool has no result/system row and therefore
  // offers no removable slot, fail closed: retain the original audit-bearing rows rather than moving the
  // tool card to today's tail and lying about chronology.
  const rollupSeq =
    rollupPayload == null
      ? undefined
      : [...auditSeqs].filter((seq) => deleteSeqs.has(seq)).sort((a, b) => a - b)[0]
  if (rollupPayload != null && rollupSeq == null) {
    for (const seq of auditSeqs) deleteSeqs.delete(seq)
    return {
      deleteSeqs: [...deleteSeqs].sort((a, b) => a - b),
      updates: [],
      payloadBytesSelected: rows
        .filter((row) => deleteSeqs.has(row.seq))
        .reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0),
      payloadBytesWritten: 0,
    }
  }
  if (rollupSeq != null) deleteSeqs.add(rollupSeq)
  const rollupRow = rollupSeq == null ? undefined : rows.find((row) => row.seq === rollupSeq)
  const rollup =
    rollupPayload != null && rollupSeq != null && rollupRow
      ? { seq: rollupSeq, ts: rollupRow.ts, payload: rollupPayload }
      : undefined

  let payloadBytesSelected = 0
  for (const row of rows) {
    if (deleteSeqs.has(row.seq)) payloadBytesSelected += Buffer.byteLength(row.payload)
  }
  const payloadBytesWritten =
    (rollup ? Buffer.byteLength(rollup.payload) : 0) +
    updates.reduce((sum, update) => sum + Buffer.byteLength(update.payload), 0)

  return {
    deleteSeqs: [...deleteSeqs].sort((a, b) => a - b),
    updates,
    rollup,
    payloadBytesSelected,
    payloadBytesWritten,
  }
}
