import { describe, expect, it } from 'vitest'
import {
  attachmentsFromPayload,
  classifyKind,
  claudeImageMediaType,
  formatBytes,
  isImageMime,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  validateIncoming,
  vendorSupport,
} from './attachments'

// New module → old-vs-new is hollow; each assertion was confirmed to fail under a deliberate mutation of
// the function it covers (documented in the report), so it discriminates behaviour.

describe('classifyKind / isImageMime', () => {
  it('treats image/* as image, everything else as file', () => {
    expect(classifyKind('image/png')).toBe('image')
    expect(classifyKind('image/svg+xml')).toBe('image') // still an image kind, even if Claude rejects it
    expect(classifyKind('application/pdf')).toBe('file')
    expect(classifyKind('')).toBe('file')
    expect(isImageMime('image/webp')).toBe(true)
    expect(isImageMime('text/plain')).toBe(false)
  })
})

describe('claudeImageMediaType', () => {
  it('accepts only the four Anthropic base64 image types', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(claudeImageMediaType(m)).toBe(m)
  })
  it('rejects other image types Claude cannot take as a block', () => {
    expect(claudeImageMediaType('image/svg+xml')).toBeNull()
    expect(claudeImageMediaType('image/bmp')).toBeNull()
    expect(claudeImageMediaType('image/heic')).toBeNull()
  })
})

describe('vendorSupport — mirrors the hub, vendor-neutral', () => {
  const ok = (name: string, mime: string, vendor: 'claude' | 'codex') => vendorSupport({ name, mime }, vendor).ok

  it('DOCUMENTS ARE ACCEPTED FOR CODEX — a PDF and an .xlsx (the regression this fixes)', () => {
    // Ramanujan's hub document support means Codex takes these now; the stale client refused them.
    expect(ok('report.pdf', 'application/pdf', 'codex')).toBe(true)
    expect(ok('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'codex')).toBe(true)
    expect(ok('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'codex')).toBe(true)
    expect(ok('server.log', 'text/plain', 'codex')).toBe(true)
    expect(ok('main.rs', '', 'codex')).toBe(true) // source file by extension, no mime
  })

  it('accepts the same set for Claude — the hub is vendor-neutral at attach time', () => {
    for (const v of ['claude', 'codex'] as const) {
      expect(ok('shot.png', 'image/png', v)).toBe(true)
      expect(ok('paper.pdf', 'application/pdf', v)).toBe(true)
      expect(ok('data.csv', 'text/csv', v)).toBe(true)
    }
  })

  it('still REJECTS genuinely unsupported types at attach time (honest failure, not silent drop)', () => {
    const zip = vendorSupport({ name: 'bundle.zip', mime: 'application/zip' }, 'codex')
    expect(zip.ok).toBe(false)
    expect(zip.reason).toBeTruthy()
    // svg is an image mime but not a valid base64 image block and not text-by-extension → rejected on both
    expect(ok('logo.svg', 'image/svg+xml', 'claude')).toBe(false)
    expect(ok('a.out', 'application/octet-stream', 'codex')).toBe(false)
  })

  it('detects documents by extension even when the mime is missing/generic', () => {
    expect(ok('q3.xlsx', 'application/octet-stream', 'codex')).toBe(true)
    expect(ok('spec.pdf', '', 'codex')).toBe(true)
  })
})

describe('formatBytes', () => {
  it('scales B / KB / MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2.4 * 1024 * 1024)).toBe('2.4 MB')
  })
  it('is empty for nonsense sizes', () => {
    expect(formatBytes(-1)).toBe('')
    expect(formatBytes(NaN)).toBe('')
  })
})

describe('validateIncoming', () => {
  const img = (size: number) => ({ name: 'shot.png', size, type: 'image/png' })
  const doc = (size: number) => ({ name: 'spec.pdf', size, type: 'application/pdf' })

  it('accepts an image under the image cap', () => {
    expect(validateIncoming(img(MAX_IMAGE_BYTES - 1), 0)).toBeNull()
  })
  it('rejects an image over the image cap (not the larger file cap)', () => {
    // A 7MB image is over the 5MB image cap even though it is under the 10MB file cap — the kind picks
    // the cap. A mutation that used MAX_FILE_BYTES for images would wrongly accept this.
    const err = validateIncoming(img(7 * 1024 * 1024), 0)
    expect(err).toMatch(/over the/)
    expect(MAX_IMAGE_BYTES).toBeLessThan(MAX_FILE_BYTES)
  })
  it('accepts a document between the image and file caps', () => {
    expect(validateIncoming(doc(7 * 1024 * 1024), 0)).toBeNull()
  })
  it('rejects the count-cap-th additional file, regardless of size', () => {
    expect(validateIncoming(img(10), MAX_ATTACHMENTS)).toMatch(/up to 5/)
  })
  it('rejects an empty file', () => {
    expect(validateIncoming(img(0), 0)).toMatch(/empty/)
  })
})

describe('attachmentsFromPayload', () => {
  it('reconstructs metadata and DROPS the hub path (bytes/path never reach the client item)', () => {
    const out = attachmentsFromPayload({
      text: 'look',
      attachments: [{ id: 'a1', name: 'shot.png', mime: 'image/png', size: 1234, path: '/hub/uploads/a1.png' }],
    })
    expect(out).toEqual([{ id: 'a1', name: 'shot.png', mime: 'image/png', size: 1234, kind: 'image' }])
    // path must not survive onto the client-side metadata
    expect(JSON.stringify(out)).not.toContain('/hub/uploads')
  })
  it('derives kind from mime and defaults missing fields', () => {
    const out = attachmentsFromPayload({ attachments: [{ id: 'd1', mime: 'application/pdf' }] })
    expect(out).toEqual([{ id: 'd1', name: 'd1', mime: 'application/pdf', size: 0, kind: 'file' }])
  })
  it('skips entries without an id, and returns undefined for a plain text message', () => {
    expect(attachmentsFromPayload({ attachments: [{ name: 'no-id.png' }] })).toBeUndefined()
    expect(attachmentsFromPayload({ text: 'hi' })).toBeUndefined()
    expect(attachmentsFromPayload(null)).toBeUndefined()
  })
})
