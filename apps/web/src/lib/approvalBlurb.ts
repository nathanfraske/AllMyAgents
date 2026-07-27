import { agentActivity, toolBlurb } from './toolBlurb'
import type { ThreadItem } from './store.svelte'

export interface ApprovalBlurb {
  toolName: string
  label: string
  /** Visible, multiline detail. This is deliberately not raw JSON. */
  detail?: string
  /** Full subject for hover when the shared transcript blurb truncates its label. */
  title?: string
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = obj?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function kindToolName(kind: string, payload: Record<string, unknown> | undefined): string {
  const explicit = stringField(payload, 'toolName')
  if (explicit) return explicit
  if (kind === 'practice/write') return 'practice/write'
  if (kind === 'practice/edit') return 'practice/edit'
  const codex = /^codex\/(?:item\/)?(.+?)\/requestApproval$/.exec(kind)?.[1]
  return codex || kind
}

/** Convert an approval into the same normalized tool item that transcript rows pass to `toolBlurb`. */
function transcriptItem(kind: string, payload: Record<string, unknown> | undefined): ThreadItem {
  const approvalName = kindToolName(kind, payload)
  let toolName = approvalName
  let toolInput: unknown = payload

  if (kind === 'claude/tool') {
    toolInput = payload?.input
  } else if (kind.startsWith('codex/')) {
    if (approvalName === 'commandExecution') {
      toolName = 'command'
      toolInput = payload?.command ?? payload
    } else if (approvalName === 'fileChange') {
      toolName = 'fileChange'
      toolInput = payload
    }
  } else if (kind === 'practice/write' || kind === 'practice/edit') {
    toolName = `mcp__allmyagents__${kind === 'practice/write' ? 'practice_write' : 'practice_edit'}`
  }

  return {
    key: 'pending-approval',
    kind: 'tool',
    ts: '',
    toolName,
    toolInput,
  }
}

function scalar(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return '(not provided)'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return String(value)
}

/** YAML-like fields: readable structure without training the operator to approve an opaque JSON blob. */
function fieldLines(value: unknown, indent = 0): string[] {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}(none)`]
    return value.flatMap((entry) => {
      if (entry && typeof entry === 'object') {
        const nested = fieldLines(entry, indent + 2)
        return [`${pad}-`, ...nested]
      }
      return [`${pad}- ${scalar(entry)}`]
    })
  }
  const obj = objectOf(value)
  if (!obj) return [`${pad}${scalar(value)}`]
  const entries = Object.entries(obj).filter(([, entry]) => entry !== undefined)
  if (entries.length === 0) return [`${pad}No additional fields were provided.`]
  return entries.flatMap(([key, entry]) => {
    if (entry && typeof entry === 'object') {
      return [`${pad}${key}:`, ...fieldLines(entry, indent + 2)]
    }
    const text = scalar(entry)
    const [first, ...rest] = text.split(/\r?\n/)
    return [`${pad}${key}: ${first}`, ...rest.map((line) => `${pad}  ${line}`)]
  })
}

function formatFields(value: unknown): string {
  const text = fieldLines(value).join('\n')
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text
}

/**
 * Human description for all approval families. Known tools use the transcript's single describer;
 * unknown/new shapes still name the tool and list their fields, never stringify to `{}`.
 */
export function approvalBlurb(kind: string, rawPayload: unknown): ApprovalBlurb {
  const payload = objectOf(rawPayload)
  const toolName = kindToolName(kind, payload)
  const item = transcriptItem(kind, payload)
  const shared = toolBlurb(item)
  const agent = agentActivity(item)

  const body = kind === 'claude/tool' ? payload?.input : payload
  const sharedDetail = shared?.title && shared.title !== shared.label ? shared.title : undefined
  const detail = sharedDetail ?? formatFields(body)
  return {
    toolName,
    label: shared?.label ?? agent?.label ?? toolName,
    detail,
    title: shared?.title,
  }
}
