<script lang="ts">
  import { api } from './api'
  import Icon from './Icon.svelte'

  // `allowedTools` are the per-chat "always allow" grants made from an approval prompt. They are listed
  // here because this is where the approval prompt's tooltip says to undo them — a promise that was made
  // before the list existed, so the grants were effectively permanent and invisible.
  let { sessionId, mode, allowedTools = [] }: { sessionId: string; mode: string; allowedTools?: string[] } =
    $props()
  let open = $state(false)
  let revokeError = $state<string | null>(null)

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

  /** Revoke an "always allow" grant so the tool prompts again. Surfaces failure instead of silently
   *  leaving the operator believing a permission was withdrawn when it was not. */
  async function revoke(toolName: string): Promise<void> {
    revokeError = null
    const res = (await api.allowTool(sessionId, toolName, false)) as { error?: string }
    if (res?.error) revokeError = `could not revoke ${toolName}: ${res.error}`
  }
</script>

<div class="wrap">
  <button class="pill-btn" class:open class:full={current.id === 'full'} onclick={() => (open = !open)} title={`Permission mode: ${current.label}`}>
    <span class="lead"><Icon name={current.icon} size={13} /></span><span class="pill-label">{current.label}</span><span class="chev"><Icon name="chevron-down" size={12} /></span>
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
      {#if allowedTools.length}
        <div class="sep"></div>
        <div class="grouphead dim">Always allowed in this chat</div>
        {#each allowedTools as t (t)}
          <div class="grant">
            <span class="gname">{t}</span>
            <button class="revoke" title={`Ask again before using ${t}`} onclick={() => revoke(t)}>Revoke</button>
          </div>
        {/each}
        {#if revokeError}<div class="gerr">{revokeError}</div>{/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; min-width: 0; }
  .pill-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .sep { height: 1px; background: var(--border); margin: var(--space-2) var(--space-1); }
  .grouphead { font-size: var(--text-xs); padding: 0 var(--space-3) var(--space-1); }
  .grant { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3); }
  .gname { font-size: var(--text-xs); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .revoke { margin-left: auto; font-size: var(--text-xs); color: var(--muted); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 0 var(--space-2); flex: none; }
  .revoke:hover { color: var(--bad-text); border-color: var(--bad); }
  .gerr { font-size: var(--text-xs); color: var(--bad-text); padding: var(--space-1) var(--space-3); }
</style>
