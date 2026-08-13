import { attachmentsFromPayload } from './attachments'
import { extractCodexReasoning } from './codexGroup'
import type { HubEvent } from './api'
import type { ThreadItem } from './store.svelte'

export const JOURNAL_HISTORY_MAX_LOGICAL_ITEMS = 80

type ClaudeBlock = {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content
    .map((part) =>
      typeof part === 'string'
        ? part
        : typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : JSON.stringify(part),
    )
    .join('\n')
}

/**
 * Pure transcript projection for one bounded journal-history page.
 *
 * It intentionally has no store/API/timer/queue access. Control-plane state comes from the cold baseline;
 * this reducer only reconstructs visible transcript items. Callers prepend its result and can safely retry
 * or discard a page after a generation CAS failure without triggering live side effects.
 */
export function reduceJournalHistory(events: readonly HubEvent[]): ThreadItem[] {
  const items: ThreadItem[] = []
  let itemInEvent = 0
  let eventSeq = 0
  const push = (item: Omit<ThreadItem, 'key'> & { key?: string }): ThreadItem => {
    const complete = {
      ...item,
      key: item.key ?? `journal:${eventSeq}:${itemInEvent++}`,
      historical: true,
      replayed: true,
    } as ThreadItem
    items.push(complete)
    return complete
  }
  const upsertCodexText = (
    ts: string,
    itemId: string,
    text: string,
    append: boolean,
    agentId?: string,
  ): void => {
    const key = `codex:${itemId}`
    const prior = items.find((item) => item.key === key)
    if (prior) {
      prior.text = append ? (prior.text ?? '') + text : text
      if (agentId) prior.agentId = agentId
    } else {
      push({ kind: 'assistant', ts, text, key, agentId })
    }
  }
  const activeCompaction = (): ThreadItem | undefined =>
    [...items].reverse().find((item) => item.kind === 'compaction' && item.status === 'started')
  const upsertCompaction = (
    ts: string,
    provider: 'claude' | 'codex',
    status: 'started' | 'completed' | 'failed' | 'unobservable',
    text: string,
    operationId?: string,
  ): void => {
    const key = operationId ? `compaction:${provider}:${operationId}` : undefined
    let item = key ? items.find((candidate) => candidate.key === key) : undefined
    item ??= activeCompaction()
    if (!item && status !== 'started') {
      const latest = [...items].reverse().find((candidate) => candidate.kind === 'compaction')
      const distance = latest ? Math.abs(Date.parse(ts) - Date.parse(latest.ts)) : Number.POSITIVE_INFINITY
      if (latest && Number.isFinite(distance) && distance <= 5_000) {
        if (latest.status === status) return
        if (latest.status === 'unobservable') item = latest
      }
    }
    if (!item) {
      push({ kind: 'compaction', ts, status, text, key })
      return
    }
    item.status = status
    item.text = text
  }
  const finishOpenCompaction = (
    ts: string,
    provider: 'claude' | 'codex',
    status: 'failed' | 'unobservable',
    text: string,
  ): void => {
    if (activeCompaction()) upsertCompaction(ts, provider, status, text)
  }

  for (const event of events) {
    eventSeq = event.seq
    itemInEvent = 0
    const { kind, payload, ts } = event
    if (kind === 'journal/history-event-oversized') {
      push({
        kind: 'note',
        ts,
        text:
          (payload as { message?: string }).message ??
          'One retained history event was too large for this bounded page.',
      })
      continue
    }
    if (kind === 'session/input') {
      push({
        kind: 'user',
        ts,
        text: (payload as { text?: string }).text ?? '',
        attachments: attachmentsFromPayload(payload),
      })
      continue
    }
    if (kind === 'bus/sent' || kind === 'bus/delivered') {
      const p = payload as {
        to?: { kind?: string; id?: string }
        recipients?: number
        fromLabel?: string
        fromSession?: string
        subject?: string | null
        body?: string
      }
      const sent = kind === 'bus/sent'
      push({
        kind: 'bus',
        ts,
        busDir: sent ? 'sent' : 'received',
        busPeer: sent
          ? p.to?.kind === 'project'
            ? `project · ${p.recipients ?? 0} agent(s)`
            : `agent ${(p.to?.id ?? '').slice(0, 8)}`
          : p.fromLabel || (p.fromSession ?? '').slice(0, 8),
        busPeerId: sent ? (p.to?.kind === 'session' ? p.to.id : undefined) : p.fromSession,
        busSubject: p.subject ?? undefined,
        text: p.body ?? '',
      })
      continue
    }
    if (kind === 'question/recovery-unknown') {
      push({
        kind: 'note',
        ts,
        text:
          (payload as { message?: string }).message ??
          'A prior answer could not be verified after recovery. The agent was told to ask again if needed.',
      })
      continue
    }
    if (kind === 'session/operator-authority-not-conferred') {
      push({
        kind: 'note',
        ts,
        text:
          (payload as { message?: string }).message ??
          'This mid-turn message guided the running turn but did not grant operator-only mutation authority. Resend it after the turn becomes idle if that authority is required.',
      })
      continue
    }
    if (kind === 'session/infrastructure-interruption') {
      push({
        kind: 'note',
        ts,
        text:
          'The worker transport was briefly unavailable and this turn was not confirmed. It was not retried automatically because the outcome is unknown; retry once if the requested work is still needed.',
      })
      continue
    }
    if (kind === 'question/restart-interrupted') {
      const p = payload as {
        phase?: 'planned' | 'crash'
        turnBoundary?: 'completed' | 'unknown'
        questionCount?: number
      }
      const count = p.questionCount ?? 1
      const outcome =
        p.phase === 'planned'
          ? p.turnBoundary === 'completed'
            ? 'The live Claude callback was released with a system-interruption result, and that exact turn then reached a terminal boundary before restart.'
            : 'The live callback was released, but whether Claude processed the interruption before restart is unknown.'
          : 'The previous provider process was not reachable, so no interruption response was delivered to it.'
      push({
        kind: 'note',
        ts,
        text:
          `SYSTEM INTERRUPTION — NOT A USER RESPONSE. The hub restart interrupted ${count} unanswered ` +
          `${count === 1 ? 'question' : 'questions'}. No answer, cancellation, decline, choice, or ` +
          `preference was supplied. ${outcome}`,
      })
      continue
    }
    if (kind === 'session/error') {
      finishOpenCompaction(
        ts,
        'claude',
        'failed',
        `Context compaction failed: ${(payload as { message?: string }).message ?? 'session error'}`,
      )
      push({ kind: 'error', ts, text: (payload as { message?: string }).message ?? 'session error' })
      continue
    }
    if (kind === 'session/mode') {
      push({
        kind: 'note',
        ts,
        text: `permission mode → ${(payload as { permissionMode?: string }).permissionMode ?? 'unknown'}`,
      })
      continue
    }
    if (kind === 'session/worktree-created') {
      push({
        kind: 'note',
        ts,
        text: `worktree: ${(payload as { worktree?: string }).worktree ?? 'unknown'}`,
      })
      continue
    }
    if (kind === 'memory/recalled') {
      const p = payload as { count?: number; titles?: string[] }
      const count = p.count ?? 0
      push({
        kind: 'note',
        ts,
        text: `✦ recalled ${count} memor${count === 1 ? 'y' : 'ies'}${p.titles?.length ? ` — ${p.titles.join(', ')}` : ''}`,
      })
      continue
    }
    if (kind === 'claude/assistant') {
      const p = payload as {
        message?: { content?: ClaudeBlock[] }
        parent_tool_use_id?: string | null
        subagent_type?: string
        task_description?: string
      }
      const blocks = p.message?.content
      if (!Array.isArray(blocks)) continue
      let sawThinking = false
      for (const block of blocks) {
        const agentId = p.parent_tool_use_id ?? undefined
        if (block.type === 'text' && block.text) {
          push({
            kind: 'assistant',
            ts,
            text: block.text,
            agentId,
            subagentType: p.subagent_type,
            taskDescription: p.task_description,
          })
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          sawThinking = true
          push({
            kind: 'thinking',
            ts,
            text: (block.thinking ?? '').trim(),
            agentId,
            subagentType: p.subagent_type,
            taskDescription: p.task_description,
          })
        } else if (block.type === 'tool_use') {
          push({
            kind: 'tool',
            ts,
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
            key: block.id ? `tool:${block.id}` : undefined,
            agentId,
            subagentType: p.subagent_type,
            taskDescription: p.task_description,
            reflex: !sawThinking,
          })
        }
      }
      continue
    }
    if (kind === 'claude/user') {
      const blocks = (payload as { message?: { content?: ClaudeBlock[] } }).message?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue
        const tool = items.find((item) => item.key === `tool:${block.tool_use_id}`)
        if (tool) {
          tool.toolResult = resultText(block.content)
          tool.toolError = block.is_error === true
          tool.toolResultTs = ts
        }
      }
      continue
    }
    if (kind === 'claude/system') {
      const p = payload as {
        subtype?: string
        message?: string
        status?: string | null
        compact_result?: 'success' | 'failed'
        compact_error?: string
        uuid?: string
        compact_metadata?: { pre_tokens?: number; post_tokens?: number }
      }
      if (p.subtype === 'status' && p.status === 'compacting') {
        upsertCompaction(ts, 'claude', 'started', 'Claude context compaction started…', p.uuid)
      } else if (p.subtype === 'status' && p.compact_result) {
        const failed = p.compact_result === 'failed'
        upsertCompaction(
          ts,
          'claude',
          failed ? 'failed' : 'completed',
          failed
            ? `Claude context compaction failed${p.compact_error ? `: ${p.compact_error}` : '.'}`
            : 'Claude context compaction completed.',
          p.uuid,
        )
      } else if (p.subtype === 'status' && p.status === null && activeCompaction()) {
        upsertCompaction(
          ts,
          'claude',
          'unobservable',
          'Claude context compaction ended without an observable terminal result.',
          p.uuid,
        )
      }
      if (p.subtype === 'compact_boundary') {
        const meta = p.compact_metadata
        const tokens = typeof meta?.pre_tokens === 'number'
          ? typeof meta.post_tokens === 'number'
            ? ` (${meta.pre_tokens.toLocaleString()} → ${meta.post_tokens.toLocaleString()} tokens)`
            : ` (${meta.pre_tokens.toLocaleString()} tokens before compaction)`
          : ''
        upsertCompaction(
          ts,
          'claude',
          'completed',
          p.message ?? `Claude context compaction completed${tokens}.`,
          p.uuid,
        )
      }
      continue
    }
    if (kind === 'claude/result') {
      const p = payload as {
        is_error?: boolean
        result?: string
        errors?: string[]
        terminal_reason?: string
        subtype?: string
      }
      const interrupted =
        p.terminal_reason === 'aborted_streaming' || p.terminal_reason === 'aborted_tools'
      finishOpenCompaction(
        ts,
        'claude',
        p.is_error ? 'failed' : 'unobservable',
        p.is_error
          ? 'Claude context compaction failed before reporting a terminal boundary.'
          : 'Claude context compaction ended without an observable terminal result.',
      )
      if (interrupted) push({ kind: 'note', ts, text: 'interrupted' })
      else if (p.is_error) {
        const errors = (p.errors ?? []).map(String).map((value) => value.trim()).filter(Boolean)
        push({
          kind: 'error',
          ts,
          text:
            errors.join('\n') ||
            p.result?.trim() ||
            `turn failed (${p.terminal_reason ?? p.subtype ?? 'unknown error'})`,
        })
      }
      continue
    }
    if (kind === 'codex/thread/compacted') {
      const p = payload as { turnId?: string }
      upsertCompaction(
        ts,
        'codex',
        'completed',
        'Codex context compaction completed.',
        p.turnId ? `turn:${p.turnId}` : undefined,
      )
      continue
    }
    if (kind === 'codex/turn/completed') {
      const turn = (payload as { turn?: { status?: string; error?: { message?: string } | string } }).turn
      const error = typeof turn?.error === 'string' ? turn.error : turn?.error?.message
      finishOpenCompaction(
        ts,
        'codex',
        turn?.status === 'failed' ? 'failed' : 'unobservable',
        turn?.status === 'failed'
          ? `Codex context compaction failed${error ? `: ${error}` : '.'}`
          : 'Codex context compaction ended without an observable terminal result.',
      )
      continue
    }
    if (kind === 'codex/item/started') {
      const item = (payload as { item?: Record<string, unknown> }).item
      if (item?.type === 'contextCompaction') {
        upsertCompaction(
          ts,
          'codex',
          'started',
          'Codex context compaction started…',
          typeof item.id === 'string' ? item.id : undefined,
        )
      }
      continue
    }
    if (kind === 'codex/item/agentMessage/delta') {
      const p = payload as { itemId?: string; delta?: string }
      if (p.itemId && typeof p.delta === 'string') upsertCodexText(ts, p.itemId, p.delta, true)
      continue
    }
    if (kind === 'codex/subagent/item/agentMessage/delta') {
      const p = payload as { itemId?: string; delta?: string; agentThreadId?: string }
      if (p.itemId && typeof p.delta === 'string') {
        upsertCodexText(ts, p.itemId, p.delta, true, p.agentThreadId)
      }
      continue
    }
    if (kind === 'codex/item/completed' || kind === 'codex/subagent/item/completed') {
      const p = payload as { item?: Record<string, unknown>; agentThreadId?: string }
      const item = p.item
      if (!item) continue
      const agentId = kind.startsWith('codex/subagent/') ? p.agentThreadId : undefined
      if (item.type === 'contextCompaction' && !agentId) {
        upsertCompaction(
          ts,
          'codex',
          'completed',
          'Codex context compaction completed.',
          typeof item.id === 'string' ? item.id : undefined,
        )
      } else if (item.type === 'agentMessage' && typeof item.id === 'string') {
        upsertCodexText(ts, item.id, typeof item.text === 'string' ? item.text : '', false, agentId)
      } else if (item.type === 'reasoning') {
        push({
          kind: 'reasoning',
          ts,
          text: extractCodexReasoning(item),
          key: typeof item.id === 'string' ? `codex:reasoning:${item.id}` : undefined,
          agentId,
        })
      } else if (item.type === 'commandExecution') {
        push({
          kind: 'tool',
          ts,
          toolName: 'command',
          toolInput: item.command ?? item,
          toolResult: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined,
          agentId,
        })
      } else if (item.type === 'fileChange') {
        push({ kind: 'tool', ts, toolName: 'fileChange', toolInput: item, agentId })
      } else if (item.type === 'mcpToolCall') {
        push({ kind: 'tool', ts, toolName: `mcp:${String(item.tool ?? '')}`, toolInput: item, agentId })
      }
      continue
    }
  }

  if (items.length <= JOURNAL_HISTORY_MAX_LOGICAL_ITEMS) return items
  return items.slice(-JOURNAL_HISTORY_MAX_LOGICAL_ITEMS)
}
