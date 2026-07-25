import { describe, it, expect } from 'vitest'
import { buildAgentRuns, summarizeRuns, latestActivity, type AgentTreeItem } from './agentTree'

const spawn = (id: string, description: string, extra: Partial<AgentTreeItem> = {}): AgentTreeItem => ({
  kind: 'tool',
  ts: '2026-07-25T10:00:00.000Z',
  toolName: 'Agent',
  toolUseId: id,
  toolInput: { description, subagent_type: 'general-purpose', prompt: '…' },
  ...extra,
})
const inAgent = (agentId: string, over: Partial<AgentTreeItem> = {}): AgentTreeItem => ({
  kind: 'assistant',
  ts: '2026-07-25T10:00:05.000Z',
  text: 'working',
  agentId,
  ...over,
})

describe('buildAgentRuns', () => {
  it('finds a spawned agent and attributes its own activity to it', () => {
    const runs = buildAgentRuns([
      { kind: 'assistant', ts: 't0', text: 'main thread' },
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
    const runs = buildAgentRuns([spawn('toolu_a', 'x'), { kind: 'assistant', ts: 't', text: 'main' }])
    expect(runs[0]!.activity).toHaveLength(0)
  })

  // The "is it stuck?" case: a spawn that has produced nothing yet must still be visible.
  it('lists a spawned agent that has emitted nothing, as running', () => {
    const runs = buildAgentRuns([spawn('toolu_a', 'just started')])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('running')
    expect(runs[0]!.activity).toEqual([])
  })

  it('is running until the tool_result lands, then done', () => {
    const running = buildAgentRuns([spawn('toolu_a', 'x')])[0]!
    expect(running.status).toBe('running')
    expect(running.endedAt).toBeUndefined()
    const finished = buildAgentRuns([
      spawn('toolu_a', 'x', { toolResult: 'the report', toolResultTs: '2026-07-25T10:04:00.000Z' }),
    ])[0]!
    expect(finished.status).toBe('done')
    expect(finished.result).toBe('the report')
    expect(finished.endedAt).toBe('2026-07-25T10:04:00.000Z')
  })

  it('marks a failed run', () => {
    const run = buildAgentRuns([spawn('toolu_a', 'x', { toolResult: 'boom', toolError: true })])[0]!
    expect(run.status).toBe('failed')
  })

  it('carries the background flag', () => {
    const bg = buildAgentRuns([
      { ...spawn('toolu_a', 'x'), toolInput: { description: 'x', run_in_background: true } },
    ])[0]!
    expect(bg.background).toBe(true)
  })

  it('nests an agent spawned by another agent', () => {
    const runs = buildAgentRuns([
      spawn('outer', 'outer agent'),
      { ...spawn('inner', 'inner agent'), agentId: 'outer' }, // the spawn call happened INSIDE outer
    ])
    expect(runs.find((r) => r.id === 'inner')!.parentId).toBe('outer')
    expect(runs.find((r) => r.id === 'outer')!.parentId).toBeUndefined()
  })

  it('ignores activity whose spawn is not present (truncated history)', () => {
    const runs = buildAgentRuns([inAgent('vanished')])
    expect(runs).toEqual([])
  })

  it('handles the alternate Task spawn tool name', () => {
    const runs = buildAgentRuns([{ ...spawn('toolu_a', 'x'), toolName: 'Task' }])
    expect(runs).toHaveLength(1)
  })

  it('does not treat an ordinary tool call as a spawn', () => {
    expect(buildAgentRuns([{ kind: 'tool', ts: 't', toolName: 'Bash', toolUseId: 'b1' }])).toEqual([])
  })
})

describe('summarizeRuns / latestActivity', () => {
  it('counts by status', () => {
    const runs = buildAgentRuns([
      spawn('a', 'one'),
      spawn('b', 'two', { toolResult: 'ok' }),
      spawn('c', 'three', { toolResult: 'bad', toolError: true }),
    ])
    expect(summarizeRuns(runs)).toEqual({ running: 1, done: 1, failed: 1, total: 3 })
  })

  it('returns the newest item an agent produced', () => {
    const run = buildAgentRuns([
      spawn('a', 'x'),
      inAgent('a', { text: 'first' }),
      inAgent('a', { text: 'latest' }),
    ])[0]!
    expect(latestActivity(run)?.text).toBe('latest')
  })
})
