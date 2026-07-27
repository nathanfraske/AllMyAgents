import { beforeEach, describe, expect, it, vi } from 'vitest'

type CapturedPrompt = AsyncIterable<{
  type: string
  message: { role: string; content: Array<{ type: string; text: string }> }
  parent_tool_use_id: string | null
  priority?: string
}>

let capturedPrompt: string | CapturedPrompt | undefined
let finishTurn: (() => void) | undefined

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string | CapturedPrompt }) => {
    capturedPrompt = params.prompt
    return (async function* () {
      await new Promise<void>((resolve) => {
        finishTurn = resolve
      })
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' }
    })()
  },
}))

const { ClaudeDriver } = await import('./adapters/claude.js')

beforeEach(() => {
  capturedPrompt = undefined
  finishTurn = undefined
})

describe('ClaudeDriver mid-turn steering', () => {
  it('opens the SDK query with a streaming prompt and sends steering input at the next tool boundary', async () => {
    const driver = new ClaudeDriver('/tmp/profile', '/tmp/cwd', () => {})
    const turn = driver.send('initial task')

    expect(capturedPrompt).not.toBeTypeOf('string')
    const iterator = (capturedPrompt as CapturedPrompt)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'initial task' }] },
        parent_tool_use_id: null,
      },
      done: false,
    })

    const steer = driver.steer('correct the instruction')
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'correct the instruction' }] },
        parent_tool_use_id: null,
        priority: 'next',
      },
      done: false,
    })
    // The SDK acknowledges a streamed message by requesting the next one after its transport.write.
    const next = iterator.next()
    await steer

    finishTurn?.()
    await turn
    await expect(next).resolves.toEqual({ value: undefined, done: true })
  })

  it('rejects a steer after the turn has ended instead of accepting input that cannot be delivered', async () => {
    const driver = new ClaudeDriver('/tmp/profile', '/tmp/cwd', () => {})
    const turn = driver.send('initial task')
    finishTurn?.()
    await turn

    await expect(driver.steer('too late')).rejects.toThrow('no active Claude turn to steer')
  })
})
