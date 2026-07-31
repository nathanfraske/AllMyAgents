import { describe, expect, it, vi } from 'vitest'
import { AgentWorker } from './agentWorker.js'
import type { AskUserQuestionInput } from './questions.js'
import type { WorkerSessionSpec, WorkerToHub } from './workerProtocol.js'

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
  relayApproval(sessionId: string, kind: string, payload: unknown): Promise<boolean>
}

const SPEC = {
  sessionId: 's1',
  provider: 'claude',
  profileId: 'p1',
  profileDir: '/tmp/p1',
  cwd: '/tmp',
} as WorkerSessionSpec

describe('AgentWorker AskUserQuestion boundary', () => {
  it('fails closed before sending prompt/correlation bytes over the unauthenticated worker socket', async () => {
    const worker = new AgentWorker('\\\\.\\pipe\\ama-question-never-bound')
    const gate = worker as unknown as Gate
    const relay = vi.fn(async (_message: WorkerToHub) => {
      throw new Error('no question frame may leave the worker')
    })
    ;(worker as unknown as { server: { relay: typeof relay } }).server = { relay }
    gate.relayApproval = vi.fn(async () => true)

    await expect(
      gate.canUseTool(SPEC, 'AskUserQuestion', INPUT, {
        toolUseID: 'toolu_ask',
        requestId: 'control_ask',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({
      behavior: 'deny',
      message:
        'AskUserQuestion is unavailable in worker mode until the worker control channel is authenticated.',
    })
    expect(relay).not.toHaveBeenCalled()
    expect(gate.relayApproval).not.toHaveBeenCalled()
  })

  it('does not serialize even malformed or missing-correlation question input in worker mode', async () => {
    const worker = new AgentWorker('\\\\.\\pipe\\ama-question-never-bound')
    const gate = worker as unknown as Gate
    const relay = vi.fn()
    ;(worker as unknown as { server: { relay: typeof relay } }).server = { relay }

    await expect(
      gate.canUseTool(SPEC, 'AskUserQuestion', { questions: [] }, undefined)
    ).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('authenticated'),
    })
    expect(relay).not.toHaveBeenCalled()
  })
})
