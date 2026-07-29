import { afterEach, describe, expect, it } from 'vitest'
import { composerAutoGrow, computeComposerHeight } from './composerAutoGrow'

function rect(height: number, width = 500): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect
}

const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')

afterEach(() => {
  document.body.replaceChildren()
  if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport)
  else Reflect.deleteProperty(window, 'visualViewport')
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts)
  else Reflect.deleteProperty(document, 'fonts')
})

describe('computeComposerHeight', () => {
  it('grows with content until the desktop ceiling, then scrolls internally', () => {
    expect(computeComposerHeight({
      contentHeight: 180,
      minHeight: 48,
      viewportHeight: 1000,
      containerHeight: 800,
      chromeHeight: 60,
    })).toEqual({ height: 180, maxHeight: 320, overflowY: 'hidden' })

    expect(computeComposerHeight({
      contentHeight: 700,
      minHeight: 48,
      viewportHeight: 1000,
      containerHeight: 800,
      chromeHeight: 60,
    })).toEqual({ height: 320, maxHeight: 320, overflowY: 'auto' })
  })

  it('leaves at least half of a short split pane for transcript and controls', () => {
    expect(computeComposerHeight({
      contentHeight: 700,
      minHeight: 48,
      viewportHeight: 900,
      containerHeight: 420,
      chromeHeight: 64,
    })).toEqual({ height: 146, maxHeight: 146, overflowY: 'auto' })
  })

  it('uses the visible mobile viewport but never collapses below the two-row minimum', () => {
    expect(computeComposerHeight({
      contentHeight: 700,
      minHeight: 48,
      viewportHeight: 260,
      containerHeight: 900,
      chromeHeight: 70,
    })).toEqual({ height: 60, maxHeight: 60, overflowY: 'auto' })

    expect(computeComposerHeight({
      contentHeight: 700,
      minHeight: 48,
      viewportHeight: 160,
      containerHeight: 900,
      chromeHeight: 70,
    })).toEqual({ height: 48, maxHeight: 48, overflowY: 'auto' })
  })
})

describe('composerAutoGrow', () => {
  it('ignores a wrapping placeholder while handling typing, draft restoration, overflow, and clear', async () => {
    const viewport = new EventTarget() as EventTarget & { height: number }
    viewport.height = 600
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const fonts = new EventTarget() as EventTarget & { ready: Promise<unknown> }
    fonts.ready = Promise.resolve(fonts)
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })

    const container = document.createElement('div')
    container.dataset.composerHeightContainer = ''
    const composer = document.createElement('div')
    const textarea = document.createElement('textarea')
    textarea.rows = 2
    textarea.placeholder =
      'Ask for follow-up changes… (Enter to send, Shift+Enter for newline)'
    composer.append(textarea)
    container.append(composer)
    document.body.append(container)

    const viewportWidth = 390
    let baseHeight = 46
    // Chromium includes a wrapping placeholder in scrollHeight even though the textarea value is empty.
    let contentHeight = 192
    let containerHeight = 600
    const chromeHeight = 60
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      // scrollHeight excludes the textarea's 1px top/bottom borders; the action adds them back because
      // the app uses border-box sizing.
      get: () => Math.max(0, contentHeight - 2),
    })
    textarea.getBoundingClientRect = () =>
      rect(textarea.style.height ? Number.parseFloat(textarea.style.height) : baseHeight, viewportWidth)
    composer.getBoundingClientRect = () =>
      rect(
        (textarea.style.height ? Number.parseFloat(textarea.style.height) : baseHeight) + chromeHeight,
        viewportWidth,
      )
    container.getBoundingClientRect = () => rect(containerHeight, viewportWidth)

    const action = composerAutoGrow(textarea, '')
    expect(textarea.style.height).toBe('46px')
    expect(textarea.style.overflowY).toBe('hidden')

    contentHeight = 180
    textarea.value = 'A real paragraph that wraps onto several measured lines.'
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await Promise.resolve()
    expect(textarea.style.height).toBe('180px')
    expect(textarea.style.overflowY).toBe('hidden')

    contentHeight = 500
    textarea.scrollTop = 72
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await Promise.resolve()
    expect(textarea.style.height).toBe('240px')
    expect(textarea.style.overflowY).toBe('auto')
    expect(textarea.scrollTop).toBe(72)

    contentHeight = 190
    textarea.value = 'restored paragraph'
    action.update?.('restored paragraph')
    await Promise.resolve()
    expect(textarea.style.height).toBe('190px')
    expect(textarea.style.overflowY).toBe('hidden')

    textarea.scrollTop = 80
    textarea.value = ''
    contentHeight = 192
    action.update?.('')
    await Promise.resolve()
    expect(textarea.style.height).toBe('46px')
    expect(textarea.style.overflowY).toBe('hidden')
    expect(textarea.scrollTop).toBe(0)

    contentHeight = 500
    textarea.value = 'another long draft'
    viewport.height = 400
    viewport.dispatchEvent(new Event('resize'))
    await Promise.resolve()
    expect(textarea.style.height).toBe('140px')
    expect(textarea.style.overflowY).toBe('auto')

    containerHeight = 900
    baseHeight = 56
    contentHeight = 56
    textarea.value = ''
    fonts.dispatchEvent(new Event('loadingdone'))
    await Promise.resolve()
    expect(textarea.style.height).toBe('56px')

    action.destroy?.()
  })
})
