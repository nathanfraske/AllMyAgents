import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

const html = (text: string) => renderMarkdown(text).map(segment => segment.html).join('')
const dom = (text: string) => { const root = document.createElement('div'); root.innerHTML = html(text); return root }
describe('math in chat Markdown', () => {
  it('renders the reported capacitor formula before Markdown can eat the delimiters', () => {
    const root = dom(String.raw`For an ideal capacitor:
\[
V_{C,\mathrm{peak}}=\frac{I_{\mathrm{peak}}}{2\pi f C}
\]
These examples assume fixed loading.`)
    expect(root.querySelector('math[display="block"] mfrac')).not.toBeNull()
    expect(root.querySelector('annotation')?.textContent).toContain(String.raw`\frac`)
    expect(root.textContent).toContain('These examples assume fixed loading.')
  })
  it('supports inline and display TeX, matrices, lists and tables', () => {
    for (const text of [String.raw`Inline \(x^2\) and $y_1$.`, String.raw`$$\sum_{i=1}^n i$$`,
      String.raw`- Value \(x\)`, '| value |\n| - |\n| $x^2$ |', String.raw`\[\begin{matrix}a&b\\c&d\end{matrix}\]`]) {
      expect(dom(text).querySelector('math')).not.toBeNull()
    }
  })
  it('does not render code, escaped dollars, or ordinary currency as math', () => {
    const root = dom('Price $5 and $10. Escaped \\$x\\$.\n\n`$x$` and `\\(y\\)`\n\n```tex\n\\[x\\]\n```')
    expect(root.querySelector('math')).toBeNull()
    expect(root.textContent).toContain('Price $5 and $10')
    expect(root.textContent).toContain('\\[x\\]')
  })
  it('keeps malformed and oversized math readable and survives macro loops', () => {
    for (const expr of [String.raw`\frac{`, 'x'.repeat(8_193), String.raw`\def\a{\a}\a`]) {
      const root = dom(`\\[${expr}\\]`)
      expect(root.querySelector('code.math-source')?.textContent).toContain(expr)
    }
    expect(dom('Streaming \\(x^').textContent).toContain('x^')
    expect(dom('Streaming \\(x^2\\)').querySelector('math')).not.toBeNull()
  })
  it('bounds expression count and never shares macro definitions between formulas', () => {
    expect(dom(Array.from({length: 130}, () => '$x$').join(' ')).querySelectorAll('math')).toHaveLength(128)
    html(String.raw`$\gdef\private{secret}\private$`)
    expect(dom(String.raw`$\private$`).querySelector('math')).toBeNull()
  })
  it('stops searching repeated incomplete delimiters after the per-message scan budget', () => {
    const root = dom(String.raw`\[ unfinished `.repeat(1000) + ' tail $z$')
    expect(root.querySelector('math')).toBeNull()
    expect(root.textContent).toContain('tail $z$')
  })
  it('keeps the zero-network/active-HTML boundary for hostile TeX and Markdown', () => {
    const root = dom(String.raw`$\href{javascript:alert(1)}{click}$ $\includegraphics{https://evil.example/pixel}$
\[\htmlStyle{position:fixed}{x}\]
<img src="https://evil.example/pixel" onerror="alert(1)"><span style="position:fixed">bad</span>`)
    expect(root.querySelector('a, img, script, iframe, [style], [onerror]')).toBeNull()
  })
})
