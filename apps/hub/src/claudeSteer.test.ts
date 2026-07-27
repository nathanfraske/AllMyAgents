import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AttachmentMeta } from './attachments.js'

type CapturedPrompt = AsyncIterable<{
  type: string
  message: { role: string; content: Array<Record<string, unknown>> }
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
  it('sends supported images as base64 image blocks and PDFs as document blocks', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-claude-attachments-'))
    const imagePath = path.join(tmp, 'pixel.png')
    const pdfPath = path.join(tmp, 'paper.pdf')
    fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]))
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-test'))
    const attachments: AttachmentMeta[] = [
      { id: 'image', name: 'pixel.png', mime: 'image/png', size: 3, path: imagePath },
      { id: 'pdf', name: 'paper.pdf', mime: 'application/pdf', size: 9, path: pdfPath },
    ]
    const driver = new ClaudeDriver('/tmp/profile', '/tmp/cwd', () => {})
    const turn = (
      driver as unknown as {
        send(text: string, options: object, attachments: AttachmentMeta[]): Promise<void>
      }
    ).send('inspect these', {}, attachments)
    const iterator = (capturedPrompt as CapturedPrompt)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        message: {
          content: [
            { type: 'text', text: 'inspect these' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') },
            },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-test').toString('base64') },
            },
          ],
        },
      },
    })

    finishTurn?.()
    await turn
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('delivers UTF-8 text-family attachments as text content', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-claude-text-attachments-'))
    const documentPath = path.join(tmp, 'notes.md')
    fs.writeFileSync(documentPath, 'CLAUDE_MARKDOWN_ATTACHMENT')
    const attachments: AttachmentMeta[] = [
      {
        id: 'document',
        name: 'notes.md',
        mime: 'text/markdown',
        size: fs.statSync(documentPath).size,
        path: documentPath,
      },
    ]
    const driver = new ClaudeDriver('/tmp/profile', '/tmp/cwd', () => {})
    const turn = (
      driver as unknown as {
        send(text: string, options: object, attachments: AttachmentMeta[]): Promise<void>
      }
    ).send('Use the document', {}, attachments)
    const iterator = (capturedPrompt as CapturedPrompt)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        message: {
          content: [
            { type: 'text', text: 'Use the document' },
            { type: 'text', text: expect.stringContaining('CLAUDE_MARKDOWN_ATTACHMENT') },
          ],
        },
      },
    })

    finishTurn?.()
    await turn
    fs.rmSync(tmp, { recursive: true, force: true })
  })

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
