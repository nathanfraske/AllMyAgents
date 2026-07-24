<script lang="ts">
  import { api } from './api'
  import { store } from './store.svelte'
  import { relativeTime } from './time'
  import SpawnForm from './SpawnForm.svelte'
  import Usage from './Usage.svelte'
  import { settings } from './settings.svelte'

  let filter = $state('')
  let showSpawn = $state(false)
  let showUsage = $state(true)
  let showSettings = $state(false)

  function label(cwd: string, repo?: string, worktree?: string): string {
    const p = worktree ?? repo ?? cwd
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
    return parts[parts.length - 1] || p
  }

  const groups = $derived.by(() => {
    const q = filter.toLowerCase()
    const map = new Map<string, typeof store.sessionList>()
    for (const s of store.sessionList) {
      if (q && !(`${s.record.profileId} ${s.record.cwd} ${s.record.model ?? ''}`.toLowerCase().includes(q))) continue
      const arr = map.get(s.record.profileId) ?? []
      arr.push(s)
      map.set(s.record.profileId, arr)
    }
    return [...map.entries()]
  })

  async function act(e: MouseEvent, id: string, verb: 'interrupt' | 'stop'): Promise<void> {
    e.stopPropagation()
    if (verb === 'interrupt') await api.interrupt(id)
    else await api.stop(id)
  }
</script>

<div class="sidebar">
  <div class="brand">
    <span class="logo"></span>
    <span class="name">AiAgentApp</span>
    <span class="tag">fleet</span>
    <span class="conn" class:on={store.connected} title={store.connected ? 'connected' : 'reconnecting'}></span>
  </div>

  <div class="search">
    <input placeholder="Search sessions" bind:value={filter} />
  </div>

  <div class="sec-head">
    <span>SESSIONS</span>
    <button class="icon" title="new session" onclick={() => (showSpawn = !showSpawn)}>{showSpawn ? '×' : '+'}</button>
  </div>

  {#if showSpawn}
    <div class="spawn-panel"><SpawnForm onspawned={() => (showSpawn = false)} /></div>
  {/if}

  <div class="list scroll">
    {#each groups as [profileId, sessions] (profileId)}
      <div class="group">
        <div class="group-head">
          <span class="gdot" class:codex={sessions[0].record.provider === 'codex'}></span>
          {profileId}
          <span class="gcount dim">{sessions.length}</span>
        </div>
        {#each sessions as s (s.record.id)}
          {@const pending = store.pendingBySession[s.record.id] ?? 0}
          <div class="row" class:sel={store.selectedId === s.record.id} role="button" tabindex="0"
            onclick={() => store.select(s.record.id)}
            onkeydown={(e) => { if (e.key === 'Enter') store.select(s.record.id) }}>
            <span class="dot {s.record.status}"></span>
            <span class="rlabel">{label(s.record.cwd, s.record.repo, s.record.worktree)}</span>
            {#if pending > 0}<span class="pbadge">{pending}</span>{/if}
            <span class="rtime dim">{relativeTime(s.lastActivity)}</span>
            <span class="ractions">
              <button class="mini" title="interrupt" onclick={(e) => act(e, s.record.id, 'interrupt')}>◼</button>
              <button class="mini" title="stop" onclick={(e) => act(e, s.record.id, 'stop')}>✕</button>
            </span>
          </div>
        {/each}
      </div>
    {/each}
    {#if groups.length === 0}
      <div class="empty dim">{filter ? 'no matches' : 'no sessions — press + to spawn'}</div>
    {/if}
  </div>

  <div class="footer">
    <div class="foot-bar">
      <button class="foot-head" onclick={() => (showUsage = !showUsage)}>
        <span>USAGE</span><span class="dim">{showUsage ? '▾' : '▸'}</span>
      </button>
      <button class="gear" title="usage settings" onclick={() => (showSettings = !showSettings)}>⚙</button>
    </div>
    {#if showSettings}
      <div class="settings">
        <label class="opt"><input type="checkbox" checked={settings.showSpend} onchange={() => settings.toggleSpend()} /> show accumulated spend</label>
        <label class="opt budget">plan budget $/mo
          <input type="number" min="0" placeholder="e.g. 100" value={settings.planBudgetUsd ?? ''}
            onchange={(e) => settings.setBudget(Number((e.target as HTMLInputElement).value) || null)} />
        </label>
        <div class="hint dim">spend shows as % of plan when a budget is set</div>
      </div>
    {/if}
    {#if showUsage}<Usage />{/if}
  </div>
</div>

<style>
  .sidebar { display: flex; flex-direction: column; height: 100vh; background: var(--sidebar); border-right: 1px solid var(--border); }
  .brand { display: flex; align-items: center; gap: 0.45rem; padding: 0.7rem 0.8rem; }
  .logo { width: 14px; height: 14px; border-radius: 4px; background: linear-gradient(135deg, var(--accent), #8a6cf0); }
  .name { font-weight: 600; }
  .tag { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); border: 1px solid var(--border-strong); border-radius: 4px; padding: 0 0.25rem; }
  .conn { margin-left: auto; width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
  .conn.on { background: var(--ok); }
  .search { padding: 0 0.7rem 0.5rem; }
  .search input { width: 100%; }
  .sec-head { display: flex; align-items: center; justify-content: space-between; padding: 0.3rem 0.85rem; font-size: 0.66rem; letter-spacing: 0.08em; color: var(--dim); }
  .icon { color: var(--muted); font-size: 1rem; line-height: 1; width: 20px; height: 20px; border-radius: 5px; }
  .icon:hover { background: var(--surface-2); color: var(--text); }
  .spawn-panel { padding: 0.3rem 0.7rem 0.6rem; }
  .list { flex: 1; padding: 0 0.4rem; }
  .group { margin-bottom: 0.5rem; }
  .group-head { display: flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.45rem; font-size: 0.78rem; color: var(--muted); }
  .gdot { width: 9px; height: 9px; border-radius: 3px; background: #8a6cf0; }
  .gdot.codex { background: var(--ok); }
  .gcount { margin-left: auto; font-size: 0.7rem; }
  .row { display: flex; align-items: center; gap: 0.5rem; padding: 0.32rem 0.45rem 0.32rem 0.7rem; border-radius: 7px; cursor: pointer; }
  .row:hover { background: var(--surface); }
  .row.sel { background: var(--surface-2); }
  .rlabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rtime { font-size: 0.68rem; flex: none; }
  .pbadge { background: var(--warn); color: #111; border-radius: 999px; padding: 0 0.35rem; font-size: 0.66rem; font-weight: 600; }
  .ractions { display: none; gap: 0.15rem; }
  .row:hover .ractions { display: flex; }
  .row:hover .rtime { display: none; }
  .mini { color: var(--dim); font-size: 0.7rem; width: 18px; height: 18px; border-radius: 4px; }
  .mini:hover { background: var(--surface-3); color: var(--text); }
  .empty { padding: 1rem 0.7rem; text-align: center; font-size: 0.8rem; }
  .footer { border-top: 1px solid var(--border); padding: 0.4rem 0.7rem 0.6rem; max-height: 42vh; overflow-y: auto; }
  .foot-bar { display: flex; align-items: center; }
  .foot-head { display: flex; justify-content: space-between; flex: 1; font-size: 0.66rem; letter-spacing: 0.08em; color: var(--dim); padding: 0.2rem 0; }
  .gear { color: var(--dim); font-size: 0.85rem; padding: 0 0.3rem; }
  .gear:hover { color: var(--text); }
  .settings { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.4rem 0.1rem 0.6rem; font-size: 0.76rem; }
  .opt { display: flex; align-items: center; gap: 0.4rem; color: var(--muted); }
  .opt.budget { flex-wrap: wrap; }
  .opt.budget input { width: 5rem; margin-left: auto; }
  .hint { font-size: 0.68rem; }
</style>
