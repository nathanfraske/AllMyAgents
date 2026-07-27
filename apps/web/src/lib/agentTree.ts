/**
 * Reconstruct the AGENT TREE for a chat: which sub-agents this session spawned, what each one is doing
 * right now, and how it ended.
 *
 * Membership is normalized by the store to an `Agent`/`Task` tool item. Claude correlates child output
 * with the spawning `tool_use` id; Codex correlates it with the spawned child thread id. Both surface here
 * as `agentId`, so the tree and panel do not need vendor branches.
 *
 * STATUS is never guessed from prose. Claude supplies `task_started` / `task_progress` /
 * `task_notification`; Codex supplies parent `subAgentActivity` edges, subscribed child
 * `turn/started` / `turn/completed`, and structured `CollabAgentState`. The store merges either lifecycle
 * onto the spawn item. Everything below reads those fields first and only falls back to a real tool_result
 * for older Claude journals.
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
  // --- Vendor task lifecycle, merged onto the SPAWN item by the store. Absent on older journals. ---
  /** Claude's `task_id` — the correlation fallback for lifecycle rows that omit `tool_use_id`. */
  agentTaskId?: string
  /** Terminal outcome from Claude task or Codex child-turn lifecycle. Its presence makes a run final. */
  agentOutcome?: AgentOutcome
  agentOutcomeTs?: string
  /** The agent's actual report, as the vendor summarized it. */
  agentSummary?: string
  /** Timestamp of the newest `task_progress` heartbeat — the liveness signal behind `stalled`. */
  agentProgressTs?: string
  agentLastTool?: string
  agentToolUses?: number
}

/** Tool names that spawn a sub-agent. `Agent` is the current one; `Task` is the older/alternate name. */
export const SPAWN_TOOLS = new Set(['Agent', 'Task'])

/** The vendor's own terminal words (`SDKTaskNotificationMessage.status`), kept verbatim so the panel can
 *  say "stopped" rather than flattening a deliberate kill into an error. */
export type AgentOutcome = 'completed' | 'failed' | 'stopped'

export type AgentStatus = 'running' | 'done' | 'failed' | 'stalled'

/**
 * How long a non-terminal run may go without a single sign of life before it reads STALLED.
 *
 * Grounded in measured cadence, not picked: across every sub-agent run in this hub's journal the
 * `task_progress` heartbeat arrived with a median gap of 4-13s, p90 under 27s, and a worst observed gap of
 * 102s. 3 minutes therefore sits well clear of normal quiet (a long Bash step, a slow model call) while
 * still catching the case this exists for — a run whose CLI process died, or whose hub was restarted, so
 * the terminal `task_notification` is never coming and the run would otherwise show "running" forever.
 *
 * STALLED IS EXPLICITLY "WE STOPPED HEARING FROM IT", NOT "IT FAILED". We cannot distinguish a wedged
 * agent from one whose completion we simply missed, so it is its own state rather than being folded into
 * `failed` — claiming failure here would be the same overconfidence that made everything read `done`.
 */
export const STALLED_AFTER_MS = 180_000

/** Generic over the item type so a caller passing full ThreadItems gets ThreadItems back in `activity`
 *  — that is what lets the panel render a sub-agent's output with the same ItemCard the main thread uses. */
export interface AgentRun<T extends AgentTreeItem = AgentTreeItem> {
  /** Vendor correlation id (Claude tool_use id / Codex child thread id), also carried by its own items. */
  id: string
  /** Claude SDK task id used by Query.stopTask. Codex runs use their child thread id (`id`) instead. */
  taskId?: string
  /** Human label for the run (the spawn's `description`, else its task description). */
  description: string
  subagentType?: string
  background: boolean
  startedAt: string
  /** Set once the run genuinely ended. Never set from the launch ack. */
  endedAt?: string
  status: AgentStatus
  /** The vendor's terminal word, when we have one — distinguishes a killed run from a crashed one. */
  outcome?: AgentOutcome
  /** The agent's returned report: its lifecycle summary, else a real (non-ack) tool_result. */
  result?: string
  /** Everything the agent itself produced, in order. */
  activity: T[]
  /** Tool calls of the agent's own that THIS chat recorded — the cheapest "is it actually working" signal. */
  toolCount: number
  /** The vendor's own tool-use count from the heartbeat. Covers a background agent whose steps never
   *  landed in this transcript, where `toolCount` is stuck at 0 however hard it is working. */
  toolUses?: number
  /** Newest tool name the vendor reported for a live run — the only progress signal for an agent whose
   *  own messages are not attributed back to this chat. */
  lastTool?: string
  /** The most recent moment we had ANY evidence this run was alive (ms epoch). Drives `stalled`. */
  lastSignalAt: number
  /** Set when this agent was spawned by ANOTHER agent, enabling real nesting. */
  parentId?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function ms(ts: string | undefined): number {
  const n = ts ? Date.parse(ts) : NaN
  return Number.isFinite(n) ? n : 0
}

/**
 * A BACKGROUND spawn's tool_result is a LAUNCH ACK, not the agent's report — it comes back within a second
 * while the agent runs for minutes, and its body is internal metadata the SDK explicitly says must never be
 * surfaced ("This tool result is internal metadata — never quote or paste any part of it"). It is ~1KB of
 * an internal agentId, a temp transcript path, and three paragraphs addressed to the MODEL.
 *
 * Two bugs came out of not recognising it. Treating "has a result" as "finished" marked every background
 * agent done the instant it started and froze its duration at ~0s; and rendering that result as the run's
 * report put the metadata blob on screen under a "returned" label, as if the agent had said it.
 *
 * Anchored on the vendor's own opening words rather than sniffed for an id, because this must be a decision
 * about WHICH KIND of result this is, and a substring hunt would misfire on a real report that happens to
 * discuss agents. Verified against every sub-agent spawn in this hub's journal (9/9 acks matched) and
 * against the string table in the shipped CLI.
 */
const LAUNCH_ACK = /^(?:Async agent launched successfully|Cloud agent launched)\b/

function isLaunchAck(result: string | undefined): boolean {
  return result !== undefined && LAUNCH_ACK.test(result.trimStart())
}

/**
 * Build every agent run in this chat, in spawn order. Claude contributes real Agent/Task tool uses;
 * Codex contributes synthetic Agent items keyed by the child thread id after its structured
 * `subAgentActivity` edge. Runs with no matching activity still appear (an agent that has not emitted
 * anything yet is exactly what you want to SEE — it is the "is it stuck?" case), so presence in this
 * list is driven by the spawn call, never by whether output arrived.
 *
 * `now` is a parameter, not a `Date.now()` read inside, because `stalled` is a statement about elapsed
 * time and a function that silently consults the clock cannot be tested for the boundary it exists to draw.
 */
export function buildAgentRuns<T extends AgentTreeItem>(items: readonly T[], now: number = Date.now()): AgentRun<T>[] {
  const runs: AgentRun<T>[] = []
  const byId = new Map<string, AgentRun<T>>()

  for (const it of items) {
    if (it.kind !== 'tool' || !it.toolName || !SPAWN_TOOLS.has(it.toolName) || !it.toolUseId) continue
    const input = (it.toolInput ?? {}) as { description?: unknown; subagent_type?: unknown; run_in_background?: unknown }
    // `run_in_background` alone UNDER-REPORTS: the SDK (0.3.218) documents it as "Agents run in the
    // background by default", so the flag is simply absent on most background spawns — which is how a
    // backgrounded agent got classified foreground and its ack read as a finished report. The ack itself
    // is the reliable tell, and it works on old journals too.
    const background = input.run_in_background === true || isLaunchAck(it.toolResult)
    // A launch ack is not a result at all, so it must not supply the report, the end time, or the verdict.
    const realResult = isLaunchAck(it.toolResult) ? undefined : it.toolResult
    const run: AgentRun<T> = {
      id: it.toolUseId,
      taskId: it.agentTaskId,
      description: str(input.description) ?? str(it.taskDescription) ?? 'agent',
      subagentType: str(input.subagent_type) ?? str(it.subagentType),
      background,
      startedAt: it.ts,
      status: 'running',
      outcome: it.agentOutcome,
      activity: [],
      toolCount: 0,
      toolUses: it.agentToolUses,
      lastTool: str(it.agentLastTool),
      // Seeded with the spawn itself: a run we have heard nothing from is measured from when it started,
      // so a brand-new spawn is never instantly stalled.
      lastSignalAt: Math.max(ms(it.ts), ms(it.agentProgressTs), ms(it.agentOutcomeTs)),
      // If the spawn call itself happened inside another agent, this run is nested under it.
      parentId: it.agentId,
    }
    if (it.agentOutcome) {
      // THE REAL SIGNAL. The vendor lifecycle is telling us the run ended and how — the only source that
      // separates a completed agent from one that was killed or errored.
      run.status = it.agentOutcome === 'completed' ? 'done' : 'failed'
      run.endedAt = it.agentOutcomeTs ?? it.toolResultTs
      run.result = str(it.agentSummary) ?? realResult
    } else if (realResult !== undefined) {
      // No lifecycle rows (an older journal, or a synchronous spawn whose tool_result IS the report):
      // the tool_result is then a genuine completion and the error flag decides done vs failed.
      run.status = it.toolError ? 'failed' : 'done'
      run.endedAt = it.toolResultTs
      run.result = realResult
      run.outcome = it.toolError ? 'failed' : 'completed'
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
    // Anything the agent itself emitted is proof of life, independent of the heartbeat.
    run.lastSignalAt = Math.max(run.lastSignalAt, ms(it.ts))
  }

  // Staleness is resolved last because a run's newest activity is only known after the pass above.
  for (const run of runs) {
    if (run.status === 'running' && now - run.lastSignalAt > STALLED_AFTER_MS) run.status = 'stalled'
  }

  return runs
}

/** Counts for a collapsed badge: how many are live vs finished. */
export function summarizeRuns(runs: readonly AgentRun[]): {
  running: number
  done: number
  failed: number
  stalled: number
  total: number
} {
  let running = 0
  let done = 0
  let failed = 0
  let stalled = 0
  for (const r of runs) {
    if (r.status === 'running') running++
    else if (r.status === 'failed') failed++
    else if (r.status === 'stalled') stalled++
    else done++
  }
  return { running, done, failed, stalled, total: runs.length }
}

/** The agent's most recent signal, for a one-line "what is it doing now" in the panel. */
export function latestActivity<T extends AgentTreeItem>(run: AgentRun<T>): T | undefined {
  return run.activity.length ? run.activity[run.activity.length - 1] : undefined
}
