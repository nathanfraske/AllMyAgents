import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalService } from './approvals.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { QuestionService } from './questions.js'
import { UsageMonitor } from './usage.js'
import type { WorkerSessionSpec } from './workerProtocol.js'

const capturedClaudeOptions: Record<string, unknown>[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...actual,
    query: ({ options }: { options: Record<string, unknown> }) => {
      capturedClaudeOptions.push(options)
      return (async function* () {})()
    },
  }
})

const { AgentWorker } = await import('./agentWorker.js')
const { AUTO_ALLOW_TOOLS, InProcessExecutor } = await import('./executor.js')

const ASSIGN_CHILD_TASK = 'mcp__allmyagents__assign_child_task'
const SELF_AUTHORIZED_MANAGER_CONTROLS = [
  'mcp__allmyagents__spawn_agent',
  'mcp__allmyagents__set_child_authority',
  'mcp__allmyagents__decide_child_approval',
  ASSIGN_CHILD_TASK,
] as const
const INPUT = { child_session: 'child', title: 'Verify the fix' }

type PermissionDecision =
  | { behavior: 'allow'; updatedInput: unknown }
  | { behavior: 'deny'; message: string }

interface WorkerGateInternals {
  canUseTool(
    spec: WorkerSessionSpec,
    toolName: string,
    input: unknown,
  ): Promise<PermissionDecision>
  relayApproval(sessionId: string, kind: string, payload: unknown): Promise<boolean>
}

interface InProcessGateInternals {
  claudeDriverFor(spec: WorkerSessionSpec): {
    send(prompt: string, options: { permissionMode: 'safe' | 'edits' | 'full' }): Promise<void>
  }
}

const specWith = (
  permissionMode: 'safe' | 'edits' | 'full',
  sessionId = `in-process-${permissionMode}`,
): WorkerSessionSpec =>
  ({
    sessionId,
    provider: 'claude',
    profileId: 'profile',
    profileDir: '/tmp/profile',
    cwd: '/tmp/worktree',
    permissionMode,
  }) as unknown as WorkerSessionSpec

beforeEach(() => {
  capturedClaudeOptions.length = 0
})

describe('assign_child_task auto-allow parity', () => {
  it('keeps the closed manager-control registry complete', () => {
    expect(
      SELF_AUTHORIZED_MANAGER_CONTROLS.filter((toolName) => AUTO_ALLOW_TOOLS.has(toolName)),
    ).toEqual(SELF_AUTHORIZED_MANAGER_CONTROLS)
  })

  for (const mode of ['safe', 'edits', 'full'] as const) {
    it(`in-process Claude allows it in ${mode} mode without allocating an ApprovalService request`, async () => {
      const journal = new Journal(':memory:')
      try {
        const approvals = new ApprovalService(journal)
        const approvalRequest = vi.spyOn(approvals, 'request').mockResolvedValue(true)
        const executor = new InProcessExecutor({
          approvals,
          questions: new QuestionService(journal),
          usage: new UsageMonitor(journal, [], {}),
          danger: { busCanUseRiskyTools: false, autoApprovePractices: false },
          memory: new MemoryStore(journal.db),
          practices: new PracticeStore(journal.db),
        }) as unknown as InProcessGateInternals

        const driver = executor.claudeDriverFor(specWith(mode))
        await driver.send('test', { permissionMode: mode })
        const canUseTool = capturedClaudeOptions[0]?.canUseTool as
          | ((toolName: string, input: unknown) => Promise<PermissionDecision>)
          | undefined

        expect(canUseTool).toBeTypeOf('function')
        await expect(canUseTool!(ASSIGN_CHILD_TASK, INPUT)).resolves.toEqual({
          behavior: 'allow',
          updatedInput: INPUT,
        })
        expect(approvalRequest).not.toHaveBeenCalled()
        expect(approvals.pending()).toEqual([])
      } finally {
        journal.db.close()
      }
    })

    it(`AgentWorker allows it in ${mode} mode without an approval relay`, async () => {
      const worker = new AgentWorker('\\\\.\\pipe\\ama-assign-task-never-bound') as unknown as WorkerGateInternals
      const relayApproval = vi.fn(async () => true)
      worker.relayApproval = relayApproval

      await expect(worker.canUseTool(specWith(mode, `worker-${mode}`), ASSIGN_CHILD_TASK, INPUT)).resolves.toEqual({
        behavior: 'allow',
        updatedInput: INPUT,
      })
      expect(relayApproval).not.toHaveBeenCalled()
    })
  }
})
