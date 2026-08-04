<script lang="ts">
  // Renders a message's text as sanitized GitHub-flavored Markdown. Prose segments are
  // injected as pre-sanitized HTML (see markdown.ts — every string here has been through
  // DOMPurify); fenced code blocks render as the native CodeBlock component so the copy
  // button and its state are real Svelte, not injected markup.
  import { onMount } from 'svelte'
  import { renderMarkdown } from './markdown'
  import { revealLocalFile } from './localFile'
  import CodeBlock from './CodeBlock.svelte'
  import { installTranscriptCopy } from './transcriptCopy'

  let { text }: { text: string } = $props()
  const segments = $derived(renderMarkdown(text))
  let fileFeedback = $state('')
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined
  let proseRoot: HTMLDivElement

  async function handleClick(event: MouseEvent): Promise<void> {
    if (!(event.target instanceof Element)) return
    const anchor = event.target.closest<HTMLAnchorElement>('a[data-local-path]')
    if (!anchor || !event.currentTarget || !(event.currentTarget as Element).contains(anchor)) return
    event.preventDefault()
    event.stopPropagation()
    const path = anchor.dataset.localPath
    if (!path) return

    if (feedbackTimer) clearTimeout(feedbackTimer)
    fileFeedback = 'Opening the containing folder…'
    try {
      const result = await revealLocalFile(path)
      fileFeedback = result === 'revealed' ? 'File revealed in your file manager.' : 'File path copied.'
    } catch (error) {
      fileFeedback = error instanceof Error ? error.message : 'Could not reveal this file.'
    }
    feedbackTimer = setTimeout(() => (fileFeedback = ''), 4_000)
  }

  onMount(() => {
    const uninstallCopy = installTranscriptCopy()
    proseRoot.addEventListener('click', handleClick)
    return () => {
      uninstallCopy?.()
      proseRoot.removeEventListener('click', handleClick)
      if (feedbackTimer) clearTimeout(feedbackTimer)
    }
  })
</script>

<div class="prose" data-transcript-copy bind:this={proseRoot}>
  {#each segments as seg (seg.key)}
    {#if seg.type === 'code'}
      <div class="seg"><CodeBlock code={seg.code} lang={seg.lang} html={seg.html} /></div>
    {:else}
      <!-- seg.html is DOMPurify-sanitized in markdown.ts before it ever reaches here -->
      <div class="seg">{@html seg.html}</div>
    {/if}
  {/each}
  <span class="sr-only" role="status" aria-live="polite">{fileFeedback}</span>
</div>

<style>
  .prose {
    line-height: 1.55;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  /* Each segment carries the vertical rhythm; first/last trim so prose sits flush in its
     bubble. min-width:0 lets wide children (tables, code) scroll instead of stretching. */
  .seg { margin: 0.55rem 0; min-width: 0; }
  .seg:first-child { margin-top: 0; }
  .seg:last-child { margin-bottom: 0; }
  /* Trim the injected block's own outer margins so the .seg margin is the single source. */
  .seg > :global(:first-child) { margin-top: 0; }
  .seg > :global(:last-child) { margin-bottom: 0; }

  .seg :global(p) { margin: 0.5rem 0; }

  .seg :global(h1),
  .seg :global(h2),
  .seg :global(h3),
  .seg :global(h4),
  .seg :global(h5),
  .seg :global(h6) { margin: 0.9rem 0 0.4rem; line-height: 1.3; font-weight: 600; }
  .seg :global(h1) { font-size: 1.3rem; }
  .seg :global(h2) { font-size: 1.15rem; }
  .seg :global(h3) { font-size: 1.02rem; }
  .seg :global(h4) { font-size: 0.94rem; }
  .seg :global(h5),
  .seg :global(h6) { font-size: 0.86rem; color: var(--muted); }

  .seg :global(ul),
  .seg :global(ol) { margin: 0.45rem 0; padding-left: 1.35rem; }
  .seg :global(li) { margin: 0.2rem 0; }
  .seg :global(li)::marker { color: var(--dim); }
  .seg :global(li > input[type='checkbox']) { margin-right: 0.35rem; }

  .seg :global(a) {
    color: var(--cyan);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .seg :global(a:hover) { color: var(--accent); }

  /* Research links carry a compact, locally-rendered identity marker. No remote favicon is loaded:
     merely viewing a model message must never contact every site the model mentioned. */
  .seg :global(a[data-link-kind]) {
    font-weight: 600;
    text-decoration: none;
  }
  .seg :global(a[data-link-kind]:hover) { text-decoration: underline; }
  .seg :global(a[data-link-kind]::before) {
    display: inline-grid;
    place-items: center;
    width: 1.25em;
    height: 1.25em;
    margin-right: 0.22em;
    vertical-align: -0.16em;
    border-radius: 0.28em;
    font-size: 0.72em;
    font-weight: 800;
    line-height: 1;
    text-decoration: none;
  }
  .seg :global(a[data-link-kind='github']::before) {
    content: 'GH';
    color: var(--bg);
    background: color-mix(in srgb, var(--cyan) 82%, white);
    letter-spacing: -0.08em;
  }
  .seg :global(a[data-link-kind='pdf']::before) {
    content: 'PDF';
    width: 1.55em;
    color: white;
    background: #e54855;
    border-radius: 0.2em;
    font-size: 0.56em;
  }
  .seg :global(a[data-link-kind='web']::before) {
    content: '↗';
    color: white;
    background: color-mix(in srgb, var(--cyan) 82%, #175cff);
  }
  .seg :global(a[data-link-kind='file']::before) {
    content: 'FILE';
    width: 1.75em;
    color: var(--bg);
    background: color-mix(in srgb, var(--cyan) 82%, white);
    border-radius: 0.2em;
    font-size: 0.52em;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .seg :global(strong) { font-weight: 600; color: var(--text); }
  .seg :global(em) { font-style: italic; }
  .seg :global(del) { color: var(--dim); }

  .seg :global(blockquote) {
    margin: 0.5rem 0;
    padding: 0.1rem 0 0.1rem 0.8rem;
    border-left: 3px solid var(--border-strong);
    color: var(--muted);
  }

  .seg :global(hr) { border: none; border-top: 1px solid var(--border); margin: 0.9rem 0; }

  /* Inline code chip. `.seg pre code` (higher specificity, below) overrides this for code
     that lives inside a block, so only true inline code gets the chip treatment. */
  .seg :global(code) {
    font-family: var(--mono);
    font-size: 0.84em;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0.03rem 0.3rem;
    color: color-mix(in srgb, var(--accent) 55%, var(--text));
    word-break: break-word;
  }

  /* Fenced code that stayed in the prose (nested in a list/quote): styled like a code block
     but without the CodeBlock chrome / copy button. */
  .seg :global(pre) {
    margin: 0.5rem 0;
    padding: 0.6rem 0.7rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow-x: auto;
  }
  .seg :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.8rem;
    color: var(--text);
    white-space: pre;
    word-break: normal;
  }

  .seg :global(table) {
    display: block;
    width: max-content;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    margin: 0.5rem 0;
    font-size: 0.9em;
  }
  .seg :global(th),
  .seg :global(td) {
    border: 1px solid var(--border);
    padding: 0.3rem 0.55rem;
    text-align: left;
  }
  .seg :global(th) { background: var(--surface-2); font-weight: 600; }

  .seg :global(img) { max-width: 100%; border-radius: 6px; }
</style>
