import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface AttachmentMeta {
  id: string
  name: string
  mime: string
  size: number
  /** Absolute worker-readable path. Journal/API metadata only; never file bytes. */
  path: string
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 5
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class AttachmentInputError extends Error {}

export function uploadRoot(cwd: string): string {
  // Lifecycle note: Stop now preserves worktrees unconditionally. These untracked files also make Git's
  // guarded Delete path report the worktree dirty, so Delete preserves them too. There is intentionally
  // no silent attachment GC yet; a future explicit delete/retention policy must remove uploads only after
  // it can do so without weakening the worktree data-loss fence.
  return path.resolve(cwd, '.allmyagents', 'uploads')
}

/** True only for a real descendant, with path.resolve + path.relative doing the security work. */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative.length > 0 && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

function secureUploadRoot(cwd: string, create: boolean): string | undefined {
  const lexical = uploadRoot(cwd)
  if (create) fs.mkdirSync(lexical, { recursive: true })
  if (!fs.existsSync(lexical)) return undefined
  const realCwd = fs.realpathSync(cwd)
  const realRoot = fs.realpathSync(lexical)
  // A checked-in `.allmyagents` symlink/junction must not redirect uploads outside the workspace.
  if (!isInside(realCwd, realRoot)) throw new Error('attachment upload root escapes the session workspace')
  return realRoot
}

/**
 * Make a portable display/storage name. This is convenience, not the containment boundary: every path
 * built from it is independently resolved and checked by {@link isInside}.
 */
export function safeAttachmentName(raw: string): string {
  const base = path.posix.basename(raw.replaceAll('\\', '/')).trim()
  const portable = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  if (!portable || portable === '.' || portable === '..') {
    throw new AttachmentInputError('attachment filename is required')
  }
  if (Buffer.byteLength(portable, 'utf8') > 180) {
    throw new AttachmentInputError('attachment filename is too long')
  }
  return portable
}

export function attachmentLimitForMime(mime: string): number {
  return mime.toLowerCase().startsWith('image/') ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
}

export function saveAttachment(
  sessionId: string,
  cwd: string,
  rawName: string,
  mime: string,
  bytes: Buffer
): AttachmentMeta {
  const root = secureUploadRoot(cwd, true)!
  const name = safeAttachmentName(rawName)
  const id = crypto.randomUUID()
  const file = path.resolve(root, `${id}-${name}`)
  const sidecar = path.resolve(root, `${id}.json`)
  // The sanitized basename is NOT trusted. Resolve both paths and prove containment immediately before
  // writing so a future sanitizer regression cannot turn an upload into an arbitrary filesystem write.
  if (!isInside(root, file) || !isInside(root, sidecar)) throw new Error('attachment path escaped upload root')
  const meta: AttachmentMeta = { id, name, mime, size: bytes.length, path: file }
  fs.writeFileSync(file, bytes, { flag: 'wx' })
  try {
    fs.writeFileSync(sidecar, JSON.stringify({ ...meta, sessionId }), { flag: 'wx' })
  } catch (err) {
    // The payload was created by this call and has no reachable id without its sidecar.
    fs.rmSync(file, { force: true })
    throw err
  }
  return meta
}

/**
 * Resolve an id back to trusted metadata. The sidecar is data on disk, not authority: rebuild the payload
 * path from the validated id/name and prove both the requested sidecar and payload remain inside this
 * session's own upload root before opening either.
 */
export function loadAttachment(sessionId: string, cwd: string, id: string): AttachmentMeta | undefined {
  if (!ATTACHMENT_ID.test(id)) return undefined
  let root: string | undefined
  try {
    root = secureUploadRoot(cwd, false)
  } catch {
    return undefined
  }
  if (!root) return undefined
  const sidecar = path.resolve(root, `${id}.json`)
  if (!isInside(root, sidecar) || !fs.existsSync(sidecar)) return undefined
  const realSidecar = fs.realpathSync(sidecar)
  if (!isInside(root, realSidecar) || !fs.statSync(realSidecar).isFile()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(realSidecar, 'utf8'))
  } catch {
    return undefined
  }
  const candidate = parsed as (Partial<AttachmentMeta> & { sessionId?: unknown }) | null
  let safeName: string
  try {
    safeName = typeof candidate?.name === 'string' ? safeAttachmentName(candidate.name) : ''
  } catch {
    return undefined
  }
  if (
    !candidate ||
    candidate.sessionId !== sessionId ||
    candidate.id !== id ||
    typeof candidate.name !== 'string' ||
    safeName !== candidate.name ||
    typeof candidate.mime !== 'string' ||
    typeof candidate.size !== 'number' ||
    !Number.isSafeInteger(candidate.size) ||
    candidate.size < 0
  ) {
    return undefined
  }
  const file = path.resolve(root, `${id}-${candidate.name}`)
  if (!isInside(root, file) || !fs.existsSync(file)) return undefined
  const realFile = fs.realpathSync(file)
  if (!isInside(root, realFile) || !fs.statSync(realFile).isFile()) return undefined
  const size = fs.statSync(realFile).size
  if (size !== candidate.size) return undefined
  return { id, name: candidate.name, mime: candidate.mime, size, path: realFile }
}

export function resolveAttachments(sessionId: string, cwd: string, ids: readonly string[]): AttachmentMeta[] {
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) throw new AttachmentInputError('duplicate attachment id')
  if (unique.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentInputError(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments may be sent at once`)
  }
  return unique.map((id) => {
    const attachment = loadAttachment(sessionId, cwd, id)
    if (!attachment) throw new AttachmentInputError(`unknown attachment: ${id}`)
    return attachment
  })
}

export function isClaudeImageMime(mime: string): mime is 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp'
}
