<script lang="ts">
  import { modelsFor, findModel, type Provider } from './catalog'

  let { provider, model, onselect }: { provider: Provider; model?: string; onselect: (slug: string) => void } = $props()

  let open = $state(false)
  let filter = $state('')

  const models = $derived(modelsFor(provider))
  const current = $derived(findModel(model) ?? models.find((m) => m.isDefault) ?? models[0])
  const shown = $derived(
    filter ? models.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase())) : models
  )

  function pick(slug: string): void {
    onselect(slug)
    open = false
    filter = ''
  }
</script>

<div class="wrap">
  <button class="pill-btn" onclick={() => (open = !open)}>
    <span class="glyph" class:codex={provider === 'codex'}></span>
    {current?.shortName ?? current?.name ?? 'model'}
    <span class="chev">▾</span>
  </button>
  {#if open}
    <button class="scrim" onclick={() => (open = false)} aria-label="close"></button>
    <div class="menu">
      {#if models.length > 5}
        <input class="search" placeholder="Search models" bind:value={filter} />
      {/if}
      {#each shown as m (m.slug)}
        <button class="row" class:sel={m.slug === current?.slug} onclick={() => pick(m.slug)}>
          <span class="name">{m.name}</span>
          {#if m.isNew}<span class="badge new">New</span>{/if}
          {#if m.isDefault}<span class="badge def">Default</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .glyph { width: 9px; height: 9px; border-radius: 3px; background: var(--secondary); }
  .glyph.codex { background: var(--ok); }
  .chev { font-size: 0.6rem; opacity: 0.7; }
  .scrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 220px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 10px; padding: 0.3rem; box-shadow: 0 8px 28px rgba(0,0,0,0.5); }
  @media (prefers-reduced-motion: no-preference) { .menu { animation: pop-in 0.12s var(--ease); } }
  .search { width: 100%; margin-bottom: 0.3rem; }
  .row { display: flex; align-items: center; gap: 0.4rem; width: 100%; text-align: left; padding: 0.35rem 0.5rem; border-radius: 7px; font-size: 0.82rem; }
  .row:hover { background: var(--surface-3); }
  .row.sel { background: var(--surface-3); }
  .name { flex: 1; }
  .badge { font-size: 0.6rem; border-radius: 4px; padding: 0 0.25rem; }
  .badge.new { color: var(--warn); border: 1px solid var(--warn); }
  .badge.def { color: var(--dim); border: 1px solid var(--border-strong); }
</style>
