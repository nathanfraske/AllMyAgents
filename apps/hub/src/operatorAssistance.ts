import { randomUUID } from 'node:crypto'
import type { HubPrefs, SessionRecord } from './types.js'
import type { PublishNotification } from './notifications.js'

export const DEFAULT_ASSISTANCE = {
  leanCoordination: true,
  toolFailureEscalation: true,
  highTokenUsageWarnings: true,
  highTokenUsageThreshold: 100_000,
  highContextUsagePercent: 80,
} as const

export interface ToolHelpIncident {
  id: string
  tool: string
  summary: string
  failures: number
  status: 'retryable' | 'waiting' | 'skipped' | 'investigating'
  createdAt: string
  updatedAt: string
  diagnosisUntil?: number
  calls: string[]
  retryCallId?: string
}

interface Counters { input: number; cached: number; output: number }
export interface TokenWarningState {
  turn: string
  billable: number
  cached: number
  usageWarned: boolean
  contextWarned: boolean
  previous?: Counters
  freshThread: boolean
  requests: Record<string, Counters>
  turnUsage?: Counters
}

export interface ToolAssistanceInput {
  phase: 'before' | 'success' | 'failure' | 'report'
  tool: string
  callId: string
  summary?: string
  retryAttempted?: boolean
}
export interface ToolAssistanceResult { blocked: boolean; message?: string; incidentId?: string }

// This is a retry-safety classification, NOT an execution/approval allowlist. Existing grants always
// apply. Mutations and opaque commands never acquire replay permission from an error message.
const READ_ONLY_TOOLS = new Set([
  'list_agents', 'peek_agent', 'child_status', 'inspect_runs', 'query_team', 'memory_search',
  'memory_read', 'practice_read', 'practice_list', 'browser_read_page', 'browser_tabs',
  'browser_status', 'browser_screenshot', 'browser_download_read', 'remote_list_devices',
  'remote_ping', 'remote_inspect_environment', 'remote_inspect_git', 'remote_list_files',
  'remote_read_file', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
])
const plain = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

export function assistancePreferences(prefs: Pick<HubPrefs, 'leanCoordination' | 'toolFailureEscalation' | 'highTokenUsageWarnings' | 'highTokenUsageThreshold' | 'highContextUsagePercent'>) {
  return {
    leanCoordination: prefs.leanCoordination !== false,
    toolFailureEscalation: prefs.toolFailureEscalation !== false,
    highTokenUsageWarnings: prefs.highTokenUsageWarnings !== false,
    highTokenUsageThreshold: Number.isSafeInteger(prefs.highTokenUsageThreshold) && prefs.highTokenUsageThreshold! >= 1_000
      && prefs.highTokenUsageThreshold! <= 10_000_000 ? prefs.highTokenUsageThreshold! : DEFAULT_ASSISTANCE.highTokenUsageThreshold,
    highContextUsagePercent: Number.isSafeInteger(prefs.highContextUsagePercent) && prefs.highContextUsagePercent! >= 10
      && prefs.highContextUsagePercent! <= 100 ? prefs.highContextUsagePercent! : DEFAULT_ASSISTANCE.highContextUsagePercent,
  }
}

export function boundedToolError(value: string): string {
  return value.slice(0, 4_000)
    .replace(/authorization\s*[:=]\s*(?:bearer\s+|basic\s+)?[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(/(authorization\s*[:=]\s*|bearer\s+|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 1_000)
}

/** Only structured failures or the shared tools' explicit failure envelopes, never log contents. */
export function agentToolFailure(output: unknown): string | undefined {
  if (Array.isArray(output)) {
    // Browser tools use MCP content blocks; screenshots and page content are not errors.
    const first = plain(output[0])
    if (first?.type === 'text' && typeof first.text === 'string' && /^(?:Browser unavailable:|Browser action failed:)/i.test(first.text)) return first.text
    return undefined
  }
  if (typeof output !== 'string') return undefined
  if (/^(?:Tool error:|Error:|Remote [\w ]{1,40} failed:|Browser action failed:|Run not started:|Run inspection failed:)/i.test(output)) return output
  if (output.startsWith('{') && output.length <= 131_072) {
    try {
      const value = plain(JSON.parse(output))
      if (value?.ok === false && typeof value.error === 'string') return value.error
    } catch { /* ordinary tool text */ }
  }
  return undefined
}

export function isPermissionOrInputError(summary: string): boolean {
  return /(?:permission denied|approval (?:required|denied)|not authori[sz]ed|outside .{0,80}(?:scope|grant|boundary)|invalid arguments|operator (?:approval|permission) required)/i.test(summary)
}

interface AssistanceHost {
  prefs(): Partial<HubPrefs>
  record(sessionId: string): SessionRecord | undefined
  save(record: SessionRecord): void
  audit(sessionId: string, kind: string, payload: unknown): void
  notify(input: PublishNotification): void
}

/** Durable state belongs to the session record. No model is launched and no tool is replayed here. */
export class OperatorAssistance {
  constructor(private readonly host: AssistanceHost) {}

  tool(sessionId: string, input: ToolAssistanceInput): ToolAssistanceResult {
    const record = this.host.record(sessionId)
    if (!record) throw new Error('Tool assistance session is unavailable')
    if (!assistancePreferences(this.host.prefs()).toolFailureEscalation) return { blocked: false }
    if (!/^[A-Za-z0-9_.:/-]{1,160}$/.test(input.tool) || !input.callId || input.callId.length > 256) throw new Error('Invalid tool failure identity')
    const incidents = record.toolHelp ??= []
    let incident = incidents.find(item => item.tool === input.tool)
    if (input.phase === 'before') {
      if (!incident) return { blocked: false }
      if (incident.status === 'investigating' && (incident.diagnosisUntil ?? 0) > Date.now()) return { blocked: false }
      if (incident.status === 'investigating') {
        incident.status = 'waiting'
        incident.summary = 'The operator-authorized five-minute diagnosis expired. Review the chat before allowing more work.'
        this.host.save(record)
        this.notifyHelp(record, incident)
      }
      if (incident.status === 'retryable') {
        if (incident.retryCallId && incident.retryCallId !== input.callId) return { blocked: true,
          message: 'The single retry is already in progress or its outcome is unknown. Do not launch another attempt.' }
        incident.retryCallId = input.callId
        this.host.save(record)
        return { blocked: false }
      }
      return { blocked: true, incidentId: incident.id, message: 'This tool is waiting for operator help. Do not retry, switch tools to repeat the same action, or repair its infrastructure. Continue only independent work.' }
    }
    if (input.phase === 'success') {
      if (incident?.status === 'retryable' && incident.retryCallId === input.callId) {
        record.toolHelp = incidents.filter(item => item !== incident)
        this.host.save(record)
        this.host.audit(sessionId, 'tool-help/recovered', { id: incident.id, tool: input.tool })
      }
      return { blocked: false }
    }
    const summary = boundedToolError(input.summary ?? 'Tool failed without diagnostic detail')
    if (isPermissionOrInputError(summary)) return { blocked: false }
    const now = new Date().toISOString()
    if (!incident) {
      // Never silently evict an unresolved hold. The bounded overflow itself needs operator help.
      if (incidents.length >= 32) return { blocked: true, message: 'Tool-help queue is full. Ask the operator to resolve existing requests; do not continue tool repair attempts.' }
      incident = { id: randomUUID(), tool: input.tool, summary, failures: 0, status: 'retryable', createdAt: now, updatedAt: now, calls: [] }
      incidents.push(incident)
    }
    if (incident.calls.includes(input.callId)) return this.result(incident)
    if (incident.status === 'waiting' || incident.status === 'skipped') return this.result(incident)
    incident.calls = [...incident.calls, input.callId].slice(-16)
    incident.failures = Math.min(2, Math.max(incident.failures + 1, input.retryAttempted ? 2 : 1))
    incident.summary = summary
    incident.updatedAt = now
    const safeRetry = READ_ONLY_TOOLS.has(input.tool) && !/outcome[_ -]unknown|unauthorized|401\b|credits|quota|usage.?limit/i.test(summary)
    const diagnosing = incident.status === 'investigating' && (incident.diagnosisUntil ?? 0) > Date.now()
    if (!diagnosing && (!safeRetry || incident.failures >= 2)) incident.status = 'waiting'
    this.host.save(record)
    this.host.audit(sessionId, 'tool-help/observed', { ...incident, calls: undefined })
    if (incident.status === 'waiting') {
      this.notifyHelp(record, incident)
    }
    return this.result(incident)
  }

  private notifyHelp(record: SessionRecord, incident: ToolHelpIncident): void {
    this.host.notify({ kind: 'tool-help-required', severity: 'warning', sourceRole: this.role(record), route: 'operator',
        title: `${record.title ?? 'Agent'} needs tool help`,
        body: `${incident.tool} needs attention. Affected work is waiting for your decision. Open the chat to review.`,
        sessionId: record.id, projectId: record.projectId, dedupeKey: `tool-help:${incident.id}` })
  }

  private result(incident: ToolHelpIncident): ToolAssistanceResult {
    const blocked = incident.status === 'waiting' || incident.status === 'skipped'
    return { blocked, incidentId: incident.id, message: blocked
      ? 'Operator help requested. Stop attempts with this tool and do not start a repair detour. Continue only independent work while waiting.'
      : incident.status === 'investigating'
        ? 'The operator allowed a bounded diagnosis. Existing tool/resource permissions still apply.'
        : 'Retry this read-only tool once yourself. If it fails again, stop and escalate to the operator; do not repair its infrastructure.' }
  }

  resolve(sessionId: string, id: string, action: 'retry' | 'diagnose' | 'skip'): string {
    const record = this.host.record(sessionId)
    const incident = record?.toolHelp?.find(item => item.id === id)
    if (!record || !incident || (incident.status !== 'waiting' && !(incident.status === 'skipped' && action !== 'skip'))) throw new Error('This tool-help request is no longer pending')
    if (action === 'retry') record.toolHelp = record.toolHelp!.filter(item => item !== incident)
    else if (action === 'diagnose') {
      incident.status = 'investigating'
      incident.id = randomUUID()
      incident.diagnosisUntil = Date.now() + 5 * 60_000
    } else incident.status = 'skipped'
    this.host.save(record)
    this.host.audit(sessionId, 'tool-help/resolved', { id, tool: incident.tool, action, diagnosisUntil: incident.diagnosisUntil, by: 'operator' })
    return action === 'retry'
      ? `Operator: the tool-help hold for ${incident.tool} was cleared. Inspect any uncertain previous outcome before attempting anything again. Continue within existing permissions.`
      : action === 'diagnose'
        ? `Operator: you may diagnose ${incident.tool} for up to five minutes, within existing permissions. This is not a grant to install, restart, deploy, or repeat ambiguous writes. Escalate if it is still broken afterward.`
        : `Operator: skip the blocked ${incident.tool} work. Continue independent work only; do not use another tool to repeat the skipped action.`
  }

  beginTurn(record: SessionRecord, baseline?: unknown): void {
    const previous = record.tokenWarning?.previous ?? this.threadCounters(baseline)
    record.tokenWarning = { turn: randomUUID(), billable: 0, cached: 0, usageWarned: false, contextWarned: false,
      previous, freshThread: !record.vendorSessionId, requests: {} }
    this.host.save(record)
  }

  private threadCounters(payload: unknown): Counters | undefined {
    const p = plain(payload)
    if (p?.usageScope !== 'thread' || typeof p.input !== 'number' || typeof p.output !== 'number'
      || !Number.isFinite(p.input) || !Number.isFinite(p.output) || p.input < 0 || p.output < 0) return undefined
    return { input: number(p.input), cached: number(p.cachedInput), output: number(p.output) }
  }

  tokens(record: SessionRecord, payload: unknown): void {
    const p = plain(payload)
    if (!p) return
    if (!record.tokenWarning) this.beginTurn(record)
    const state = record.tokenWarning!
    const prefs = assistancePreferences(this.host.prefs())
    const current = this.threadCounters(p)
    if (current) {
      const previous = state.previous ?? (state.freshThread ? { input: 0, cached: 0, output: 0 } : current)
      // Counter resets or resumed threads are a new baseline, not a giant negative/positive bill.
      if (current.input >= previous.input && current.output >= previous.output && current.cached >= previous.cached) {
        state.billable += Math.max(0, current.input - previous.input - (current.cached - previous.cached)) + current.output - previous.output
        state.cached += current.cached - previous.cached
      }
      state.previous = current
    } else if (p.scope === 'turn' || (p.scope === 'request' && typeof p.requestId === 'string')) {
      if (p.scope === 'turn') {
        state.turnUsage = { input: number(p.input) + number(p.cacheWrite), cached: number(p.cacheRead), output: number(p.output) }
      } else {
        const value = { input: number(p.input) + number(p.cacheWrite), cached: number(p.cacheRead), output: number(p.output) }
        const key = `request:${(p.requestId as string).slice(0, 200)}`
        if (Object.hasOwn(state.requests, key) || Object.keys(state.requests).length < 512) {
          const old = state.requests[key] ?? { input: 0, cached: 0, output: 0 }
          state.requests[key] = { input: Math.max(old.input, value.input), cached: Math.max(old.cached, value.cached), output: Math.max(old.output, value.output) }
        }
        // Above this bound, rely on the authoritative turn result; do not evict ids and double-count replays.
      }
      const requests = Object.values(state.requests)
      state.billable = Math.max(state.billable, requests.reduce((sum, v) => sum + v.input + v.output, 0),
        (state.turnUsage?.input ?? 0) + (state.turnUsage?.output ?? 0))
      state.cached = Math.max(state.cached, requests.reduce((sum, v) => sum + v.cached, 0), state.turnUsage?.cached ?? 0)
    }
    const occupancy = number(p.contextWindow) > 0 ? number(p.contextUsed) / number(p.contextWindow) : 0
    if (prefs.highTokenUsageWarnings && !state.usageWarned && state.billable >= prefs.highTokenUsageThreshold) {
      state.usageWarned = true
      this.warn(record, 'spend', `${Math.round(state.billable).toLocaleString('en-US')} non-cached input/output tokens reported this turn; ${Math.round(state.cached).toLocaleString('en-US')} cache-read tokens separately. This is usage, not a dollar estimate. Work has not been stopped.`)
    }
    if (prefs.highTokenUsageWarnings && !state.contextWarned && occupancy >= prefs.highContextUsagePercent / 100) {
      state.contextWarned = true
      this.warn(record, 'context', `Reported context is ${Math.round(occupancy * 100)}% of the model window. Long prompts can increase usage and trigger compaction. This is context occupancy, not billed token usage. Work has not been stopped.`)
    }
    this.host.save(record)
  }

  private warn(record: SessionRecord, type: string, body: string): void {
    this.host.notify({ kind: 'high-token-usage', severity: 'warning', sourceRole: this.role(record), route: 'operator',
      title: `${record.title ?? 'Agent'}: high ${type === 'context' ? 'context' : 'token'} usage`, body,
      sessionId: record.id, projectId: record.projectId, dedupeKey: `token-warning:${record.id}:${record.tokenWarning!.turn}:${type}` })
    this.host.audit(record.id, 'session/token-warning', { turn: record.tokenWarning!.turn, type, body })
  }

  private role(record: SessionRecord): 'overseer' | 'manager' | 'agent' {
    return record.isOverseer ? 'overseer' : record.isProjectManager ? 'manager' : 'agent'
  }
}
