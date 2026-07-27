import { formatBytes } from './attachments'

// --- Large-paste promotion ------------------------------------------------------------------------
//
// Pasting a wall of logs into the composer thrashes the chat. Over a threshold we promote the paste to a
// "pasted text" CHIP so the composer (and transcript) stay readable — but the content still reaches the
// agent IN FULL.
//
// The load-bearing decision, and why this lives in the TEXT path not the attachment path: a pasted blob
// is TEXT. Nothing about any vendor prevents delivering text, so on send the promoted content is inlined
// back into the prompt via composeWithPastes(). That reaches BOTH vendors identically (Codex takes text;
// it does NOT take non-image files — routing this through the image/file attachment path would silently
// drop it on Codex, the single worst outcome). Inline delivery has one ceiling: the model's context
// window. For content that must exceed that, the future upgrade is to write the blob beside the uploads
// and put its PATH in the prompt (needs the hub endpoint) — deliberately NOT this cut.

export interface PastedText {
  id: string
  name: string
  content: string
}

/** Promote a paste iff it is at least `threshold` characters. `threshold <= 0` disables promotion, so
 *  ordinary pasting is never made weird. */
export function shouldPromotePaste(text: string, threshold: number): boolean {
  return threshold > 0 && text.length >= threshold
}

/** UTF-8 byte length (for a human size label), tolerant of environments without TextEncoder. */
export function pasteByteSize(content: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(content).length : content.length
}

/** Chip label: "Pasted text · 48.2 KB · 812 lines". */
export function pasteChipLabel(content: string): string {
  const lines = content.split('\n').length
  return `Pasted text · ${formatBytes(pasteByteSize(content))} · ${lines} line${lines === 1 ? '' : 's'}`
}

/**
 * DELIVERY (parity-critical). Build the prompt text that actually goes to the vendor: the typed text
 * followed by each promoted paste as a clearly delimited section. NOTHING is truncated — the whole point
 * is not losing it. Plain text, so it is identical for Claude and Codex. Returns `typed` unchanged when
 * there are no pastes, so a normal message is byte-for-byte unaffected.
 */
export function composeWithPastes(typed: string, pastes: PastedText[]): string {
  if (pastes.length === 0) return typed
  const blocks = pastes.map((p) => `----- ${p.name} -----\n${p.content}`)
  const body = blocks.join('\n\n')
  const head = typed.trim()
  return head ? `${head}\n\n${body}` : body
}
