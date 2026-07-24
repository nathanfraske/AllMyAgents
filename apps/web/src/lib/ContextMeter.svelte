<script lang="ts">
  import type { SessionView } from './store.svelte'

  let { view }: { view: SessionView } = $props()

  const pct = $derived(
    view.contextUsed && view.contextWindow ? Math.min(100, Math.round((view.contextUsed / view.contextWindow) * 100)) : null
  )
  const fmt = (n?: number): string => (n == null ? '?' : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`)
</script>

{#if pct !== null}
  <span class="meter" class:hot={pct > 90} title="{view.contextUsed} / {view.contextWindow} context tokens">
    <span class="ring" style="--p:{pct}"></span>
    <span class="lbl">{pct}%</span>
    <span class="tok dim">{fmt(view.contextUsed)}/{fmt(view.contextWindow)}</span>
  </span>
{/if}

<style>
  .meter { display: inline-flex; align-items: center; gap: 0.35rem; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .ring {
    width: 16px; height: 16px; border-radius: 50%;
    background: conic-gradient(var(--accent) calc(var(--p) * 1%), var(--surface-3) 0);
    box-shadow: inset 0 0 0 3px var(--surface); /* faint inner hole → cleaner "gauge" look */
    flex: none;
  }
  .meter.hot .ring { background: conic-gradient(var(--warn) calc(var(--p) * 1%), var(--surface-3) 0); }
  .meter.hot .lbl { color: var(--warn); }
  .tok { font-family: var(--mono); font-size: var(--text-2xs); }

  @media (prefers-reduced-motion: no-preference) {
    /* --p is a registered custom property (app.css), so the conic sweep tweens on change. */
    .ring { transition: --p var(--dur-slow) var(--ease); }
    .meter.hot .ring { animation: ctx-pulse 1.8s var(--ease) infinite; }
    @keyframes ctx-pulse {
      0%   { box-shadow: inset 0 0 0 3px var(--surface), 0 0 0 0 color-mix(in srgb, var(--warn) 50%, transparent); }
      70%  { box-shadow: inset 0 0 0 3px var(--surface), 0 0 0 4px color-mix(in srgb, var(--warn) 0%, transparent); }
      100% { box-shadow: inset 0 0 0 3px var(--surface), 0 0 0 0 color-mix(in srgb, var(--warn) 0%, transparent); }
    }
  }
</style>
