<script lang="ts">
  import { onMount } from 'svelte'
  import type { OverseerUiGuide } from './store.svelte'

  let { guide, ondismiss }: { guide: OverseerUiGuide; ondismiss: () => void } = $props()
  let target = $state<DOMRect | null>(null)
  let targetFound = $state(false)

  function updateTarget(): void {
    const element = document.querySelector<HTMLElement>(`[data-overseer-anchor="${guide.target}"]`)
    const rect = element?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) {
      target = rect
      targetFound = true
      element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    } else {
      target = null
      targetFound = false
    }
  }

  $effect(() => {
    void guide.seq
    target = null
    targetFound = false
    const timers = [0, 120, 500, 1_500].map((delay) => window.setTimeout(updateTarget, delay))
    return () => timers.forEach((timer) => clearTimeout(timer))
  })

  onMount(() => {
    const refresh = (): void => updateTarget()
    window.addEventListener('resize', refresh)
    window.addEventListener('scroll', refresh, true)
    return () => {
      window.removeEventListener('resize', refresh)
      window.removeEventListener('scroll', refresh, true)
    }
  })

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') ondismiss()
  }

  const vertical = $derived(target && target.y + target.height / 2 > window.innerHeight / 2 ? 'top' : 'bottom')
  const horizontal = $derived(target && target.x + target.width / 2 > window.innerWidth / 2 ? 'left' : 'right')
</script>

<svelte:window onkeydown={onKey} />

{#if target}
  <div
    class="spotlight"
    aria-hidden="true"
    style={`left:${target.x - 6}px;top:${target.y - 6}px;width:${target.width + 12}px;height:${target.height + 12}px`}
  ></div>
{/if}

<aside
  class="guide-card {targetFound ? vertical : 'center'} {targetFound ? horizontal : ''}"
  aria-label="Overseer UI guide"
  aria-live="polite"
>
  <div class="head">
    <span>OVERSEER GUIDE</span>
    <button onclick={ondismiss} aria-label="Dismiss Overseer guide">Dismiss</button>
  </div>
  <p>{guide.message}</p>
  {#if !targetFound}
    <small>The destination is open, but this control is not visible in the current layout. Resize the pane or ask the Overseer for another route.</small>
  {/if}
</aside>

<style>
  .spotlight {
    position: fixed; z-index: 96; pointer-events: none; border: 2px solid var(--accent);
    border-radius: var(--r-md); box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 24%, transparent), var(--shadow-3);
  }
  .guide-card {
    position: fixed; z-index: 97; width: min(360px, calc(100vw - 24px)); padding: var(--space-4);
    color: var(--text); background: var(--surface); border: 1px solid var(--border-accent);
    border-radius: var(--r-xl); box-shadow: var(--shadow-4);
  }
  .guide-card.top { top: 18px; }
  .guide-card.bottom { bottom: 18px; }
  .guide-card.left { left: 18px; }
  .guide-card.right { right: 18px; }
  .guide-card.center { inset: 50% auto auto 50%; transform: translate(-50%, -50%); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .head span { color: var(--accent); font-size: var(--text-2xs); font-weight: var(--fw-semibold); letter-spacing: var(--ls-label); }
  .head button { color: var(--muted); font-size: var(--text-xs); text-decoration: underline; text-underline-offset: 3px; }
  p { margin: var(--space-3) 0 0; color: var(--text); font-size: var(--text-sm); line-height: 1.5; }
  small { display: block; margin-top: var(--space-3); color: var(--muted); font-size: var(--text-xs); line-height: 1.45; }
  @media (max-width: 560px) {
    .guide-card.top, .guide-card.bottom, .guide-card.left, .guide-card.right { inset: auto 8px 8px 8px; width: auto; }
  }
</style>
