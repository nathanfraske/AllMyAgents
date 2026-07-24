<script lang="ts">
  import { api } from './api'
  import { store, type SessionView } from './store.svelte'
  import { relativeTime } from './time'
  import Usage from './Usage.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import Icon from './Icon.svelte'

  let filter = $state('')
  let showCreate = $state(false)
  let newName = $state('')
  let newPath = $state('')
  let createErr = $state('')
  let showUsage = $state(true)
  let collapsed = $state(new Set<string>())

  function toggleCollapse(id: string): void {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    collapsed = next
  }

  interface Summary {
    providers: ('claude' | 'codex')[]
    done: number
    review: number
    stalled: number
    working: number
  }

  function summarize(sessions: SessionView[]): Summary {
    const providers = new Set<'claude' | 'codex'>()
    let done = 0
    let review = 0
    let stalled = 0
    let working = 0
    for (const s of sessions) {
      providers.add(s.record.provider)
      const k = store.status(s).key
      if (k === 'completed') done++
      else if (k === 'approval' || k === 'question') review++
      else if (k === 'error') stalled++
      else if (k === 'working' || k === 'starting') working++
    }
    return { providers: [...providers], done, review, stalled, working }
  }

  async function browse(): Promise<void> {
    const { path } = await api.pickFolder()
    if (path) {
      newPath = path
      // inherit the project name from the chosen folder
      newName = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    }
  }

  function label(s: SessionView): string {
    const p = s.record.worktree ?? s.record.repo ?? s.record.cwd
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
  }

  interface Group {
    id: string
    name: string
    sessions: SessionView[]
  }

  const groups = $derived.by(() => {
    const q = filter.toLowerCase()
    const match = (s: SessionView): boolean =>
      !q || `${s.record.profileId} ${s.record.cwd} ${s.record.model ?? ''}`.toLowerCase().includes(q)
    const byProject = new Map<string, SessionView[]>()
    for (const s of store.sessionList) {
      if (!match(s)) continue
      const key = s.record.projectId ?? '__none__'
      const arr = byProject.get(key) ?? []
      arr.push(s)
      byProject.set(key, arr)
    }
    const out: Group[] = []
    for (const p of store.projects) {
      const ss = byProject.get(p.id) ?? []
      if (ss.length || !filter) out.push({ id: p.id, name: p.name, sessions: ss })
    }
    const none = byProject.get('__none__')
    if (none?.length) out.push({ id: '__none__', name: 'Unfiled', sessions: none })
    return out
  })


  async function createProject(): Promise<void> {
    createErr = ''
    const out = await api.createProject(newName, newPath)
    if ('error' in out) {
      createErr = out.error
      return
    }
    newName = ''
    newPath = ''
    showCreate = false
    await store.refreshProjects()
  }

  async function act(e: MouseEvent, id: string, verb: 'interrupt' | 'stop'): Promise<void> {
    e.stopPropagation()
    if (verb === 'interrupt') await api.interrupt(id)
    else await api.stop(id)
  }

  async function del(e: MouseEvent, id: string, name: string): Promise<void> {
    e.stopPropagation()
    if (!confirm(`Delete "${name}"? This ends the session and removes the chat from the hub.`)) return
    await store.deleteSession(id)
  }
</script>

<div class="sidebar">
  <div class="brand">
    <button class="brandbtn" title="home / dashboard" onclick={() => store.goHome()}>
      <span class="logo"></span>
      <span class="name">AllMyAgents</span>
    </button>
    <span class="tag">fleet</span>
    <span class="conn" class:on={store.connected} title={store.connected ? 'connected' : 'reconnecting'}></span>
  </div>

  <div class="search"><span class="sicon"><Icon name="search" size={13} /></span><input placeholder="Search sessions" bind:value={filter} /></div>

  <div class="sec-head">
    <span>PROJECTS</span>
    <span class="sec-actions">
      <button class="icon" class:on={showCreate} title="new project" onclick={() => (showCreate = !showCreate)}><Icon name="folder-plus" size={15} /></button>
      <button class="icon" title="new chat" onclick={() => store.newSession()}><Icon name="square-pen" size={15} /></button>
    </span>
  </div>

  {#if showCreate}
    <div class="panel">
      <input placeholder="project name" bind:value={newName} />
      <div class="path-row">
        <input placeholder="folder path" bind:value={newPath} />
        <button class="browse" title="browse folders" onclick={browse}><Icon name="folder" size={14} /></button>
      </div>
      <button class="mkbtn" onclick={createProject}>create project</button>
      {#if createErr}<div class="err">{createErr}</div>{/if}
    </div>
  {/if}

  <div class="list scroll">
    {#each groups as g (g.id)}
      {@const isCollapsed = collapsed.has(g.id)}
      <div class="group">
        <div class="group-head">
          <button class="folder" title={isCollapsed ? 'expand' : 'collapse'} onclick={() => toggleCollapse(g.id)}><Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} /></button>
          <span class="gname">{g.name}</span>
          <span class="gcount dim tnum">{g.sessions.length}</span>
          {#if g.id !== '__none__'}
            <button class="gadd" title="new chat here" onclick={() => store.newSession(undefined, g.id)}><Icon name="plus" size={14} /></button>
          {/if}
        </div>
        {#if isCollapsed && g.sessions.length}
          {@const sum = summarize(g.sessions)}
          <div class="summary" role="button" tabindex="0" onclick={() => toggleCollapse(g.id)} onkeydown={(e) => { if (e.key === 'Enter') toggleCollapse(g.id) }}>
            <span class="logos">{#each sum.providers as pv (pv)}<ProviderLogo provider={pv} size={12} />{/each}</span>
            {#if sum.working}<span class="sc working" title="working"><Icon name="play" size={10} /><span class="tnum">{sum.working}</span></span>{/if}
            {#if sum.review}<span class="sc review" title="ready for review"><Icon name="flag" size={10} /><span class="tnum">{sum.review}</span></span>{/if}
            {#if sum.done}<span class="sc done" title="completed"><Icon name="check" size={11} /><span class="tnum">{sum.done}</span></span>{/if}
            {#if sum.stalled}<span class="sc stalled" title="stalled / error"><Icon name="x" size={11} /><span class="tnum">{sum.stalled}</span></span>{/if}
          </div>
        {/if}
        {#if !isCollapsed}
        {#each g.sessions as s (s.record.id)}
          {@const st = store.status(s)}
          {@const pending = store.pendingBySession[s.record.id] ?? 0}
          <div class="row" class:sel={store.selectedId === s.record.id} role="button" tabindex="0"
            draggable="true"
            ondragstart={(e) => { store.dragSession = s.record.id; e.dataTransfer?.setData('text/plain', s.record.id) }}
            ondragend={() => store.endDragSession()}
            onclick={() => store.select(s.record.id)}
            onkeydown={(e) => { if (e.key === 'Enter') store.select(s.record.id) }}>
            <span class="dot {st.key}" title={st.label}></span>
            <ProviderLogo provider={s.record.provider} size={13} />
            <span class="rlabel">{label(s)}</span>
            {#if pending > 0}<span class="pbadge tnum">{pending}</span>{/if}
            <span class="rtime dim tnum">{relativeTime(s.lastActivity)}</span>
            <span class="ractions">
              <button class="mini" title="interrupt" onclick={(e) => act(e, s.record.id, 'interrupt')}><Icon name="square" size={12} /></button>
              <button class="mini" title="stop" onclick={(e) => act(e, s.record.id, 'stop')}><Icon name="x" size={13} /></button>
              <button class="mini del" title="delete chat" onclick={(e) => del(e, s.record.id, label(s))}><Icon name="trash" size={12} /></button>
            </span>
          </div>
        {/each}
        {/if}
      </div>
    {/each}
    {#if groups.length === 0}
      <div class="empty dim">{filter ? 'no matches' : 'create a project (⊞) or start a session (+)'}</div>
    {/if}
  </div>

  <div class="footer">
    <div class="foot-bar">
      <button class="foot-head" onclick={() => (showUsage = !showUsage)}><span>USAGE</span><span class="dim fchev"><Icon name={showUsage ? 'chevron-down' : 'chevron-right'} size={13} /></span></button>
      <button class="gear" title="settings" onclick={() => (store.settingsOpen = true)}><Icon name="settings" size={15} /></button>
    </div>
    {#if showUsage}<Usage />{/if}
  </div>
</div>

<style>
  .sidebar { display: flex; flex-direction: column; height: 100vh; background: var(--sidebar); border-right: 1px solid var(--border); }
  .brand { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3); }
  .brandbtn { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-2); border-radius: var(--r-sm); }
  .brandbtn:hover { background: var(--surface); }
  .logo { width: 16px; height: 16px; border-radius: var(--r-sm); background: linear-gradient(135deg, var(--accent), var(--cyan));
    box-shadow: 0 0 12px -2px color-mix(in srgb, var(--accent) 60%, transparent); }
  .name { font-weight: var(--fw-semibold); }
  .tag { font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: var(--ls-label); color: var(--dim); border: 1px solid var(--border-strong); border-radius: var(--r-xs); padding: 0 0.3rem; }
  .conn { margin-left: auto; width: 8px; height: 8px; border-radius: 50%; background: var(--bad); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08); }
  .conn.on { background: var(--ok); }
  .search { position: relative; padding: 0 var(--space-4) var(--space-3); }
  .sicon { position: absolute; left: 1.15rem; top: calc(50% - 0.25rem); transform: translateY(-50%); color: var(--dim); display: grid; }
  .search input { width: 100%; padding-left: 1.9rem; }
  .sec-head { display: flex; align-items: center; justify-content: space-between; padding: var(--space-2) var(--space-5); font-size: var(--text-2xs); letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--dim); }
  .sec-actions { display: flex; gap: 0.15rem; }
  .icon { display: grid; place-items: center; color: var(--muted); width: 26px; height: 24px; border-radius: var(--r-sm); transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .icon:hover { background: var(--surface-2); color: var(--text); }
  .icon.on { background: var(--surface-3); color: var(--accent); }
  .panel { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-2) var(--space-4) var(--space-3); }
  .panel input { width: 100%; }
  .path-row { display: flex; gap: var(--space-2); }
  .path-row input { flex: 1; }
  .browse { flex: none; display: grid; place-items: center; border: 1px solid var(--border-strong); border-radius: var(--r-md); padding: 0 0.5rem; color: var(--muted); }
  .browse:hover { border-color: var(--border-accent); color: var(--text); }
  .mkbtn { background: var(--accent); color: #fff; border-radius: var(--r-md); padding: var(--space-2); font-weight: var(--fw-medium); box-shadow: var(--edge-hi), var(--shadow-1); }
  .mkbtn:hover { filter: brightness(1.08); }
  .err { color: var(--bad-text); font-size: var(--text-xs); }
  .list { flex: 1; padding: 0 var(--space-2); }
  .group { margin-bottom: var(--space-2); }
  .group-head { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); font-size: var(--text-sm); color: var(--muted); }
  .folder { display: grid; place-items: center; color: var(--dim); width: 16px; height: 16px; }
  .folder:hover { color: var(--text); }
  .summary { display: flex; align-items: center; gap: var(--space-2); padding: 0.2rem 0.5rem 0.4rem 1.05rem; cursor: pointer; }
  .summary .logos { display: inline-flex; gap: 0.15rem; margin-right: 0.1rem; }
  .sc { display: inline-flex; align-items: center; gap: 0.25rem; font-size: var(--text-2xs); font-weight: var(--fw-medium);
    padding: 0.1rem 0.35rem; border-radius: var(--r-pill); }
  .sc.working { color: var(--working); background: color-mix(in srgb, var(--working) 14%, transparent); }
  .sc.review { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
  .sc.done { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }
  .sc.stalled { color: var(--bad-text); background: color-mix(in srgb, var(--bad-text) 14%, transparent); }
  .gname { font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gcount { margin-left: auto; font-size: var(--text-xs); }
  .gadd { display: grid; place-items: center; color: var(--dim); width: 20px; height: 20px; border-radius: var(--r-xs); opacity: 0; transition: opacity var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .group-head:hover .gadd { opacity: 1; }
  .gadd:hover { background: var(--surface-2); color: var(--accent); }
  .row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4); border-radius: var(--r-md); cursor: pointer; }
  .row:hover { background: var(--surface-2); }
  .row.sel { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent); }
  .rlabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.sel .rlabel { font-weight: var(--fw-medium); }
  .rtime { font-size: var(--text-xs); flex: none; }
  .pbadge { background: var(--warn); color: #111; border-radius: var(--r-pill); padding: 0 0.35rem; font-size: var(--text-2xs); font-weight: var(--fw-semibold); }
  .ractions { display: none; gap: 0.15rem; }
  .row:hover .ractions { display: flex; }
  .row:hover .rtime { display: none; }
  .mini { display: grid; place-items: center; color: var(--dim); width: 20px; height: 20px; border-radius: var(--r-xs); }
  .mini:hover { background: var(--surface-3); color: var(--text); }
  .mini.del:hover { background: var(--surface-3); color: var(--bad-text); }
  .empty { padding: 1rem 0.7rem; text-align: center; font-size: var(--text-sm); }
  .footer { border-top: 1px solid var(--border-subtle); padding: var(--space-2) var(--space-4) var(--space-3); max-height: 42vh; overflow-y: auto; }
  .foot-bar { display: flex; align-items: center; }
  .foot-head { display: flex; align-items: center; justify-content: space-between; flex: 1; font-size: var(--text-2xs); letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--dim); padding: var(--space-1) 0; }
  .fchev { display: inline-grid; }
  .gear { display: grid; place-items: center; color: var(--dim); width: 24px; height: 22px; border-radius: var(--r-sm); }
  .gear:hover { color: var(--text); background: var(--surface-2); }
</style>
