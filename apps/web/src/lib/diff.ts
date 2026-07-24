// File-diff model + rendering helpers for tool items that create or edit files.
//
// This turns the various file-edit tool shapes (Claude Edit / Write / MultiEdit, Codex
// fileChange) into one normalized `FileDiff` structure that DiffView.svelte renders.
//
// SECURITY: like markdown.ts, this module is a place that converts model-influenced text
// (source lines) into HTML for `{@html}`. The ONLY string it hands back for injection is the
// output of `highlightDiffLine`, and that is always either HTML-escaped plaintext or
// highlight.js output run through DOMPurify with a span/class-only allowlist — provably inert.
// Everything else on a FileDiff (paths, line numbers, hunk headers, counts) is rendered by
// DiffView as plain Svelte text nodes, never as HTML.

import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import type { ThreadItem } from './store.svelte'

export type DiffLineType = 'add' | 'del' | 'context'
export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed'

export interface DiffLine {
  type: DiffLineType
  text: string
  // Absolute line numbers when known (unified diff, or 1-based for whole-file add/delete).
  // Left undefined for apply_patch hunks, which carry no line numbers.
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header?: string
  lines: DiffLine[]
}

export interface FileDiff {
  path?: string
  oldPath?: string
  language: string
  status: FileStatus
  hunks: DiffHunk[]
  additions: number
  deletions: number
  // Every added line joined by \n — what the "copy" button writes (the new content).
  addedText: string
}

// --- HTML production (the sanitized surface) -----------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// highlight.js emits only <span class="hljs-…"> around already-escaped text. A span/class-only
// allowlist guarantees inertness (identical to markdown.ts's code-highlight sanitizer).
function sanitizeCodeHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] })
}

// Safe display HTML for one diff line. Known language → hljs highlight (then sanitize);
// unknown/absent → HTML-escaped plaintext (no {@html} risk). Highlighting is per-line, so
// constructs spanning multiple lines aren't fully tokenized — a cosmetic-only tradeoff.
export function highlightDiffLine(text: string, language: string): string {
  if (language && hljs.getLanguage(language)) {
    try {
      return sanitizeCodeHtml(hljs.highlight(text, { language, ignoreIllegals: true }).value)
    } catch {
      /* fall through to plain escaping */
    }
  }
  return escapeHtml(text)
}

// --- language detection --------------------------------------------------------------------

// Extension → highlight.js language id. Unknown/unavailable ids are filtered out by the
// getLanguage() guard in langFromPath, so listing an id that isn't in the "common" bundle is
// harmless (it simply renders as plaintext).
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  py: 'python', pyi: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', scala: 'scala',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', lua: 'lua', pl: 'perl', r: 'r',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  sql: 'sql', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  md: 'markdown', markdown: 'markdown', diff: 'diff', patch: 'diff',
}

export function langFromPath(path: string | undefined): string {
  if (!path) return ''
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (base === 'dockerfile') return hljs.getLanguage('dockerfile') ? 'dockerfile' : ''
  if (base === 'makefile') return hljs.getLanguage('makefile') ? 'makefile' : ''
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : ''
  const lang = EXT_LANG[ext] ?? ''
  return lang && hljs.getLanguage(lang) ? lang : ''
}

// --- line diff (LCS) -----------------------------------------------------------------------

// Split into lines, dropping the single phantom empty element a trailing newline produces so
// "text" and "text\n" diff identically.
function lineArray(s: string): string[] {
  if (s === '') return []
  const lines = s.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Above this LCS table size, fall back to a plain remove-then-add block (keeps memory bounded
// for pathologically large inputs; real edit hunks are far smaller).
const MAX_LCS_CELLS = 1_500_000

// Classic LCS-backtrack line diff → context / del / add lines with 1-based line numbers.
function diffLineList(oldText: string, newText: string): DiffLine[] {
  const a = lineArray(oldText)
  const b = lineArray(newText)
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0) return b.map((text, i) => ({ type: 'add' as const, text, newNo: i + 1 }))
  if (m === 0) return a.map((text, i) => ({ type: 'del' as const, text, oldNo: i + 1 }))
  if (n * m > MAX_LCS_CELLS) {
    return [
      ...a.map((text, i) => ({ type: 'del' as const, text, oldNo: i + 1 })),
      ...b.map((text, i) => ({ type: 'add' as const, text, newNo: i + 1 })),
    ]
  }

  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + (j + 1)] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  let oldNo = 1
  let newNo = 1
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i], oldNo: oldNo++, newNo: newNo++ })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      out.push({ type: 'del', text: a[i], oldNo: oldNo++ })
      i++
    } else {
      out.push({ type: 'add', text: b[j], newNo: newNo++ })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i], oldNo: oldNo++ }), i++
  while (j < m) out.push({ type: 'add', text: b[j], newNo: newNo++ }), j++
  return out
}

// Assemble a FileDiff from finished hunks, computing the add/del counts + copyable new text.
function makeFileDiff(
  path: string | undefined,
  language: string,
  status: FileStatus,
  hunks: DiffHunk[]
): FileDiff {
  let additions = 0
  let deletions = 0
  const added: string[] = []
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') {
        additions++
        added.push(l.text)
      } else if (l.type === 'del') {
        deletions++
      }
    }
  }
  return { path, oldPath: undefined, language, status, hunks, additions, deletions, addedText: added.join('\n') }
}

function oneHunk(lines: DiffLine[], header?: string): DiffHunk[] {
  return lines.length ? [{ header, lines }] : []
}

function allAdded(content: string): DiffLine[] {
  return lineArray(content).map((text, i) => ({ type: 'add' as const, text, newNo: i + 1 }))
}

function allDeleted(content: string): DiffLine[] {
  return lineArray(content).map((text, i) => ({ type: 'del' as const, text, oldNo: i + 1 }))
}

// --- Claude tool inputs --------------------------------------------------------------------

function claudeEdit(input: unknown): FileDiff | null {
  const p = (input ?? {}) as { file_path?: string; old_string?: string; new_string?: string }
  if (typeof p.old_string !== 'string' || typeof p.new_string !== 'string') return null
  const lines = diffLineList(p.old_string, p.new_string)
  return makeFileDiff(p.file_path, langFromPath(p.file_path), 'modified', oneHunk(lines))
}

function claudeWrite(input: unknown): FileDiff | null {
  const p = (input ?? {}) as { file_path?: string; content?: string }
  if (typeof p.content !== 'string') return null
  return makeFileDiff(p.file_path, langFromPath(p.file_path), 'added', oneHunk(allAdded(p.content)))
}

function claudeMultiEdit(input: unknown): FileDiff | null {
  const p = (input ?? {}) as {
    file_path?: string
    edits?: Array<{ old_string?: string; new_string?: string }>
  }
  if (!Array.isArray(p.edits) || p.edits.length === 0) return null
  const hunks: DiffHunk[] = []
  p.edits.forEach((e, idx) => {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return
    const lines = diffLineList(e.old_string, e.new_string)
    if (lines.length) hunks.push({ header: p.edits!.length > 1 ? `edit ${idx + 1}` : undefined, lines })
  })
  if (!hunks.length) return null
  return makeFileDiff(p.file_path, langFromPath(p.file_path), 'modified', hunks)
}

// --- unified diff / apply_patch parser -----------------------------------------------------

// Cheap check that a string is a patch before we try to parse it as one.
function looksLikePatch(s: string): boolean {
  return /^(?:\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)|diff --git |@@ |--- )/m.test(s)
}

// Parse a unified diff or Codex apply_patch envelope into one FileDiff per file section.
// Handles both real unified hunk headers (`@@ -a,b +c,d @@`, with line numbers) and
// apply_patch headers (`@@ heading`, no numbers → number gutters stay blank).
function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = []
  // A mutable holder (rather than bare `let`s) so TypeScript keeps re-narrowing `cur`/`hunk`
  // through the closures below — a captured `let` assigned only inside a closure gets pinned to
  // its initializer by control-flow analysis, which would make every `if (cur)` narrow to never.
  const st: { cur: FileDiff | null; hunk: DiffHunk | null; oldNo: number; newNo: number } = {
    cur: null,
    hunk: null,
    oldNo: 0,
    newNo: 0,
  }

  const finishHunk = (): void => {
    if (st.cur && st.hunk && st.hunk.lines.length) st.cur.hunks.push(st.hunk)
    st.hunk = null
  }
  const startFile = (path: string | undefined, status: FileStatus): FileDiff => {
    finishHunk()
    const f: FileDiff = { path, oldPath: undefined, language: langFromPath(path), status, hunks: [], additions: 0, deletions: 0, addedText: '' }
    files.push(f)
    st.cur = f
    st.oldNo = 0
    st.newNo = 0
    return f
  }
  const ensureHunk = (): DiffHunk => {
    if (!st.cur) startFile(undefined, 'modified')
    if (!st.hunk) st.hunk = { lines: [] }
    return st.hunk
  }

  for (let raw of patch.split('\n')) {
    if (raw.endsWith('\r')) raw = raw.slice(0, -1)
    let m: RegExpMatchArray | null

    if (raw === '*** Begin Patch' || raw === '*** End Patch') continue
    if ((m = raw.match(/^\*\*\* Update File: (.+)$/))) { startFile(m[1], 'modified'); continue }
    if ((m = raw.match(/^\*\*\* Add File: (.+)$/))) { startFile(m[1], 'added'); continue }
    if ((m = raw.match(/^\*\*\* Delete File: (.+)$/))) { startFile(m[1], 'deleted'); continue }
    if ((m = raw.match(/^\*\*\* (?:Move|Rename) to: (.+)$/))) {
      if (st.cur) { st.cur.status = 'renamed'; st.cur.oldPath = st.cur.path; st.cur.path = m[1] }
      continue
    }
    if ((m = raw.match(/^diff --git a\/(.+) b\/(.+)$/))) {
      startFile(m[2], 'modified').oldPath = m[1]
      continue
    }
    if (/^index /.test(raw)) continue
    if ((m = raw.match(/^--- (?:a\/)?(.+)$/))) {
      const path = m[1] === '/dev/null' ? undefined : m[1]
      // Start a new file section unless the current one is still empty (the paired +++ follows).
      if (!st.cur || st.cur.hunks.length || (st.hunk && st.hunk.lines.length)) {
        const f = startFile(path, 'modified')
        if (m[1] === '/dev/null') f.status = 'added'
      } else {
        st.cur.oldPath = path
        if (m[1] === '/dev/null') st.cur.status = 'added'
      }
      continue
    }
    if ((m = raw.match(/^\+\+\+ (?:b\/)?(.+)$/))) {
      const f = st.cur ?? startFile(undefined, 'modified')
      if (m[1] === '/dev/null') f.status = 'deleted'
      else {
        f.path = m[1]
        f.language = langFromPath(m[1])
      }
      continue
    }
    if ((m = raw.match(/^@@+ (?:-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? )?@@(.*)$/))) {
      if (!st.cur) startFile(undefined, 'modified')
      finishHunk()
      st.oldNo = m[1] ? parseInt(m[1], 10) : 0
      st.newNo = m[2] ? parseInt(m[2], 10) : 0
      const heading = (m[3] ?? '').trim()
      st.hunk = { header: heading || undefined, lines: [] }
      continue
    }

    if (!st.cur) continue
    const cur = st.cur
    const tag = raw[0]
    if (tag === '+') {
      ensureHunk().lines.push({ type: 'add', text: raw.slice(1), newNo: st.newNo || undefined })
      if (st.newNo) st.newNo++
      cur.additions++
    } else if (tag === '-') {
      ensureHunk().lines.push({ type: 'del', text: raw.slice(1), oldNo: st.oldNo || undefined })
      if (st.oldNo) st.oldNo++
      cur.deletions++
    } else if (tag === ' ') {
      ensureHunk().lines.push({ type: 'context', text: raw.slice(1), oldNo: st.oldNo || undefined, newNo: st.newNo || undefined })
      if (st.oldNo) st.oldNo++
      if (st.newNo) st.newNo++
    } else if (raw === '') {
      // Bare empty line inside a hunk: treat as an empty context line.
      if (st.hunk) {
        st.hunk.lines.push({ type: 'context', text: '', oldNo: st.oldNo || undefined, newNo: st.newNo || undefined })
        if (st.oldNo) st.oldNo++
        if (st.newNo) st.newNo++
      }
    }
    // `\ No newline at end of file` and anything else: ignored, for robustness.
  }
  finishHunk()

  for (const f of files) {
    const added: string[] = []
    for (const h of f.hunks) for (const l of h.lines) if (l.type === 'add') added.push(l.text)
    f.addedText = added.join('\n')
  }
  return files.filter((f) => f.hunks.length > 0)
}

// --- Codex fileChange (raw app-server item; shape probed defensively) ----------------------

function pathOf(o: Record<string, unknown>): string | undefined {
  for (const k of ['path', 'file', 'filename', 'file_path', 'filePath', 'name']) {
    const v = o[k]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string') return v
  }
  return undefined
}

function firstPatchString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && looksLikePatch(v)) return v
  }
  return undefined
}

// The change "kind" may be a string ('add'|'delete'|'update'|…) or a tagged object ({type}).
function kindOf(o: Record<string, unknown>): string {
  const k = o.kind ?? o.type ?? o.changeType ?? o.change_type ?? o.action ?? o.operation
  if (typeof k === 'string') return k.toLowerCase()
  if (k && typeof k === 'object') {
    const t = (k as Record<string, unknown>).type
    if (typeof t === 'string') return t.toLowerCase()
  }
  return ''
}

// `changes` may be an array of change objects or a { path: change } map. Normalize both.
function toChangeEntries(changes: unknown): Array<{ path?: string; change: Record<string, unknown> }> {
  if (Array.isArray(changes)) {
    return changes
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({ path: pathOf(c), change: c }))
  }
  if (changes && typeof changes === 'object') {
    return Object.entries(changes as Record<string, unknown>)
      .filter((e): e is [string, Record<string, unknown>] => !!e[1] && typeof e[1] === 'object')
      .map(([path, change]) => ({ path, change }))
  }
  return []
}

function changeToFileDiff(path: string | undefined, change: Record<string, unknown>): FileDiff[] | null {
  // a) an embedded unified diff / patch string
  const patch = firstPatchString(change, ['unified_diff', 'unifiedDiff', 'diff', 'patch'])
  if (patch) {
    const files = parsePatch(patch)
    if (files.length) {
      if (files.length === 1 && path && !files[0].path) {
        files[0].path = path
        files[0].language = langFromPath(path)
      }
      return files
    }
  }

  const kind = kindOf(change)
  const lang = langFromPath(path)

  // b) explicit before/after content pair
  const oldText = firstString(change, ['old_content', 'oldContent', 'old', 'original', 'original_content', 'originalContent', 'before', 'old_string'])
  const newText = firstString(change, ['new_content', 'newContent', 'new', 'modified', 'updated_content', 'after', 'new_string'])
  if (oldText !== undefined || newText !== undefined) {
    if (kind.includes('add') || (oldText === undefined && !kind.includes('delete'))) {
      return [makeFileDiff(path, lang, 'added', oneHunk(allAdded(newText ?? '')))]
    }
    if (kind.includes('delete') || newText === undefined) {
      return [makeFileDiff(path, lang, 'deleted', oneHunk(allDeleted(oldText ?? '')))]
    }
    return [makeFileDiff(path, lang, 'modified', oneHunk(diffLineList(oldText ?? '', newText ?? '')))]
  }

  // c) add/delete carrying only the file content
  const content = firstString(change, ['content', 'text'])
  if (content !== undefined) {
    if (kind.includes('delete')) return [makeFileDiff(path, lang, 'deleted', oneHunk(allDeleted(content)))]
    return [makeFileDiff(path, lang, 'added', oneHunk(allAdded(content)))]
  }

  return null
}

function codexFileChange(input: unknown): FileDiff[] | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>

  // 1) A top-level patch string covering one or more files.
  const topPatch = firstPatchString(obj, ['unified_diff', 'unifiedDiff', 'diff', 'patch', 'content'])
  if (topPatch) {
    const files = parsePatch(topPatch)
    if (files.length) {
      const p = pathOf(obj)
      if (files.length === 1 && p && !files[0].path) {
        files[0].path = p
        files[0].language = langFromPath(p)
      }
      return files
    }
  }

  // 2) A `changes` collection (array or path→change map).
  const entries = toChangeEntries(obj.changes)
  if (entries.length) {
    const out: FileDiff[] = []
    for (const { path, change } of entries) {
      const fd = changeToFileDiff(path, change)
      if (fd) out.push(...fd)
    }
    if (out.length) return out
  }

  // 3) A single change described at the top level (path + kind + content/old/new).
  const single = changeToFileDiff(pathOf(obj), obj)
  return single && single.length ? single : null
}

// --- entry point ---------------------------------------------------------------------------

// Turn a transcript tool item into one FileDiff per changed file, or null when the item isn't
// a recognizable file edit/create (the caller then keeps its generic tool rendering).
export function fileDiffsFromItem(item: ThreadItem): FileDiff[] | null {
  if (item.kind !== 'tool') return null
  switch (item.toolName) {
    case 'Edit': {
      const d = claudeEdit(item.toolInput)
      return d ? [d] : null
    }
    case 'Write': {
      const d = claudeWrite(item.toolInput)
      return d ? [d] : null
    }
    case 'MultiEdit': {
      const d = claudeMultiEdit(item.toolInput)
      return d ? [d] : null
    }
    case 'fileChange':
      return codexFileChange(item.toolInput)
    default:
      return null
  }
}
