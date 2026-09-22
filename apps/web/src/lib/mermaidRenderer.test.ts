import { afterEach, describe, expect, it, vi } from 'vitest'
import { mermaidFrameDocument, mermaidImage, mermaidSourceError, renderMermaid, MERMAID_TIMEOUT_MS } from './mermaidRenderer'

afterEach(() => { vi.useRealTimers() })

describe('isolated Mermaid rendering', () => {
  it('rejects oversized source and renderer directives, with no unsafe app HTML path', () => {
    expect(mermaidSourceError('graph TD\n A-->B')).toBeUndefined()
    expect(mermaidSourceError('x'.repeat(20_001))).toMatch(/limit/)
    expect(mermaidSourceError('%%{init: {securityLevel: "loose"}}%%\ngraph TD')).toMatch(/directives/)
    expect(mermaidSourceError('---\nconfig:\n theme: dark\n---\ngraph TD')).toMatch(/frontmatter/)
    const doc = mermaidFrameDocument('https://app.invalid/mermaid.js', 'nonce')
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain("connect-src 'none'")
    expect(doc).toContain("img-src 'none'")
    expect(doc).toContain("securityLevel:'strict'")
    expect(doc).not.toContain('allow-same-origin')
    expect(doc).toContain("event.source!==parent")
  })

  it('sanitizes SVG and displays only an image, retaining diagram shapes and local styles', () => {
    const result = mermaidImage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30"><style>.node{fill:red}</style><rect class="node" width="100" height="30"/><text x="10" y="20">A</text><script>alert(1)</script><foreignObject><iframe src="https://bad.invalid"/></foreignObject><image href="https://bad.invalid/pixel"/><a href="javascript:alert(1)"><text onclick="steal()">B</text></a></svg>')
    expect(result).toMatch(/^data:image\/svg\+xml/)
    const svg = decodeURIComponent(result.split(',')[1]!)
    expect(svg).toContain('<rect')
    expect(svg).toContain('<style>')
    expect(svg).not.toMatch(/script|foreignObject|iframe|href|onclick|<image/i)
    expect(() => mermaidImage('<div>not an SVG</div>')).toThrow(/SVG/)
  })

  it('accepts only its exact frame/channel, tears down and reuses bounded completed results', async () => {
    const controller = new AbortController()
    const source = 'graph TD\n A[unique cache test]-->B'
    const work = renderMermaid(source, controller.signal)
    await Promise.resolve(); await Promise.resolve()
    const frame = document.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.srcdoc).not.toContain(source)
    const channel = /const channel="([^"]+)"/.exec(frame.srcdoc)![1]
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { channel, kind: 'rendered', svg: '<svg/>' } }))
    expect(frame.isConnected).toBe(true)
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { channel: 'wrong', kind: 'rendered', svg: '<svg/>' } }))
    expect(frame.isConnected).toBe(true)
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { channel, kind: 'rendered', svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>safe</text></svg>' } }))
    const result = await work
    expect(document.querySelector('iframe')).toBeNull()
    expect(await renderMermaid(source, controller.signal)).toBe(result)
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('aborts detached work and recovers the queue after a timeout', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const first = renderMermaid('graph TD\n A[abort]-->B', controller.signal)
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve(); await Promise.resolve()
    controller.abort()
    await rejected
    expect(document.querySelector('iframe')).toBeNull()
    const second = renderMermaid('graph TD\n A[timeout]-->B', new AbortController().signal)
    const timedOut = expect(second).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT_MS + 1)
    await timedOut
    expect(document.querySelector('iframe')).toBeNull()
  })
})
