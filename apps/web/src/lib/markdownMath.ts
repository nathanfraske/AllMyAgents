import katex from 'katex'
import type { TokenizerAndRendererExtension } from 'marked'

// No HTML layout/styles or remote fonts are needed: native MathML goes through the same
// DOMPurify boundary as prose. Keep untrusted TeX work bounded and never share macro state.
const MAX_MATH_LENGTH = 8_192
const MAX_MESSAGE_MATH = 128
const cache = new Map<string, string>()
let cacheBytes = 0
const CACHE_BYTES = 512 * 1024

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function expression(src: string, block: boolean, scan: () => boolean) {
  const prefix = block ? /^ {0,3}/.exec(src)![0].length : 0
  const text = src.slice(prefix)
  const opener = ['\\[', '$$', '\\(', '$'].find(delimiter => text.startsWith(delimiter))
  if (!opener || (block && opener !== '\\[' && opener !== '$$')) return
  const closer = opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener
  const display = opener === '\\[' || opener === '$$'
  if (opener === '$' && /\s/.test(text[1] ?? ' ')) return
  // Linear scan, even for incomplete streaming formulas. Do not eat a trailing escaped delimiter.
  for (let i = opener.length; i < text.length && scan(); i++) {
    if (!display && text[i] === '\n') return
    if (text.startsWith(closer, i)) {
      if (opener === '$' && (/\s/.test(text[i - 1]!) || /[\d$]/.test(text[i + 1] ?? ''))) return
      const end = prefix + i + closer.length
      if (block && !/^[ \t]*(?:\n|$)/.test(src.slice(end))) return
      const math = text.slice(opener.length, i)
      if (!math.trim()) return
      return { raw: src.slice(0, end), math, display }
    }
    if (text[i] === '\\') i++
  }
}

/** Shared by delimiter math and explicit math/latex fences. Undefined means show escaped source. */
export function renderLatex(math: string, display: boolean): string | undefined {
  if (math.length > MAX_MATH_LENGTH) return undefined
  const key = JSON.stringify([display, math])
  const prior = cache.get(key)
  if (prior) { cache.delete(key); cache.set(key, prior); return prior }
  try {
    const rendered = katex.renderToString(math, {
      output: 'mathml', displayMode: display, trust: false, throwOnError: true,
      strict: 'ignore', maxExpand: 100, maxSize: 10, macros: {},
    })
    const size = 2 * (key.length + rendered.length)
    if (size <= CACHE_BYTES) {
      cache.set(key, rendered); cacheBytes += size
      while (cacheBytes > CACHE_BYTES || cache.size > 128) {
        const oldest = cache.keys().next().value!
        cacheBytes -= 2 * (oldest.length + cache.get(oldest)!.length)
        cache.delete(oldest)
      }
    }
    return rendered
  } catch { return undefined }
}

/** Fresh budget per Markdown message, shared across its nested inline/block tokens. */
export function mathExtensions(budget = { remaining: MAX_MESSAGE_MATH }): TokenizerAndRendererExtension[] {
  // Many unfinished opening delimiters must not cause repeated full-suffix scans.
  let scanBudget = 256 * 1024
  return (['block', 'inline'] as const).map(level => ({
    name: `chatMath${level}`,
    level,
    start: (src: string) => {
      if (scanBudget <= 0) return undefined
      const match = level === 'block' ? /(?:^|\n) {0,3}(?:\\\[|\$\$)/.exec(src) : /\\[([]|\$/.exec(src)
      return match?.index
    },
    tokenizer(src: string) {
      if (scanBudget <= 0) return undefined
      const found = expression(src, level === 'block', () => --scanBudget >= 0)
      return found ? { type: `chatMath${level}`, ...found } : undefined
    },
    renderer(token) {
      const fallback = () => `<code class="math-source">${escape(token.raw)}</code>`
      if (budget.remaining-- <= 0 || token.math.length > MAX_MATH_LENGTH) return fallback()
      return renderLatex(token.math, token.display) ?? fallback()
    },
  }))
}
