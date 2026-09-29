<script lang="ts">
  import { modelsFor, findModel, daybreakAliasProgram, daybreakPrograms, modelSupportsProgram, type Provider } from './catalog'
  import type { ProfileModelInfo, CyberAccessProgram } from './api'
  import Icon from './Icon.svelte'

  let { provider, model, availableModels, onselect, onrefresh, catalogKey = '', updatedAt, cyberAccessProgram, disabled = false }: {
    provider: Provider
    model?: string
    availableModels?: ProfileModelInfo[]
    onselect: (slug: string, program?: CyberAccessProgram) => void
    onrefresh?: () => Promise<void>
    catalogKey?: string
    updatedAt?: string
    cyberAccessProgram?: CyberAccessProgram
    disabled?: boolean
  } = $props()

  let open = $state(false)
  let filter = $state('')
  let refreshing = $state(false)
  let error = $state('')
  let now = $state(Date.now())
  $effect(() => { catalogKey; refreshing = false; error = ''; filter = '' })
  $effect(() => {
    if (!open) return
    now = Date.now()
    const timer = setInterval(() => { now = Date.now() }, 60_000)
    return () => clearInterval(timer)
  })
  async function refresh(): Promise<void> {
    if (!onrefresh || refreshing) return
    const key = catalogKey
    refreshing = true
    error = ''
    try { await onrefresh() }
    catch (e) { if (key === catalogKey) error = e instanceof Error ? e.message : 'Model refresh failed' }
    finally { if (key === catalogKey) { refreshing = false; now = Date.now() } }
  }

  const catalog = $derived(modelsFor(provider, availableModels, now))
  const programs = $derived(daybreakPrograms(provider, availableModels))
  const program = $derived(cyberAccessProgram ?? daybreakAliasProgram(model) ?? 'standard')
  const daybreak = $derived(provider === 'codex' && program !== 'standard')
  const ordinary = $derived(catalog.filter(m => !daybreakAliasProgram(m.slug)))
  const defaultAlias = $derived(catalog.find(m => daybreakAliasProgram(m.slug) === program))
  const models = $derived(daybreak
    ? [...(defaultAlias ? [{ ...defaultAlias, name: 'Default', isDefault: false }] : []), ...ordinary]
    : ordinary)
  // Refresh may remove a preview model from the offered catalog. Keep the actual selection visible;
  // displaying the new default here would imply the running conversation had switched models.
  const current = $derived(model
    ? findModel(model, availableModels, provider) ?? { slug: model, name: model, shortName: model }
    : models.find((m) => m.isDefault) ?? models[0])
  const shown = $derived(
    filter ? models.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase())) : models
  )

  function supports(slug: string, value: CyberAccessProgram): boolean {
    return availableModels ? modelSupportsProgram(availableModels.find(m => m.slug === slug), value) : value === 'standard'
  }

  function pick(slug: string): void {
    if (disabled || (daybreak && !programs.includes(program)) || (provider === 'codex' && !supports(slug, program))) return
    onselect(slug, provider === 'codex' ? program : undefined)
    open = false
    filter = ''
  }

  function toggleDaybreak(): void {
    if (disabled) return
    if (daybreak) {
      const choices = ordinary.filter(m => supports(m.slug, 'standard'))
      const standard = choices.find(m => m.slug === model) ?? choices.find(m => m.isDefault) ?? choices[0]
      onselect(standard?.slug ?? '', 'standard')
    } else {
      const next = programs.includes('daybreakBlue') ? 'daybreakBlue' : programs[0]
      if (!next) return
      const selected = ordinary.find(m => m.slug === model && supports(m.slug, next)) ??
        catalog.find(m => daybreakAliasProgram(m.slug) === next && supports(m.slug, next)) ?? ordinary.find(m => supports(m.slug, next))
      if (selected) onselect(selected.slug, next)
    }
  }

  function changeProgram(next: CyberAccessProgram): void {
    if (disabled) return
    const selected = ordinary.find(m => m.slug === model && supports(m.slug, next)) ??
      catalog.find(m => daybreakAliasProgram(m.slug) === next && supports(m.slug, next)) ?? ordinary.find(m => supports(m.slug, next))
    if (selected && programs.includes(next)) onselect(selected.slug, next)
  }
</script>

<div class="wrap">
  <button class="pill-btn" class:open onclick={() => (open = !open)} title={`Model: ${current?.name ?? 'model'}`}>
    <span class="glyph" class:codex={provider === 'codex'}></span>
    <span class="pill-label">{current?.shortName ?? current?.name ?? 'model'}</span>
    {#if daybreak}<span class="badge daybreak-badge">Daybreak</span>{/if}
    <span class="chev"><Icon name="chevron-down" size={12} /></span>
  </button>
  {#if open}
    <button class="scrim" onclick={() => (open = false)} aria-label="close"></button>
    <div class="menu">
      {#if programs.length || daybreak}
        <button class="daybreak-toggle" role="switch" aria-label="Daybreak" aria-checked={daybreak}
          disabled={disabled || (!daybreak && !programs.length)} onclick={toggleDaybreak}>
          <span>Daybreak</span><span class="switch-track" class:enabled={daybreak}><span></span></span>
        </button>
        {#if daybreak}
          <p class="daybreak-note dim">{availableModels?.some(m => m.cyberAccessPrograms === undefined)
            ? 'Older catalog: Codex verifies Daybreak compatibility when the turn starts.'
            : 'Choose a model enabled for Daybreak on this account.'}</p>
          {#if !programs.includes(program)}<p class="refresh-error" role="alert">Daybreak is no longer advertised by this account. Refresh models or turn it off.</p>{/if}
          {#if programs.includes(program) && model && !supports(model, program)}<p class="refresh-error" role="alert">The selected model is not available with this Daybreak program. Choose an enabled model or turn it off.</p>{/if}
          {#if programs.length > 1}
            <label class="program">Program <select value={program} {disabled} onchange={e => changeProgram(e.currentTarget.value as CyberAccessProgram)}>
              {#each programs as value}<option {value}>{value === 'daybreakBlue' ? 'Blue' : 'Red'}</option>{/each}
            </select></label>
          {/if}
        {/if}
      {/if}
      {#if onrefresh}
        <div class="refresh-row">
          <button onclick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh models'}</button>
          <span class="dim" title={updatedAt ? `Last discovery: ${new Date(updatedAt).toLocaleString()}` : 'No live discovery yet'}>{updatedAt ? 'Account catalog' : 'Fallback catalog'}</span>
        </div>
      {/if}
      {#if error}<p class="refresh-error" role="alert">{error}</p>{/if}
      {#if !models.length}<p class="dim">No models advertised by this account.</p>{/if}
      {#if models.length > 5}
        <input class="search" placeholder="Search models" bind:value={filter} />
      {/if}
      {#each shown as m (m.slug)}
        <button class="row" disabled={disabled || (daybreak && !programs.includes(program)) || (provider === 'codex' && !supports(m.slug, program))}
          title={provider === 'codex' && !supports(m.slug, program) ? 'Not available with this access program on this account' : undefined}
          class:sel={m.slug === current?.slug} onclick={() => pick(m.slug)}>
          <span class="name">{m.name}</span>
          {#if daybreakAliasProgram(m.slug)}<span class="dim">Recommended</span>{/if}
          {#if m.isNew}<span class="badge new" title={`Released ${m.releasedAt?.slice(0, 10)} · New for 90 days`}>New</span>{/if}
          {#if m.isDefault}<span class="badge def">Default</span>{/if}
          {#if m.slug === current?.slug}<span class="tick"><Icon name="check" size={13} /></span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; min-width: 0; }
  .daybreak-toggle { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: var(--space-2) var(--space-3); border-radius: var(--r-md); background: var(--surface-3); }
  .switch-track { width: 28px; height: 16px; padding: 2px; border-radius: 12px; background: var(--dim); }
  .switch-track span { display: block; width: 12px; height: 12px; border-radius: 50%; background: var(--text); }
  .switch-track.enabled { background: var(--accent); }
  .switch-track.enabled span { margin-left: 12px; }
  .daybreak-badge { color: var(--accent); }
  .daybreak-note { max-width: 270px; font-size: var(--text-xs); padding: 6px; }
  .program { display: flex; align-items: center; gap: 10px; padding: 6px; font-size: var(--text-xs); }
  .refresh-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px; font-size: var(--text-xs); }
  .refresh-error { color: var(--warn); max-width: 320px; font-size: var(--text-xs); padding: 6px; }
  .menu { max-height: min(65vh, 480px); overflow-y: auto; overscroll-behavior: contain; }
  .pill-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .glyph { width: 9px; height: 9px; border-radius: var(--r-xs); background: var(--secondary); }
  .glyph.codex { background: var(--ok); }
  .chev { display: inline-grid; opacity: 0.6; }
  .scrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 220px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--space-1); box-shadow: var(--shadow-3), var(--edge-hi); }
  @media (prefers-reduced-motion: no-preference) { .menu { animation: pop-in var(--dur-fast) var(--ease); } }
  .search { width: 100%; margin-bottom: var(--space-1); }
  .row { display: flex; align-items: center; gap: var(--space-2); width: 100%; text-align: left; padding: var(--space-2) var(--space-3); border-radius: var(--r-md); font-size: var(--text-sm); }
  .row:hover:not(:disabled) { background: var(--surface-3); }
  .row:disabled { opacity: 0.45; cursor: not-allowed; }
  .row.sel { background: var(--surface-3); }
  .row.sel .name { font-weight: var(--fw-medium); }
  .name { flex: 1; }
  .tick { display: inline-grid; color: var(--accent); flex: none; }
  .badge { font-size: var(--text-2xs); border-radius: var(--r-xs); padding: 0 0.3rem; line-height: 1.5; }
  .badge.new { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
  .badge.def { color: var(--dim); border: 1px solid var(--border-strong); }
</style>
