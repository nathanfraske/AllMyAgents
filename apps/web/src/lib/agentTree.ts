/**
 * Reconstruct the AGENT TREE for a chat: which sub-agents this session spawned, what each one is doing
 * right now, and how it ended.
 *
 * All of this already exists in the journal and always has — a spawn is an `Agent`/`Task` tool call, and
 * every message produced inside that agent carries the spawning tool_use id on its event envelope
 * (`parent_tool_use_id`, surfaced as `agentId`). The hub stored it; nothing ever read it. So this is a
 * pure re-reading of existing history: no hub change, no schema change, and it works on chats that were
 * recorded before the panel existed.
 *
 * Kept as a pure function over a structural item type so it is unit-testable without the store, Svelte,
 * or a live hub.
 */

/** The subset of a thread item this module needs (ThreadItem satisfies it structurally). */
export interface AgentTreeItem {
  kind: string
  ts: string
  text?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: string
  toolError?: boolean
  toolUseId?: string
  toolResultTs?: string
  agentId?: string
  subagentType?: string
  taskDescription?: string
}

/** Tool names that spawn a sub-agent. `Agent` is the current one; `Task` is the older/alternate name. */
export const SPAWN_TOOLS = new Set(['Agent', 'Task'])

export type AgentStatus = 'running' | 'done' | 'failed'

/** Generic over the item type so a caller passing full ThreadItems gets ThreadItems back in `activity`
 *  — that is what lets the panel render a sub-agent's output with the same ItemCard the main thread uses. */
export interface AgentRun<T extends AgentTreeItem = AgentTreeItem> {
  /** The spawning tool_use id — also the `agentId` its own items carry. */
  id: string
  /** Human label for the run (the spawn's `description`, else its task description). */
  description: string
  subagentType?: string
  background: boolean
  startedAt: string
  /** Set once the tool_result came back. */
  endedAt?: string
  status: AgentStatus
  /** The agent's returned report (truncated by the transport, not here). */
  result?: string
  /** Everything the agent itself produced, in order. */
  activity: T[]
  /** Tool calls the agent made — the cheapest "is it actually working" signal. */
  toolCount: number
  /** Set when this agent was spawned by ANOTHER agent, enabling real nesting. */
  parentId?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/**
 * A BACKGROUND spawn's tool_result is a LAUNCH ACK ("Async agent launched successfully … agentId: …"),
 * not the agent's report — it comes back within a second while the agent runs for minutes. Treating
 * "has a result" as "finished" therefore marked every background agent done the instant it started, and
 * froze its duration at ~0s. Detect the ack so those runs stay RUNNING until real completion.
 */
function launchAckId(result: string | undefined): string | undefined {
  if (!result) return undefined
  return /agentId[":\s]+([a-z0-9]{6,})/i.exec(result)?.[1]
}

/**
 * Completion for a background agent arrives later as a task notification naming its agentId. Scan the
 * transcript for one so a finished background run stops reading as running.
 */
function backgroundOutcome(items: readonly AgentTreeItem[], agentId: string): { done: boolean; failed: boolean; ts?: string } {
  for (const it of items) {
    const text = it.text ?? it.toolResult ?? ''
    if (!text.includes(agentId)) continue
    if (/task-notification|status>|completed|finished|stopped/i.test(text)) {
      return { done: true, failed: /\bstopped\b|\berror\b|\bfailed\b/i.test(text), ts: it.ts }
    }
  }
  return { done: false, failed: false }
}

/**
 * Build every agent run in this chat, in spawn order. Runs with no matching activity still appear (an
 * agent that has not emitted anything yet is exactly what you want to SEE — it is the "is it stuck?"
 * case), so presence in this list is driven by the spawn call, never by whether output arrived.
 */
export function buildAgentRuns<T extends AgentTreeItem>(items: readonly T[]): AgentRun<T>[] {
  const runs: AgentRun<T>[] = []
  const byId = new Map<string, AgentRun<T>>()

  for (const it of items) {
    if (it.kind !== 'tool' || !it.toolName || !SPAWN_TOOLS.has(it.toolName) || !it.toolUseId) continue
    const input = (it.toolInput ?? {}) as { description?: unknown; subagent_type?: unknown; run_in_background?: unknown }
    const run: AgentRun<T> = {
      id: it.toolUseId,
      description: str(input.description) ?? str(it.taskDescription) ?? 'agent',
      subagentType: str(input.subagent_type),
      background: input.run_in_background === true,
      startedAt: it.ts,
      endedAt: it.toolResultTs,
      // A foreground run is RUNNING until its tool_result lands; the error flag decides done vs failed.
      status: it.toolResult === undefined ? 'running' : it.toolError ? 'failed' : 'done',
      result: it.toolResult,
      activity: [],
      toolCount: 0,
      // If the spawn call itself happened inside another agent, this run is nested under it.
      parentId: it.agentId,
    }
    // Background: the result is only an ACK, so ignore it as a completion signal and look for the real
    // outcome later in the transcript. Until that arrives the run is genuinely still going — which is
    // also what keeps its elapsed timer ticking instead of freezing at the ack.
    const ackId = run.background ? launchAckId(it.toolResult) : undefined
    if (ackId) {
      const outcome = backgroundOutcome(items, ackId)
      run.status = outcome.done ? (outcome.failed ? 'failed' : 'done') : 'running'
      run.endedAt = outcome.done ? outcome.ts : undefined
      run.result = outcome.done ? it.toolResult : undefined // the ack is not a report; don't show it as one
    }
    runs.push(run)
    byId.set(run.id, run)
  }

  for (const it of items) {
    if (!it.agentId) continue // main-thread item
    const run = byId.get(it.agentId)
    if (!run) continue // activity from a spawn we cannot see (e.g. history truncated) — ignore
    run.activity.push(it)
    if (it.kind === 'tool') run.toolCount++
  }

  return runs
}

/** Counts for a collapsed badge: how many are live vs finished. */
export function summarizeRuns(runs: readonly AgentRun[]): { running: number; done: number; failed: number; total: number } {
  let running = 0
  let done = 0
  let failed = 0
  for (const r of runs) {
    if (r.status === 'running') running++
    else if (r.status === 'failed') failed++
    else done++
  }
  return { running, done, failed, total: runs.length }
}

/** The agent's most recent signal, for a one-line "what is it doing now" in the panel. */
export function latestActivity<T extends AgentTreeItem>(run: AgentRun<T>): T | undefined {
  return run.activity.length ? run.activity[run.activity.length - 1] : undefined
}
