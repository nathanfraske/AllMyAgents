import { describe, expect, it, vi } from 'vitest'
import { AgentWorker } from './agentWorker.js'
import type { AttachmentMeta } from './attachments.js'
import type { HubToWorker, WorkerSessionSpec } from './workerProtocol.js'

const SPEC = {
  sessionId: 's1',
  provider: 'claude',
  profileId: 'p1',
  profileDir: '/tmp/profile',
  cwd: '/tmp/work',
  label: 'test',
} satisfies WorkerSessionSpec

const ATTACHMENT: AttachmentMeta = {
  id: 'a1',
  name: 'shot.png',
  mime: 'image/png',
  size: 3,
  path: '/tmp/work/.allmyagents/uploads/a1-shot.png',
}

interface WorkerInternals {
  onCommand(msg: HubToWorker): void
  runClaudeTurn(
    spec: WorkerSessionSpec,
    prompt: string,
    origin: 'operator' | 'bus',
    attachments: readonly AttachmentMeta[]
  ): Promise<void>
  steer(sessionId: string, text: string, attachments: readonly AttachmentMeta[]): Promise<void>
}

describe('agent-worker attachment seam', () => {
  it('forwards metadata from runTurn and steer commands without embedding bytes in text', async () => {
    const worker = new AgentWorker('\\\\.\\pipe\\ama-attachment-never-bound') as unknown as WorkerInternals
    const runClaudeTurn = vi.fn(async (
      _spec: WorkerSessionSpec,
      _prompt: string,
      _origin: 'operator' | 'bus',
      _attachments: readonly AttachmentMeta[]
    ) => {})
    const steer = vi.fn(async (
      _sessionId: string,
      _text: string,
      _attachments: readonly AttachmentMeta[]
    ) => {})
    worker.runClaudeTurn = runClaudeTurn
    worker.steer = steer

    worker.onCommand({
      t: 'runTurn',
      reqId: 'run',
      spec: SPEC,
      prompt: 'inspect',
      origin: 'operator',
      attachments: [ATTACHMENT],
    })
    worker.onCommand({
      t: 'steer',
      reqId: 'steer',
      sessionId: SPEC.sessionId,
      text: 'look again',
      attachments: [ATTACHMENT],
    })
    await Promise.resolve()

    expect(runClaudeTurn).toHaveBeenCalledWith(SPEC, 'inspect', 'operator', [ATTACHMENT])
    expect(steer).toHaveBeenCalledWith(SPEC.sessionId, 'look again', [ATTACHMENT])
    expect(runClaudeTurn.mock.calls[0]![1]).not.toContain('AQID')
  })
})
