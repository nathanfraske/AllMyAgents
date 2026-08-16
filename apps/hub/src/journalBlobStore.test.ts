import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { JournalBlobStore } from './journalBlobStore.js'

describe('journal blob history hydration', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-blob-read-'))

  afterEach(() => vi.restoreAllMocks())
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('reads a cold working set asynchronously with store-wide bounded concurrency', async () => {
    const store = new JournalBlobStore(path.join(tmp, 'concurrent'), {
      cacheMaxBytes: 0,
      maxConcurrentReads: 4,
    })
    const texts = Array.from(
      { length: 12 },
      (_, index) => `${index}:` + String.fromCharCode(65 + index).repeat(70 * 1024),
    )
    const stored = texts.map((text) => store.encode({ text }).stored)
    const originalReadFile = fs.promises.readFile.bind(fs.promises)
    let active = 0
    let maximumActive = 0
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      try {
        return await originalReadFile(file)
      } finally {
        active -= 1
      }
    }) as typeof fs.promises.readFile)
    let eventLoopAdvanced = false
    setTimeout(() => { eventLoopAdvanced = true }, 0)

    const decoded = await store.decodeManyAsync(stored)

    expect(decoded).toEqual(texts.map((text) => ({ text })))
    expect(eventLoopAdvanced).toBe(true)
    expect(maximumActive).toBeGreaterThan(1)
    expect(maximumActive).toBeLessThanOrEqual(4)
  })

  it('coalesces identical cold reads across concurrent history requests', async () => {
    const store = new JournalBlobStore(path.join(tmp, 'coalesced'), { cacheMaxBytes: 0 })
    const stored = store.encode({ text: 'shared:'.padEnd(70 * 1024, 'x') }).stored
    const read = vi.spyOn(fs.promises, 'readFile')

    const [first, second] = await Promise.all([
      store.decodeManyAsync([stored]),
      store.decodeManyAsync([stored]),
    ])

    expect(first).toEqual(second)
    expect(read).toHaveBeenCalledTimes(1)
  })
})
