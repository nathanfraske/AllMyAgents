import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isInside, loadAttachment, safeAttachmentName, saveAttachment, type AttachmentMeta } from './attachments.js'
import type { Journal } from './journal.js'

export interface PublishArtifactInput { path: string; caption?: string }
export interface PublishedArtifact {
  attachment: Omit<AttachmentMeta, 'path' | 'executionPath'>
  sha256: string
  reused: boolean
}
type Workspace = { id: string; cwd: string; executionCwd?: string }
export const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024
export const ARTIFACT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const ARTIFACT_SESSION_MAX_BYTES = 256 * 1024 * 1024
export const ARTIFACT_TOTAL_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const ARTIFACT_SESSION_MAX_FILES = 256

// An agent's display intent is not authority to expose credentials or arbitrary host paths. Files
// must belong to its actual checkout (including the host mapping of a WSL checkout), not a URL.
export function artifactSource(workspace: Workspace, raw: string): string {
  if (!raw || raw.length > 4096 || /[\u0000-\u001f]/u.test(raw) || /^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) {
    throw new Error('Provide a local file path inside this chat workspace, not a URL.')
  }
  let relative: string
  if (workspace.executionCwd && path.posix.isAbsolute(raw)) {
    relative = path.posix.relative(workspace.executionCwd, raw)
  } else {
    relative = path.relative(workspace.cwd, path.resolve(workspace.cwd, raw))
  }
  const candidate = path.resolve(workspace.cwd, relative)
  if (!isInside(workspace.cwd, candidate) || /(?:^|[\\/])(?:\.git|\.ssh|\.aws|\.azure|\.codex|\.claude|\.env(?:\.[^\\/]*)?)(?:[\\/]|$)/iu.test(relative)) {
    throw new Error('Artifact is outside this chat workspace or is a private configuration file.')
  }
  return candidate
}

/** Sniff only raster types we can safely serve inline. SVG/HTML and every other format download. */
export function artifactMime(bytes: Buffer): string {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 13 && /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return 'application/octet-stream'
}

/** Explicit, provider-neutral display intent. Snapshots live outside checkouts; journal rows contain
 * metadata only. The same fingerprint returns the original publication across retries and restarts. */
export class ChatArtifacts {
  private readonly root: string
  constructor(private readonly journal: Journal, storageRoot: string) {
    this.root = path.resolve(storageRoot)
    journal.db.exec(`CREATE TABLE IF NOT EXISTS chat_artifacts (
      id TEXT PRIMARY KEY, session TEXT NOT NULL, fingerprint TEXT NOT NULL,
      metadata TEXT NOT NULL, size INTEGER NOT NULL, UNIQUE(session, fingerprint)
    )`)
  }

  private cwd(session: string): string {
    return path.join(this.root, crypto.createHash('sha256').update(session).digest('hex'))
  }

  get(session: string, id: string): AttachmentMeta | undefined {
    const row = this.journal.db.prepare('SELECT id FROM chat_artifacts WHERE session = ? AND id = ?').get(session, id)
    return row ? loadAttachment(session, this.cwd(session), id) : undefined
  }

  async publish(workspace: Workspace, input: PublishArtifactInput): Promise<PublishedArtifact> {
    if (typeof input.path !== 'string' || (input.caption !== undefined && (typeof input.caption !== 'string' || input.caption.length > 1000))) {
      throw new Error('Artifact requires a local path and an optional caption of at most 1000 characters.')
    }
    const source = artifactSource(workspace, input.path)
    const [realCwd, realFile] = await Promise.all([fs.promises.realpath(workspace.cwd), fs.promises.realpath(source)])
    if (!isInside(realCwd, realFile)) throw new Error('Artifact symlink escapes this chat workspace.')
    // Recheck private components after realpath too (e.g. preview.png -> .env).
    artifactSource({ ...workspace, cwd: realCwd, executionCwd: undefined }, realFile)
    const handle = await fs.promises.open(realFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    let bytes: Buffer
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size === 0 || before.size > ARTIFACT_MAX_BYTES) throw new Error('Artifact must be a non-empty regular file no larger than 32 MiB.')
      const openedPath = await fs.promises.realpath(realFile)
      const named = await fs.promises.stat(openedPath)
      if (!isInside(realCwd, openedPath) || named.dev !== before.dev || named.ino !== before.ino) throw new Error('Artifact path changed while opening it.')
      bytes = Buffer.alloc(before.size)
      let offset = 0
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) throw new Error('Artifact changed while reading; publish it after the writer has finished.')
        offset += read.bytesRead
      }
      const after = await handle.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Artifact changed while reading; publish it after the writer has finished.')
    } finally { await handle.close() }
    const mime = artifactMime(bytes)
    if (mime.startsWith('image/') && bytes.length > ARTIFACT_IMAGE_MAX_BYTES) throw new Error('Image preview exceeds 5 MiB; export a smaller preview.')
    const name = safeAttachmentName(path.basename(source))
    const caption = input.caption?.trim() ?? ''
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([sha256, name, caption])).digest('hex')
    // No await from admission through publication: concurrent calls cannot race quotas or dedupe.
    const previous = this.journal.db.prepare('SELECT metadata FROM chat_artifacts WHERE session = ? AND fingerprint = ?').get(workspace.id, fingerprint) as { metadata: string } | undefined
    if (previous) {
      const attachment = JSON.parse(previous.metadata) as PublishedArtifact['attachment']
      if (!this.get(workspace.id, attachment.id)) throw new Error('The previously published artifact is missing from storage; it was not republished silently.')
      return { attachment, sha256, reused: true }
    }
    const usage = this.journal.db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM chat_artifacts WHERE session = ?').get(workspace.id) as { files: number; bytes: number }
    const total = this.journal.db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM chat_artifacts').get() as { bytes: number }
    if (usage.files >= ARTIFACT_SESSION_MAX_FILES || usage.bytes + bytes.length > ARTIFACT_SESSION_MAX_BYTES || total.bytes + bytes.length > ARTIFACT_TOTAL_MAX_BYTES) {
      throw new Error('Chat artifact storage limit reached (256 files / 256 MiB per chat, 2 GiB total). Existing previews are retained; no files were deleted.')
    }
    const cwd = this.cwd(workspace.id)
    fs.mkdirSync(cwd, { recursive: true })
    if (!isInside(fs.realpathSync(this.root), fs.realpathSync(cwd))) throw new Error('Artifact storage path escapes its root.')
    const saved = saveAttachment(workspace.id, cwd, name, mime, bytes)
    const { path: _path, executionPath: _executionPath, ...attachment } = saved
    try {
      this.journal.atomic(() => {
        this.journal.db.prepare('INSERT INTO chat_artifacts (id,session,fingerprint,metadata,size) VALUES (?,?,?,?,?)').run(saved.id, workspace.id, fingerprint, JSON.stringify(attachment), saved.size)
        this.journal.append(workspace.id, 'session/artifact', { text: caption, attachments: [attachment], sha256 })
      })
    } catch (error) {
      // Only this failed, unpublished snapshot; never another artifact or a source file.
      fs.rmSync(saved.path, { force: true })
      fs.rmSync(path.join(path.dirname(saved.path), `${saved.id}.json`), { force: true })
      throw error
    }
    return { attachment, sha256, reused: false }
  }
}
