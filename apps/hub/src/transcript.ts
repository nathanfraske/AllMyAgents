/**
 * Read a vendor session's on-disk transcript into ordered, render-ready history items — so imported
 * chats show their real conversation instead of an empty thread. Read-only, bounded, and TAIL-first:
 * real transcripts reach many MB / tens of thousands of lines (one AllMyStuff Codex rollout is 55k
 * lines), so we read the most-recent slice and cap the item count, never the whole file. "Load older"
 * pages backwards from a byte cursor.
 *
 * Formats grounded on the real files (inspected 2026-07-24) — see importScan.ts for the summary-field
 * counterpart; this module emits the FULL ordered turn stream.
 *
 *  - Claude JSONL: `user`/`assistant` records; content is a string or a block array. Blocks:
 *    text (user/assistant), thinking (assistant reasoning), tool_use (assistant tool call),
 *    tool_result (user, paired to a tool_use by tool_use_id). Other record types are framing.
 *  - Codex rollout: `event_msg` (user_message, agent_message, agent_reasoning) carries the chat text;
 *    `response_item` (custom_tool_call / function_call + *_output, paired by call_id) carries tools.
 *    token_count / world_state / turn_context / session_meta / *_applied are metadata.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Provider } from './types.js'

export interface HistoryItem {
  /** Matches the web ThreadItem kinds so the client maps 1:1. */
  kind: 'user' | 'assistant' | 'reasoning' | 'tool'
  text?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: string
  toolError?: boolean
  /** ISO timestamp of the source record — lets the thread show a date for older-than-today turns. */
  ts?: string
}

export interface HistoryPage {
  items: HistoryItem[]
  /** Byte offset to pass back as `beforeByte` to page OLDER; null when the file start was reached. */
  olderCursor: number | null
  /** True when there is older history not in this page. */
  hasOlder: boolean
}

const DEFAULT_MAX_BYTES = 1.5 * 1024 * 1024 // tail slice to parse per page
const DEFAULT_ITEM_CAP = 300 // most-recent N items returned per page

// Synthetic / injected wrappers that are never real chat turns (shared spirit with importScan).
function isSynthetic(t: string): boolean {
  return (
    /^<(command-|local-command|bash-|user-memory|system-|permissions)/i.test(t) ||
    /^Caveat: The messages below/i.test(t) ||
    /^\[Request interrupted/i.test(t)
  )
}

/** Flatten Claude tool_result / Codex output content (string | block array) to display text. */
function contentToText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object') {
          const o = b as { text?: unknown; content?: unknown; type?: string }
          if (typeof o.text === 'string') return o.text
          if (typeof o.content === 'string') return o.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (c && typeof c === 'object') {
    const o = c as { text?: unknown; output?: unknown }
    if (typeof o.text === 'string') return o.text
    if (typeof o.output === 'string') return o.output
  }
  return c == null ? '' : String(c)
}

/** One parsed Claude JSONL record → zero or more ordered history items. */
export function claudeRecordItems(r: Record<string, unknown>): HistoryItem[] {
  const out: HistoryItem[] = []
  const message = r.message as { content?: unknown } | undefined
  if (r.type === 'user') {
    const c = message?.content
    if (typeof c === 'string') {
      const t = c.trim()
      if (t && !isSynthetic(t)) out.push({ kind: 'user', text: t })
    } else if (Array.isArray(c)) {
      for (const b of c) {
        const blk = b as { type?: string; text?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
        if (blk.type === 'text') {
          const t = String(blk.text ?? '').trim()
          if (t && !isSynthetic(t)) out.push({ kind: 'user', text: t })
        } else if (blk.type === 'tool_result') {
          out.push({ kind: 'tool', toolResult: contentToText(blk.content).slice(0, 4000), toolError: blk.is_error === true, toolName: `__result__${blk.tool_use_id ?? ''}` })
        }
      }
    }
  } else if (r.type === 'assistant') {
    const c = message?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        const blk = b as { type?: string; text?: unknown; thinking?: unknown; name?: string; input?: unknown; id?: string }
        if (blk.type === 'text') {
          const t = String(blk.text ?? '').trim()
          if (t) out.push({ kind: 'assistant', text: t })
        } else if (blk.type === 'thinking') {
          const t = String(blk.thinking ?? '').trim()
          if (t) out.push({ kind: 'reasoning', text: t })
        } else if (blk.type === 'tool_use') {
          out.push({ kind: 'tool', toolName: blk.name, toolInput: blk.input, toolResult: undefined, text: `__call__${blk.id ?? ''}` })
        }
      }
    }
  }
  return out
}

/** One parsed Codex rollout record → zero or more ordered history items. */
export function codexRecordItems(r: Record<string, unknown>): HistoryItem[] {
  const out: HistoryItem[] = []
  const p = (r.payload ?? {}) as Record<string, unknown>
  if (r.type === 'event_msg') {
    if (p.type === 'user_message' && typeof p.message === 'string') {
      const t = p.message.trim()
      if (t && !isSynthetic(t)) out.push({ kind: 'user', text: t })
    } else if (p.type === 'agent_message' && typeof p.message === 'string') {
      const t = p.message.trim()
      if (t) out.push({ kind: 'assistant', text: t })
    } else if (p.type === 'agent_reasoning' && typeof p.text === 'string') {
      const t = p.text.trim()
      if (t) out.push({ kind: 'reasoning', text: t })
    }
  } else if (r.type === 'response_item') {
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      out.push({ kind: 'tool', toolName: String(p.name ?? 'tool'), toolInput: p.input ?? p.arguments, text: `__call__${p.call_id ?? ''}` })
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      out.push({ kind: 'tool', toolResult: contentToText(p.output).slice(0, 4000), toolName: `__result__${p.call_id ?? ''}` })
    }
  }
  return out
}

/**
 * Pair tool calls with their outputs (by call id embedded in the placeholder fields) into single
 * tool items, and drop the placeholder markers — so a tool renders once, input + result together,
 * exactly like the live thread. Orphan results (output with no visible call) become their own item.
 */
function pairTools(raw: HistoryItem[]): HistoryItem[] {
  const calls = new Map<string, HistoryItem>()
  const out: HistoryItem[] = []
  for (const it of raw) {
    const callMark = it.text?.startsWith('__call__') ? it.text.slice(8) : undefined
    const resultMark = it.toolName?.startsWith('__result__') ? it.toolName.slice(10) : undefined
    if (callMark !== undefined && it.kind === 'tool') {
      const clean: HistoryItem = { kind: 'tool', toolName: it.toolName, toolInput: it.toolInput, ts: it.ts }
      out.push(clean)
      if (callMark) calls.set(callMark, clean)
    } else if (resultMark !== undefined && it.kind === 'tool') {
      const call = resultMark ? calls.get(resultMark) : undefined
      if (call) {
        call.toolResult = it.toolResult
        call.toolError = it.toolError
      } else {
        out.push({ kind: 'tool', toolName: 'result', toolResult: it.toolResult, toolError: it.toolError, ts: it.ts })
      }
    } else {
      out.push(it)
    }
  }
  return out
}

/**
 * Locate a session's transcript file from its owning profile + vendor id — the fallback for records
 * adopted before `transcriptPath` was persisted. Claude: `projects/<dir>/<sessionId>.jsonl`. Codex:
 * the newest `rollout-*-<sessionId>.jsonl` under `sessions/` (a session spans several; newest wins).
 */
export async function locateTranscript(profileDir: string, provider: Provider, vendorSessionId: string): Promise<string | undefined> {
  if (provider === 'claude') {
    const projects = path.join(profileDir, 'projects')
    let dirs: string[]
    try {
      dirs = await fs.promises.readdir(projects)
    } catch {
      return undefined
    }
    for (const d of dirs) {
      const f = path.join(projects, d, `${vendorSessionId}.jsonl`)
      try {
        if ((await fs.promises.stat(f)).isFile()) return f
      } catch {
        /* not here */
      }
    }
    return undefined
  }
  const suffix = `-${vendorSessionId}.jsonl`
  let best: { file: string; mtimeMs: number } | undefined
  const stack = [path.join(profileDir, 'sessions')]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.startsWith('rollout-') && e.name.endsWith(suffix)) {
        try {
          const st = await fs.promises.stat(full)
          if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs }
        } catch {
          /* vanished */
        }
      }
    }
  }
  return best?.file
}

/**
 * Read the tail of a transcript file and parse it into history items. `beforeByte` pages backwards:
 * omit it for the most-recent page, then pass back `olderCursor` to load the previous slice.
 */
export async function readHistoryPage(
  file: string,
  provider: Provider,
  opts: { maxBytes?: number; itemCap?: number; beforeByte?: number } = {}
): Promise<HistoryPage> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const itemCap = opts.itemCap ?? DEFAULT_ITEM_CAP
  const stat = await fs.promises.stat(file)
  const end = Math.min(opts.beforeByte ?? stat.size, stat.size)
  const start = Math.max(0, end - maxBytes)
  const length = end - start
  const buf = Buffer.alloc(length)
  const fd = await fs.promises.open(file, 'r')
  try {
    if (length > 0) await fd.read(buf, 0, length, start)
  } finally {
    await fd.close()
  }
  let text = buf.toString('utf8')
  // If we didn't begin at the file start, the first line is almost certainly partial — drop it.
  if (start > 0) {
    const nl = text.indexOf('\n')
    text = nl >= 0 ? text.slice(nl + 1) : ''
  }
  const raw: HistoryItem[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue // partial / malformed line — skip
    }
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined
    const items = provider === 'claude' ? claudeRecordItems(rec) : codexRecordItems(rec)
    for (const it of items) {
      if (ts && !it.ts) it.ts = ts
      raw.push(it)
    }
  }
  const paired = pairTools(raw)
  // Cap to the most-recent itemCap; anything trimmed here (or a non-zero start) means older exists.
  const trimmed = paired.length > itemCap
  const items = trimmed ? paired.slice(paired.length - itemCap) : paired
  const hasOlder = start > 0 || trimmed
  return { items, olderCursor: hasOlder ? start : null, hasOlder }
}
