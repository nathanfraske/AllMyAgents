<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type ImportableChat, type ScanResult } from './api'
  import { store } from './store.svelte'
  import { relativeTime } from './time'
  import ProviderLogo from './ProviderLogo.svelte'
  import Icon from './Icon.svelte'

  // Adopt existing Claude Code / Codex conversations that already live for a project's folder —
  // across the AllMyAgents-managed profiles AND the user's default vendor homes (~/.claude, ~/.codex).
  // Scans on mount (read-only preview; may be handed a preloaded scan from the auto-prompt), lets the
  // user pick, then imports the selected ones — they arrive in the sidebar under the project over the
  // WS, auto-named. Also surfaces (read-only) the folder's MCP / hooks / memory config.
  let { projectId, path, preloaded, onClose }: { projectId: string; path: string; preloaded?: ScanResult; onClose: () => void } = $props()

  let scanning = $state(true)
  let result = $state<ScanResult | null>(null)
  let error = $state('')
  let selected = $state(new Set<string>())
  let importing = $state(false)
  let done = $state<{ imported: number; skipped: number } | null>(null)

  const importable = $derived((result?.chats ?? []).filter((c) => !c.alreadyImported))
  const foundProfiles = $derived(result ? Object.keys(result.byProfile) : [])
  const selectedCount = $derived([...selected].filter((id) => importable.some((c) => c.vendorSessionId === id)).length)
  const cfg = $derived(result?.config)
  const hasConfig = $derived(!!cfg && (cfg.mcpServers.length > 0 || cfg.hooks.length > 0 || cfg.memoryFiles.length > 0))

  function applyResult(r: ScanResult): void {
    scanning = false
    result = r
    selected = new Set(r.chats.filter((c) => !c.alreadyImported).map((c) => c.vendorSessionId))
  }

  onMount(async () => {
    if (preloaded) {
      applyResult(preloaded)
      return
    }
    const out = await api.scanProject(path)
    if (!out || 'error' in out) {
      scanning = false
      error = (out as { error?: string } | null)?.error ?? 'scan failed'
      return
    }
    applyResult(out)
  })

  function toggle(id: string): void {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selected = next
  }

  function meta(c: ImportableChat): string {
    const bits = [c.profileId, `${c.messageCount} msg${c.messageCount === 1 ? '' : 's'}`]
    if (c.model) bits.push(c.model)
    return bits.join(' · ')
  }

  async function doImport(): Promise<void> {
    if (!selectedCount) return
    importing = true
    const ids = [...selected].filter((id) => importable.some((c) => c.vendorSessionId === id))
    const res = await store.importChats(projectId, ids)
    importing = false
    done = res
    setTimeout(onClose, 1100) // let the "Imported N" confirmation show briefly, then close
  }
</script>

<div class="import">
  <div class="ihead">
    <span class="ititle"><Icon name="download" size={13} /> Import existing chats</span>
    <button class="iclose" title="close" onclick={onClose}><Icon name="x" size={14} /></button>
  </div>

  {#if scanning}
    <div class="imsg dim scanning">Scanning every Claude &amp; Codex account for this folder — this can take a few seconds…</div>
  {:else if error}
    <div class="imsg err">{error}</div>
  {:else if done}
    <div class="imsg ok">Imported {done.imported} chat{done.imported === 1 ? '' : 's'}{done.skipped ? ` · ${done.skipped} skipped` : ''}.</div>
  {:else if result}
    {#if importable.length === 0}
      <div class="imsg dim">No new chats found for this folder{result.chats.length ? ' (all already imported)' : ''}.</div>
    {:else}
      <div class="isum">Found <b>{importable.length}</b> chat{importable.length === 1 ? '' : 's'} across {foundProfiles.join(', ')}</div>
      <div class="ilist scroll">
        {#each result.chats as c (c.transcriptPath)}
          {@const disabled = c.alreadyImported}
          <label class="ichat" class:disabled>
            <input type="checkbox" checked={disabled || selected.has(c.vendorSessionId)} {disabled} onchange={() => toggle(c.vendorSessionId)} />
            <ProviderLogo provider={c.provider} size={13} />
            <span class="iname" title={c.firstPrompt ?? c.title}>{c.title}</span>
            {#if disabled}<span class="itag">imported</span>{/if}
            <span class="imeta dim">{meta(c)}</span>
            <span class="itime dim">{relativeTime(c.lastActivity)}</span>
          </label>
        {/each}
      </div>
      {#if result.warnings.length}<div class="iwarn dim">{result.warnings.length} file(s) skipped while scanning</div>{/if}
    {/if}

    {#if hasConfig && cfg}
      <!-- Read-only: what config lives in this folder. Adopting it (MCP wiring / hook runner) is a
           documented follow-up — surfaced here so the user knows it was detected. -->
      <div class="icfg">
        <div class="icfg-h dim">Project config detected</div>
        {#each cfg.mcpServers as m (m.name)}
          <div class="icfg-row"><Icon name="zap" size={11} /><span class="cname">{m.name}</span><span class="dim">{m.transport}{m.hasSecrets ? ' · has secrets' : ''}</span></div>
        {/each}
        {#if cfg.hooks.length}<div class="icfg-row"><Icon name="lock" size={11} /><span class="cname">{cfg.hooks.length} hook{cfg.hooks.length === 1 ? '' : 's'}</span><span class="dim">{cfg.hooks.join(', ')}</span></div>{/if}
        {#each cfg.memoryFiles as f (f.name)}
          <div class="icfg-row"><Icon name="square-pen" size={11} /><span class="cname">{f.name}</span><span class="dim">{Math.max(1, Math.round(f.bytes / 1024))} KB</span></div>
        {/each}
        <div class="icfg-note dim">MCP wiring &amp; hooks are surfaced but not yet auto-adopted.</div>
      </div>
    {/if}

    <div class="ifoot">
      <button class="link" title="never prompt for this project again" onclick={() => store.dismissImport(projectId)}>Don't ask again</button>
      <span class="spacer"></span>
      <button class="skip" onclick={onClose}>Skip</button>
      {#if importable.length > 0}
        <button class="imp" disabled={!selectedCount || importing} onclick={doImport}>
          {importing ? 'Importing…' : `Import ${selectedCount}`}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .import { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-2) var(--space-4) var(--space-3); border-bottom: 1px solid var(--border-subtle); }
  .ihead { display: flex; align-items: center; justify-content: space-between; }
  .ititle { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); font-weight: var(--fw-medium); color: var(--muted); text-transform: uppercase; letter-spacing: var(--ls-label); }
  .iclose { display: grid; place-items: center; width: 20px; height: 20px; border-radius: var(--r-xs); color: var(--dim); }
  .iclose:hover { background: var(--surface-2); color: var(--text); }
  .imsg { font-size: var(--text-sm); padding: var(--space-2) 0; }
  .imsg.err { color: var(--bad-text); }
  .imsg.ok { color: var(--ok); }
  @media (prefers-reduced-motion: no-preference) {
    .scanning { animation: iscan 1.4s ease-in-out infinite; }
    @keyframes iscan { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
  }
  .isum { font-size: var(--text-sm); color: var(--text); }
  .ilist { display: flex; flex-direction: column; gap: 1px; max-height: 34vh; overflow-y: auto; }
  .ichat { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-2); border-radius: var(--r-sm); cursor: pointer; font-size: var(--text-sm); }
  .ichat:hover { background: var(--surface-2); }
  .ichat.disabled { opacity: 0.5; cursor: default; }
  .ichat input { flex: none; accent-color: var(--accent); }
  .iname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .itag { flex: none; font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: var(--ls-label); color: var(--dim); border: 1px solid var(--border-strong); border-radius: var(--r-xs); padding: 0 0.3rem; }
  .imeta { flex: none; font-size: var(--text-2xs); max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .itime { flex: none; font-size: var(--text-2xs); }
  .iwarn { font-size: var(--text-2xs); }
  .icfg { display: flex; flex-direction: column; gap: 2px; padding: var(--space-2); background: var(--surface); border: 1px solid var(--border-subtle); border-radius: var(--r-sm); }
  .icfg-h { font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: var(--ls-label); }
  .icfg-row { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); }
  .icfg-row .cname { font-weight: var(--fw-medium); }
  .icfg-note { font-size: var(--text-2xs); padding-top: 2px; }
  .ifoot { display: flex; align-items: center; gap: var(--space-2); padding-top: var(--space-1); }
  .spacer { flex: 1; }
  .link { color: var(--dim); font-size: var(--text-xs); }
  .link:hover { color: var(--muted); text-decoration: underline; }
  .skip { color: var(--muted); border: 1px solid var(--border-strong); border-radius: var(--r-md); padding: var(--space-1) var(--space-3); font-size: var(--text-sm); }
  .skip:hover { color: var(--text); border-color: var(--border-accent); }
  .imp { background: var(--accent); color: #fff; border-radius: var(--r-md); padding: var(--space-1) var(--space-3); font-weight: var(--fw-medium); font-size: var(--text-sm); box-shadow: var(--edge-hi), var(--shadow-1); }
  .imp:hover:not(:disabled) { filter: brightness(1.08); }
  .imp:disabled { opacity: 0.5; cursor: default; box-shadow: none; }
</style>
