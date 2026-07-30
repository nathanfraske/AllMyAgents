import { describe, expect, it } from 'vitest'
import { AgentWorker } from './agentWorker.js'
import type { AskUserQuestionInput, QuestionOutcome } from './questions.js'
import { stableQuestionId, type WorkerSessionSpec } from './workerProtocol.js'
import type { HubToWorker, WorkerToHub } from './workerProtocol.js'

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
  relayQuestion(
    sessionId: string,
    input: unknown,
    context: { toolUseID?: string; requestId?: string; signal?: AbortSignal }
  ): Promise<QuestionOutcome>
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
  it('uses the dedicated question relay, not ApprovalService, and returns answered updatedInput', async () => {
    const gate = new AgentWorker('\\\\.\\pipe\\ama-question-never-bound') as unknown as Gate
    let approvalCount = 0
    let observedQuestionId = ''
    gate.relayApproval = async () => {
      approvalCount += 1
      return true
    }
    gate.relayQuestion = async (sessionId, input, context) => {
      observedQuestionId = stableQuestionId(sessionId, context.toolUseID!, context.requestId!)
      expect(input).toEqual(INPUT)
      return {
        kind: 'answered',
        updatedInput: {
          questions: INPUT.questions,
          answers: { 'Which database?': 'SQLite' },
        },
      }
    }

    await expect(
      gate.canUseTool(SPEC, 'AskUserQuestion', INPUT, {
        toolUseID: 'toolu_ask',
        requestId: 'control_ask',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: INPUT.questions,
        answers: { 'Which database?': 'SQLite' },
      },
    })
    expect(observedQuestionId).toBe(stableQuestionId('s1', 'toolu_ask', 'control_ask'))
    expect(approvalCount).toBe(0)
  })

  it('maps cancel to deny and fails closed when correlation is missing or input is malformed', async () => {
    const gate = new AgentWorker('\\\\.\\pipe\\ama-question-never-bound') as unknown as Gate
    let relayed = 0
    gate.relayQuestion = async () => {
      relayed += 1
      return { kind: 'cancelled' }
    }

    await expect(
      gate.canUseTool(SPEC, 'AskUserQuestion', INPUT, {
        toolUseID: 'toolu_ask',
        requestId: 'control_ask',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ behavior: 'deny' })
    expect(relayed).toBe(1)

    await expect(
      gate.canUseTool(SPEC, 'AskUserQuestion', INPUT, { toolUseID: 'toolu_ask' })
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(
      gate.canUseTool(SPEC, 'AskUserQuestion', { questions: [] }, {
        toolUseID: 'toolu_bad',
        requestId: 'control_bad',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ behavior: 'deny' })
    expect(relayed).toBe(1)
  })

  it('relays signal cancellation after the request and resolves only from the hub outcome', async () => {
    const worker = new AgentWorker('\\\\.\\pipe\\ama-question-never-bound')
    const gate = worker as unknown as Gate
    const relays: WorkerToHub[] = []
    let resolveQuestion!: (reply: Extract<HubToWorker, { t: 'questionResolved' }>) => void
    ;(
      worker as unknown as {
        server: {
          relay(
            message: WorkerToHub
          ): Promise<
            Extract<HubToWorker, { t: 'questionResolved' | 'questionAbortAck' }>
          >
        }
      }
    ).server = {
      relay: (message) => {
        relays.push(message)
        if (message.t === 'questionAbort') {
          return Promise.resolve({
            t: 'questionAbortAck',
            questionId: message.questionId,
            aborted: true,
          })
        }
        return new Promise((resolve) => {
          resolveQuestion = resolve
        })
      },
    }
    const controller = new AbortController()
    const pending = gate.relayQuestion('s1', INPUT, {
      toolUseID: 'tool-signal',
      requestId: 'request-signal',
      signal: controller.signal,
    })
    expect(relays.map((message) => message.t)).toEqual(['questionRequest'])

    controller.abort()
    await Promise.resolve()
    expect(relays.map((message) => message.t)).toEqual(['questionRequest', 'questionAbort'])
    const questionId = stableQuestionId('s1', 'tool-signal', 'request-signal')
    resolveQuestion({
      t: 'questionResolved',
      questionId,
      outcome: { kind: 'cancelled', reason: 'aborted' },
    })
    await expect(pending).resolves.toEqual({ kind: 'cancelled', reason: 'aborted' })
  })
})
