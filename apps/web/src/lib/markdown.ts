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
export interface LocalFileLink {
  path: string
  line?: number
  column?: number
}

/** Recognize the absolute path forms emitted by both vendors. The value is display data until an
 * operator click reaches the native reveal command; rendering never reads or probes the path. */
export function parseLocalFileHref(raw: string): LocalFileLink | null {
  let value = raw.trim()
  if (!value || value.length > 8_192 || value.includes('\0')) return null
  try {
    value = decodeURIComponent(value)
  } catch {
    return null
  }

  if (/^file:\/\//iu.test(value)) {
    try {
      const url = new URL(value)
      if (url.protocol !== 'file:') return null
      const host = url.hostname
      value = host && host !== 'localhost'
        ? `//${host}${url.pathname}${url.hash}`
        : `${url.pathname}${url.hash}`
      value = decodeURIComponent(value)
    } catch {
      return null
    }
  }

  // Marked prefixes a Windows drive path with '/' only when the model used /C:/... or file:///C:/....
  if (/^\/[A-Za-z]:[\\/]/u.test(value)) value = value.slice(1)
  const absolute = /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value) || /^\//u.test(value)
  if (!absolute) return null

  let line: number | undefined
  let column: number | undefined
  const suffix = /:(\d+)(?::(\d+))?$/u.exec(value)
  if (suffix) {
    value = value.slice(0, suffix.index)
    line = Number(suffix[1])
    column = suffix[2] ? Number(suffix[2]) : undefined
  } else {
    const fragment = /#L(\d+)(?:C(\d+))?$/iu.exec(value)
    if (fragment) {
      value = value.slice(0, fragment.index)
      line = Number(fragment[1])
      column = fragment[2] ? Number(fragment[2]) : undefined
    }
  }
  if (!value || value.length > 4_096) return null
  return { path: value, ...(line ? { line } : {}), ...(column ? { column } : {}) }
}

function decorateSafeLink(node: Element): void {
  const href = node.getAttribute('href')
  if (!href) return
  let kind: 'github' | 'pdf' | 'web' | undefined
  let host: string | undefined
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (/\.pdf$/i.test(url.pathname)) kind = 'pdf'
    else if (host === 'github.com' || host.endsWith('.github.com')) kind = 'github'
    else kind = 'web'
  } catch {
    return
  }
  node.setAttribute('data-link-kind', kind)
  if (host) node.setAttribute('data-link-host', host)
  if (!node.hasAttribute('title')) {
    node.setAttribute('title', kind === 'pdf' ? `Open PDF from ${host}` : `Open ${host}`)
  }
}

function installHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  DOMPurify.addHook('beforeSanitizeAttributes', (candidate) => {
    if (!(candidate instanceof Element) || candidate.tagName !== 'A') return
    // Raw model HTML is allowed through Markdown before sanitization. Remove any forged marker first;
    // only an href that this parser independently recognizes may recreate it.
    candidate.removeAttribute('data-local-path')
    candidate.removeAttribute('data-local-line')
    candidate.removeAttribute('data-local-column')
    const href = candidate.getAttribute('href')
    const local = href ? parseLocalFileHref(href) : null
    if (!local) return
    candidate.setAttribute('href', '#')
    candidate.setAttribute('data-local-path', local.path)
    if (local.line) candidate.setAttribute('data-local-line', String(local.line))
    if (local.column) candidate.setAttribute('data-local-column', String(local.column))
  })
  // Every surviving link opens in a new context with no opener handle. DOMPurify has already
  // rejected javascript:/vbscript:/unsafe-data: URLs via its default URI policy — this only
  // hardens the links that were safe to begin with.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      const localPath = node.getAttribute('data-local-path')
      if (localPath) {
        node.removeAttribute('target')
        node.removeAttribute('rel')
        node.setAttribute('data-link-kind', /\.pdf$/iu.test(localPath) ? 'pdf' : 'file')
        node.setAttribute('title', `Reveal ${localPath}`)
        return
      }
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
      // Rich link identity is derived only from the already-sanitized URL and rendered with local CSS.
      // Never fetch a favicon here: message rendering must remain a zero-network, zero-click surface.
      decorateSafeLink(node)
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
