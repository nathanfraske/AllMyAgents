import { PassThrough } from 'node:stream'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { consumeBoundedLines } from './boundedLineStream.js'

describe('consumeBoundedLines', () => {
  it('reassembles fragmented UTF-8 lines and accepts CRLF', async () => {
    const input = new PassThrough()
    const lines: string[] = []
    consumeBoundedLines(input, {
      maxLineBytes: 64,
      onLine: (line) => lines.push(line),
      onOverflow: vi.fn(),
    })

    const encoded = Buffer.from('one ☃\r\ntwo\nlast', 'utf8')
    input.write(encoded.subarray(0, 6))
    input.write(encoded.subarray(6, 9))
    input.end(encoded.subarray(9))
    await once(input, 'end')

    expect(lines).toEqual(['one ☃', 'two', 'last'])
  })

  it('stops before retaining or decoding an oversized unterminated line', () => {
    const input = new PassThrough()
    const onLine = vi.fn()
    const onOverflow = vi.fn()
    consumeBoundedLines(input, { maxLineBytes: 16, onLine, onOverflow })

    input.write(Buffer.alloc(10, 0x78))
    input.write(Buffer.alloc(10, 0x79))
    input.write('\nthis must be ignored\n')

    expect(onLine).not.toHaveBeenCalled()
    expect(onOverflow).toHaveBeenCalledOnce()
    expect(onOverflow).toHaveBeenCalledWith({ maxLineBytes: 16, observedBytes: 20 })
  })

  it('bounds every frame independently when one chunk contains many lines', () => {
    const input = new PassThrough()
    const lines: string[] = []
    const onOverflow = vi.fn()
    consumeBoundedLines(input, { maxLineBytes: 4, onLine: (line) => lines.push(line), onOverflow })

    input.end('1234\na\n12345\nnever\n')

    expect(lines).toEqual(['1234', 'a'])
    expect(onOverflow).toHaveBeenCalledWith({ maxLineBytes: 4, observedBytes: 5 })
  })

  it('does not deliver later frames when the consumer stops inside a callback', () => {
    const input = new PassThrough()
    const lines: string[] = []
    let stop = (): void => {}
    stop = consumeBoundedLines(input, {
      maxLineBytes: 64,
      onLine: (line) => {
        lines.push(line)
        stop()
      },
      onOverflow: vi.fn(),
    })

    input.write('first\nsecond\n')
    expect(lines).toEqual(['first'])
  })
})
