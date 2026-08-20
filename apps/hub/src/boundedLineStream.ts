export interface BoundedLineOverflow {
  maxLineBytes: number
  observedBytes: number
}

export interface BoundedLineStreamOptions {
  maxLineBytes: number
  onLine: (line: string) => void
  onOverflow: (overflow: BoundedLineOverflow) => void
}

/**
 * Consume newline-delimited UTF-8 without letting one unterminated peer frame grow a JavaScript
 * string until V8 aborts with `RangeError: Invalid string length`.
 *
 * Keep bytes until a complete line exists. Besides making the limit honest for multi-byte UTF-8,
 * this avoids the quadratic string concatenation performed by readline for a very large line.
 * The caller owns the peer lifecycle after overflow; this reader stops consuming immediately.
 */
export function consumeBoundedLines(
  input: NodeJS.ReadableStream,
  options: BoundedLineStreamOptions,
): () => void {
  if (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes < 1) {
    throw new Error('maxLineBytes must be a positive safe integer')
  }

  let pieces: Buffer[] = []
  let lineBytes = 0
  let stopped = false

  const detach = (): void => {
    input.removeListener('data', onData)
    input.removeListener('end', onEnd)
  }
  const stop = (): void => {
    if (stopped) return
    stopped = true
    pieces = []
    lineBytes = 0
    detach()
  }
  const emit = (): void => {
    const bytes = pieces.length === 0
      ? Buffer.alloc(0)
      : pieces.length === 1
        ? pieces[0]!
        : Buffer.concat(pieces, lineBytes)
    pieces = []
    lineBytes = 0
    const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length
    options.onLine(bytes.subarray(0, end).toString('utf8'))
  }
  const append = (chunk: Buffer, start: number, end: number): boolean => {
    const added = end - start
    const observedBytes = lineBytes + added
    if (observedBytes > options.maxLineBytes) {
      stop()
      options.onOverflow({ maxLineBytes: options.maxLineBytes, observedBytes })
      return false
    }
    if (added > 0) {
      pieces.push(chunk.subarray(start, end))
      lineBytes = observedBytes
    }
    return true
  }
  function onData(value: string | Buffer | Uint8Array): void {
    if (stopped) return
    const chunk = typeof value === 'string'
      ? Buffer.from(value, 'utf8')
      : Buffer.isBuffer(value)
        ? value
        : Buffer.from(value)
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start)
      const end = newline < 0 ? chunk.length : newline
      if (!append(chunk, start, end)) return
      if (newline < 0) return
      emit()
      if (stopped) return
      start = newline + 1
    }
  }
  function onEnd(): void {
    if (stopped) return
    detach()
    stopped = true
    if (lineBytes > 0) emit()
  }

  input.on('data', onData)
  input.once('end', onEnd)
  return stop
}
