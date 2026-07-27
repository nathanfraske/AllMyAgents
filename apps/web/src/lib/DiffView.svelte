<script lang="ts">
  // A GitHub / Claude-Code-style unified file diff for one changed file. Fed a normalized
  // `FileDiff` (built in diff.ts); renders a path header with +add/−del counts, a copy button
  // for the new content, syntax-highlighted add/removed/context lines with line-number gutters,
  // and a collapse/expand for large diffs.
  //
  // The only injected HTML is each line's `highlightDiffLine(...)` output, which diff.ts has
  // already escaped-or-highlighted and run through DOMPurify (span/class allowlist). Everything
  // else here is plain Svelte text.
  import { highlightDiffLine } from './diff'
  import type { FileDiff } from './diff'
  import { store } from './store.svelte'
  import { diffDisplay, initialDiffExpanded } from './diffDisplay'

  let { diff }: { diff: FileDiff } = $props()

  // null follows the live preference; once clicked, this individual diff keeps the user's override.
  let expandedOverride = $state<boolean | null>(null)
  let copied = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  const density = $derived(store.prefs.fileWriteDiffDensity ?? 'minimal')
  const expanded = $derived(expandedOverride ?? initialDiffExpanded(density))
  const compact = $derived(density === 'minimal' && !expanded)
  const display = $derived(diffDisplay(diff, density, expanded))
  const shown = $derived(display.rows)
  const collapsible = $derived(display.canToggle)
  const hiddenLabel = $derived.by(() => {
    const details: string[] = []
    if (display.hidden.changed) details.push(`${display.hidden.changed} changed`)
    if (display.hidden.context) details.push(`${display.hidden.context} context`)
    return `${display.hidden.total} more row${display.hidden.total === 1 ? '' : 's'}${details.length ? ` (${details.join(', ')})` : ''}`
  })

  function toggleExpanded(): void {
    expandedOverride = !expanded
  }

  // Precompute per-row render data (incl. the sanitized, highlighted HTML) for the visible rows
  // only — so a collapsed large diff never pays to highlight the hidden lines.
  const rows = $derived.by(() =>
    shown.map((r, i) => {
      if (r.kind === 'hunk') return { kind: 'hunk' as const, key: `h${i}`, text: r.text }
      const l = r.line
      return {
        kind: 'line' as const,
        key: `l${i}`,
        type: l.type,
        oldNo: l.oldNo != null ? String(l.oldNo) : '',
        newNo: l.newNo != null ? String(l.newNo) : '',
        sign: l.type === 'add' ? '+' : l.type === 'del' ? '-' : '',
        html: highlightDiffLine(l.text, diff.language),
      }
    })
  )

  // Split the path so the directory can ellipsize while the filename stays fully visible.
  const nameParts = $derived.by(() => {
    const full = (diff.path ?? '').replace(/\\/g, '/')
    if (!full) return { dir: '', base: '(unknown file)' }
    const idx = full.lastIndexOf('/')
    return idx >= 0 ? { dir: full.slice(0, idx + 1), base: full.slice(idx + 1) } : { dir: '', base: full }
  })

  const badge = $derived(
    diff.status === 'added'
      ? 'new file'
      : diff.status === 'deleted'
        ? 'deleted'
        : diff.status === 'renamed'
          ? 'renamed'
          : ''
  )
  const editVerb = $derived(
    diff.status === 'added'
      ? 'Created'
      : diff.status === 'deleted'
        ? 'Deleted'
        : diff.status === 'renamed'
          ? 'Renamed'
          : 'Edited'
  )

  // Clipboard write with a legacy execCommand fallback (mirrors CodeBlock.svelte).
  function execCopy(text: string): boolean {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
  async function copyText(text: string): Promise<boolean> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        /* rejected — try the legacy path */
      }
    }
    return execCopy(text)
  }
  async function copy(): Promise<void> {
    if (!(await copyText(diff.addedText))) return
    copied = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied = false), 1400)
  }
</script>

<div class="diffview">
  <div class="dhead" class:compact>
    {#if !compact}
      <button
        class="toggle"
        onclick={toggleExpanded}
        disabled={!collapsible}
        aria-expanded={expanded || !collapsible}
        title={collapsible ? (expanded ? 'Collapse diff' : 'Expand full diff') : ''}
      >
        <span class="chev" class:invisible={!collapsible}>{expanded ? '▾' : '▸'}</span>
      </button>
    {:else}
      <span class="verb"><span aria-hidden="true">✎</span> {editVerb}</span>
    {/if}

    <span class="path" title={diff.path ?? ''}>
      {#if !compact && nameParts.dir}<span class="dir">{nameParts.dir}</span>{/if}<span class="base">{nameParts.base}</span>
    </span>

    {#if !compact && badge}<span class="badge {diff.status}">{badge}</span>{/if}

    <span class="counts">
      {#if diff.additions}<span class="add">+{diff.additions}</span>{/if}
      {#if diff.deletions}<span class="del">−{diff.deletions}</span>{/if}
      {#if !diff.additions && !diff.deletions}<span class="nochg">no changes</span>{/if}
    </span>

    <span class="spacer"></span>

    {#if diff.addedText && !compact}
      <button class="copy" class:copied onclick={copy} title="Copy new content" aria-label="Copy new content">
        {#if copied}
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
          copied
        {:else}
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
          copy
        {/if}
      </button>
    {/if}

    {#if compact}
      <button
        class="toggle"
        onclick={toggleExpanded}
        disabled={!collapsible}
        aria-expanded={false}
        aria-label="Show full diff"
        title={collapsible ? 'Expand full diff' : ''}
      >
        <span class="chev" class:invisible={!collapsible}>▸</span>
      </button>
    {/if}
  </div>

  {#if rows.length}
    <div class="dbody" class:clipped={collapsible && !expanded}>
      {#each rows as row (row.key)}
        {#if row.kind === 'hunk'}
          <div class="hunk"><span class="hunk-txt">{row.text}</span></div>
        {:else}
          <div class="line {row.type}">
            <span class="ln">{row.oldNo}</span>
            <span class="ln">{row.newNo}</span>
            <span class="sign">{row.sign}</span>
            <!-- row.html is escaped-or-hljs output, DOMPurify-sanitized in diff.ts -->
            <span class="code">{@html row.html}</span>
          </div>
        {/if}
      {/each}
    </div>

    {#if collapsible}
      <button class="more" onclick={toggleExpanded}>
        {expanded ? 'Show less' : `Show full diff · ${hiddenLabel}`}
      </button>
    {/if}
  {/if}
</div>

<style>
  .diffview {
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    background: var(--bg);
  }

  .dhead {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.28rem 0.4rem 0.28rem 0.25rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
  }
  .dhead.compact { border-bottom: 0; }
  .verb {
    display: inline-flex;
    align-items: baseline;
    gap: 0.28rem;
    flex: none;
    color: var(--muted);
    font-size: 0.74rem;
  }
  .toggle {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    flex: none;
    color: var(--muted);
    border-radius: 4px;
    font-size: 0.7rem;
  }
  .toggle:hover:not(:disabled) { color: var(--text); background: var(--surface-3); }
  .toggle:disabled { cursor: default; }
  .chev.invisible { visibility: hidden; }

  .path {
    display: flex;
    align-items: baseline;
    min-width: 0;
    font-family: var(--mono);
    font-size: 0.74rem;
  }
  .dir { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .base { color: var(--text); font-weight: 500; flex: none; }

  .badge {
    flex: none;
    font-size: 0.62rem;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    padding: 0.02rem 0.4rem;
    color: var(--muted);
  }
  .badge.added { color: var(--add); border-color: color-mix(in srgb, var(--add) 55%, transparent); }
  .badge.deleted { color: var(--del); border-color: color-mix(in srgb, var(--del) 55%, transparent); }

  .counts {
    flex: none;
    display: flex;
    gap: 0.4rem;
    font-family: var(--mono);
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
  }
  .counts .add { color: var(--add); }
  .counts .del { color: var(--del); }
  .counts .nochg { color: var(--dim); }

  .spacer { flex: 1; }

  .copy {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    flex: none;
    font-size: 0.68rem;
    color: var(--muted);
    padding: 0.12rem 0.4rem;
    border-radius: 6px;
  }
  .copy:hover { background: var(--surface-3); color: var(--text); }
  .copy.copied { color: var(--ok); }

  .dbody {
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 0.76rem;
    line-height: 1.5;
    padding: 0.15rem 0;
  }
  .dbody.clipped {
    -webkit-mask-image: linear-gradient(#000 62%, transparent);
    mask-image: linear-gradient(#000 62%, transparent);
  }

  .line {
    display: flex;
    min-width: 100%;
    width: max-content;
  }
  .line.add { background: color-mix(in srgb, var(--add) 15%, transparent); }
  .line.del { background: color-mix(in srgb, var(--del) 15%, transparent); }

  .ln {
    flex: none;
    width: 2.6rem;
    padding: 0 0.45rem;
    text-align: right;
    color: var(--dim);
    white-space: nowrap;
    user-select: none;
    font-variant-numeric: tabular-nums;
  }
  .sign {
    flex: none;
    width: 1.1rem;
    text-align: center;
    color: var(--dim);
    user-select: none;
  }
  .line.add .sign { color: var(--add); }
  .line.del .sign { color: var(--del); }

  .code {
    flex: none;
    white-space: pre;
    padding-right: 1rem;
    color: var(--text);
    tab-size: 2;
  }

  .hunk {
    display: flex;
    padding: 0.1rem 0.5rem;
    background: color-mix(in srgb, var(--secondary) 10%, transparent);
    color: var(--secondary);
    font-size: 0.7rem;
  }
  .hunk-txt { white-space: pre; overflow: hidden; text-overflow: ellipsis; }

  .more {
    width: 100%;
    padding: 0.3rem 0.5rem;
    font-size: 0.72rem;
    color: var(--accent);
    background: var(--surface-2);
    border-top: 1px solid var(--border);
    text-align: center;
  }
  .more:hover { background: var(--surface-3); }

  /* highlight.js token palette (CEC colors), scoped to this component's code cells. Mirrors the
     mapping in CodeBlock.svelte — component-scoped styles can't be shared, so it's repeated. */
  .code :global(.hljs-comment),
  .code :global(.hljs-quote) { color: var(--dim); font-style: italic; }
  .code :global(.hljs-keyword),
  .code :global(.hljs-selector-tag),
  .code :global(.hljs-literal),
  .code :global(.hljs-type),
  .code :global(.hljs-doctag) { color: var(--secondary); }
  .code :global(.hljs-string),
  .code :global(.hljs-regexp),
  .code :global(.hljs-char),
  .code :global(.hljs-meta .hljs-string) { color: var(--ok); }
  .code :global(.hljs-number),
  .code :global(.hljs-symbol),
  .code :global(.hljs-link) { color: var(--cyan); }
  .code :global(.hljs-title),
  .code :global(.hljs-title.function_),
  .code :global(.hljs-section) { color: var(--cyan); }
  .code :global(.hljs-attr),
  .code :global(.hljs-attribute),
  .code :global(.hljs-property),
  .code :global(.hljs-variable),
  .code :global(.hljs-template-variable) { color: color-mix(in srgb, var(--cyan) 70%, var(--text)); }
  .code :global(.hljs-name),
  .code :global(.hljs-selector-id),
  .code :global(.hljs-selector-class),
  .code :global(.hljs-built_in),
  .code :global(.hljs-tag) { color: var(--accent); }
  .code :global(.hljs-meta) { color: var(--muted); }
  .code :global(.hljs-deletion) { color: var(--del); }
  .code :global(.hljs-addition) { color: var(--add); }
  .code :global(.hljs-emphasis) { font-style: italic; }
  .code :global(.hljs-strong) { font-weight: 600; }
</style>
