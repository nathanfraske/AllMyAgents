import { describe, expect, it, vi } from 'vitest'
import { CodexClient } from './adapters/codex.js'
import type { AttachmentMeta } from './attachments.js'

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
