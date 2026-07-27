// --- Attachment rules (shared truth for the composer UI) -----------------------------------------
//
// Pure classification/validation, kept out of the component so the caps, the mime rules, and the
// per-VENDOR support asymmetry are testable in one place. The vendor matrix was verified against the
// INSTALLED SDKs (see the spec), not assumed:
//   • Claude (@anthropic-ai/claude-agent-sdk → @anthropic-ai/sdk MessageParam): images as base64 blocks
//     (png/jpeg/gif/webp ONLY) and documents (PDF/plaintext) as document blocks.
//   • Codex (@openai/codex app-server 0.145.0): images ONLY, via a local file path (localImage) or a
//     data URI. There is NO generic file/PDF input item.
// So images work on both vendors; non-image files work on Claude only. A file a vendor cannot take must
// SAY so, never fail silently.
//
// NOTE: validateIncoming is UX only — the hub enforces the real size cap while streaming the upload,
// because content-length is client-supplied. The UI must never be the only thing standing between a
// user and a limit.

export type Vendor = 'claude' | 'codex'
export type AttachmentKind = 'image' | 'file'

/** Metadata identifying an attachment everywhere (UI, wire, journal) — never the bytes. */
export interface AttachmentMeta {
  id: string
  name: string
  mime: string
  size: number
  kind: AttachmentKind
}

// The only image media types the Anthropic API accepts as a base64 image block. Other image/* types
// (bmp, svg, heic, tiff, …) are real images the OS may hand us but are NOT valid Claude image blocks.
const CLAUDE_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export const MAX_ATTACHMENTS = 5
// Per-image cap is driven by Claude's API limit (~5MB per image after base64), the binding constraint;
// Codex takes a path and has no small cap, so 5MB is the safe common ceiling. Non-image files (Claude
// documents) get a larger but still bounded cap.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_FILE_BYTES = 10 * 1024 * 1024

export function isImageMime(mime: string): boolean {
  return typeof mime === 'string' && mime.startsWith('image/')
}

export function classifyKind(mime: string): AttachmentKind {
  return isImageMime(mime) ? 'image' : 'file'
}

/** Canonical Claude image media_type, or null if this image type is not a valid Claude image block. */
export function claudeImageMediaType(mime: string): string | null {
  return (CLAUDE_IMAGE_MIME as readonly string[]).includes(mime) ? mime : null
}

// --- Vendor acceptance, MIRRORED from the hub -----------------------------------------------------
//
// AUTHORITY: apps/hub/src/attachments.ts `prepareAttachment` (+ the codex.ts / claude.ts adapters). The
// hub decides what actually reaches a vendor; this is a client-side COPY so the composer can flag an
// unsupported file AT ATTACH TIME instead of letting it fail on send. A duplicated table goes stale — the
// last time it did, the client refused documents the hub had started accepting. KEEP THESE TWO IN SYNC;
// the honest fix (a hub-reported capability set) is deferred as too big for this cut.
//
// Acceptance is currently VENDOR-NEUTRAL: the hub accepts the same set for Claude and Codex (images
// png/jpeg/gif/webp, PDF, DOCX, XLSX, UTF-8 text/source). The only per-vendor difference is a RUNTIME one
// the client can't predict at attach time (a scanned/text-less PDF is rejected for Codex during
// extraction, accepted for Claude) — that surfaces as an honest send-time error, not a type gate here.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const TEXT_APPLICATION_MIMES = new Set([
  'application/json', 'application/jsonl', 'application/ld+json', 'application/xml',
  'application/yaml', 'application/x-yaml', 'application/javascript', 'application/typescript', 'application/sql',
])
const SPECIAL_TEXT_FILENAMES = new Set(['dockerfile', 'makefile', 'gemfile', 'rakefile', 'justfile'])
const TEXT_DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.yaml', '.yml', '.xml', '.toml',
  '.ini', '.cfg', '.conf', '.env', '.properties', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py',
  '.rs', '.go', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.sql', '.css', '.scss', '.sass', '.less', '.html', '.htm',
  '.vue', '.svelte',
])

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function isPdf(a: Pick<AttachmentMeta, 'name' | 'mime'>): boolean {
  return a.mime === 'application/pdf' || extOf(a.name) === '.pdf'
}
function officeKind(a: Pick<AttachmentMeta, 'name' | 'mime'>): 'docx' | 'xlsx' | undefined {
  const e = extOf(a.name)
  if (e === '.docx' || a.mime === DOCX_MIME) return 'docx'
  if (e === '.xlsx' || a.mime === XLSX_MIME) return 'xlsx'
  return undefined
}
function isTextLike(a: Pick<AttachmentMeta, 'name' | 'mime'>): boolean {
  const lower = a.name.toLowerCase()
  return (
    a.mime.startsWith('text/') ||
    TEXT_APPLICATION_MIMES.has(a.mime) ||
    TEXT_DOCUMENT_EXTENSIONS.has(extOf(lower)) ||
    SPECIAL_TEXT_FILENAMES.has(lower)
  )
}

export interface Support {
  ok: boolean
  reason?: string
}

/**
 * Whether this attachment is a type the hub will deliver — mirrors `prepareAttachment` (see the AUTHORITY
 * note above). Drives the composer's "not supported here" badge and the decision to drop an attachment
 * rather than let it fail silently — silently dropping a file the user deliberately attached is the worst
 * option; they assume the agent saw it.
 *
 * `vendor` is accepted for call-site stability but not consulted: acceptance is vendor-neutral (the hub
 * treats both the same at attach time). If a genuine per-vendor TYPE gate ever returns, branch here and
 * keep it aligned with the hub.
 */
export function vendorSupport(a: Pick<AttachmentMeta, 'name' | 'mime'>, _vendor?: Vendor): Support {
  if (claudeImageMediaType(a.mime) || isPdf(a) || officeKind(a) || isTextLike(a)) return { ok: true }
  return {
    ok: false,
    reason: 'Unsupported file — use PNG, JPEG, GIF, WebP, PDF, DOCX, XLSX, or a UTF-8 text/source file',
  }
}

/** Human-readable byte size: 1023 B, 4.0 KB, 2.4 MB. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Validate one incoming file against the caps, given how many are already staged. Returns a
 * human-readable error to show inline, or null if acceptable. Ordering matters: the count cap is
 * checked first (a 6th is rejected regardless of size), then empty, then the kind-specific size cap.
 */
export function validateIncoming(file: Pick<File, 'name' | 'size' | 'type'>, existingCount: number): string | null {
  if (existingCount >= MAX_ATTACHMENTS) return `You can attach up to ${MAX_ATTACHMENTS} files per message.`
  if (file.size === 0) return `“${file.name}” is empty.`
  const cap = classifyKind(file.type) === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
  if (file.size > cap) return `“${file.name}” is ${formatBytes(file.size)} — over the ${formatBytes(cap)} limit.`
  return null
}

/**
 * Reconstruct attachment METADATA from a journaled `session/input` payload. The hub journals
 * `attachments: [{id,name,mime,size,path}]` (path stays hub-side; the client never needs it — it fetches
 * bytes by id). Defensive: skips anything without a usable id, derives `kind` from the mime, and returns
 * undefined when there are none, so a normal text message carries no `attachments` field at all.
 */
export function attachmentsFromPayload(payload: unknown): AttachmentMeta[] | undefined {
  const raw = (payload as { attachments?: unknown } | null)?.attachments
  if (!Array.isArray(raw)) return undefined
  const out: AttachmentMeta[] = []
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue
    const r = a as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : undefined
    if (!id) continue
    const name = typeof r.name === 'string' ? r.name : id
    const mime = typeof r.mime === 'string' ? r.mime : ''
    const size = typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : 0
    out.push({ id, name, mime, size, kind: classifyKind(mime) })
  }
  return out.length > 0 ? out : undefined
}
