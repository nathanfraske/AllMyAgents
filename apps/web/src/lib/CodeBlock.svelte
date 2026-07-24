<script lang="ts">
  // A fenced code block: language label + copy button over a dark, scrollable code area.
  // `html` is the pre-highlighted, already-sanitized markup (see markdown.ts); `code` is the
  // raw source the copy button writes to the clipboard.
  let { code, lang, html }: { code: string; lang: string; html: string } = $props()

  let copied = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  // Legacy fallback for when the async Clipboard API is absent OR rejects (e.g. the window
  // isn't focused / a permissions policy blocks it).
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
        /* rejected — try the legacy path below */
      }
    }
    return execCopy(text)
  }

  async function copy(): Promise<void> {
    if (!(await copyText(code))) return // copy failed — don't flash a false "copied"
    copied = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied = false), 1400)
  }
</script>

<div class="code">
  <div class="chead">
    <span class="lang">{lang || 'text'}</span>
    <button class="copy" class:copied onclick={copy} title="Copy code" aria-label="Copy code">
      {#if copied}
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
        copied
      {:else}
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
        copy
      {/if}
    </button>
  </div>
  <pre class="cbody"><code>{@html html}</code></pre>
</div>

<style>
  .code {
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    background: var(--bg);
    margin: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem 0.35rem 0.25rem 0.6rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
  }
  .lang {
    font-family: var(--mono);
    font-size: 0.68rem;
    letter-spacing: 0.03em;
    color: var(--dim);
    text-transform: lowercase;
  }
  .copy {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    font-size: 0.7rem;
    color: var(--muted);
    padding: 0.15rem 0.4rem;
    border-radius: 6px;
    font-style: normal;
  }
  .copy:hover { background: var(--surface-3); color: var(--text); }
  .copy.copied { color: var(--ok); }
  .cbody {
    margin: 0;
    padding: 0.65rem 0.75rem;
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 0.8rem;
    line-height: 1.5;
    font-style: normal;
  }
  .cbody code {
    font-family: inherit;
    background: none;
    border: none;
    padding: 0;
    color: var(--text);
    white-space: pre;
  }

  /* Compact highlight.js theme mapped onto the CEC palette (avoids shipping a hljs CSS file).
     Only the token classes the common languages emit are covered; anything else inherits the
     base code colour. */
  .cbody :global(.hljs-comment),
  .cbody :global(.hljs-quote) { color: var(--dim); font-style: italic; }
  .cbody :global(.hljs-keyword),
  .cbody :global(.hljs-selector-tag),
  .cbody :global(.hljs-literal),
  .cbody :global(.hljs-type),
  .cbody :global(.hljs-doctag) { color: var(--secondary); }
  .cbody :global(.hljs-string),
  .cbody :global(.hljs-regexp),
  .cbody :global(.hljs-char),
  .cbody :global(.hljs-meta .hljs-string) { color: var(--ok); }
  .cbody :global(.hljs-number),
  .cbody :global(.hljs-symbol),
  .cbody :global(.hljs-link) { color: var(--cyan); }
  .cbody :global(.hljs-title),
  .cbody :global(.hljs-title.function_),
  .cbody :global(.hljs-section) { color: var(--cyan); }
  .cbody :global(.hljs-attr),
  .cbody :global(.hljs-attribute),
  .cbody :global(.hljs-property),
  .cbody :global(.hljs-variable),
  .cbody :global(.hljs-template-variable) { color: color-mix(in srgb, var(--cyan) 70%, var(--text)); }
  .cbody :global(.hljs-name),
  .cbody :global(.hljs-selector-id),
  .cbody :global(.hljs-selector-class),
  .cbody :global(.hljs-built_in),
  .cbody :global(.hljs-tag) { color: var(--accent); }
  .cbody :global(.hljs-meta),
  .cbody :global(.hljs-comment .hljs-doctag) { color: var(--muted); }
  .cbody :global(.hljs-deletion) { color: var(--del); }
  .cbody :global(.hljs-addition) { color: var(--add); }
  .cbody :global(.hljs-emphasis) { font-style: italic; }
  .cbody :global(.hljs-strong) { font-weight: 600; }
</style>
