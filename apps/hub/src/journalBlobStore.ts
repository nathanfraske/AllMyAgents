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

export interface JournalBlobEncoding {
  stored: unknown
  blobsWritten: number
  bytesExternalized: number
}

const SHA256 = /^[0-9a-f]{64}$/u
const CACHE_MAX_BYTES = 16 * 1024 * 1024

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
  private readonly cache = new Map<string, string>()
  private cacheBytes = 0

  constructor(readonly root: string) {}

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
    const cached = this.cache.get(digest)
    if (cached !== undefined) {
      this.cache.delete(digest)
      this.cache.set(digest, cached)
      return cached
    }
    const bytes = fs.readFileSync(this.file(digest))
    if (bytes.byteLength !== expectedBytes) {
      throw new Error(`expected ${expectedBytes} bytes; found ${bytes.byteLength}`)
    }
    const actual = crypto.createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest) throw new Error('content hash does not match its journal reference')
    const text = bytes.toString('utf8')
    if (bytes.byteLength <= CACHE_MAX_BYTES) {
      while (this.cacheBytes + bytes.byteLength > CACHE_MAX_BYTES && this.cache.size > 0) {
        const oldest = this.cache.entries().next().value as [string, string] | undefined
        if (!oldest) break
        this.cache.delete(oldest[0])
        this.cacheBytes -= Buffer.byteLength(oldest[1])
      }
      this.cache.set(digest, text)
      this.cacheBytes += bytes.byteLength
    }
    return text
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
