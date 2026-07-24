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
  .meter { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.72rem; }
  .ring {
    width: 14px; height: 14px; border-radius: 50%;
    background: conic-gradient(var(--accent) calc(var(--p) * 1%), var(--surface-3) 0);
    flex: none;
  }
  .meter.hot .ring { background: conic-gradient(var(--warn) calc(var(--p) * 1%), var(--surface-3) 0); }
  .meter.hot .lbl { color: var(--warn); }
  .tok { font-family: var(--mono); font-size: 0.68rem; }
</style>
