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
</script>

<div class="sidebar">
  <div class="brand">
    <button class="brandbtn" title="home / dashboard" onclick={() => store.goHome()}>
      <span class="logo"></span>
      <span class="name">CEC AiMesh</span>
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
          <button class="folder" onclick={() => toggleCollapse(g.id)}>{isCollapsed ? '▸' : '▾'}</button>
          <span class="gname">{g.name}</span>
          <span class="gcount dim">{g.sessions.length}</span>
          {#if g.id !== '__none__'}
            <button class="gadd" title="new chat here" onclick={() => store.newSession(undefined, g.id)}><Icon name="plus" size={14} /></button>
          {/if}
        </div>
        {#if isCollapsed && g.sessions.length}
          {@const sum = summarize(g.sessions)}
          <div class="summary" role="button" tabindex="0" onclick={() => toggleCollapse(g.id)} onkeydown={(e) => { if (e.key === 'Enter') toggleCollapse(g.id) }}>
            <span class="logos">{#each sum.providers as pv (pv)}<ProviderLogo provider={pv} size={12} />{/each}</span>
            {#if sum.working}<span class="sc working" title="working">{sum.working} ▶</span>{/if}
            {#if sum.review}<span class="sc review" title="ready for review">{sum.review} ⚑</span>{/if}
            {#if sum.done}<span class="sc done" title="completed">{sum.done} ✓</span>{/if}
            {#if sum.stalled}<span class="sc stalled" title="stalled / error">{sum.stalled} ✕</span>{/if}
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
            {#if pending > 0}<span class="pbadge">{pending}</span>{/if}
            <span class="rtime dim">{relativeTime(s.lastActivity)}</span>
            <span class="ractions">
              <button class="mini" title="interrupt" onclick={(e) => act(e, s.record.id, 'interrupt')}>◼</button>
              <button class="mini" title="stop" onclick={(e) => act(e, s.record.id, 'stop')}>✕</button>
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
      <button class="foot-head" onclick={() => (showUsage = !showUsage)}><span>USAGE</span><span class="dim">{showUsage ? '▾' : '▸'}</span></button>
      <button class="gear" title="settings" onclick={() => (store.settingsOpen = true)}><Icon name="settings" size={15} /></button>
    </div>
    {#if showUsage}<Usage />{/if}
  </div>
</div>

<style>
  .sidebar { display: flex; flex-direction: column; height: 100vh; background: var(--sidebar); border-right: 1px solid var(--border); }
  .brand { display: flex; align-items: center; gap: 0.45rem; padding: 0.55rem 0.6rem; }
  .brandbtn { display: flex; align-items: center; gap: 0.45rem; padding: 0.15rem 0.3rem; border-radius: 7px; }
  .brandbtn:hover { background: var(--surface); }
  .logo { width: 14px; height: 14px; border-radius: 4px; background: linear-gradient(135deg, var(--accent), var(--cyan)); }
  .name { font-weight: 600; }
  .tag { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); border: 1px solid var(--border-strong); border-radius: 4px; padding: 0 0.25rem; }
  .conn { margin-left: auto; width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
  .conn.on { background: var(--ok); }
  .search { position: relative; padding: 0 0.7rem 0.5rem; }
  .sicon { position: absolute; left: 1.15rem; top: calc(50% - 0.25rem); transform: translateY(-50%); color: var(--dim); display: grid; }
  .search input { width: 100%; padding-left: 1.9rem; }
  .sec-head { display: flex; align-items: center; justify-content: space-between; padding: 0.3rem 0.85rem; font-size: 0.66rem; letter-spacing: 0.08em; color: var(--dim); }
  .sec-actions { display: flex; gap: 0.15rem; }
  .icon { display: grid; place-items: center; color: var(--muted); width: 26px; height: 24px; border-radius: 6px; transition: background 0.12s, color 0.12s; }
  .icon:hover { background: var(--surface-2); color: var(--text); }
  .icon.on { background: var(--surface-3); color: var(--accent); }
  .panel { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.3rem 0.7rem 0.6rem; }
  .panel input { width: 100%; }
  .path-row { display: flex; gap: 0.35rem; }
  .path-row input { flex: 1; }
  .browse { flex: none; border: 1px solid var(--border-strong); border-radius: 7px; padding: 0 0.5rem; }
  .browse:hover { border-color: var(--accent); }
  .mkbtn { background: var(--accent); color: #fff; border-radius: 7px; padding: 0.35rem; font-weight: 500; }
  .err { color: var(--bad-text); font-size: 0.72rem; }
  .acctmenu { margin: 0 0.7rem 0.6rem; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 10px; padding: 0.35rem; }
  .amhead { font-size: 0.66rem; padding: 0.25rem 0.4rem 0.35rem; }
  .amrow { display: flex; align-items: center; gap: 0.5rem; width: 100%; text-align: left; padding: 0.4rem 0.45rem; border-radius: 7px; }
  .amrow:hover { background: var(--surface-2); }
  .amid { font-weight: 500; }
  .amprov { font-size: 0.72rem; margin-left: auto; }
  .amempty { padding: 0.4rem; font-size: 0.76rem; }
  .list { flex: 1; padding: 0 0.4rem; }
  .group { margin-bottom: 0.4rem; }
  .group-head { display: flex; align-items: center; gap: 0.35rem; padding: 0.3rem 0.45rem; font-size: 0.78rem; color: var(--muted); }
  .folder { font-size: 0.62rem; color: var(--dim); width: 14px; }
  .folder:hover { color: var(--text); }
  .summary { display: flex; align-items: center; gap: 0.45rem; padding: 0.2rem 0.5rem 0.4rem 1.05rem; cursor: pointer; font-size: 0.7rem; }
  .summary .logos { display: inline-flex; gap: 0.15rem; }
  .sc { font-family: var(--mono); }
  .sc.working { color: var(--working); }
  .sc.review { color: var(--warn); }
  .sc.done { color: var(--ok); }
  .sc.stalled { color: var(--bad-text); }
  .gname { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gcount { margin-left: auto; font-size: 0.7rem; }
  .gadd { display: grid; place-items: center; color: var(--dim); width: 20px; height: 20px; border-radius: 5px; opacity: 0; transition: opacity 0.12s, background 0.12s, color 0.12s; }
  .group-head:hover .gadd { opacity: 1; }
  .gadd:hover { background: var(--surface-2); color: var(--accent); }
  .row { display: flex; align-items: center; gap: 0.45rem; padding: 0.32rem 0.45rem 0.32rem 0.6rem; border-radius: 7px; cursor: pointer; }
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
  .gear { display: grid; place-items: center; color: var(--dim); width: 24px; height: 22px; border-radius: 6px; }
  .gear:hover { color: var(--text); background: var(--surface-2); }
</style>
