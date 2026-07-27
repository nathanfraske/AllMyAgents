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

describe('vendorSupport — the asymmetry that must never be silent', () => {
  it('Claude: png image ok, svg image not ok, pdf file ok', () => {
    expect(vendorSupport({ kind: 'image', mime: 'image/png' }, 'claude').ok).toBe(true)
    expect(vendorSupport({ kind: 'image', mime: 'image/svg+xml' }, 'claude').ok).toBe(false)
    expect(vendorSupport({ kind: 'file', mime: 'application/pdf' }, 'claude').ok).toBe(true)
  })
  it('Codex: any image ok, ANY file not ok (images-only app-server)', () => {
    expect(vendorSupport({ kind: 'image', mime: 'image/png' }, 'codex').ok).toBe(true)
    expect(vendorSupport({ kind: 'image', mime: 'image/svg+xml' }, 'codex').ok).toBe(true) // path, not base64
    const pdf = vendorSupport({ kind: 'file', mime: 'application/pdf' }, 'codex')
    expect(pdf.ok).toBe(false)
    expect(pdf.reason).toMatch(/images only/i)
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
