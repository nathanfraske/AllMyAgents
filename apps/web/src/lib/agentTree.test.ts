import { describe, it, expect } from 'vitest'
import { buildAgentRuns, summarizeRuns, latestActivity, STALLED_AFTER_MS, type AgentTreeItem } from './agentTree'

const T0 = '2026-07-25T10:00:00.000Z'
const at = (msAfterT0: number): string => new Date(Date.parse(T0) + msAfterT0).toISOString()
// One minute after the spawn — inside the staleness window, so any test not ABOUT staleness reads
// naturally. `buildAgentRuns` takes `now` explicitly precisely so these stay deterministic.
const NOW = Date.parse(at(60_000))
const build = (items: AgentTreeItem[], now: number = NOW): ReturnType<typeof buildAgentRuns<AgentTreeItem>> =>
  buildAgentRuns(items, now)

/**
 * The real tool_result a backgrounded spawn returns, verbatim from this hub's journal (every sub-agent
 * spawn in it returned this same 1075-char text). It is internal metadata, not a report — the fixture is
 * kept realistic because recognising it is load-bearing, and a paraphrase would test nothing.
 */
const LAUNCH_ACK = `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)
agentId: a8d7352e676bd71b1 (internal ID - do not mention to user. Use SendMessage with to: 'a8d7352e676bd71b1', summary: '<5-10 word recap>' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes.
output_file: C:\\Users\\Admin\\AppData\\Local\\Temp\\claude\\tasks\\a8d7352e676bd71b1.output`

const spawn = (id: string, description: string, extra: Partial<AgentTreeItem> = {}): AgentTreeItem => ({
  kind: 'tool',
  ts: T0,
  toolName: 'Agent',
  toolUseId: id,
  toolInput: { description, subagent_type: 'general-purpose', prompt: '…' },
  ...extra,
})
/** A spawn as it really lands: `run_in_background` absent (the SDK backgrounds agents by default) and the
 *  launch ack already returned within a second. */
const bgSpawn = (id: string, description: string, extra: Partial<AgentTreeItem> = {}): AgentTreeItem =>
  spawn(id, description, { toolResult: LAUNCH_ACK, toolResultTs: at(900), ...extra })
const inAgent = (agentId: string, over: Partial<AgentTreeItem> = {}): AgentTreeItem => ({
  kind: 'assistant',
  ts: at(5_000),
  text: 'working',
  agentId,
  ...over,
})

describe('buildAgentRuns', () => {
  it('finds a spawned agent and attributes its own activity to it', () => {
    const runs = build([
      { kind: 'assistant', ts: T0, text: 'main thread' },
      spawn('toolu_a', 'Re-integrate the branch'),
      inAgent('toolu_a', { text: 'reading files' }),
      inAgent('toolu_a', { kind: 'tool', toolName: 'Read', toolUseId: 'toolu_x' }),
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.description).toBe('Re-integrate the branch')
    expect(runs[0]!.subagentType).toBe('general-purpose')
    expect(runs[0]!.activity).toHaveLength(2)
    expect(runs[0]!.toolCount).toBe(1)
  })

  it('main-thread items are never attributed to an agent', () => {
    const runs = build([spawn('toolu_a', 'x'), { kind: 'assistant', ts: 't', text: 'main' }])
    expect(runs[0]!.activity).toHaveLength(0)
  })

  // The "is it stuck?" case: a spawn that has produced nothing yet must still be visible.
  it('lists a spawned agent that has emitted nothing, as running', () => {
    const runs = build([spawn('toolu_a', 'just started')])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('running')
    expect(runs[0]!.activity).toEqual([])
  })

  it('is running until the tool_result lands, then done', () => {
    const running = build([spawn('toolu_a', 'x')])[0]!
    expect(running.status).toBe('running')
    expect(running.endedAt).toBeUndefined()
    const finished = build([spawn('toolu_a', 'x', { toolResult: 'the report', toolResultTs: at(240_000) })])[0]!
    expect(finished.status).toBe('done')
    expect(finished.result).toBe('the report')
    expect(finished.endedAt).toBe(at(240_000))
  })

  it('marks a failed run', () => {
    const run = build([spawn('toolu_a', 'x', { toolResult: 'boom', toolError: true })])[0]!
    expect(run.status).toBe('failed')
  })

  it('carries the background flag', () => {
    const bg = build([{ ...spawn('toolu_a', 'x'), toolInput: { description: 'x', run_in_background: true } }])[0]!
    expect(bg.background).toBe(true)
  })

  it('nests an agent spawned by another agent', () => {
    const runs = build([
      spawn('outer', 'outer agent'),
      { ...spawn('inner', 'inner agent'), agentId: 'outer' }, // the spawn call happened INSIDE outer
    ])
    expect(runs.find((r) => r.id === 'inner')!.parentId).toBe('outer')
    expect(runs.find((r) => r.id === 'outer')!.parentId).toBeUndefined()
  })

  it('ignores activity whose spawn is not present (truncated history)', () => {
    expect(build([inAgent('vanished')])).toEqual([])
  })

  it('handles the alternate Task spawn tool name', () => {
    expect(build([{ ...spawn('toolu_a', 'x'), toolName: 'Task' }])).toHaveLength(1)
  })

  it('does not treat an ordinary tool call as a spawn', () => {
    expect(build([{ kind: 'tool', ts: 't', toolName: 'Bash', toolUseId: 'b1' }])).toEqual([])
  })
})

/**
 * THE BUG THIS MODULE EXISTS TO PREVENT. A backgrounded spawn's tool_result comes back in under a second
 * and is a LAUNCH ACK, not a report. Reading it as a completion marked every sub-agent `done` the instant
 * it started, froze its duration at ~0s, and printed the ack's internal metadata as the agent's answer.
 */
describe('the launch ack is not a result', () => {
  it('a freshly-spawned background agent is running, not done', () => {
    const run = build([bgSpawn('toolu_a', 'Research the thing')], Date.parse(at(10_000)))[0]!
    expect(run.status).toBe('running')
    expect(run.endedAt).toBeUndefined()
  })

  it('never surfaces the ack as the agent report', () => {
    const run = build([bgSpawn('toolu_a', 'x')], Date.parse(at(10_000)))[0]!
    expect(run.result).toBeUndefined()
  })

  it('recognises a background spawn from the ack even when run_in_background is absent', () => {
    // The SDK (0.3.218) documents run_in_background as defaulting to TRUE, so the flag is simply missing
    // on most real background spawns — which is exactly how they got classified foreground.
    const run = build([bgSpawn('toolu_a', 'x')], Date.parse(at(10_000)))[0]!
    expect((run as { background: boolean }).background).toBe(true)
  })

  it('still trusts a REAL tool_result — a synchronous spawn returns its report there', () => {
    // Guards the ack detector against over-matching: this report TALKS about agents and agentIds, which a
    // substring hunt would have swallowed. The match is anchored on the vendor's opening words instead.
    const report = 'Here is what I found. The agentId plumbing is fine; async agent launches look correct.'
    const run = build([spawn('toolu_a', 'x', { toolResult: report, toolResultTs: at(120_000) })])[0]!
    expect(run.status).toBe('done')
    expect(run.result).toBe(report)
    expect(run.background).toBe(false)
    expect(run.outcome).toBe('completed')
  })
})

/**
 * Status now comes from the vendor's own `task_notification` (journaled as `claude/system`, merged onto the
 * spawn item by the store) instead of being inferred from the ack's prose.
 */
describe('vendor task lifecycle', () => {
  it('a completed run is done, and reports the vendor summary rather than the ack', () => {
    const run = build([
      bgSpawn('toolu_a', 'Trace the input path', {
        agentTaskId: 'a3bed3da30bf970eb',
        agentOutcome: 'completed',
        agentOutcomeTs: at(300_000),
        agentSummary: 'I traced the entire input path. The composer is never disabled by an error.',
      }),
    ])[0]!
    expect(run.status).toBe('done')
    expect(run.result).toBe('I traced the entire input path. The composer is never disabled by an error.')
    expect(run.endedAt).toBe(at(300_000)) // the real end, not the ack's ~1s
  })

  it('a failed run is failed — visibly not done', () => {
    const run = build([
      bgSpawn('toolu_a', 'x', { agentOutcome: 'failed', agentOutcomeTs: at(300_000), agentSummary: 'x' }),
    ])[0]!
    expect(run.status).toBe('failed')
    expect(run.status).not.toBe('done')
    expect(run.outcome).toBe('failed')
  })

  it('a stopped run is a failure, but keeps `stopped` as its outcome', () => {
    // A killed agent did not succeed, so it must not read green; but "stopped" and "crashed" are
    // different facts and the panel says which.
    const run = build([bgSpawn('toolu_a', 'x', { agentOutcome: 'stopped', agentOutcomeTs: at(300_000) })])[0]!
    expect(run.status).toBe('failed')
    expect(run.outcome).toBe('stopped')
  })

  it('surfaces the vendor heartbeat for an agent whose own steps were never attributed here', () => {
    const run = build([
      bgSpawn('toolu_a', 'x', { agentProgressTs: at(30_000), agentLastTool: 'Bash', agentToolUses: 42 }),
    ])[0]!
    expect(run.toolCount).toBe(0) // nothing of the agent's landed in this transcript…
    expect(run.toolUses).toBe(42) // …but the vendor counted 42
    expect(run.lastTool).toBe('Bash')
  })
})

describe('stalled', () => {
  it('goes stalled once nothing has been heard for longer than the threshold', () => {
    const items = [bgSpawn('toolu_a', 'x', { agentProgressTs: at(30_000) })]
    expect(build(items, Date.parse(at(30_000 + STALLED_AFTER_MS - 1000)))[0]!.status).toBe('running')
    expect(build(items, Date.parse(at(30_000 + STALLED_AFTER_MS + 1000)))[0]!.status).toBe('stalled')
  })

  it('a live heartbeat keeps a long-running agent out of stalled', () => {
    // 20 minutes in and still reporting: long, not stuck. Elapsed time alone must not condemn it.
    const run = build(
      [bgSpawn('toolu_a', 'x', { agentProgressTs: at(1_200_000) })],
      Date.parse(at(1_200_000 + 30_000))
    )[0]!
    expect(run.status).toBe('running')
  })

  it('the agent\u2019s own output counts as a sign of life, with no heartbeat at all', () => {
    const run = build(
      [bgSpawn('toolu_a', 'x'), inAgent('toolu_a', { ts: at(1_200_000), text: 'still going' })],
      Date.parse(at(1_200_000 + 30_000))
    )[0]!
    expect(run.status).toBe('running')
  })

  it('never overrides a terminal outcome — a finished run cannot go stale', () => {
    // Replayed from a year-old journal: both are long past the threshold, and both must keep the verdict
    // the vendor gave them. A failure in particular must not be laundered into "stalled" (or, as before,
    // into "done") just because time has passed.
    const ancient = Date.parse(at(99_999_999))
    const done = build([bgSpawn('a', 'x', { agentOutcome: 'completed', agentOutcomeTs: at(60_000), agentSummary: 'ok' })], ancient)[0]!
    const failed = build([bgSpawn('b', 'x', { agentOutcome: 'failed', agentOutcomeTs: at(60_000) })], ancient)[0]!
    expect(done.status).toBe('done')
    expect(failed.status).toBe('failed')
  })
})

/**
 * REPLAY OF AN OLDER JOURNAL. The lifecycle fields only exist on chats recorded after the store learned to
 * read `claude/system`; every earlier journal replays with none of them. The rule is degrade to what is
 * knowable — never crash, and never claim a state the rows cannot support.
 */
describe('legacy journals with no lifecycle rows', () => {
  it('a backgrounded spawn degrades to running/stalled, never to a confident done', () => {
    const legacy = [bgSpawn('toolu_a', 'Research t3code attachments')]
    expect(build(legacy, Date.parse(at(10_000)))[0]!.status).toBe('running')
    // Long after the fact — replayed from history — it is honestly unknown, so it reads stalled.
    const replayed = build(legacy, Date.parse(at(86_400_000)))[0]!
    expect(replayed.status).toBe('stalled')
    expect(replayed.status).not.toBe('done')
    expect(replayed.result).toBeUndefined()
  })

  it('an item carrying none of the new fields builds without throwing', () => {
    const runs = build([
      { kind: 'tool', ts: T0, toolName: 'Agent', toolUseId: 'toolu_a', toolInput: { description: 'legacy' } },
      { kind: 'assistant', ts: T0, text: 'agent output', agentId: 'toolu_a' },
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.outcome).toBeUndefined()
    expect(runs[0]!.lastSignalAt).toBe(Date.parse(T0))
  })

  it('an unparseable timestamp does not produce a NaN clock or a bogus stall', () => {
    const run = build([{ kind: 'tool', ts: 'not-a-date', toolName: 'Agent', toolUseId: 'toolu_a' }])[0]!
    expect(Number.isFinite(run.lastSignalAt)).toBe(true)
    expect(['running', 'stalled']).toContain(run.status)
  })
})

describe('summarizeRuns / latestActivity', () => {
  it('counts by status', () => {
    const runs = build([
      spawn('a', 'one'),
      spawn('b', 'two', { toolResult: 'ok' }),
      spawn('c', 'three', { toolResult: 'bad', toolError: true }),
      bgSpawn('d', 'four'), // launched, never heard from again
    ], Date.parse(at(STALLED_AFTER_MS + 60_000)))
    expect(summarizeRuns(runs)).toEqual({ running: 0, done: 1, failed: 1, stalled: 2, total: 4 })
  })

  it('returns the newest item an agent produced', () => {
    const run = build([spawn('a', 'x'), inAgent('a', { text: 'first' }), inAgent('a', { text: 'latest' })])[0]!
    expect(latestActivity(run)?.text).toBe('latest')
  })
})
