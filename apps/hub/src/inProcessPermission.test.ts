import { describe, expect, it } from 'vitest'
import { InProcessExecutor } from './executor.js'
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
})
