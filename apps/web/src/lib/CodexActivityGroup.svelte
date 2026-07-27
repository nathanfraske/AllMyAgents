<script lang="ts">
  import type { ThreadItem } from './store.svelte'
  import { summarizeCodexGroup } from './codexGroup'
  import ItemCard from './ItemCard.svelte'

  // A collapsed group of consecutive Codex reasoning/command steps — the reasoning→command→reasoning
  // churn a turn produces, folded into one line the way the Codex app does. It accumulates LIVE while
  // the model works (the store keeps appending to `items`, and this component's id is stable so its
  // open state survives), and the parent breaks the group when the agent actually says something.
  let { items, now = 0, live = false }: { items: ThreadItem[]; now?: number; live?: boolean } = $props()

  // Per-group expansion, held here so it survives new steps arriving (stable component id upstream).
  // Once the operator opens a group it STAYS open as more steps stream in — we never collapse it out
  // from under them.
  let open = $state(false)

  const summary = $derived(summarizeCodexGroup(items))

  // Elapsed spans the first step to the last — or to the live clock while the turn is still running,
  // so a collapsed group visibly ticks rather than freezing at its first step's timestamp.
  function ms(ts?: string): number {
    if (!ts) return 0
    const t = new Date(ts).getTime()
    return Number.isNaN(t) ? 0 : t
  }
  const startMs = $derived(ms(items[0]?.ts))
  const endMs = $derived(live && now > 0 ? now : ms(items[items.length - 1]?.ts))
  const elapsed = $derived(startMs > 0 && endMs > startMs ? fmtElapsed(endMs - startMs) : '')
  function fmtElapsed(d: number): string {
    const s = Math.floor(d / 1000)
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
</script>

<div class="grp" class:live>
  <button class="hd" onclick={() => (open = !open)} aria-expanded={open}>
    <span class="chev">{open ? '▾' : '▸'}</span>
    <span class="glyph" aria-hidden="true">✦</span>
    <span class="steps">{summary.steps} {summary.steps === 1 ? 'step' : 'steps'}</span>
    {#if elapsed}<span class="meta">{elapsed}</span>{/if}
    {#if summary.current}<span class="cur" title={summary.current}>{summary.current}</span>
    {:else if summary.reasoning}<span class="cur dim">thinking…</span>{/if}
    {#if live}<span class="livedot" aria-label="working"></span>{/if}
  </button>
  {#if open}
    <div class="body">
      {#each items as it (it.key)}
        <ItemCard item={it} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .grp { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 0.15rem 0.2rem; }
  .grp.live { border-color: color-mix(in srgb, var(--working) 45%, var(--border)); }
  .hd {
    display: flex; align-items: center; gap: 0.45rem; width: 100%; text-align: left;
    background: none; border: none; color: var(--muted); font-size: 0.78rem; padding: 0.25rem 0.4rem; cursor: pointer;
  }
  .hd:hover { color: var(--text); }
  .chev { width: 0.8rem; color: var(--dim); }
  .glyph { color: var(--accent); font-size: 0.8rem; }
  .steps { font-weight: var(--fw-medium); color: var(--text); }
  .meta { font-variant-numeric: tabular-nums; font-family: var(--mono); color: var(--dim); font-size: 0.72rem; }
  .cur { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--mono); font-size: 0.72rem; color: var(--muted); }
  .cur.dim { color: var(--dim); font-style: italic; font-family: inherit; }
  .livedot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--working); }
  @media (prefers-reduced-motion: no-preference) {
    .livedot { animation: pulse 1.1s var(--ease) infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
  }
  .body { display: flex; flex-direction: column; gap: 0.45rem; padding: 0.3rem 0.4rem 0.45rem; border-top: 1px solid var(--border); }
</style>
