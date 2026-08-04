import { describe, expect, it, vi } from 'vitest'
import { AgentWorker } from './agentWorker.js'
import type { AskUserQuestionInput, QuestionOutcome } from './questions.js'
import type { HubToWorker, WorkerSessionSpec, WorkerToHub } from './workerProtocol.js'

const INPUT: AskUserQuestionInput = {
  questions: [
    {
      question: 'Which database?',
      header: 'Database',
      options: [
        { label: 'SQLite', description: 'Embedded and local.' },
        { label: 'Postgres', description: 'A shared database.' },
      ],
      multiSelect: false,
    },
  ],
}

interface Gate {
  canUseTool(
    spec: WorkerSessionSpec,
    toolName: string,
    input: unknown,
    context?: { toolUseID?: string; requestId?: string; signal?: AbortSignal }
  ): Promise<{ behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }>
}

const SPEC = {
  sessionId: 's1',
  provider: 'claude',
  profileId: 'p1',
  profileDir: '/tmp/p1',
  cwd: '/tmp',
} as WorkerSessionSpec

function rpcReply(
  message: Extract<WorkerToHub, { t: 'rpc' }>,
  value: unknown,
): Extract<HubToWorker, { t: 'rpcResult' }> {
  return { t: 'rpcResult', callId: message.callId, ok: true, value }
}

describe('AgentWorker AskUserQuestion boundary', () => {
  it('relays a correlated question over the authenticated worker channel and returns the durable answer', async () => {
    const worker = new AgentWorker('\\\\.\\pipe\\ama-question-never-bound')
    const gate = worker as unknown as Gate
    const outcome: QuestionOutcome = {
      kind: 'answered',
      updatedInput: { questions: INPUT.questions, answers: { 'Which database?': 'SQLite' } },
    }
    const relay = vi.fn(async (message: WorkerToHub) => {
      if (message.t !== 'rpc' || message.method !== 'questions.request') {
        throw new Error('unexpected relay')
      }
      return rpcReply(message, outcome)
    })
    ;(worker as unknown as { server: { relay: typeof relay } }).server = { relay }

    await expect(
      gate.canUseTool(SPEC, 'AskUserQuestion', INPUT, {
        toolUseID: 'toolu_ask',
        requestId: 'control_ask',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ behavior: 'allow', updatedInput: outcome.updatedInput })
    expect(relay).toHaveBeenCalledTimes(1)
    expect(relay.mock.calls[0]?.[0]).toMatchObject({
      t: 'rpc',
      method: 'questions.request',
      args: {
        sessionId: 's1',
        toolUseId: 'toolu_ask',
        requestId: 'control_ask',
        input: INPUT,
      },
    })
  })

  it('fails closed without serializing malformed input or missing SDK correlation', async () => {
    const worker = new AgentWorker('\\\\.\\pipe\\ama-question-never-bound')
    const gate = worker as unknown as Gate
    const relay = vi.fn()
    ;(worker as unknown as { server: { relay: typeof relay } }).server = { relay }

    await expect(
      gate.canUseTool(SPEC, 'AskUserQuestion', { questions: [] }, undefined)
    ).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('required SDK correlation'),
    })
    expect(relay).not.toHaveBeenCalled()
  })

  it('relays an interrupt as a correlated question abort', async () => {
    const worker = new AgentWorker('\\\\.\\pipe\\ama-question-never-bound')
    const gate = worker as unknown as Gate
    const controller = new AbortController()
    let settleRequest!: (value: Extract<HubToWorker, { t: 'rpcResult' }>) => void
    const relay = vi.fn((message: WorkerToHub): Promise<Extract<HubToWorker, { t: 'rpcResult' }>> => {
      if (message.t !== 'rpc') throw new Error('unexpected relay')
      if (message.method === 'questions.request') {
        return new Promise((resolve) => { settleRequest = resolve })
      }
      if (message.method === 'questions.abort') {
        settleRequest(rpcReply(message, { kind: 'cancelled', reason: 'aborted' }))
        return Promise.resolve(rpcReply(message, true))
      }
      throw new Error('unexpected method')
    })
    ;(worker as unknown as { server: { relay: typeof relay } }).server = { relay }

    const pending = gate.canUseTool(SPEC, 'AskUserQuestion', INPUT, {
      toolUseID: 'toolu_abort',
      requestId: 'control_abort',
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(relay).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: 'The question was cancelled because the turn was interrupted.',
    })
    expect(relay.mock.calls.map((call) => (call[0] as Extract<WorkerToHub, { t: 'rpc' }>).method)).toEqual([
      'questions.request',
      'questions.abort',
    ])
  })
})
