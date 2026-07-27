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

export interface Support {
  ok: boolean
  reason?: string
}

/**
 * Whether `vendor` can actually receive this attachment. Drives the per-attachment "not supported here"
 * badge and the decision to drop an attachment from the send rather than let it silently fail — silently
 * dropping a file the user deliberately attached is the worst option; they assume the agent saw it.
 */
export function vendorSupport(a: Pick<AttachmentMeta, 'kind' | 'mime'>, vendor: Vendor): Support {
  if (vendor === 'claude') {
    if (a.kind === 'image') {
      return claudeImageMediaType(a.mime)
        ? { ok: true }
        : { ok: false, reason: `Claude accepts PNG, JPEG, GIF or WebP images — not ${a.mime || 'this type'}` }
    }
    return { ok: true } // documents (PDF / plaintext) supported as document blocks
  }
  // codex: images only, via a local path — any image/* the OS produced is fine; non-images are not.
  return a.kind === 'image' ? { ok: true } : { ok: false, reason: 'Codex can attach images only, not files' }
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
