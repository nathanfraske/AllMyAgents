const MAX_TEXTAREA_HEIGHT = 320
const VISIBLE_AREA_SHARE = 0.5

export type ComposerHeight = {
  height: number
  maxHeight: number
  overflowY: 'hidden' | 'auto'
}

export type ComposerHeightInput = {
  contentHeight: number
  minHeight: number
  viewportHeight: number
  containerHeight?: number
  chromeHeight?: number
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Fit the textarea while reserving at least half of the visible pane for the transcript. The
 * surrounding composer chrome (attachment chips and footer controls) is measured separately so those
 * controls stay in flow instead of being accidentally counted as writable space.
 */
export function computeComposerHeight(input: ComposerHeightInput): ComposerHeight {
  const minHeight = Math.ceil(finitePositive(input.minHeight, 1))
  const contentHeight = Math.max(minHeight, Math.ceil(finitePositive(input.contentHeight, minHeight)))
  const chromeHeight = Math.max(0, finitePositive(input.chromeHeight ?? 0, 0))
  const candidates = [MAX_TEXTAREA_HEIGHT]

  if (input.viewportHeight > 0) {
    candidates.push(input.viewportHeight * VISIBLE_AREA_SHARE - chromeHeight)
  }

  // An auto-height embedded composer reports itself as its container. Ignore that circular measurement;
  // a real transcript pane is large enough to hold two minimum composers and can safely contribute a cap.
  const containerHeight = input.containerHeight ?? 0
  if (containerHeight >= (minHeight + chromeHeight) * 2) {
    candidates.push(containerHeight * VISIBLE_AREA_SHARE - chromeHeight)
  }

  const maxHeight = Math.max(minHeight, Math.floor(Math.min(...candidates)))
  return {
    height: Math.min(contentHeight, maxHeight),
    maxHeight,
    overflowY: contentHeight > maxHeight ? 'auto' : 'hidden',
  }
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Svelte action for a multiline composer. Input events cover typing and IME updates; `update` covers
 * Svelte-driven value changes such as chat draft restoration, inline-paste expansion, and clearing after
 * send. ResizeObserver, visualViewport, window resize, and font completion cover reflow without polling.
 */
export function composerAutoGrow(node: HTMLTextAreaElement, _value = ''): {
  update(value: string): void
  destroy(): void
} {
  const doc = node.ownerDocument
  const win = doc.defaultView
  const composer = node.parentElement
  const heightContainer = node.closest<HTMLElement>('[data-composer-height-container]')
  const originalHeight = node.style.height
  const originalOverflowY = node.style.overflowY
  let destroyed = false
  let queued = false

  function resize(): void {
    if (destroyed || !win) return

    // Removing only our inline height reveals the intrinsic `rows=2` box even when a long draft was
    // restored before mount. Read every time so zoom, theme, and loaded-font metrics can change it.
    const previousScrollTop = node.scrollTop
    node.style.height = ''
    node.style.overflowY = 'hidden'

    const style = win.getComputedStyle(node)
    const intrinsicHeight = node.getBoundingClientRect().height
    const minHeight = Math.max(1, intrinsicHeight, cssPixels(style.minHeight))
    const borderHeight = cssPixels(style.borderTopWidth) + cssPixels(style.borderBottomWidth)
    const contentHeight = Math.max(minHeight, node.scrollHeight + borderHeight)
    const composerHeight = composer?.getBoundingClientRect().height ?? minHeight
    const chromeHeight = Math.max(0, composerHeight - intrinsicHeight)
    const measuredContainerHeight =
      heightContainer?.getBoundingClientRect().height || heightContainer?.clientHeight || undefined
    const viewportHeight =
      win.visualViewport?.height || win.innerHeight || doc.documentElement.clientHeight || minHeight

    const fitted = computeComposerHeight({
      contentHeight,
      minHeight,
      viewportHeight,
      containerHeight: measuredContainerHeight,
      chromeHeight,
    })

    node.style.height = `${fitted.height}px`
    node.style.overflowY = fitted.overflowY
    // When content fits, an old capped draft must not leave the newly-short box scrolled into blank space.
    // While capped, preserving the browser's current scroll position preserves its native caret tracking,
    // including selection edits in the middle of a long IME composition.
    node.scrollTop = fitted.overflowY === 'hidden' ? 0 : previousScrollTop
  }

  function schedule(): void {
    if (destroyed || queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      resize()
    })
  }

  node.addEventListener('input', schedule)
  win?.addEventListener('resize', schedule)
  win?.visualViewport?.addEventListener('resize', schedule)

  const ResizeObserverCtor = win?.ResizeObserver
  const observer = ResizeObserverCtor
    ? new ResizeObserverCtor(schedule)
    : undefined
  if (composer) observer?.observe(composer)
  if (heightContainer && heightContainer !== composer) observer?.observe(heightContainer)

  const fonts = doc.fonts
  const onFontsLoaded = (): void => schedule()
  fonts?.addEventListener('loadingdone', onFontsLoaded)
  void fonts?.ready.then(onFontsLoaded).catch(() => {})

  resize()

  return {
    update(_nextValue: string): void {
      schedule()
    },
    destroy(): void {
      destroyed = true
      observer?.disconnect()
      node.removeEventListener('input', schedule)
      win?.removeEventListener('resize', schedule)
      win?.visualViewport?.removeEventListener('resize', schedule)
      fonts?.removeEventListener('loadingdone', onFontsLoaded)
      node.style.height = originalHeight
      node.style.overflowY = originalOverflowY
    },
  }
}
