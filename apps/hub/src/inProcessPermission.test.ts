import { describe, expect, it, vi } from 'vitest'
import { InProcessExecutor } from './executor.js'
import { Journal } from './journal.js'
import {
  ASK_INTERRUPTED_BY_RESTART_MESSAGE,
  ASK_UNAVAILABLE_MESSAGE,
  QuestionOwnershipError,
  QuestionService,
} from './questions.js'
import type { WorkerSessionSpec } from './workerProtocol.js'

type GateResult =
  | { behavior: 'allow'; updatedInput: unknown }
  | { behavior: 'deny'; message: string }

function spec(permissionMode: 'safe' | 'edits' | 'full', sessionId = 's1'): WorkerSessionSpec {
  return {
    sessionId,
    provider: 'claude',
    profileId: 'p1',
    profileDir: '/tmp/p1',
    cwd: '/tmp',
    label: 'test',
    permissionMode,
  }
}

function permissionGate(
  executor: InProcessExecutor,
  value: WorkerSessionSpec
): (toolName: string, input: unknown, context?: unknown) => Promise<GateResult> {
  const driver = (
    executor as unknown as {
      claudeDriverFor(specification: WorkerSessionSpec): unknown
    }
  ).claudeDriverFor(value)
  return (
    driver as {
      canUseTool(
        toolName: string,
        input: unknown,
        context?: unknown
      ): Promise<GateResult>
    }
  ).canUseTool
}

describe('InProcessExecutor AskUserQuestion permission callback', () => {
  it('classifies a missing exact turn handle as unknown and awaits bounded interrupt dispatch', async () => {
    const executor = new InProcessExecutor({} as never)
    executor.bindHub({} as never)
    let releaseInterrupt!: () => void
    const interrupt = vi
      .spyOn(executor, 'interrupt')
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseInterrupt = resolve
          })
      )
    const pending = new Promise<void>(() => {})
    ;(
      executor as unknown as {
        turnSettlements: Map<string, { token: symbol; promise: Promise<void> }>
      }
    ).turnSettlements.set('with-handle', {
      token: Symbol('with-handle'),
      promise: pending,
    })

    const settling = executor.settleQuestionTurnsForRestart(
      ['with-handle', 'missing-handle'],
      0
    )
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))
    expect(interrupt).toHaveBeenCalledWith('with-handle')
    expect(interrupt).not.toHaveBeenCalledWith('missing-handle')
    let completed = false
    void settling.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    releaseInterrupt()

    await expect(settling).resolves.toEqual({
      settled: [],
      outcomeUnknown: ['with-handle', 'missing-handle'],
    })
  })

  it('cancels exact-turn settlement without dispatching a late interrupt after rollback', async () => {
    const executor = new InProcessExecutor({} as never)
    executor.bindHub({} as never)
    const interrupt = vi.spyOn(executor, 'interrupt').mockResolvedValue()
    ;(
      executor as unknown as {
        turnSettlements: Map<string, { token: symbol; promise: Promise<void> }>
      }
    ).turnSettlements.set('with-handle', {
      token: Symbol('with-handle'),
      promise: new Promise<void>(() => {}),
    })
    const abort = new AbortController()

    const settling = executor.settleQuestionTurnsForRestart(
      ['with-handle'],
      60_000,
      abort.signal
    )
    abort.abort()

    await expect(settling).resolves.toEqual({
      settled: [],
      outcomeUnknown: ['with-handle'],
    })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('returns the exact system-interruption marker without answers or user-cancellation wording', async () => {
    const executor = new InProcessExecutor({
      approvals: { request: async () => true },
      questions: {
        request: async () => ({
          kind: 'interrupted',
          reason: 'restart',
          message: ASK_INTERRUPTED_BY_RESTART_MESSAGE,
        }),
      },
    } as never)
    executor.bindHub({ journal: () => {} } as never)
    const result = await permissionGate(executor, spec('safe'))(
      'AskUserQuestion',
      { questions: [] },
      {
        toolUseID: 'tool-ok',
        requestId: 'request-ok',
        signal: new AbortController().signal,
      }
    )

    expect(result).toEqual({
      behavior: 'deny',
      message: ASK_INTERRUPTED_BY_RESTART_MESSAGE,
    })
    if (result.behavior !== 'deny') throw new Error('expected deny')
    expect(
      result.message.match(/ALLMYAGENTS_ASK_INTERRUPTED_BY_RESTART_V1/gu)
    ).toHaveLength(1)
    expect(result.message).not.toContain('The user cancelled')
    expect(result).not.toHaveProperty('updatedInput')
  })

  it('treats a repeat Ask during inactive restart ownership as system unavailability, not user refusal', async () => {
    const executor = new InProcessExecutor({
      approvals: { request: async () => true },
      questions: {
        request: async () => {
          throw new QuestionOwnershipError()
        },
      },
    } as never)
    executor.bindHub({ journal: () => {} } as never)

    await expect(
      permissionGate(executor, spec('safe'))(
        'AskUserQuestion',
        { questions: [] },
        {
          toolUseID: 'tool-repeat',
          requestId: 'request-repeat',
          signal: new AbortController().signal,
        }
      )
    ).resolves.toEqual({
      behavior: 'deny',
      message: ASK_UNAVAILABLE_MESSAGE,
    })
    expect(ASK_UNAVAILABLE_MESSAGE).toContain('NOT A USER RESPONSE')
    expect(ASK_UNAVAILABLE_MESSAGE).not.toContain('The user cancelled')
  })

  it('denies malformed Ask correlation without journaling raw SDK identifiers', async () => {
    const journaled: Array<{ kind: string; payload: unknown }> = []
    const executor = new InProcessExecutor({
      approvals: { request: async () => true },
      questions: { request: async () => ({ kind: 'cancelled' }) },
    } as never)
    executor.bindHub({
      journal: (_sessionId: string | null, kind: string, payload: unknown) =>
        journaled.push({ kind, payload }),
    } as never)
    const canUseTool = permissionGate(executor, spec('safe'))
    const signal = new AbortController().signal
    const invalid = [
      { toolUseID: {}, requestId: 'request-ok', signal },
      { toolUseID: 'tool-ok', requestId: '\u0000bad', signal },
      { toolUseID: 'x'.repeat(513), requestId: 'request-ok', signal },
    ]

    for (const context of invalid) {
      await expect(
        canUseTool('AskUserQuestion', { questions: [] }, context)
      ).resolves.toMatchObject({
        behavior: 'deny',
        message: expect.stringContaining('input was invalid'),
      })
    }
    await expect(
      canUseTool(
        'AskUserQuestion',
        { questions: [] },
        { toolUseID: '', requestId: 'request-ok', signal }
      )
    ).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('without required SDK correlation'),
    })

    expect(journaled).toHaveLength(3)
    expect(journaled.every((event) => event.kind === 'question/rejected')).toBe(
      true
    )
    const serialized = JSON.stringify(journaled)
    expect(serialized).not.toContain('\\u0000bad')
    expect(serialized).not.toContain('x'.repeat(100))
    expect(serialized).not.toContain('request-ok')
  })

  it('never persists an unknown model-controlled property name in a rejected Ask event', async () => {
    const journal = new Journal(':memory:')
    try {
      const questions = new QuestionService(journal)
      questions.activatePublicOwner()
      const executor = new InProcessExecutor({
        approvals: { request: async () => true },
        questions,
      } as never)
      executor.bindHub({
        journal: (sessionId: string | null, kind: string, payload: unknown) =>
          journal.append(sessionId, kind, payload),
      } as never)
      const canUseTool = permissionGate(executor, spec('safe'))
      const secretPrefix = 'sk-ant-secret-unknown-field'
      const unknownKey = `${secretPrefix}-${'x'.repeat(100_000)}`
      const input = Object.fromEntries([
        ['questions', []],
        [unknownKey, true],
      ])

      const result = await canUseTool('AskUserQuestion', input, {
        toolUseID: 'tool-ok',
        requestId: 'request-ok',
        signal: new AbortController().signal,
      })

      expect(result).toMatchObject({
        behavior: 'deny',
        message: 'AskUserQuestion was rejected because its input was invalid: AskUserQuestion input has unsupported fields',
      })
      const replay = JSON.stringify(journal.recentEventsForSession('s1'))
      const stored = (
        journal.db
          .prepare("SELECT payload FROM events WHERE kind = 'question/rejected'")
          .all() as Array<{ payload: string }>
      ).map((row) => row.payload).join('\n')
      expect(replay).not.toContain(secretPrefix)
      expect(stored).not.toContain(secretPrefix)
      expect(stored).not.toContain(unknownKey)
      expect(JSON.parse(stored)).toEqual({
        code: 'invalid-question-input',
        toolUseIdLength: 7,
        requestIdLength: 10,
      })
    } finally {
      journal.db.close()
    }
  })
})
