import type { ThreadItem } from './store.svelte'

// --- Codex transcript polish --------------------------------------------------------------------
//
// Two jobs, both about how a Codex turn reads in the transcript, both pure + testable so the logic
// is not buried in a component (see codexGroup.test.ts):
//
//   1. extractCodexReasoning — pull the human-readable reasoning text out of a Codex app-server
//      `reasoning` item. The app-server carries it in `summary` / `content` ARRAYS (not a flat
//      `text`), and only populates them when the turn asked for a reasoning summary. See the adapter
//      note in the report: the fix that makes these non-empty lives in the hub's turn params.
//
//   2. groupCodexItems / summarizeCodexGroup — collapse the reasoning→command→reasoning→command
//      churn a Codex turn produces into a single live group, the way the Codex app does. The group
//      accumulates while the model works and BREAKS when the agent actually says something.

/** An element of a Codex reasoning item's `summary` / `content` array, defensively typed. Real rows
 *  are `{ type: 'summary_text' | 'reasoning_text', text }`; we also accept a bare string or `{text}`
 *  so a shape drift across app-server versions degrades to "still shows the text" rather than blank. */
function partText(part: unknown): string {
  if (typeof part === 'string') return part
  if (part && typeof part === 'object') {
    const t = (part as { text?: unknown }).text
    if (typeof t === 'string') return t
  }
  return ''
}

function joinParts(arr: unknown): string {
  if (!Array.isArray(arr)) return ''
  return arr
    .map(partText)
    .filter((s) => s.trim().length > 0)
    .join('\n\n')
    .trim()
}

/**
 * Extract the reasoning text from a Codex app-server `reasoning` item.
 *
 * Preference order: the human `summary` first (what `model_reasoning_summary` produces), then the
 * raw `content`, then a flat `text` if some app-server version ever supplies one. Returns '' when the
 * item genuinely carries no text — the honest empty state, NOT a "(reasoning)" placeholder that
 * promises content and delivers none.
 */
export function extractCodexReasoning(item: unknown): string {
  if (!item || typeof item !== 'object') return ''
  const it = item as { summary?: unknown; content?: unknown; text?: unknown }
  const fromSummary = joinParts(it.summary)
  if (fromSummary) return fromSummary
  const fromContent = joinParts(it.content)
  if (fromContent) return fromContent
  return typeof it.text === 'string' ? it.text.trim() : ''
}

// --- Live grouping of Codex activity -------------------------------------------------------------

/** An item is Codex "activity" (churn to collapse) when it is a reasoning step or a tool call. A
 *  Codex transcript's tool items are all Codex tools (command / fileChange / mcp:*), so within a
 *  Codex session this is unambiguous; the caller only ever runs this on the Codex render path. */
export function isActivityItem(item: ThreadItem): boolean {
  return item.kind === 'reasoning' || item.kind === 'tool'
}

export type CodexRenderNode =
  | { type: 'item'; id: string; item: ThreadItem }
  | { type: 'group'; id: string; items: ThreadItem[] }

/**
 * Fold a Codex transcript into render nodes: maximal runs of ≥2 consecutive activity items become a
 * `group`; everything else (assistant/user/note/error/bus, and a lone activity item) stays a standalone
 * `item`. An `agentMessage` (kind `assistant`) — the boundary a reader cares about — breaks the run,
 * exactly as the Codex app does.
 *
 * The group id is the FIRST item's key, which does not change as later steps append, so the group's
 * expansion state (held per-id in the component) survives new items arriving mid-turn.
 */
export function groupCodexItems(items: ThreadItem[]): CodexRenderNode[] {
  const out: CodexRenderNode[] = []
  let run: ThreadItem[] = []
  const flush = (): void => {
    if (run.length === 0) return
    if (run.length === 1) {
      const only = run[0] as ThreadItem
      out.push({ type: 'item', id: only.key, item: only })
    } else {
      out.push({ type: 'group', id: `codexgrp:${(run[0] as ThreadItem).key}`, items: run })
    }
    run = []
  }
  for (const item of items) {
    if (isActivityItem(item)) run.push(item)
    else {
      flush()
      out.push({ type: 'item', id: item.key, item })
    }
  }
  flush()
  return out
}

export interface CodexGroupSummary {
  /** Total activity steps in the group — what the collapsed header ticks ("12 steps"). */
  steps: number
  reasoning: number
  commands: number
  /** A short label for the most recent tool call, so a collapsed group is still informative. */
  current?: string
}

/** A short one-line label for a Codex tool item — the command line, the edited file, or the tool. */
export function codexToolLabel(item: ThreadItem): string | undefined {
  if (item.kind !== 'tool') return undefined
  if (item.toolName === 'command') return commandText(item.toolInput)
  if (item.toolName === 'fileChange') return fileChangeLabel(item.toolInput)
  return item.toolName
}

function commandText(input: unknown): string | undefined {
  if (typeof input === 'string') return clip(input)
  if (Array.isArray(input)) return clip(input.map(String).join(' '))
  if (input && typeof input === 'object') {
    const cmd = (input as { command?: unknown }).command
    if (typeof cmd === 'string') return clip(cmd)
    if (Array.isArray(cmd)) return clip(cmd.map(String).join(' '))
  }
  return undefined
}

function fileChangeLabel(input: unknown): string | undefined {
  const path =
    (input as { path?: unknown } | null)?.path ??
    (input as { file?: unknown } | null)?.file ??
    (input as { filename?: unknown } | null)?.filename
  return typeof path === 'string' ? `edit ${clip(path)}` : 'file change'
}

function clip(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

/** Live summary of a group for its collapsed header. `current` is the last tool call's label. */
export function summarizeCodexGroup(items: ThreadItem[]): CodexGroupSummary {
  let reasoning = 0
  let commands = 0
  let current: string | undefined
  for (const it of items) {
    if (it.kind === 'reasoning') reasoning++
    else if (it.kind === 'tool') {
      commands++
      const label = codexToolLabel(it)
      if (label) current = label
    }
  }
  return { steps: items.length, reasoning, commands, current }
}
