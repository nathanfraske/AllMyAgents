import type { AttachmentMeta } from './attachments'

export interface GalleryImage { sessionId: string; attachment: AttachmentMeta; src: string }
// Only actual attachment components register. Model-authored HTML/data attributes never
// become authority to fetch an image. Weak references also avoid retaining old transcripts.
const images = new WeakMap<HTMLButtonElement, GalleryImage>()
export function registerChatImage(node: HTMLButtonElement, image: GalleryImage) {
  images.set(node, image)
  return { update(next: GalleryImage) { images.set(node, next) }, destroy() { images.delete(node) } }
}

export function conversationImages(trigger: HTMLButtonElement): GalleryImage[] {
  const current = images.get(trigger)
  if (!current) return []
  const root = trigger.closest('[role="log"]') ?? trigger.closest('.atts')
  const seen = new Set<string>()
  return Array.from(root?.querySelectorAll('button') ?? [trigger]).flatMap(node => {
    const image = images.get(node)
    if (!image || image.sessionId !== current.sessionId || seen.has(image.attachment.id)) return []
    seen.add(image.attachment.id)
    return [image]
  })
}

/** Capture before document/composer/window-bubble shortcuts. A held Escape's repeats and
 * keyup remain consumed after the viewer unmounts, so one press cannot dismiss two layers. */
export function captureViewerKeys(close: () => void, step?: (delta: number) => void): () => void {
  let active = true
  let escapeHeld = false
  const consume = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation() }
  const remove = () => {
    window.removeEventListener('keydown', down, true)
    window.removeEventListener('keyup', up, true)
    window.removeEventListener('blur', blur)
  }
  const down = (e: KeyboardEvent) => {
    if (!active) {
      if (e.key === 'Escape' && e.repeat && escapeHeld) consume(e)
      else if (e.key === 'Escape') { escapeHeld = false; remove() }
      return
    }
    if (e.key === 'Escape') { consume(e); escapeHeld = true; active = false; close() }
    else if (step && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      consume(e)
      step(e.key === 'ArrowLeft' ? -1 : 1)
    }
  }
  const up = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && escapeHeld) { consume(e); escapeHeld = false; if (!active) remove() }
    else if (active && step && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) consume(e)
  }
  const blur = () => { escapeHeld = false; if (!active) remove() }
  window.addEventListener('keydown', down, true)
  window.addEventListener('keyup', up, true)
  window.addEventListener('blur', blur)
  return () => { active = false; if (!escapeHeld) remove() }
}
