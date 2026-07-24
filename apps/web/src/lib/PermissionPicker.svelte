<script lang="ts">
  import { api } from './api'
  import Icon from './Icon.svelte'

  let { sessionId, mode }: { sessionId: string; mode: string } = $props()
  let open = $state(false)

  const MODES = [
    { id: 'safe', icon: 'lock', label: 'Safe', desc: 'ask before every tool' },
    { id: 'edits', icon: 'pencil', label: 'Edits', desc: 'auto-approve file edits' },
    { id: 'full', icon: 'zap', label: 'Full access', desc: 'no approvals (careful)' },
  ]
  const current = $derived(MODES.find((m) => m.id === (mode || 'safe')) ?? MODES[0])

  async function pick(id: string): Promise<void> {
    open = false
    await api.setMode(sessionId, id)
  }
</script>

<div class="wrap">
  <button class="pill-btn" class:open class:full={current.id === 'full'} onclick={() => (open = !open)}>
    <span class="lead"><Icon name={current.icon} size={13} /></span> {current.label} <span class="chev"><Icon name="chevron-down" size={12} /></span>
  </button>
  {#if open}
    <button class="scrim" onclick={() => (open = false)} aria-label="close"></button>
    <div class="menu">
      {#each MODES as m (m.id)}
        <button class="opt" class:sel={m.id === current.id} onclick={() => pick(m.id)}>
          <span class="ic"><Icon name={m.icon} size={15} /></span>
          <span class="txt"><span class="l">{m.label}</span><span class="d dim">{m.desc}</span></span>
          {#if m.id === current.id}<span class="tick"><Icon name="check" size={13} /></span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .pill-btn.full { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
  .pill-btn.full .lead { color: var(--warn); }
  .lead { display: inline-grid; color: var(--muted); }
  .chev { display: inline-grid; opacity: 0.6; }
  .scrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 210px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--space-1); box-shadow: var(--shadow-3), var(--edge-hi); }
  @media (prefers-reduced-motion: no-preference) { .menu { animation: pop-in var(--dur-fast) var(--ease); } }
  .opt { display: flex; align-items: center; gap: var(--space-3); width: 100%; text-align: left; padding: var(--space-3); border-radius: var(--r-md); }
  .opt:hover { background: var(--surface-3); }
  .opt.sel { background: var(--surface-3); }
  .ic { display: inline-grid; place-items: center; width: 1.2rem; color: var(--muted); }
  .opt.sel .ic { color: var(--accent); }
  .txt { display: flex; flex-direction: column; }
  .opt.sel .l { font-weight: var(--fw-medium); }
  .l { font-size: var(--text-sm); }
  .d { font-size: var(--text-xs); }
  .tick { margin-left: auto; display: inline-grid; color: var(--accent); flex: none; }
</style>
