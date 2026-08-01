import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CapturedPrompt = AsyncIterable<{
  type: string
  message: { role: string; content: Array<Record<string, unknown>> }
  parent_tool_use_id: string | null
  priority?: string
}>

type VendorMessage = {
  type: string
  subtype?: string
  is_error?: boolean
  result?: string
  terminal_reason?: string
}

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

afterEach(() => vi.useRealTimers())

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

    // The accepted steer becomes a new SDK run just after the preceding result. Its init is the positive
    // continuation signal that keeps the shared permission/control stream open.
    emitVendor({ type: 'system', subtype: 'init' })
    await vi.waitFor(() => expect(seenKinds).toEqual(['claude/result', 'claude/system']))

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
    expect(seenKinds).toEqual(['claude/result', 'claude/system', 'claude/result'])
  })

  it('settles when Claude coalesces several accepted steers into one result', async () => {
    vi.useFakeTimers()
    const seenKinds: string[] = []
    const driver = new ClaudeDriver('/tmp/profile', '/tmp/cwd', (kind) => seenKinds.push(kind))
    const turn = driver.send('original prompt')
    const input = capturedPrompt![Symbol.asyncIterator]()

    await input.next()
    let waitingForMoreInput = input.next()
    for (const text of ['first correction', 'second correction', 'third correction']) {
      const steer = driver.steer(text)
      await expect(waitingForMoreInput).resolves.toMatchObject({
        done: false,
        value: { priority: 'next', message: { content: [{ type: 'text', text }] } },
      })
      waitingForMoreInput = input.next()
      await steer
    }

    // This is what the production journal captured: four accepted user inputs, but one top-level result.
    // Message/result counting leaves the stream and session active forever. A quiet result boundary closes
    // it after the bounded grace period instead.
    emitVendor({ type: 'result', subtype: 'success', is_error: false, result: 'all input complete' })
    await Promise.resolve()
    await Promise.resolve()
    expect(seenKinds).toEqual(['claude/result'])
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(waitingForMoreInput).resolves.toEqual({ value: undefined, done: true })

    finishVendor()
    await turn
  })

  it('closes immediately on the terminal aborted_streaming result emitted by interrupt', async () => {
    const driver = new ClaudeDriver('/tmp/profile', '/tmp/cwd', () => {})
    const turn = driver.send('original prompt')
    const input = capturedPrompt![Symbol.asyncIterator]()
    await input.next()
    const waitingForMoreInput = input.next()

    emitVendor({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
    })
    await expect(waitingForMoreInput).resolves.toEqual({ value: undefined, done: true })

    finishVendor()
    await turn
  })
})
