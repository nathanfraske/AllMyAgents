<script lang="ts">
  import { onMount } from 'svelte'
  import { captureViewerKeys, type GalleryImage } from './imageGallery'

  let { images, initialId, onclose }: { images: GalleryImage[]; initialId: string; onclose: () => void } = $props()
  let index = $state(0)
  let failed = $state(false)
  let retry = $state(0)
  let dialog: HTMLDialogElement
  let closeButton: HTMLButtonElement
  const current = $derived(images[index]!)
  const source = $derived(retry ? `${current.src}${current.src.includes('?') ? '&' : '?'}viewerRetry=${retry}` : current.src)
  function step(delta: number) {
    index = (index + delta + images.length) % images.length
    failed = false
    retry = 0
  }
  onMount(() => {
    index = Math.max(0, images.findIndex(image => image.attachment.id === initialId))
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const priorOverflow = document.body.style.overflow
    // Escape containment and top-layer modal placement work even inside a content-visibility
    // transcript row. Never request OS fullscreen or mutate the transcript's scroll position.
    document.body.appendChild(dialog)
    const releaseKeys = captureViewerKeys(onclose, step)
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    closeButton.focus({ preventScroll: true })
    return () => {
      releaseKeys()
      dialog.close()
      dialog.remove()
      document.body.style.overflow = priorOverflow
      if (priorFocus?.isConnected) priorFocus.focus({ preventScroll: true })
    }
  })
</script>

<dialog bind:this={dialog} aria-label="Image viewer" oncancel={(event) => { event.preventDefault(); event.stopPropagation(); onclose() }}>
  <header>
    <div class="identity"><strong>{current.attachment.name}</strong><span aria-live="polite">{index + 1} / {images.length}</span></div>
    <a href={source} download={current.attachment.name}>Download</a>
    <button bind:this={closeButton} onclick={onclose} aria-label="Close image viewer" title="Close (Escape)">✕</button>
  </header>
  <div class="canvas">
    {#if images.length > 1}<button class="previous" onclick={() => step(-1)} aria-label="Previous image" title="Previous (Left arrow)">‹</button>{/if}
    {#if failed}
      <div class="error" role="status">Image unavailable. <button onclick={() => { failed = false; retry++ }}>Retry image</button></div>
    {:else}
      {#key source}<img src={source} alt={current.attachment.name} decoding="async" onerror={() => { failed = true }} />{/key}
    {/if}
    {#if images.length > 1}<button class="next" onclick={() => step(1)} aria-label="Next image" title="Next (Right arrow)">›</button>{/if}
  </div>
  <footer>Escape to close{#if images.length > 1} · ← → to browse this conversation's loaded images{/if}</footer>
</dialog>

<style>
  dialog { position: fixed; inset: 0; margin: 0; padding: 0; border: 0; width: 100vw; height: 100dvh; max-width: none; max-height: none;
    background: var(--bg, #090b12); color: var(--text, #eee); }
  dialog[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
  dialog::backdrop { background: #090b12; }
  header { display: flex; gap: 1rem; align-items: center; padding: 0.7rem 1rem; border-bottom: 1px solid var(--border); }
  .identity { flex: 1; min-width: 0; display: flex; gap: 1rem; align-items: center; }
  strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  span, footer { color: var(--muted); font-size: 0.8rem; }
  span { white-space: nowrap; }
  a { color: var(--cyan); font-size: 0.85rem; }
  button { color: inherit; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 8px; padding: 0.6rem; cursor: pointer; }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
  .canvas { min-height: 0; min-width: 0; position: relative; display: grid; place-items: center; padding: 0.6rem 3.5rem; }
  img { width: 100%; height: 100%; min-height: 0; object-fit: contain; }
  .previous, .next { position: absolute; top: 50%; transform: translateY(-50%); font-size: 1.8rem; }
  .previous { left: 0.5rem; } .next { right: 0.5rem; }
  footer { text-align: center; padding: 0.5rem; }
  .error { text-align: center; }
  @media (max-width: 500px) { header { gap: 0.6rem; padding: 0.5rem; } .identity { flex-direction: column; align-items: start; gap: 0.2rem; } strong { max-width: 100%; } }
</style>
