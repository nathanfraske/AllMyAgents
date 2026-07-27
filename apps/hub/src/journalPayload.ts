import { Blob, Buffer } from 'node:buffer'

export const JOURNAL_OMISSION_KEY = '__allmyagentsJournalTruncated'

type Omission = {
  reason: string
  omittedFields?: string[]
  byteLength?: number
  originalChars?: number
}

const ATTACHMENT_METADATA_LIMITS = {
  id: 1_024,
  name: 4_096,
  mime: 1_024,
  path: 32_768,
  kind: 64,
} as const

const ATTACHMENT_METADATA_KEYS = new Set<string>([
  ...Object.keys(ATTACHMENT_METADATA_LIMITS),
  'size',
])

// Do not content-sniff every long string. Command output can legitimately be a base64 dump, and silently
// eating transcript text would be worse than a false negative. These names are deliberately narrow:
// callers use them to say "this value is bytes", so a large base64 value here is not ambiguous text.
const EXPLICIT_BINARY_FIELD =
  /^(?:base64|bytes|bytesBase64|contentBase64|dataBase64|fileBytes|imageBytes|fileData|imageData|blob)$/i
const INLINE_BINARY_FIELD = /^(?:url|uri|src|imageUrl|fileUrl|thumbnailUrl)$/i
const BULK_BASE64_MIN_CHARS = 4 * 1024
const DATA_URL = /^data:[^,]{0,1024};base64,/i
const MAX_OMITTED_FIELD_NAMES = 32

function omission(details: Omission): Record<string, Omission> {
  return { [JOURNAL_OMISSION_KEY]: details }
}

function byteLengthOf(value: ArrayBuffer | SharedArrayBuffer | ArrayBufferView | Blob): number {
  if (value instanceof Blob) return value.size
  if (ArrayBuffer.isView(value)) return value.byteLength
  return value.byteLength
}

function isBinaryObject(value: object): value is ArrayBuffer | SharedArrayBuffer | ArrayBufferView | Blob {
  return (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) ||
    ArrayBuffer.isView(value) ||
    value instanceof Blob
  )
}

function isSerializedBuffer(value: Record<string, unknown>): value is { type: 'Buffer'; data: number[] } {
  return (
    value.type === 'Buffer' &&
    Array.isArray(value.data) &&
    value.data.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  )
}

function isBulkBase64(value: string): boolean {
  if (value.length < BULK_BASE64_MIN_CHARS || value.length % 4 === 1) return false
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)
}

function isByteArray(value: unknown[]): boolean {
  return (
    value.length >= BULK_BASE64_MIN_CHARS &&
    value.every((item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255)
  )
}

function validAttachmentMetadata(key: string, value: unknown): boolean {
  if (key === 'size') return Number.isSafeInteger(value) && Number(value) >= 0
  const limit = ATTACHMENT_METADATA_LIMITS[key as keyof typeof ATTACHMENT_METADATA_LIMITS]
  return typeof value === 'string' && value.length <= limit
}

function summarizeOmittedFields(fields: string[]): string[] {
  const unique = [...new Set(fields)].sort()
  if (unique.length <= MAX_OMITTED_FIELD_NAMES) return unique
  return [
    ...unique.slice(0, MAX_OMITTED_FIELD_NAMES),
    `$and-${unique.length - MAX_OMITTED_FIELD_NAMES}-more`,
  ]
}

/**
 * Rebuild an attachment from the journal's metadata contract instead of trying to enumerate today's
 * possible byte fields. This is the load-bearing defense: a future caller can journal its convenient
 * in-memory attachment object and still cannot accidentally persist `base64`, `bytes`, or a new raw-body
 * property. Adding a new metadata field must be an intentional change to this allowlist.
 */
function sanitizeAttachment(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return omission({ reason: 'attachment-metadata-only', omittedFields: ['$value'] })
  }
  if (Buffer.isBuffer(value) || isBinaryObject(value)) {
    return omission({ reason: 'attachment-metadata-only', omittedFields: ['$binary'] })
  }

  const source = value as Record<string, unknown>
  if (isSerializedBuffer(source)) {
    return omission({ reason: 'attachment-metadata-only', omittedFields: ['$binary'] })
  }
  const clean: Record<string, unknown> = {}
  const omittedFields: string[] = []
  for (const [key, field] of Object.entries(source)) {
    if (!ATTACHMENT_METADATA_KEYS.has(key) || !validAttachmentMetadata(key, field)) {
      omittedFields.push(key)
      continue
    }
    clean[key] = field
  }
  if (omittedFields.length) {
    clean[JOURNAL_OMISSION_KEY] = {
      reason: 'attachment-metadata-only',
      // Bound the marker too. A raw typed array or a malformed object with thousands of numeric keys must
      // not shed its bytes only to replace them with an equally enormous inventory of property names.
      omittedFields: summarizeOmittedFields(omittedFields),
    }
  }
  return clean
}

function sanitizeValue(value: unknown, fieldName: string | undefined, ancestors: Set<object>): unknown {
  if (typeof value === 'string') {
    if (
      fieldName &&
      (EXPLICIT_BINARY_FIELD.test(fieldName) || INLINE_BINARY_FIELD.test(fieldName)) &&
      DATA_URL.test(value)
    ) {
      return omission({ reason: 'inline-binary-data-url', originalChars: value.length })
    }
    if (fieldName && EXPLICIT_BINARY_FIELD.test(fieldName) && isBulkBase64(value)) {
      return omission({ reason: 'bulk-base64', originalChars: value.length })
    }
    return value
  }

  if (!value || typeof value !== 'object') return value

  // Buffer is also an ArrayBuffer view, but calling out its length before generic traversal avoids its
  // JSON representation (`{"type":"Buffer","data":[...]}`) becoming hundreds of thousands of integers.
  if (Buffer.isBuffer(value)) {
    return omission({ reason: 'binary-value', byteLength: value.byteLength })
  }
  if (isBinaryObject(value)) {
    return omission({ reason: 'binary-value', byteLength: byteLengthOf(value) })
  }

  if (fieldName === 'attachments') {
    if (!Array.isArray(value)) {
      return omission({ reason: 'attachment-metadata-only', omittedFields: ['$value'] })
    }
    return value.map(sanitizeAttachment)
  }

  if (Array.isArray(value)) {
    if (fieldName && EXPLICIT_BINARY_FIELD.test(fieldName) && isByteArray(value)) {
      return omission({ reason: 'binary-value', byteLength: value.length })
    }
    if (ancestors.has(value)) return omission({ reason: 'circular-reference' })
    ancestors.add(value)
    const clean = value.map((item) => sanitizeValue(item, undefined, ancestors))
    ancestors.delete(value)
    return clean
  }

  const source = value as Record<string, unknown>
  if (isSerializedBuffer(source)) {
    return omission({ reason: 'binary-value', byteLength: source.data.length })
  }
  if (ancestors.has(value)) return omission({ reason: 'circular-reference' })
  ancestors.add(value)
  const clean: Record<string, unknown> = {}
  const base64Envelope = source.type === 'base64'
  for (const [key, field] of Object.entries(source)) {
    // SDK image blocks commonly spell bytes `{type:"base64", data:"..."}`. `data` alone is far too
    // generic to classify globally, so only treat it as binary under that explicit discriminator.
    const effectiveKey = base64Envelope && key === 'data' ? 'base64' : key
    clean[key] = sanitizeValue(field, effectiveKey, ancestors)
  }
  ancestors.delete(value)
  return clean
}

/**
 * Remove bulk binary from a journal payload BEFORE redaction and JSON serialization.
 *
 * Attachment entries are always reconstructed from metadata. Outside that contract this stays
 * conservative: only values that identify themselves as binary are replaced, while arbitrary large
 * strings remain byte-for-byte intact. Every replacement is a plain JSON marker, so the event is still
 * durably appended, emitted, replayable, and visibly incomplete instead of becoming a poison row.
 */
export function sanitizeJournalPayload(payload: unknown): unknown {
  return sanitizeValue(payload ?? null, undefined, new Set())
}
