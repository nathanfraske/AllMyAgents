import { describe, expect, it } from 'vitest'
import { mapCodexTokenUsage } from './adapters/codex.js'

describe('mapCodexTokenUsage', () => {
  it('normalizes the modern app-server context occupancy shape', () => {
    expect(mapCodexTokenUsage({
      threadId: 'thread-1',
      tokenUsage: {
        total: {
          inputTokens: 9_081_737_127,
          cachedInputTokens: 8_909_979_648,
          outputTokens: 10_408_122,
          reasoningOutputTokens: 4_159_000,
          totalTokens: 9_092_145_249,
        },
        last: { inputTokens: 42_000, totalTokens: 42_500 },
        modelContextWindow: 258_000,
      },
    })).toEqual({
      input: 9_081_737_127,
      cachedInput: 8_909_979_648,
      output: 10_408_122,
      reasoningOutput: 4_159_000,
      total: 9_092_145_249,
      usageScope: 'thread',
      contextUsed: 42_000,
      contextWindow: 258_000,
      scope: 'request',
    })
  })

  it('keeps generic usage counters and returns undefined for an unknown shape', () => {
    expect(mapCodexTokenUsage({ usage: { input_tokens: 10, output_tokens: 5 } }))
      .toEqual({ input: 10, output: 5, total: 15 })
    expect(mapCodexTokenUsage({ futureEnvelope: { opaque: true } })).toBeUndefined()
  })
})
