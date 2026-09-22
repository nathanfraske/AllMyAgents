<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import CodeBlock from './CodeBlock.svelte'
  import { renderMermaid } from './mermaidRenderer'

  let { code, html, complete = true }: { code: string; html: string; complete?: boolean } = $props()
  let root: HTMLElement
  let visible = $state(false)
  let image = $state('')
  let error = $state('')
  let sourceOpen = $state(false)
  let retry = $state(0)
  let lastSource = ''
  let lastRetry = -1
  onMount(() => {
    if (!globalThis.IntersectionObserver) { visible = true; return }
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting)
    }, { rootMargin: '200px' })
    observer.observe(root)
    return () => observer.disconnect()
  })
  $effect(() => {
    const source = code
    const attempt = retry
    if (source !== lastSource || attempt !== lastRetry) {
      lastSource = source; lastRetry = attempt
      image = ''; error = ''
    }
    // Leaving the viewport must not collapse a completed diagram and move the reader's scroll anchor.
    if (!visible || !complete || untrack(() => Boolean(image || error))) return
    const controller = new AbortController()
    // Streaming updates debounce; an unfinished fence never pays for a diagram parse.
    const timer = setTimeout(() => {
      void renderMermaid(source, controller.signal).then(value => {
        if (!controller.signal.aborted) image = value
      }).catch(reason => {
        if (!controller.signal.aborted) error = reason instanceof Error ? reason.message : 'Diagram preview failed'
      })
    }, attempt ? 0 : 180)
    return () => { clearTimeout(timer); controller.abort() }
  })
</script>

<section class="diagram" aria-label="Mermaid diagram" bind:this={root}>
  <div class="toolbar" data-copy-ignore>
    <span>Mermaid</span>
    <button aria-expanded={sourceOpen} onclick={() => sourceOpen = !sourceOpen}>{sourceOpen ? 'Hide source' : 'View source'}</button>
  </div>
  {#if image}
    <div class="preview"><img src={image} alt="Rendered Mermaid diagram; its text definition is available in View source" onerror={() => { image = ''; error = 'Diagram image could not be displayed.' }} /></div>
  {:else if error}
    <div class="notice" role="status">Diagram preview unavailable: {error} <button onclick={() => retry++}>Retry</button></div>
  {:else}
    <div class="notice" role="status">{!complete ? 'Waiting for the diagram to finish…' : 'Preparing diagram…'}</div>
  {/if}
  {#if sourceOpen || error || !complete}
    <CodeBlock {code} lang="mermaid" {html} />
  {/if}
</section>

<style>
  .diagram { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .toolbar { display:flex; justify-content:space-between; align-items:center; padding:0.35rem 0.6rem; background:var(--surface-2); font-size:0.75rem; color:var(--muted); }
  button { border-radius:5px; padding:0.2rem 0.45rem; color:var(--cyan); }
  button:hover { background:var(--surface-3); }
  .preview { background:#fff; padding:0.75rem; overflow:auto; max-height:650px; }
  .preview img { display:block; max-width:100%; height:auto; margin:auto; }
  .notice { padding:0.8rem; font-size:0.85rem; color:var(--muted); white-space:pre-wrap; }
</style>
