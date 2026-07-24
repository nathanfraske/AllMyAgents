// Markdown → safe render pipeline for chat message text.
//
// SECURITY: message text is model-generated and may contain hostile HTML (raw <script>,
// <img onerror=…>, javascript: links). This module is the ONLY place that turns that text
// into HTML, and every string it hands back for {@html} has been run through DOMPurify.
// Nothing here trusts marked's output — marked passes raw HTML through untouched, so the
// sanitize step is load-bearing, not cosmetic.
//
// Rendering is split into segments so fenced code blocks render as a native Svelte component
// (CodeBlock.svelte) with a real copy button, while prose (headings, lists, tables, quotes,
// inline code, links, …) renders as sanitized HTML.

import { Marked } from 'marked'
import type { Token, Tokens } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

// A rendered chunk of a message: a run of sanitized prose HTML, or one fenced code block
// (raw `code` kept for the copy button; `html` is the highlighted, sanitized display form).
export type Segment =
  | { type: 'html'; key: string; html: string }
  | { type: 'code'; key: string; lang: string; code: string; html: string }

// Isolated marked instance so we never mutate marked's global singleton. GFM on (tables,
// strikethrough, task lists, autolinks); breaks:true turns single newlines into <br>, which
// matches how chat models format replies (closer to how ChatGPT/Claude render).
const marked = new Marked({ gfm: true, breaks: true })

// Install the link-hardening hook exactly once. The module-scope guard keeps Vite HMR from
// stacking duplicate hooks across reloads.
let hooksInstalled = false
function installHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  // Every surviving link opens in a new context with no opener handle. DOMPurify has already
  // rejected javascript:/vbscript:/unsafe-data: URLs via its default URI policy — this only
  // hardens the links that were safe to begin with.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Sanitize model prose HTML with DOMPurify's default (XSS-safe) profile: it drops <script>,
// all on* event handlers, and javascript: URLs. We additionally forbid tags that could embed
// remote content or restyle the app shell, plus inline style, as defense-in-depth / layout
// safety — none of these are producible from plain Markdown anyway.
function sanitizeProse(html: string): string {
  installHooks()
  return DOMPurify.sanitize(html, {
    // `img` is forbidden too: message text is model-generated, so a remote image src would be a
    // zero-click exfil beacon / prompt-injection channel (auto-fetched on render).
    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'img'],
    FORBID_ATTR: ['style'],
  })
}

// highlight.js output is exclusively <span class="hljs-…"> wrappers around already-escaped
// text. Sanitizing with a span/class-only allowlist guarantees inertness even if a future
// hljs release ever emitted something unexpected.
function sanitizeCodeHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] })
}

// Produce safe display HTML for a code block. Known language → hljs highlight (then sanitize).
// Unknown/absent language → HTML-escaped plaintext (provably inert, no {@html} risk). We do
// not use hljs auto-detection: it is slow and frequently mis-guesses on short snippets.
function highlight(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return sanitizeCodeHtml(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value)
    } catch {
      /* fall through to plain escaping */
    }
  }
  return escapeHtml(code)
}

// The info string may carry more than the language (```ts title=foo). Take the first word.
function langOf(info: string | undefined): string {
  return (info ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

// Split message Markdown into renderable segments. Top-level fenced/indented code blocks
// become `code` segments; everything else is grouped and rendered as sanitized prose.
//
// We lex once (marked resolves all inline tokens — including reference links — during lexing,
// so slicing the top-level token list afterwards is safe) then re-run the parser per prose
// group. Code blocks nested inside lists/blockquotes stay in the prose HTML (still sanitized,
// still styled) but do not get their own copy button — an accepted, rare edge case.
export function renderMarkdown(src: string | undefined): Segment[] {
  const text = src ?? ''
  if (!text.trim()) return []

  const tokens = marked.lexer(text)
  const segments: Segment[] = []
  let buffer: Token[] = []
  let n = 0

  const flush = (): void => {
    if (buffer.length === 0) return
    const html = sanitizeProse(marked.parser(buffer))
    if (html.trim()) segments.push({ type: 'html', key: `s${n++}`, html })
    buffer = []
  }

  for (const token of tokens) {
    if (token.type === 'code') {
      flush()
      const t = token as Tokens.Code
      const code = t.text ?? ''
      const lang = langOf(t.lang)
      segments.push({ type: 'code', key: `s${n++}`, lang, code, html: highlight(code, lang) })
    } else {
      buffer.push(token)
    }
  }
  flush()

  return segments
}
