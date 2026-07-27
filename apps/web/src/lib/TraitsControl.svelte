<script lang="ts">
  import { descriptorLabel, type OptionDescriptor } from './catalog'
  import Icon from './Icon.svelte'

  let {
    descriptors,
    values,
    onchange,
  }: {
    descriptors: OptionDescriptor[]
    values: Record<string, string>
    onchange: (id: string, value: string) => void
  } = $props()

  let open = $state(false)

  const label = $derived(descriptors.map((d) => descriptorLabel(d, values[d.id])).join(' · '))

  function current(d: OptionDescriptor): string {
    return values[d.id] ?? d.options?.find((o) => o.isDefault)?.value ?? d.options?.[0]?.value ?? ''
  }
</script>

{#if descriptors.length > 0}
  <div class="wrap">
    <button class="pill-btn" class:open onclick={() => (open = !open)} title={`Model options: ${label}`}><span class="lead"><Icon name="zap" size={13} /></span><span class="pill-label">{label}</span><span class="chev"><Icon name="chevron-down" size={12} /></span></button>
    {#if open}
      <button class="scrim" onclick={() => (open = false)} aria-label="close"></button>
      <div class="menu">
        {#each descriptors as d (d.id)}
          <div class="group">
            <div class="glabel dim">{d.label}</div>
            {#if d.type === 'select'}
              {#each d.options ?? [] as opt (opt.value)}
                <button class="opt" class:sel={current(d) === opt.value} onclick={() => { onchange(d.id, opt.value); open = false }}>
                  {opt.label}{#if opt.isDefault}<span class="def">default</span>{/if}
                  {#if current(d) === opt.value}<span class="tick"><Icon name="check" size={13} /></span>{/if}
                </button>
              {/each}
            {:else}
              <button class="opt" class:sel={current(d) !== 'true'} onclick={() => { onchange(d.id, 'false'); open = false }}>Off{#if current(d) !== 'true'}<span class="tick"><Icon name="check" size={13} /></span>{/if}</button>
              <button class="opt" class:sel={current(d) === 'true'} onclick={() => { onchange(d.id, 'true'); open = false }}>On{#if current(d) === 'true'}<span class="tick"><Icon name="check" size={13} /></span>{/if}</button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .wrap { position: relative; min-width: 0; }
  .pill-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lead { display: inline-grid; color: var(--accent); }
  .chev { display: inline-grid; opacity: 0.6; }
  .scrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 170px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--space-2); box-shadow: var(--shadow-3), var(--edge-hi); }
  @media (prefers-reduced-motion: no-preference) { .menu { animation: pop-in var(--dur-fast) var(--ease); } }
  .group { margin-bottom: var(--space-2); }
  .glabel { font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: var(--ls-label); padding: 0.15rem 0.35rem; }
  .opt { display: flex; align-items: center; gap: var(--space-2); width: 100%; text-align: left; padding: var(--space-2) var(--space-3); border-radius: var(--r-md); font-size: var(--text-sm); }
  .opt:hover { background: var(--surface-3); }
  .opt.sel { background: var(--surface-3); font-weight: var(--fw-medium); }
  .def { margin-left: auto; font-size: var(--text-2xs); color: var(--dim); }
  .tick { margin-left: auto; display: inline-grid; color: var(--accent); flex: none; }
  .def + .tick { margin-left: var(--space-1); }
</style>
