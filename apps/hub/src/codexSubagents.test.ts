import { describe, expect, it } from 'vitest'
import { CodexClient } from './adapters/codex.js'

type SeenEvent = { kind: string; payload: Record<string, unknown> }

function harness(): {
  ingest: (message: unknown) => void
  events: SeenEvent[]
  outbound: Record<string, unknown>[]
} {
  const events: SeenEvent[] = []
  const outbound: Record<string, unknown>[] = []
  const client = new CodexClient('unused', (kind, payload) => {
    events.push({ kind, payload: payload as Record<string, unknown> })
  })
  ;(client as unknown as { send(message: Record<string, unknown>): void }).send = (message) => {
    outbound.push(message)
  }
  const ingest = (message: unknown): void => {
    ;(client as unknown as { onLine(line: string): void }).onLine(JSON.stringify(message))
  }
  return { ingest, events, outbound }
}

describe('Codex sub-agent event routing', () => {
  it('routes a child thread through its root while preserving child identity', () => {
    const { ingest, events } = harness()
    ingest({
      method: 'thread/started',
      params: { thread: { id: 'root', parentThreadId: null } },
    })
    ingest({
      method: 'thread/started',
      params: { thread: { id: 'child', parentThreadId: 'root', agentRole: 'explorer' } },
    })
    ingest({
      method: 'item/completed',
      params: {
        threadId: 'child',
        turnId: 'child-turn',
        item: { type: 'agentMessage', id: 'answer', text: 'child answer' },
      },
    })

    expect(events[1]).toMatchObject({
      kind: 'codex/subagent/thread/started',
      payload: {
        threadId: 'root',
        agentThreadId: 'child',
        parentThreadId: 'root',
      },
    })
    expect(events[2]).toMatchObject({
      kind: 'codex/subagent/item/completed',
      payload: {
        threadId: 'root',
        agentThreadId: 'child',
        parentThreadId: 'root',
      },
    })
  })

  it('keeps nested agents attached to the same root and their immediate parent', () => {
    const { ingest, events } = harness()
    ingest({ method: 'thread/started', params: { thread: { id: 'root', parentThreadId: null } } })
    ingest({ method: 'thread/started', params: { thread: { id: 'outer', parentThreadId: 'root' } } })
    ingest({ method: 'thread/started', params: { thread: { id: 'inner', parentThreadId: 'outer' } } })
    ingest({
      method: 'turn/started',
      params: { threadId: 'inner', turn: { id: 'inner-turn', status: 'inProgress' } },
    })

    expect(events.at(-1)).toMatchObject({
      kind: 'codex/subagent/turn/started',
      payload: {
        threadId: 'root',
        agentThreadId: 'inner',
        parentThreadId: 'outer',
      },
    })
  })

  it('does not relabel root-thread notifications as sub-agent activity', () => {
    const { ingest, events } = harness()
    ingest({ method: 'thread/started', params: { thread: { id: 'root', parentThreadId: null } } })
    ingest({
      method: 'item/completed',
      params: {
        threadId: 'root',
        turnId: 'root-turn',
        item: { type: 'agentMessage', id: 'answer', text: 'root answer' },
      },
    })

    expect(events.at(-1)).toEqual({
      kind: 'codex/item/completed',
      payload: {
        threadId: 'root',
        turnId: 'root-turn',
        item: { type: 'agentMessage', id: 'answer', text: 'root answer' },
      },
    })
  })

  it('routes a child approval request through the root chat without losing attribution', () => {
    const { ingest, events } = harness()
    ingest({ method: 'thread/started', params: { thread: { id: 'root', parentThreadId: null } } })
    ingest({ method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root' } } })
    ingest({
      id: 40,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'child', turnId: 'child-turn', command: 'git status' },
    })

    expect(events.at(-1)).toMatchObject({
      kind: 'codex/request/item/commandExecution/requestApproval',
      payload: {
        threadId: 'root',
        agentThreadId: 'child',
        parentThreadId: 'root',
      },
    })
  })

  it('learns the child edge from the subAgentActivity item Codex 0.145 actually emits', () => {
    const { ingest, events, outbound } = harness()
    ingest({ method: 'thread/started', params: { thread: { id: 'root', parentThreadId: null } } })
    ingest({
      method: 'item/completed',
      params: {
        threadId: 'root',
        turnId: 'root-turn',
        item: {
          type: 'subAgentActivity',
          id: 'spawn-call',
          kind: 'started',
          agentThreadId: 'child',
          agentPath: '/root/inspect_package',
        },
      },
    })
    ingest({
      id: 41,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'child', turnId: 'child-turn', command: 'Get-Content package.json' },
    })

    expect(events.at(-1)).toMatchObject({
      kind: 'codex/request/item/commandExecution/requestApproval',
      payload: {
        threadId: 'root',
        agentThreadId: 'child',
        parentThreadId: 'root',
      },
    })
    expect(outbound).toContainEqual({
      id: expect.any(Number),
      method: 'thread/resume',
      params: { threadId: 'child' },
    })
  })
})
