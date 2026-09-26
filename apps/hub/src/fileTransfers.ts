import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

// These are transport buffers, not model/tool payload limits. The model sees only a receipt.
export const FILE_TRANSFER_CHUNK = 512 * 1024
export const FILE_TRANSFER_MAX = 256 * 1024 * 1024
export type FileTransferRequest = {
  id: string
  mode: 'read' | 'write'
  operation: 'begin' | 'chunk' | 'finish' | 'abort' | 'status'
  path?: string
  size?: number
  sha256?: string
  offset?: number
  content?: string
}
export type FileTransferReceipt = {
  state: 'active' | 'completed' | 'aborted' | 'outcome_unknown'
  size: number
  offset: number
  sha256?: string
  content?: string
}
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
const inside = (base: string, file: string) => {
  const rel = path.relative(base, file)
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

/** Refuse links/junctions, ADS, parent traversal and non-files, including in parent directories.
 * The chosen root is canonicalized once by the caller. Rechecked before publication. */
export async function transferPath(base: string, relative: string, mustExist: boolean): Promise<string> {
  if (typeof relative !== 'string' || relative.length > 4096 || !relative ||
      /[\x00-\x1f:]/u.test(relative) || path.isAbsolute(relative) || /^[\\/]/u.test(relative)) {
    throw new Error('Transfer path must be relative to the granted root.')
  }
  const parts = relative.split(/[\\/]/u)
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/u.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/iu.test(p))) throw new Error('Transfer path contains traversal, ambiguous names or empty components.')
  let current = base
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!)
    if (!inside(base, current)) throw new Error('Transfer path escapes its root.')
    const stat = await fs.lstat(current).catch(error => {
      if (!mustExist && i === parts.length - 1 && error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) continue
    if (stat.isSymbolicLink()) throw new Error('Transfers do not follow symbolic links or junctions.')
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error('Transfer path is not a regular file/directory.')
    if (await fs.realpath(current) !== current) throw new Error('Transfer path changed its canonical identity.')
  }
  return current
}

type Stamp = { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }
function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.dev === b.dev && a.ino === b.ino
}
export async function hashFile(handle: FileHandle): Promise<{ size: number; sha256: string; stamp: Stamp }> {
  const stamp = await handle.stat()
  if (!stamp.isFile() || stamp.size > FILE_TRANSFER_MAX) throw new Error(`Transfer requires a regular file of at most ${FILE_TRANSFER_MAX} bytes.`)
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.alloc(FILE_TRANSFER_CHUNK)
  let offset = 0
  while (offset < stamp.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stamp.size - offset), offset)
    if (!bytesRead) throw new Error('Source file changed while hashing.')
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
  }
  if (!sameStamp(stamp, await handle.stat())) throw new Error('Source file changed while hashing.')
  return { size: stamp.size, sha256: hash.digest('hex'), stamp }
}

type Saved = FileTransferReceipt & { owner: string; base: string; relative: string; mode: 'read' | 'write'; temp?: string }
type Active = { saved: Saved; handle: FileHandle; hash: crypto.Hash; stamp: Stamp; timer: NodeJS.Timeout }

/** Target-side bounded staging. No target file exists until checksum-verified exclusive publication.
 * Durable receipts fence repeat begin/finish after an ambiguous acknowledgement or process restart. */
export class FileTransferTarget {
  private active = new Map<string, Active>()
  private busy = new Set<string>()
  constructor(private directory: string) {}
  private receiptFile(id: string) { return path.join(this.directory, `${id}.json`) }
  private async save(id: string, saved: Saved, exclusive = false) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (exclusive) {
      await fs.writeFile(this.receiptFile(id), JSON.stringify(saved), { flag: 'wx', mode: 0o600 })
    } else {
      const temp = path.join(this.directory, `${id}.${crypto.randomUUID()}.tmp`)
      try {
        await fs.writeFile(temp, JSON.stringify(saved), { flag: 'wx', mode: 0o600 })
        await fs.rename(temp, this.receiptFile(id))
      } finally { await fs.unlink(temp).catch(() => {}) }
    }
  }
  private timer(id: string) {
    const timer = setTimeout(() => { void this.expire(id).catch(() => {}) }, 5 * 60_000)
    timer.unref()
    return timer
  }
  private async expire(id: string) {
    if (this.busy.has(id)) { const entry = this.active.get(id); if (entry) entry.timer = this.timer(id); return }
    const entry = this.active.get(id)
    if (!entry) return
    this.busy.add(id)
    try { await this.abort(id, entry) } finally { this.busy.delete(id) }
  }
  private async abort(id: string, entry: Active) {
    clearTimeout(entry.timer)
    this.active.delete(id)
    try {
      await entry.handle.close()
      if (entry.saved.temp) {
        await transferPath(entry.saved.base, entry.saved.relative, false)
        await fs.unlink(entry.saved.temp).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
      entry.saved.state = 'aborted'
    } catch (error) {
      entry.saved.state = 'outcome_unknown'
      throw error
    } finally { await this.save(id, entry.saved) }
  }
  async shutdown() { for (const id of this.active.keys()) await this.expire(id) }
  async execute(base: string, owner: string, request: FileTransferRequest, authorized: () => boolean = () => true): Promise<FileTransferReceipt> {
    if (!request || !validId(request.id) || !owner || owner.length > 1024 || !['read', 'write'].includes(request.mode)) throw new Error('Invalid transfer identity.')
    if (this.busy.has(request.id)) throw new Error('Transfer already has an in-flight operation; do not resend.')
    const check = () => { if (!authorized()) throw new Error('Transfer authority was revoked.') }
    check()
    this.busy.add(request.id)
    try {
      if (request.operation === 'begin') {
        if (this.active.size + this.busy.size > 4) throw new Error('Target transfer capacity reached (4 active).')
        const realBase = await fs.realpath(base)
        const relative = request.path ?? ''
        const destination = await transferPath(realBase, relative, request.mode === 'read')
        if (request.mode === 'write') {
          if (!Number.isSafeInteger(request.size) || request.size! < 0 || request.size! > FILE_TRANSFER_MAX || (request.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(request.sha256))) throw new Error('Invalid transfer size/checksum.')
          if (await fs.lstat(destination).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e })) throw new Error('Destination exists; choose a new path. Transfers never overwrite.')
        }
        const saved: Saved = { owner, base: realBase, relative, mode: request.mode,
          state: 'active', offset: 0, size: request.size ?? 0,
          ...(request.mode === 'write' ? { sha256: request.sha256, temp: path.join(path.dirname(destination), `.ama-transfer-${request.id}.part`) } : {}),
        }
        // Reserve the ID before opening staging: a lost begin ACK cannot accidentally create a second transfer.
        await this.save(request.id, saved, true)
        check()
        const before = saved.temp ? undefined : await fs.lstat(destination)
        const handle = await fs.open(saved.temp ?? destination, saved.temp ? 'wx+' : 'r', 0o600)
        try {
          const stamp = await handle.stat()
          if (!stamp.isFile() || stamp.size > FILE_TRANSFER_MAX) throw new Error('Source is not a bounded regular file.')
          await transferPath(realBase, saved.temp ? path.relative(realBase, saved.temp) : relative, true)
          if (before && (!before.isFile() || !sameStamp(before, stamp))) throw new Error('Source identity changed while opening.')
          if (request.mode === 'read') saved.size = stamp.size
          await this.save(request.id, saved)
          this.active.set(request.id, { saved, handle, stamp, hash: crypto.createHash('sha256'), timer: this.timer(request.id) })
        } catch (error) { await handle.close(); if (saved.temp) await fs.unlink(saved.temp).catch(() => {}); throw error }
      }
      let entry = this.active.get(request.id)
      const saved: Saved = entry?.saved ?? JSON.parse(await fs.readFile(this.receiptFile(request.id), 'utf8')) as Saved
      if (saved.owner !== owner || saved.mode !== request.mode || saved.base !== await fs.realpath(base)) throw new Error('Transfer belongs to another caller, root, or direction.')
      if (!entry) {
        // A restart cannot prove how far publication progressed. Never replay a write from this state.
        if (saved.state === 'active') saved.state = 'outcome_unknown'
        if (request.operation !== 'status') throw new Error(`Transfer is ${saved.state}; inspect its receipt, do not retry the operation.`)
        return { state: saved.state, size: saved.size, offset: saved.offset, sha256: saved.sha256 }
      }
      if (request.operation !== 'status') { clearTimeout(entry.timer); entry.timer = this.timer(request.id) }
      if (request.operation === 'chunk') {
        if (request.offset !== saved.offset) throw new Error('Transfer offset mismatch; chunks are never blindly replayed.')
        check()
        const remaining = saved.size - saved.offset
        if (remaining <= 0) throw new Error('No remaining file bytes.')
        let content: string | undefined
        if (saved.mode === 'write') {
          if (typeof request.content !== 'string' || request.content.length > Math.ceil(FILE_TRANSFER_CHUNK / 3) * 4) throw new Error('Invalid chunk size.')
          const bytes = Buffer.from(request.content, 'base64')
          if (!bytes.length || bytes.length > Math.min(FILE_TRANSFER_CHUNK, remaining) || bytes.toString('base64') !== request.content) throw new Error('Invalid chunk encoding/length.')
          let written = 0
          while (written < bytes.length) {
            const result = await entry.handle.write(bytes, written, bytes.length - written, saved.offset + written)
            if (!result.bytesWritten) throw new Error('Target write made no progress.')
            written += result.bytesWritten
          }
          entry.hash.update(bytes); saved.offset += bytes.length
        } else {
          if (!sameStamp(entry.stamp, await entry.handle.stat())) throw new Error('Source changed during transfer.')
          const buffer = Buffer.alloc(Math.min(FILE_TRANSFER_CHUNK, remaining))
          const result = await entry.handle.read(buffer, 0, buffer.length, saved.offset)
          if (!result.bytesRead) throw new Error('Source ended before expected size.')
          const bytes = buffer.subarray(0, result.bytesRead)
          entry.hash.update(bytes); saved.offset += bytes.length; content = bytes.toString('base64')
        }
        return { state: saved.state, size: saved.size, offset: saved.offset, ...(content ? { content } : {}) }
      }
      if (request.operation === 'abort') { await this.abort(request.id, entry); entry = undefined }
      else if (request.operation === 'finish') {
        if (saved.offset !== saved.size) throw new Error('Transfer is incomplete.')
        const digest = entry.hash.copy().digest('hex')
        if (saved.mode === 'write' && digest !== (saved.sha256 ?? request.sha256)) throw new Error('Transfer checksum mismatch; destination was not published.')
        if (saved.mode === 'read' && !sameStamp(entry.stamp, await entry.handle.stat())) throw new Error('Source changed during transfer.')
        const destination = await transferPath(saved.base, saved.relative, saved.mode === 'read')
        check()
        if (saved.temp) {
          const actual = await hashFile(entry.handle)
          if (actual.size !== saved.size || actual.sha256 !== digest) throw new Error('Staged file checksum mismatch; destination was not published.')
          const staged = await fs.lstat(saved.temp)
          if (!staged.isFile() || !sameStamp(staged, actual.stamp)) throw new Error('Staged file identity changed.')
          await entry.handle.sync()
          await transferPath(saved.base, saved.relative, false)
          check()
          // Exclusive hard-link publication is atomic and cannot clobber a concurrently created file.
          await fs.link(saved.temp, destination)
          await fs.unlink(saved.temp)
        }
        await entry.handle.close(); clearTimeout(entry.timer); this.active.delete(request.id)
        saved.sha256 = digest; saved.state = 'completed'
        await this.save(request.id, saved)
      } else if (!['begin', 'status'].includes(request.operation)) throw new Error('Unknown transfer operation.')
      return { state: saved.state, size: saved.size, offset: saved.offset, sha256: saved.state === 'completed' ? saved.sha256 : undefined }
    } finally { this.busy.delete(request.id) }
  }
}
