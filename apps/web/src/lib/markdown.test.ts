import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

// renderMarkdown is the sole HTML-producing surface for chat message text. These tests pin the
// two things that matter: (1) the sanitizer neutralizes hostile model output, and (2) ordinary
// Markdown renders into the expected structure / segments. Runs under jsdom (vitest env), which
// gives DOMPurify a real DOM to sanitize against.

// Concatenate every segment's HTML (both prose and code carry `.html`) for whole-output asserts.
function html(src: string): string {
  return renderMarkdown(src)
    .map((s) => s.html)
    .join('\n')
}

describe('renderMarkdown — XSS sanitization', () => {
  it('drops <script> entirely', () => {
    const out = html('hello <script>alert(1)</script> world')
    expect(out).not.toMatch(/<script/i)
    expect(out).not.toContain('alert(1)')
  })

  it('strips inline event handlers and keeps no onerror vector', () => {
    const out = html('<img src=x onerror=alert(1)>')
    expect(out).not.toMatch(/onerror/i)
    expect(out).not.toMatch(/alert\(1\)/)
  })

  it('neutralizes a javascript: link URL', () => {
    const out = html('[click me](javascript:alert(1))')
    expect(out).not.toMatch(/javascript:/i)
    expect(out).not.toMatch(/alert\(1\)/)
  })

  it('removes on* handlers from raw block HTML', () => {
    const out = html('<div onclick="steal()">x</div>')
    expect(out).not.toMatch(/onclick/i)
    expect(out).not.toContain('steal()')
  })

  it('strips <iframe> embeds', () => {
    const out = html('<iframe src="https://evil.example"></iframe>')
    expect(out).not.toMatch(/<iframe/i)
  })
})

describe('renderMarkdown — safe links', () => {
  it('hardens external links with target and rel', () => {
    const out = html('see [example](https://example.com)')
    expect(out).toMatch(/href="https:\/\/example\.com"/)
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })
})

describe('renderMarkdown — structure', () => {
  it('returns nothing for empty / whitespace input', () => {
    expect(renderMarkdown('')).toEqual([])
    expect(renderMarkdown('   \n  ')).toEqual([])
    expect(renderMarkdown(undefined)).toEqual([])
  })

  it('renders plain text as a paragraph in a single html segment', () => {
    const segs = renderMarkdown('just some text')
    expect(segs).toHaveLength(1)
    expect(segs[0]?.type).toBe('html')
    expect(segs[0]?.html).toMatch(/<p>just some text<\/p>/)
  })

  it('renders headings, bold, and lists', () => {
    const out = html('# Title\n\n**bold** text\n\n- one\n- two')
    expect(out).toMatch(/<h1[^>]*>Title<\/h1>/)
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toMatch(/<li>one<\/li>/)
    expect(out).toMatch(/<li>two<\/li>/)
  })

  it('renders GFM tables and blockquotes', () => {
    const table = html('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(table).toContain('<table>')
    expect(table).toContain('<th>a</th>')
    expect(html('> quoted')).toContain('<blockquote>')
  })

  it('renders inline code as a <code> element', () => {
    expect(html('use `npm run build`')).toContain('<code>npm run build</code>')
  })
})

describe('renderMarkdown — fenced code blocks', () => {
  it('extracts a fenced block as its own code segment with language + raw code', () => {
    const segs = renderMarkdown('before\n\n```js\nconst a = 1\n```\n\nafter')
    const code = segs.find((s) => s.type === 'code')
    expect(code).toBeDefined()
    expect(code?.type).toBe('code')
    if (code?.type === 'code') {
      expect(code.lang).toBe('js')
      expect(code.code).toBe('const a = 1')
      // highlighted display html is present and tokenized (const -> keyword span)
      expect(code.html).toMatch(/hljs-keyword/)
    }
    // prose on either side stays as separate html segments
    expect(segs.filter((s) => s.type === 'html')).toHaveLength(2)
  })

  it('escapes (never executes) HTML inside a code block', () => {
    const segs = renderMarkdown('```\n<script>alert(1)</script>\n```')
    const code = segs.find((s) => s.type === 'code')
    expect(code?.type).toBe('code')
    // raw code is preserved verbatim for copying…
    expect(code?.type === 'code' && code.code).toContain('<script>')
    // …but the display html has it escaped, not as a live tag
    expect(code?.html).not.toMatch(/<script/i)
    expect(code?.html).toContain('&lt;script&gt;')
  })

  it('takes only the first info-string word as the language', () => {
    const segs = renderMarkdown('```ts title=example.ts\nlet x: number = 1\n```')
    const code = segs.find((s) => s.type === 'code')
    expect(code?.type === 'code' && code.lang).toBe('ts')
  })

  it('falls back to escaped plaintext for an unknown language', () => {
    const segs = renderMarkdown('```notalang\na < b && c > d\n```')
    const code = segs.find((s) => s.type === 'code')
    expect(code?.type).toBe('code')
    expect(code?.html).toContain('a &lt; b &amp;&amp; c &gt; d')
  })
})
