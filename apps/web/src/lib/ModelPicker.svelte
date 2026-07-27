<script lang="ts">
  import { modelsFor, findModel, type Provider } from './catalog'
  import Icon from './Icon.svelte'

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
  <button class="pill-btn" class:open onclick={() => (open = !open)} title={`Model: ${current?.name ?? 'model'}`}>
    <span class="glyph" class:codex={provider === 'codex'}></span>
    <span class="pill-label">{current?.shortName ?? current?.name ?? 'model'}</span>
    <span class="chev"><Icon name="chevron-down" size={12} /></span>
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
          {#if m.slug === current?.slug}<span class="tick"><Icon name="check" size={13} /></span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; min-width: 0; }
  .pill-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .glyph { width: 9px; height: 9px; border-radius: var(--r-xs); background: var(--secondary); }
  .glyph.codex { background: var(--ok); }
  .chev { display: inline-grid; opacity: 0.6; }
  .scrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 220px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--space-1); box-shadow: var(--shadow-3), var(--edge-hi); }
  @media (prefers-reduced-motion: no-preference) { .menu { animation: pop-in var(--dur-fast) var(--ease); } }
  .search { width: 100%; margin-bottom: var(--space-1); }
  .row { display: flex; align-items: center; gap: var(--space-2); width: 100%; text-align: left; padding: var(--space-2) var(--space-3); border-radius: var(--r-md); font-size: var(--text-sm); }
  .row:hover { background: var(--surface-3); }
  .row.sel { background: var(--surface-3); }
  .row.sel .name { font-weight: var(--fw-medium); }
  .name { flex: 1; }
  .tick { display: inline-grid; color: var(--accent); flex: none; }
  .badge { font-size: var(--text-2xs); border-radius: var(--r-xs); padding: 0 0.3rem; line-height: 1.5; }
  .badge.new { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
  .badge.def { color: var(--dim); border: 1px solid var(--border-strong); }
</style>
