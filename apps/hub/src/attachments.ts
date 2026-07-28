import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { extractText, getDocumentProxy } from 'unpdf'
import type { Provider } from './types.js'
import { extractDocxText, extractXlsxText, OfficeExtractionError } from './officeDocuments.js'

export interface AttachmentMeta {
  id: string
  name: string
  mime: string
  size: number
  /** Absolute worker-readable path. Journal/API metadata only; never file bytes. */
  path: string
  /** Distro-native path for a WSL agent. Host-side validation and reads continue to use `path`. */
  executionPath?: string
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 5
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const MAX_INLINE_DOCUMENT_BYTES = 256 * 1024
const MAX_PDF_PAGES = 500
const MAX_PDF_IMAGE_PIXELS = 16_777_216

const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const TEXT_DOCUMENT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.log',
  '.yaml',
  '.yml',
  '.xml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.properties',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.sql',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.vue',
  '.svelte',
])
const TEXT_APPLICATION_MIMES = new Set([
  'application/json',
  'application/jsonl',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/typescript',
  'application/sql',
])
const SPECIAL_TEXT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'gemfile',
  'rakefile',
  'justfile',
])

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
  bytes: Buffer,
  extractedText?: string
): AttachmentMeta {
  const root = secureUploadRoot(cwd, true)!
  const name = safeAttachmentName(rawName)
  const id = crypto.randomUUID()
  const file = path.resolve(root, `${id}-${name}`)
  const sidecar = path.resolve(root, `${id}.json`)
  const extractedTextFile = path.resolve(root, `${id}.extracted.txt`)
  // The sanitized basename is NOT trusted. Resolve both paths and prove containment immediately before
  // writing so a future sanitizer regression cannot turn an upload into an arbitrary filesystem write.
  if (!isInside(root, file) || !isInside(root, sidecar) || !isInside(root, extractedTextFile)) {
    throw new Error('attachment path escaped upload root')
  }
  const meta: AttachmentMeta = { id, name, mime, size: bytes.length, path: file }
  fs.writeFileSync(file, bytes, { flag: 'wx' })
  try {
    if (extractedText !== undefined) fs.writeFileSync(extractedTextFile, extractedText, { flag: 'wx' })
    fs.writeFileSync(sidecar, JSON.stringify({ ...meta, sessionId }), { flag: 'wx' })
  } catch (err) {
    // The payload was created by this call and has no reachable id without its sidecar.
    fs.rmSync(file, { force: true })
    fs.rmSync(extractedTextFile, { force: true })
    throw err
  }
  return meta
}

function attachmentExtension(name: string): string {
  return path.extname(name).toLowerCase()
}

export function isPdfAttachment(attachment: Pick<AttachmentMeta, 'name' | 'mime'>): boolean {
  return attachment.mime === 'application/pdf' || attachmentExtension(attachment.name) === '.pdf'
}

export function officeAttachmentKind(
  attachment: Pick<AttachmentMeta, 'name' | 'mime'>
): 'docx' | 'xlsx' | undefined {
  const extension = attachmentExtension(attachment.name)
  if (extension === '.docx' || attachment.mime === DOCX_MIME) return 'docx'
  if (extension === '.xlsx' || attachment.mime === XLSX_MIME) return 'xlsx'
  return undefined
}

export function isTextAttachment(attachment: Pick<AttachmentMeta, 'name' | 'mime'>): boolean {
  const lowerName = attachment.name.toLowerCase()
  const extension = attachmentExtension(lowerName)
  return (
    attachment.mime.startsWith('text/') ||
    TEXT_APPLICATION_MIMES.has(attachment.mime) ||
    TEXT_DOCUMENT_EXTENSIONS.has(extension) ||
    SPECIAL_TEXT_FILENAMES.has(lowerName)
  )
}

function validateUtf8(bytes: Buffer, name: string): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new AttachmentInputError(`${name} is not valid UTF-8 text`)
  }
}

async function extractPdfText(bytes: Buffer, name: string): Promise<string> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: MAX_PDF_IMAGE_PIXELS })
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new AttachmentInputError(`${name} has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}`)
    }
    const result = await extractText(pdf, { mergePages: true })
    const text = result.text.trim()
    if (!text) {
      throw new AttachmentInputError(`This PDF appears to be scanned; no text could be extracted: ${name}`)
    }
    return text
  } catch (err) {
    if (err instanceof AttachmentInputError) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new AttachmentInputError(`Could not extract text from PDF ${name}: ${detail}`)
  } finally {
    await pdf?.destroy().catch(() => {})
  }
}

/**
 * Validate vendor delivery before an upload becomes reachable. Rasterising scanned PDF pages remains
 * deliberately deferred: accepting one without deliverable content would recreate the silent vendor
 * asymmetry this boundary exists to prevent.
 */
export async function prepareAttachment(
  provider: Provider,
  sessionId: string,
  cwd: string,
  rawName: string,
  mime: string,
  bytes: Buffer
): Promise<AttachmentMeta> {
  const name = safeAttachmentName(rawName)
  if (isPdfAttachment({ name, mime })) {
    const text = provider === 'codex' ? await extractPdfText(bytes, name) : undefined
    return saveAttachment(sessionId, cwd, name, mime, bytes, text)
  }
  const officeKind = officeAttachmentKind({ name, mime })
  if (officeKind) {
    try {
      const text = officeKind === 'docx' ? extractDocxText(bytes) : extractXlsxText(bytes)
      return saveAttachment(sessionId, cwd, name, mime, bytes, text)
    } catch (err) {
      if (!(err instanceof OfficeExtractionError)) throw err
      throw new AttachmentInputError(`Could not extract ${officeKind.toUpperCase()} ${name}: ${err.message}`)
    }
  }
  if (isClaudeImageMime(mime)) return saveAttachment(sessionId, cwd, name, mime, bytes)
  if (isTextAttachment({ name, mime })) {
    validateUtf8(bytes, name)
    return saveAttachment(sessionId, cwd, name, mime, bytes)
  }
  throw new AttachmentInputError(
    `Unsupported attachment type for ${name}; use PNG, JPEG, GIF, WebP, PDF, DOCX, XLSX, or a UTF-8 text/source file`
  )
}

function verifiedSiblingFile(attachment: AttachmentMeta, suffix: string): string {
  if (!ATTACHMENT_ID.test(attachment.id)) throw new Error(`invalid attachment id: ${attachment.id}`)
  // macOS commonly exposes the same temp directory through `/var` and `/private/var`. Compare canonical
  // paths so that alias is not mistaken for an escape while a real sidecar symlink still fails containment.
  const root = fs.realpathSync(path.dirname(attachment.path))
  const candidate = path.resolve(root, `${attachment.id}${suffix}`)
  if (!isInside(root, candidate) || !fs.existsSync(candidate)) {
    throw new Error(`attachment delivery file is unavailable: ${attachment.name}`)
  }
  const real = fs.realpathSync(candidate)
  if (!isInside(root, real) || !fs.statSync(real).isFile()) {
    throw new Error(`attachment delivery file escaped its upload root: ${attachment.name}`)
  }
  return real
}

/**
 * Convert a text-family upload into one vendor-neutral prompt block. Large documents stay on disk so
 * both agents can inspect them with file tools without consuming an entire model context window.
 */
export function documentTextBlock(attachment: AttachmentMeta, extractedText = false): string {
  const file = extractedText ? verifiedSiblingFile(attachment, '.extracted.txt') : attachment.path
  const size = fs.statSync(file).size
  if (size > MAX_INLINE_DOCUMENT_BYTES) {
    const executionFile = extractedText && attachment.executionPath
      ? path.posix.join(
          path.posix.dirname(attachment.executionPath),
          `${attachment.id}.extracted.txt`,
        )
      : attachment.executionPath ?? file
    return `Attached document ${JSON.stringify(attachment.name)} is available at ${executionFile}. Read that file before answering.`
  }
  const text = fs.readFileSync(file, 'utf8')
  const label = extractedText ? 'Extracted document text' : 'Attached document'
  return `[${label}: ${JSON.stringify(attachment.name)}]\n${text}\n[End ${label.toLowerCase()}]`
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
