<script lang="ts">
  import { api } from './api'

  let { sessionId, mode }: { sessionId: string; mode: string } = $props()
  let open = $state(false)

  const MODES = [
    { id: 'safe', icon: '🔒', label: 'Safe', desc: 'ask before every tool' },
    { id: 'edits', icon: '✎', label: 'Edits', desc: 'auto-approve file edits' },
    { id: 'full', icon: '⚡', label: 'Full access', desc: 'no approvals (careful)' },
  ]
  const current = $derived(MODES.find((m) => m.id === (mode || 'safe')) ?? MODES[0])

  async function pick(id: string): Promise<void> {
    open = false
    await api.setMode(sessionId, id)
  }
</script>

<div class="wrap">
  <button class="pill-btn" class:full={current.id === 'full'} onclick={() => (open = !open)}>
    {current.icon} {current.label} <span class="chev">▾</span>
  </button>
  {#if open}
    <button class="scrim" onclick={() => (open = false)} aria-label="close"></button>
    <div class="menu">
      {#each MODES as m (m.id)}
        <button class="opt" class:sel={m.id === current.id} onclick={() => pick(m.id)}>
          <span class="ic">{m.icon}</span>
          <span class="txt"><span class="l">{m.label}</span><span class="d dim">{m.desc}</span></span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .pill-btn.full { color: var(--warn); border-color: var(--warn); }
  .chev { font-size: 0.6rem; opacity: 0.7; }
  .scrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 210px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 10px; padding: 0.3rem; box-shadow: 0 8px 28px rgba(0,0,0,0.5); }
  .opt { display: flex; align-items: center; gap: 0.5rem; width: 100%; text-align: left; padding: 0.4rem 0.5rem; border-radius: 7px; }
  .opt:hover { background: var(--surface-3); }
  .opt.sel { background: var(--surface-3); }
  .ic { width: 1.2rem; text-align: center; }
  .txt { display: flex; flex-direction: column; }
  .l { font-size: 0.82rem; }
  .d { font-size: 0.68rem; }
</style>
