<script lang="ts">
  import { api } from './api'
  import Icon from './Icon.svelte'

  // `allowedTools` are the per-chat "always allow" grants made from an approval prompt. They are listed
  // here because this is where the approval prompt's tooltip says to undo them — a promise that was made
  // before the list existed, so the grants were effectively permanent and invisible.
  type PermissionMode = 'safe' | 'edits' | 'full'
  type ManagedScope = 'manager' | 'child'
  let {
    sessionId,
    mode,
    allowedTools = [],
    ceiling,
    managedScope,
    managedBy,
    operatorOverrideActive = false,
    operatorOverrideCeiling,
    onchange,
  }: {
    sessionId: string
    mode: string
    allowedTools?: string[]
    ceiling?: PermissionMode
    managedScope?: ManagedScope
    managedBy?: string
    operatorOverrideActive?: boolean
    operatorOverrideCeiling?: PermissionMode
    onchange?: (mode: PermissionMode, operatorOverride: boolean) => void
  } = $props()
  let open = $state(false)
  let revokeError = $state<string | null>(null)
  let modeError = $state<string | null>(null)

  const MODES = [
    { id: 'safe', icon: 'lock', label: 'Safe', desc: 'ask before every tool' },
    { id: 'edits', icon: 'pencil', label: 'Edits', desc: 'auto-approve file edits' },
    { id: 'full', icon: 'zap', label: 'Full access', desc: 'ordinary tools auto-approved · host access (OS elevation still applies)' },
  ]
  const current = $derived(MODES.find((m) => m.id === (mode || 'safe')) ?? MODES[0])
  const ranks: Record<PermissionMode, number> = { safe: 0, edits: 1, full: 2 }
  const currentOverride = $derived(
    operatorOverrideActive ||
      (!!ceiling && ranks[(current.id as PermissionMode)] > ranks[ceiling]),
  )

  function exceedsCeiling(id: string): boolean {
    return !!ceiling && ranks[id as PermissionMode] > ranks[ceiling]
  }

  const boundaryExplanation = $derived.by(() => {
    if (!ceiling || !managedScope) return ''
    const owner = managedBy ? ` ${managedBy}` : ''
    if (managedScope === 'manager') {
      return `This manager's reusable operator grant is capped at ${ceiling}. Higher modes below are explicit one-chat operator overrides and do not widen child defaults.`
    }
    if (operatorOverrideCeiling && ranks[operatorOverrideCeiling] > ranks[ceiling]) {
      return `${owner || 'The parent manager'} normally may set this child up to ${ceiling}. The operator explicitly extended this child to ${operatorOverrideCeiling}, so its manager may adjust this child within that per-chat ceiling; sibling grants are unchanged.`
    }
    return `${owner || 'The parent manager'} may set this child up to ${ceiling}. Higher modes below require an explicit one-chat operator override.`
  })

  async function pick(id: PermissionMode): Promise<void> {
    modeError = null
    const operatorOverride = exceedsCeiling(id)
    const out = (await api.setMode(sessionId, id, operatorOverride)) as { error?: string }
    if (out?.error) {
      modeError = out.error
      return
    }
    onchange?.(id, operatorOverride)
    open = false
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
  <button class="pill-btn" class:open class:full={current.id === 'full'} onclick={() => (open = !open)} title={`Permission mode: ${current.label}${currentOverride ? ' · operator override' : ''}`}>
    <span class="lead"><Icon name={current.icon} size={13} /></span><span class="pill-label">{current.label}</span>{#if currentOverride}<span class="override-mark" title="Explicit operator override">operator</span>{/if}<span class="chev"><Icon name="chevron-down" size={12} /></span>
  </button>
  {#if open}
    <button class="scrim" onclick={() => (open = false)} aria-label="close"></button>
    <div class="menu">
      {#if boundaryExplanation}<div class="boundary-note">{boundaryExplanation}</div>{/if}
      {#each MODES as m (m.id)}
        {@const override = exceedsCeiling(m.id)}
        <button
          class="opt"
          class:sel={m.id === current.id}
          class:override
          aria-label={override ? `Override permission to ${m.label} as operator` : `Set permission to ${m.label}`}
          onclick={() => pick(m.id as PermissionMode)}
        >
          <span class="ic"><Icon name={m.icon} size={15} /></span>
          <span class="txt"><span class="l">{m.label}</span><span class="d dim">{override ? `operator override · ${m.desc}` : m.desc}</span></span>
          {#if m.id === current.id}<span class="tick"><Icon name="check" size={13} /></span>{/if}
        </button>
      {/each}
      {#if modeError}<div class="gerr" role="alert">Permission change failed: {modeError}</div>{/if}
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
  .override-mark { flex: none; padding: 0 .3rem; border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
    border-radius: var(--r-pill); color: var(--warn); font-size: .58rem; line-height: 1.45; text-transform: uppercase; }
  .lead { display: inline-grid; color: var(--muted); }
  .chev { display: inline-grid; opacity: 0.6; }
  .scrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 210px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--space-1); box-shadow: var(--shadow-3), var(--edge-hi); }
  .boundary-note { max-width: 280px; padding: var(--space-2) var(--space-3); color: var(--muted);
    font-size: var(--text-xs); line-height: 1.4; border-bottom: 1px solid var(--border); }
  @media (prefers-reduced-motion: no-preference) { .menu { animation: pop-in var(--dur-fast) var(--ease); } }
  .opt { display: flex; align-items: center; gap: var(--space-3); width: 100%; text-align: left; padding: var(--space-3); border-radius: var(--r-md); }
  .opt:hover { background: var(--surface-3); }
  .opt.sel { background: var(--surface-3); }
  .opt.override .ic, .opt.override .d { color: var(--warn); }
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
