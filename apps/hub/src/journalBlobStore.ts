import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const JOURNAL_BLOB_INLINE_LIMIT_BYTES = 64 * 1024
export const JOURNAL_BLOB_KEY = '__allmyagentsJournalBlobV1'

type BlobReference = {
  [JOURNAL_BLOB_KEY]: {
    sha256: string
    bytes: number
    encoding: 'utf8'
  }
}

type CacheEntry = {
  text: string
  bytes: number
}

export interface JournalBlobStoreOptions {
  cacheMaxBytes?: number
  maxConcurrentReads?: number
}

export interface JournalBlobEncoding {
  stored: unknown
  blobsWritten: number
  bytesExternalized: number
}

const SHA256 = /^[0-9a-f]{64}$/u
const DEFAULT_CACHE_MAX_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_CONCURRENT_READS = 16

function blobReference(value: unknown): value is BlobReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1) return false
  const raw = record[JOURNAL_BLOB_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const ref = raw as Record<string, unknown>
  return (
    Object.keys(ref).sort().join(',') === 'bytes,encoding,sha256' &&
    typeof ref.sha256 === 'string' &&
    SHA256.test(ref.sha256) &&
    Number.isSafeInteger(ref.bytes) &&
    Number(ref.bytes) >= JOURNAL_BLOB_INLINE_LIMIT_BYTES &&
    ref.encoding === 'utf8'
  )
}

/**
 * Lossless, content-addressed storage for large JSON strings.
 *
 * Publication order is the crash boundary: write + fsync + same-directory rename the immutable blob,
 * then let the caller commit the SQLite pointer. A kill can leave an unreferenced blob, but can never
 * publish a journal row that points at bytes which were still only in a temporary file. Content hashes
 * deduplicate repeated tool results across turns and, unlike truncation, preserve exact replay/history.
 */
export class JournalBlobStore {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly pendingReads = new Map<string, Promise<string>>()
  private readonly readWaiters: Array<() => void> = []
  private cacheBytes = 0
  private activeReads = 0
  private readonly cacheMaxBytes: number
  private readonly maxConcurrentReads: number

  constructor(readonly root: string, options: JournalBlobStoreOptions = {}) {
    this.cacheMaxBytes = options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES
    this.maxConcurrentReads = options.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS
    if (!Number.isSafeInteger(this.cacheMaxBytes) || this.cacheMaxBytes < 0) {
      throw new Error('journal blob cache bound must be a non-negative whole number')
    }
    if (
      !Number.isSafeInteger(this.maxConcurrentReads) ||
      this.maxConcurrentReads < 1 ||
      this.maxConcurrentReads > 64
    ) {
      throw new Error('journal blob read concurrency must be a whole number from 1 to 64')
    }
  }

  encode(value: unknown): JournalBlobEncoding {
    let blobsWritten = 0
    let bytesExternalized = 0
    const visit = (candidate: unknown): unknown => {
      if (typeof candidate === 'string') {
        const bytes = Buffer.byteLength(candidate)
        if (bytes < JOURNAL_BLOB_INLINE_LIMIT_BYTES) return candidate
        const digest = crypto.createHash('sha256').update(candidate, 'utf8').digest('hex')
        if (this.publish(digest, candidate, bytes)) blobsWritten += 1
        bytesExternalized += bytes
        return {
          [JOURNAL_BLOB_KEY]: { sha256: digest, bytes, encoding: 'utf8' },
        } satisfies BlobReference
      }
      if (Array.isArray(candidate)) return candidate.map(visit)
      if (!candidate || typeof candidate !== 'object') return candidate
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>).map(([key, item]) => [key, visit(item)]),
      )
    }
    return { stored: visit(value), blobsWritten, bytesExternalized }
  }

  decode(value: unknown): unknown {
    const visit = (candidate: unknown): unknown => {
      if (blobReference(candidate)) {
        const ref = candidate[JOURNAL_BLOB_KEY]
        try {
          return this.read(ref.sha256, ref.bytes)
        } catch (error) {
          return {
            __allmyagentsJournalBlobUnreadable: {
              sha256: ref.sha256,
              bytes: ref.bytes,
              reason: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }
      if (Array.isArray(candidate)) return candidate.map(visit)
      if (!candidate || typeof candidate !== 'object') return candidate
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>).map(([key, item]) => [key, visit(item)]),
      )
    }
    return visit(value)
  }

  /**
   * Resolve a bounded history working set without blocking the hub's event loop on one synchronous file
   * read per blob. The semaphore is store-wide, so several panes opening together cannot multiply the
   * configured I/O pressure; immutable digest reads are also coalesced across concurrent requests.
   */
  async decodeManyAsync(values: readonly unknown[]): Promise<unknown[]> {
    const references = new Map<string, { digest: string; bytes: number }>()
    const collect = (candidate: unknown): void => {
      if (blobReference(candidate)) {
        const ref = candidate[JOURNAL_BLOB_KEY]
        references.set(`${ref.sha256}:${ref.bytes}`, { digest: ref.sha256, bytes: ref.bytes })
        return
      }
      if (Array.isArray(candidate)) {
        for (const item of candidate) collect(item)
        return
      }
      if (!candidate || typeof candidate !== 'object') return
      for (const item of Object.values(candidate as Record<string, unknown>)) collect(item)
    }
    for (const value of values) collect(value)

    const resolved = new Map<string, unknown>()
    await Promise.all(
      [...references.entries()].map(async ([key, ref]) => {
        try {
          resolved.set(key, await this.readAsync(ref.digest, ref.bytes))
        } catch (error) {
          resolved.set(key, {
            __allmyagentsJournalBlobUnreadable: {
              sha256: ref.digest,
              bytes: ref.bytes,
              reason: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }),
    )

    const replace = (candidate: unknown): unknown => {
      if (blobReference(candidate)) {
        const ref = candidate[JOURNAL_BLOB_KEY]
        return resolved.get(`${ref.sha256}:${ref.bytes}`)
      }
      if (Array.isArray(candidate)) return candidate.map(replace)
      if (!candidate || typeof candidate !== 'object') return candidate
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>).map(([key, item]) => [key, replace(item)]),
      )
    }
    return values.map(replace)
  }

  /**
   * Estimate the JSON envelope cost from blob metadata, without reading blob bodies. It is exact for
   * inline parsed JSON and intentionally approximate for an external string (escaping can make the final
   * JSON larger); the caller still enforces the exact encoded bound after hydration.
   */
  estimateDecodedJsonBytes(value: unknown): number {
    const estimate = (candidate: unknown): number => {
      if (blobReference(candidate)) return candidate[JOURNAL_BLOB_KEY].bytes + 2
      if (typeof candidate === 'string') return Buffer.byteLength(JSON.stringify(candidate))
      if (candidate === null || typeof candidate !== 'object') {
        return Buffer.byteLength(JSON.stringify(candidate) ?? 'null')
      }
      if (Array.isArray(candidate)) {
        return 2 + candidate.reduce((total, item, index) => total + (index > 0 ? 1 : 0) + estimate(item), 0)
      }
      let total = 2
      let index = 0
      for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
        total += (index > 0 ? 1 : 0) + Buffer.byteLength(JSON.stringify(key)) + 1 + estimate(item)
        index += 1
      }
      return total
    }
    return estimate(value)
  }

  private file(digest: string): string {
    return path.join(this.root, 'sha256', digest.slice(0, 2), digest)
  }

  private publish(digest: string, text: string, bytes: number): boolean {
    const target = this.file(digest)
    try {
      if (fs.statSync(target).size === bytes) return false
      throw new Error(`journal blob ${digest} exists with the wrong byte length`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const directory = path.dirname(target)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(
      directory,
      `.${digest}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.partial`,
    )
    let handle: number | undefined
    try {
      handle = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(handle, text, { encoding: 'utf8' })
      fs.fsyncSync(handle)
      fs.closeSync(handle)
      handle = undefined
      try {
        fs.renameSync(temporary, target)
      } catch (error) {
        // A concurrent blue/green writer may have won the identical content-addressed publication.
        if (!fs.existsSync(target) || fs.statSync(target).size !== bytes) throw error
      }
      this.fsyncDirectory(directory)
      return true
    } finally {
      if (handle !== undefined) {
        try { fs.closeSync(handle) } catch { /* preserve the primary failure */ }
      }
      try { fs.rmSync(temporary, { force: true }) } catch { /* atomic rename consumed it */ }
    }
  }

  private read(digest: string, expectedBytes: number): string {
    const cached = this.cached(digest, expectedBytes)
    if (cached !== undefined) return cached
    const bytes = fs.readFileSync(this.file(digest))
    if (bytes.byteLength !== expectedBytes) {
      throw new Error(`expected ${expectedBytes} bytes; found ${bytes.byteLength}`)
    }
    const actual = crypto.createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest) throw new Error('content hash does not match its journal reference')
    const text = bytes.toString('utf8')
    this.remember(digest, text, bytes.byteLength)
    return text
  }

  private async readAsync(digest: string, expectedBytes: number): Promise<string> {
    const cached = this.cached(digest, expectedBytes)
    if (cached !== undefined) return cached
    const pendingKey = `${digest}:${expectedBytes}`
    const inFlight = this.pendingReads.get(pendingKey)
    if (inFlight) return inFlight
    const pending = (async () => {
      await this.acquireReadSlot()
      try {
        const bytes = await fs.promises.readFile(this.file(digest))
        if (bytes.byteLength !== expectedBytes) {
          throw new Error(`expected ${expectedBytes} bytes; found ${bytes.byteLength}`)
        }
        const actual = crypto.createHash('sha256').update(bytes).digest('hex')
        if (actual !== digest) throw new Error('content hash does not match its journal reference')
        const text = bytes.toString('utf8')
        this.remember(digest, text, bytes.byteLength)
        return text
      } finally {
        this.releaseReadSlot()
      }
    })()
    this.pendingReads.set(pendingKey, pending)
    try {
      return await pending
    } finally {
      if (this.pendingReads.get(pendingKey) === pending) this.pendingReads.delete(pendingKey)
    }
  }

  private cached(digest: string, expectedBytes: number): string | undefined {
    const cached = this.cache.get(digest)
    if (!cached) return undefined
    if (cached.bytes !== expectedBytes) {
      throw new Error(`expected ${expectedBytes} bytes; found ${cached.bytes}`)
    }
    this.cache.delete(digest)
    this.cache.set(digest, cached)
    return cached.text
  }

  private remember(digest: string, text: string, bytes: number): void {
    if (bytes > this.cacheMaxBytes) return
    const previous = this.cache.get(digest)
    if (previous) {
      this.cache.delete(digest)
      this.cacheBytes -= previous.bytes
    }
    while (this.cacheBytes + bytes > this.cacheMaxBytes && this.cache.size > 0) {
      const oldest = this.cache.entries().next().value as [string, CacheEntry] | undefined
      if (!oldest) break
      this.cache.delete(oldest[0])
      this.cacheBytes -= oldest[1].bytes
    }
    if (bytes > this.cacheMaxBytes) return
    this.cache.set(digest, { text, bytes })
    this.cacheBytes += bytes
  }

  private async acquireReadSlot(): Promise<void> {
    if (this.activeReads < this.maxConcurrentReads) {
      this.activeReads += 1
      return
    }
    await new Promise<void>((resolve) => this.readWaiters.push(resolve))
    this.activeReads += 1
  }

  private releaseReadSlot(): void {
    this.activeReads -= 1
    this.readWaiters.shift()?.()
  }

  private fsyncDirectory(directory: string): void {
    // POSIX needs the directory entry flushed for rename durability. Windows does not permit opening a
    // directory this way; the file fsync + atomic rename remains its supported boundary.
    if (process.platform === 'win32') return
    let handle: number | undefined
    try {
      handle = fs.openSync(directory, 'r')
      fs.fsyncSync(handle)
    } catch {
      // Some appliance filesystems reject directory fsync. Never erase the successfully published blob.
    } finally {
      if (handle !== undefined) try { fs.closeSync(handle) } catch { /* best effort */ }
    }
  }
}
