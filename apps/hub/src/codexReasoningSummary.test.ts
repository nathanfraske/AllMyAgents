import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_ELICITATION_METHOD,
  CODEX_PERMISSIONS_APPROVAL_METHOD,
  CodexClient,
  codexRequestResult,
} from './adapters/codex.js'
import type { AttachmentMeta } from './attachments.js'
import { CODEX_COMPACTION_PROMPT } from './compactionContinuity.js'

describe('Codex reasoning summaries', () => {
  it('passes image attachments as localImage inputs', async () => {
    const client = new CodexClient('unused', vi.fn())
    const request = vi.spyOn(client, 'request').mockResolvedValue(undefined)
    const attachments: AttachmentMeta[] = [
      { id: 'image', name: 'shot.png', mime: 'image/png', size: 3, path: '/tmp/shot.png' },
    ]

    await (
      client as unknown as {
        sendTurn(threadId: string, text: string, options: object, attachments: AttachmentMeta[]): Promise<void>
      }
    ).sendTurn('thread-1', 'Look', {}, attachments)

    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'Look' },
        { type: 'localImage', path: '/tmp/shot.png' },
      ],
      summary: 'auto',
    })
  })

  it('requests an automatic reasoning summary for every turn', async () => {
    const client = new CodexClient('unused', vi.fn())
    const request = vi.spyOn(client, 'request').mockResolvedValue(undefined)

    await client.sendTurn('thread-1', 'Think this through')

    expect(request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({ summary: 'auto' })
    )
  })
})

describe('Codex host contract', () => {
  it('sets developer instructions through the supported thread seams and reasserts them after compaction', async () => {
    const client = new CodexClient('unused', vi.fn())
    vi.spyOn(client, 'ensureStarted').mockResolvedValue()
    const request = vi.spyOn(client, 'request').mockImplementation(async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1', parentThreadId: null } }
      if (method === 'thread/resume') return { thread: { id: 'thread-1', parentThreadId: null } }
      return undefined
    })
    const instructions = 'Use the live AllMyAgents control plane and bounded topology.'

    const threadId = await client.startThread('C:/repo', instructions)
    await client.ensureDeveloperInstructions(threadId, instructions)

    expect(request).toHaveBeenCalledWith('thread/start', {
      cwd: 'C:/repo',
      config: { compact_prompt: CODEX_COMPACTION_PROMPT },
      developerInstructions: instructions,
    })
    expect(request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(0)

    ;(client as unknown as { onLine(line: string): void }).onLine(JSON.stringify({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-before-compact' } },
    }))
    ;(client as unknown as { onLine(line: string): void }).onLine(JSON.stringify({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-before-compact', status: 'completed' } },
    }))
    ;(client as unknown as { onLine(line: string): void }).onLine(JSON.stringify({
      method: 'item/completed',
      params: {
        threadId,
        turnId: 'turn-1',
        item: { id: 'compact-1', type: 'contextCompaction' },
      },
    }))
    await client.ensureDeveloperInstructions(threadId, instructions)

    expect(request).toHaveBeenCalledWith('thread/resume', {
      threadId,
      config: { compact_prompt: CODEX_COMPACTION_PROMPT },
      developerInstructions: instructions,
    })
    expect(CODEX_COMPACTION_PROMPT).toMatch(/active objective.*current project.*current slice/su)
    expect(CODEX_COMPACTION_PROMPT).toMatch(/completed work.*work currently in progress.*remaining work/su)
    expect(CODEX_COMPACTION_PROMPT).toMatch(/Exact next action/u)
  })

  it('does not resume a pristine thread before app-server has created its first rollout', async () => {
    const client = new CodexClient('unused', vi.fn())
    vi.spyOn(client, 'ensureStarted').mockResolvedValue()
    const request = vi.spyOn(client, 'request').mockImplementation(async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-new', parentThreadId: null } }
      if (method === 'thread/resume') return { thread: { id: 'thread-new', parentThreadId: null } }
      return undefined
    })

    const threadId = await client.startThread('C:/repo', 'initial topology')
    await client.ensureDeveloperInstructions(threadId, 'topology changed before turn one')
    expect(request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(0)

    ;(client as unknown as { onLine(line: string): void }).onLine(JSON.stringify({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-1' } },
    }))
    ;(client as unknown as { onLine(line: string): void }).onLine(JSON.stringify({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-1', status: 'completed' } },
    }))
    await client.ensureDeveloperInstructions(threadId, 'topology changed before turn one')

    expect(request).toHaveBeenCalledWith('thread/resume', {
      threadId,
      config: { compact_prompt: CODEX_COMPACTION_PROMPT },
      developerInstructions: 'topology changed before turn one',
    })
  })

  it('answers request_permissions with the documented granted subset instead of an exec decision', () => {
    const permissions = {
      network: { enabled: true },
      fileSystem: { write: ['C:/repo/out'] },
    }
    expect(codexRequestResult(CODEX_PERMISSIONS_APPROVAL_METHOD, true, { permissions })).toEqual({
      permissions,
      scope: 'turn',
    })
    expect(codexRequestResult(CODEX_PERMISSIONS_APPROVAL_METHOD, false, { permissions })).toEqual({
      permissions: {},
      scope: 'turn',
    })
    expect(codexRequestResult(CODEX_PERMISSIONS_APPROVAL_METHOD, true, { permissions: [] })).toEqual({
      permissions: {},
      scope: 'turn',
    })
    expect(codexRequestResult('item/commandExecution/requestApproval', true, {})).toEqual({
      decision: 'accept',
    })
  })

  it('answers connector elicitations with protocol-shaped one-shot or explicit persisted decisions', () => {
    expect(codexRequestResult(CODEX_ELICITATION_METHOD, false, {})).toEqual({
      action: 'decline',
      content: null,
    })
    expect(codexRequestResult(CODEX_ELICITATION_METHOD, true, {})).toEqual({
      action: 'accept',
      content: {},
    })
    expect(codexRequestResult(CODEX_ELICITATION_METHOD, true, {}, 'always')).toEqual({
      action: 'accept',
      content: {},
      _meta: { persist: 'always' },
    })
  })

  it('fails every request kind closed with its own protocol shape when no approval handler exists', async () => {
    const client = new CodexClient('unused', vi.fn())
    const sent: Array<Record<string, unknown>> = []
    vi.spyOn(
      client as unknown as { send(message: Record<string, unknown>): void },
      'send',
    ).mockImplementation((message) => { sent.push(message) })

    ;(client as unknown as { onLine(line: string): void }).onLine(JSON.stringify({
      id: 41,
      method: CODEX_PERMISSIONS_APPROVAL_METHOD,
      params: { permissions: { network: { enabled: true } } },
    }))
    ;(client as unknown as { onLine(line: string): void }).onLine(JSON.stringify({
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'git status' },
    }))

    expect(sent).toEqual([
      { id: 41, result: { permissions: {}, scope: 'turn' } },
      { id: 42, result: { decision: 'decline' } },
    ])
  })
})

describe('Codex interrupts', () => {
  it('targets the active turn, not just its thread', async () => {
    const client = new CodexClient('unused', vi.fn())
    const request = vi.spyOn(client, 'request').mockResolvedValue(undefined)

    ;(client as unknown as { onLine(line: string): void }).onLine(
      JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      })
    )
    await client.interrupt('thread-1')

    expect(request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
  })
})
