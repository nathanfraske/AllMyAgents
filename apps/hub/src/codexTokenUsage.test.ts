import { describe, expect, it } from 'vitest'
import { mapCodexTokenUsage } from './adapters/codex.js'

describe('mapCodexTokenUsage', () => {
  it('normalizes the modern app-server context occupancy shape', () => {
    expect(mapCodexTokenUsage({
      threadId: 'thread-1',
      tokenUsage: {
        last: { inputTokens: 42_000, totalTokens: 42_500 },
        modelContextWindow: 258_000,
      },
    })).toEqual({ contextUsed: 42_000, contextWindow: 258_000, scope: 'request' })
  })

  it('keeps generic usage counters and returns undefined for an unknown shape', () => {
    expect(mapCodexTokenUsage({ usage: { input_tokens: 10, output_tokens: 5 } }))
      .toEqual({ input: 10, output: 5, total: 15 })
    expect(mapCodexTokenUsage({ futureEnvelope: { opaque: true } })).toBeUndefined()
  })
})
