import { describe, expect, it, vi } from 'vitest'
import { CodexClient } from './adapters/codex.js'

describe('Codex reasoning summaries', () => {
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
