<script lang="ts">
  import { descriptorLabel, type OptionDescriptor } from './catalog'

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
    <button class="pill-btn" onclick={() => (open = !open)}>⚡ {label} <span class="chev">▾</span></button>
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
                </button>
              {/each}
            {:else}
              <button class="opt" class:sel={current(d) !== 'true'} onclick={() => { onchange(d.id, 'false'); open = false }}>Off</button>
              <button class="opt" class:sel={current(d) === 'true'} onclick={() => { onchange(d.id, 'true'); open = false }}>On</button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .wrap { position: relative; }
  .chev { font-size: 0.6rem; opacity: 0.7; }
  .scrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 170px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 10px; padding: 0.35rem; box-shadow: 0 8px 28px rgba(0,0,0,0.5); }
  .group { margin-bottom: 0.35rem; }
  .glabel { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.15rem 0.35rem; }
  .opt { display: flex; align-items: center; gap: 0.4rem; width: 100%; text-align: left; padding: 0.3rem 0.5rem; border-radius: 6px; font-size: 0.8rem; }
  .opt:hover { background: var(--surface-3); }
  .opt.sel { background: var(--surface-3); color: var(--accent); }
  .def { margin-left: auto; font-size: 0.6rem; color: var(--dim); }
</style>
