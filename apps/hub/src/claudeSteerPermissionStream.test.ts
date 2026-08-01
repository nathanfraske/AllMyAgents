import { beforeEach, describe, expect, it, vi } from 'vitest'

type CapturedPrompt = AsyncIterable<{
  type: string
  message: { role: string; content: Array<Record<string, unknown>> }
  parent_tool_use_id: string | null
  priority?: string
}>

type VendorMessage = { type: string; subtype?: string; is_error?: boolean; result?: string }

let capturedPrompt: CapturedPrompt | undefined
let vendorQueue: Array<IteratorResult<VendorMessage>> = []
let vendorWaiter: ((result: IteratorResult<VendorMessage>) => void) | undefined

function emitVendor(message: VendorMessage): void {
  const result: IteratorResult<VendorMessage> = { value: message, done: false }
  if (vendorWaiter) {
    const resolve = vendorWaiter
    vendorWaiter = undefined
    resolve(result)
  } else {
    vendorQueue.push(result)
  }
}

function finishVendor(): void {
  const result: IteratorResult<VendorMessage> = { value: undefined, done: true }
  if (vendorWaiter) {
    const resolve = vendorWaiter
    vendorWaiter = undefined
    resolve(result)
  } else {
    vendorQueue.push(result)
  }
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: CapturedPrompt }) => {
    capturedPrompt = params.prompt
    return {
      next: () => {
        const queued = vendorQueue.shift()
        if (queued) return Promise.resolve(queued)
        return new Promise<IteratorResult<VendorMessage>>((resolve) => {
          vendorWaiter = resolve
        })
      },
      [Symbol.asyncIterator]() {
        return this
      },
      interrupt: vi.fn(),
      stopTask: vi.fn(),
    }
  },
}))

const { ClaudeDriver } = await import('./adapters/claude.js')

beforeEach(() => {
  capturedPrompt = undefined
  vendorQueue = []
  vendorWaiter = undefined
})

describe('Claude steering permission-stream lifetime', () => {
  it('keeps stdin open after the original result while an accepted priority-next steer is still running', async () => {
    const seenKinds: string[] = []
    const driver = new ClaudeDriver('/tmp/profile', '/tmp/cwd', (kind) => seenKinds.push(kind))
    const turn = driver.send('original prompt')
    const input = capturedPrompt![Symbol.asyncIterator]()

    await expect(input.next()).resolves.toMatchObject({
      done: false,
      value: { message: { content: [{ type: 'text', text: 'original prompt' }] } },
    })

    const steer = driver.steer('queued correction')
    await expect(input.next()).resolves.toMatchObject({
      done: false,
      value: {
        priority: 'next',
        message: { content: [{ type: 'text', text: 'queued correction' }] },
      },
    })
    // The SDK acknowledges that it wrote the steer by requesting the following input item.
    const waitingForMoreInput = input.next()
    await steer

    emitVendor({ type: 'result', subtype: 'success', is_error: false, result: 'original complete' })
    await vi.waitFor(() => expect(seenKinds).toEqual(['claude/result']))

    // This is the release-blocking regression. The old adapter resolved this as done:true here, closing
    // Claude's stdin while the steer continued. Its next permission response then failed with
    // `Tool permission request failed: AbortError: Stream closed`.
    let inputClosed = false
    void waitingForMoreInput.then(() => {
      inputClosed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(inputClosed).toBe(false)

    emitVendor({ type: 'result', subtype: 'success', is_error: false, result: 'steer complete' })
    finishVendor()
    await turn

    await expect(waitingForMoreInput).resolves.toEqual({ value: undefined, done: true })
    expect(seenKinds).toEqual(['claude/result', 'claude/result'])
  })
})
