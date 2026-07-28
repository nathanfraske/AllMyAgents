export interface TranscriptClipboardPayload {
  plain: string
  html: string
}

interface CopyPiece {
  kind: 'prose' | 'code'
  text: string
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'MAIN', 'NAV', 'P', 'SECTION',
  'SUMMARY',
])

const SKIP_TAGS = new Set([
  'BUTTON', 'INPUT', 'NOSCRIPT', 'SCRIPT', 'SELECT', 'STYLE', 'SVG', 'TEXTAREA',
])

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function proseText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\u00a0', ' ')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function proseHtml(text: string): string {
  return escapeHtml(text).replaceAll('\n\n', '<br><br>').replaceAll('\n', '<br>')
}

function nearestElement(node: Node | null): Element | null {
  return node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement ?? null
}

function nearestPre(node: Node, boundary: Element): HTMLPreElement | null {
  let element = nearestElement(node)
  while (element && boundary.contains(element)) {
    if (element.tagName === 'PRE') return element as HTMLPreElement
    if (element === boundary) break
    element = element.parentElement
  }
  return null
}

function copyRoots(root: HTMLElement): HTMLElement[] {
  const descendants = Array.from(root.querySelectorAll<HTMLElement>('[data-transcript-copy]'))
  return root.matches('[data-transcript-copy]') ? [root, ...descendants] : descendants
}

function nodeIsInside(root: Element, node: Node): boolean {
  return root === node || root.contains(node)
}

function selectedFragment(range: Range, copyRoot: HTMLElement): DocumentFragment {
  const clipped = document.createRange()
  clipped.selectNodeContents(copyRoot)
  if (nodeIsInside(copyRoot, range.startContainer)) {
    clipped.setStart(range.startContainer, range.startOffset)
  }
  if (nodeIsInside(copyRoot, range.endContainer)) {
    clipped.setEnd(range.endContainer, range.endOffset)
  }
  return clipped.cloneContents()
}

function serializeFragment(fragment: DocumentFragment): CopyPiece[] {
  const pieces: CopyPiece[] = []
  let prose = ''

  function flushProse(): void {
    const text = proseText(prose)
    if (text) pieces.push({ kind: 'prose', text })
    prose = ''
  }

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      prose += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return

    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of Array.from(node.childNodes)) walk(child)
      return
    }

    const element = node as Element
    const tag = element.tagName
    if (
      SKIP_TAGS.has(tag) ||
      element.matches('[data-copy-ignore], [hidden], [aria-hidden="true"], .chead')
    ) return

    if (tag === 'PRE') {
      flushProse()
      pieces.push({ kind: 'code', text: element.textContent ?? '' })
      return
    }
    if (tag === 'BR') {
      prose += '\n'
      return
    }
    if (tag === 'HR') {
      prose += '\n\n---\n\n'
      return
    }
    if (tag === 'IMG') {
      prose += element.getAttribute('alt') ?? ''
      return
    }

    const isBlock = BLOCK_TAGS.has(tag)
    if (isBlock) prose += '\n\n'
    if (tag === 'LI') prose += '- '

    const children = Array.from(element.childNodes)
    for (let index = 0; index < children.length; index += 1) {
      walk(children[index])
      if ((tag === 'TR' || tag === 'TABLE') && index < children.length - 1) prose += '\t'
    }

    if (tag === 'LI') prose += '\n'
    if (tag === 'TR') prose += '\n'
    if (tag === 'UL' || tag === 'OL' || tag === 'TABLE' || isBlock) prose += '\n\n'
  }

  walk(fragment)
  flushProse()
  return pieces
}

function piecesForRange(range: Range, copyRoot: HTMLElement): CopyPiece[] {
  const startPre = nearestPre(range.startContainer, copyRoot)
  const endPre = nearestPre(range.endContainer, copyRoot)
  if (startPre && startPre === endPre) {
    return [{ kind: 'code', text: range.toString() }]
  }
  return serializeFragment(selectedFragment(range, copyRoot))
}

/**
 * Build deliberately unstyled clipboard flavours from a rendered transcript selection.
 *
 * Prose follows what the reader selected, not the source Markdown. Code is the exception:
 * a PRE is kept as an exact text region and represented only as PRE/CODE in HTML, without
 * the syntax-highlighting spans or copy-button chrome from the app.
 */
export function transcriptClipboardPayload(
  root: HTMLElement,
  selection: Selection | null,
): TranscriptClipboardPayload | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null

  const range = selection.getRangeAt(0)
  const roots = copyRoots(root)
  if (roots.length === 0) return null

  // Both ends must be transcript content. This is the fail-closed boundary that leaves
  // composer, diff, settings, and selections crossing outside the transcript to the browser.
  if (
    !roots.some((candidate) => nodeIsInside(candidate, range.startContainer)) ||
    !roots.some((candidate) => nodeIsInside(candidate, range.endContainer))
  ) return null

  const pieces: CopyPiece[] = []
  for (const copyRoot of roots) {
    try {
      if (!range.intersectsNode(copyRoot)) continue
    } catch {
      continue
    }
    pieces.push(...piecesForRange(range, copyRoot))
  }
  if (pieces.length === 0) return null

  return {
    plain: pieces.map((piece) => piece.text).join('\n\n'),
    html: pieces
      .map((piece) => piece.kind === 'code'
        ? `<pre><code>${escapeHtml(piece.text)}</code></pre>`
        : proseHtml(piece.text))
      .join('<br><br>'),
  }
}

export function handleTranscriptCopy(event: ClipboardEvent, root: HTMLElement): void {
  if (event.defaultPrevented || !event.clipboardData) return
  const payload = transcriptClipboardPayload(root, window.getSelection())
  if (!payload) return

  event.clipboardData.setData('text/plain', payload.plain)
  event.clipboardData.setData('text/html', payload.html)
  event.preventDefault()
}

let installedConsumers = 0

function handleWindowCopy(event: ClipboardEvent): void {
  handleTranscriptCopy(event, document.body)
}

/**
 * One window listener covers selections spanning multiple messages. Each Markdown component
 * participates through a reference count, while the payload boundary still requires both
 * selection ends to be marked transcript content.
 */
export function installTranscriptCopy(): () => void {
  if (installedConsumers === 0) window.addEventListener('copy', handleWindowCopy)
  installedConsumers += 1
  let removed = false
  return () => {
    if (removed) return
    removed = true
    installedConsumers -= 1
    if (installedConsumers === 0) window.removeEventListener('copy', handleWindowCopy)
  }
}
