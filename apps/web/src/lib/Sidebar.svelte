<script lang="ts">
  import { api } from './api'
  import { store, type SessionView } from './store.svelte'
  import { relativeTime } from './time'
  import Usage from './Usage.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import Icon from './Icon.svelte'
  import { flip } from 'svelte/animate'
  import { cubicOut } from 'svelte/easing'

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
    if (s.record.title) return s.record.title
    const p = s.record.worktree ?? s.record.repo ?? s.record.cwd
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
  }

  // Inline rename: double-click the label (or the rename action). Enter commits, Esc cancels.
  let editingId = $state<string | null>(null)
  let draft = $state('')
  function startRename(e: Event, s: SessionView): void {
    e.stopPropagation()
    editingId = s.record.id
    draft = label(s)
  }
  function commitRename(): void {
    if (editingId) store.renameSession(editingId, draft)
    editingId = null
  }
  function focusInput(node: HTMLInputElement): void {
    node.focus()
    node.select()
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
    for (const p of store.orderedProjects) {
      const ss = byProject.get(p.id) ?? []
      if (ss.length || !filter) out.push({ id: p.id, name: p.name, sessions: store.orderedChats(p.id, ss) })
    }
    const none = byProject.get('__none__')
    if (none?.length) out.push({ id: '__none__', name: 'Unfiled', sessions: store.orderedChats('__none__', none) })
    return out
  })

  // --- Drag-to-reorder (pointer-based) ---------------------------------------------------------
  // A dedicated grip handle starts a REORDER via pointer events, kept deliberately separate from the
  // chat row's native HTML drag (which drags a chat OUT into the main pane to open/split it): the
  // grip is not `draggable`, and while a reorder is armed we cancel the row's native `dragstart`, so
  // the two gestures never collide. As the pointer moves we hit-test the group/row underneath and
  // reorder live in the store, so the keyed {#each} items animate (FLIP) to open a gap where the
  // dragged item will land. The chosen order persists via the store.
  type ReorderState = { kind: 'project'; id: string } | { kind: 'chat'; groupId: string; id: string }
  let reordering = $state<ReorderState | null>(null)
  // Last target we acted on — skip repeats so a stationary pointer over one neighbour can't oscillate.
  let lastOverId: string | null = null

  const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // FLIP only WHILE dragging (matches --dur / --ease feel). The list otherwise re-sorts by recency
  // as agents work; keeping those instant (duration 0) avoids constant shuffling, so the "bump out
  // of the way" glide is reserved for a deliberate reorder. Reduced-motion disables it entirely.
  const flipParams = $derived({ duration: reordering && !reduceMotion ? 190 : 0, easing: cubicOut })

  function isDragging(kind: 'project' | 'chat', id: string): boolean {
    return reordering?.kind === kind && reordering.id === id
  }

  function startReorder(e: PointerEvent, target: ReorderState): void {
    if (e.button !== 0) return
    e.preventDefault() // suppress text-selection + help keep the row's native drag from starting
    e.stopPropagation()
    reordering = target
    lastOverId = null
    window.addEventListener('pointermove', onReorderMove)
    window.addEventListener('pointerup', endReorder)
    window.addEventListener('pointercancel', endReorder)
  }

  function onReorderMove(e: PointerEvent): void {
    const cur = reordering
    if (!cur) return
    e.preventDefault()
    // The dragged element has pointer-events:none, so elementFromPoint returns the item beneath.
    const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(
      `[data-reorder-kind="${cur.kind}"]`,
    )
    const overId = el?.dataset.reorderId
    if (!overId || overId === cur.id || overId === lastOverId) return
    if (cur.kind === 'project') {
      store.reorderProjects(cur.id, overId)
      lastOverId = overId
    } else if (el?.dataset.reorderGroup === cur.groupId) {
      store.reorderChats(cur.groupId, cur.id, overId)
      lastOverId = overId
    }
  }

  function endReorder(): void {
    reordering = null
    lastOverId = null
    window.removeEventListener('pointermove', onReorderMove)
    window.removeEventListener('pointerup', endReorder)
    window.removeEventListener('pointercancel', endReorder)
  }


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
      <img class="logo" src="/logo.png" alt="" />
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

  {#snippet gripIcon()}
    <svg class="gripicon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="5" r="1.5" /><circle cx="15" cy="5" r="1.5" />
      <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="19" r="1.5" /><circle cx="15" cy="19" r="1.5" />
    </svg>
  {/snippet}

  <div class="list scroll" class:reordering={!!reordering}>
    {#each groups as g (g.id)}
      {@const isCollapsed = collapsed.has(g.id)}
      {@const reorderable = g.id !== '__none__'}
      <div class="group" class:dragging={isDragging('project', g.id)} animate:flip={flipParams}
        data-reorder-kind={reorderable ? 'project' : undefined}
        data-reorder-id={reorderable ? g.id : undefined}>
        <div class="group-head">
          {#if reorderable}
            <button class="grip" title="drag to reorder project" aria-label="reorder project" draggable="false" tabindex="-1"
              onpointerdown={(e) => startReorder(e, { kind: 'project', id: g.id })}
              onclick={(e) => e.stopPropagation()}>{@render gripIcon()}</button>
          {/if}
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
          <div class="row" class:sel={store.selectedId === s.record.id} class:dragging={isDragging('chat', s.record.id)} role="button" tabindex="0"
            draggable={editingId !== s.record.id}
            animate:flip={flipParams}
            data-reorder-kind="chat" data-reorder-id={s.record.id} data-reorder-group={g.id}
            ondragstart={(e) => { if (reordering) { e.preventDefault(); return } store.dragSession = s.record.id; e.dataTransfer?.setData('text/plain', s.record.id) }}
            ondragend={() => store.endDragSession()}
            onclick={() => store.select(s.record.id)}
            onkeydown={(e) => { if (e.key === 'Enter') store.select(s.record.id) }}>
            <button class="grip" title="drag to reorder chat" aria-label="reorder chat" draggable="false" tabindex="-1"
              onpointerdown={(e) => startReorder(e, { kind: 'chat', groupId: g.id, id: s.record.id })}
              onclick={(e) => e.stopPropagation()}>{@render gripIcon()}</button>
            <span class="dot {st.key}" title={st.label}></span>
            <ProviderLogo provider={s.record.provider} size={13} />
            {#if editingId === s.record.id}
              <input class="rename-input" bind:value={draft} use:focusInput
                onclick={(e) => e.stopPropagation()}
                onpointerdown={(e) => e.stopPropagation()}
                onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') editingId = null }}
                onblur={commitRename} />
            {:else}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <span class="rlabel" ondblclick={(e) => startRename(e, s)}>{label(s)}</span>
            {/if}
            {#if pending > 0}<span class="pbadge tnum">{pending}</span>{/if}
            <span class="rtime dim tnum">{relativeTime(s.lastActivity)}</span>
            <span class="ractions">
              <button class="mini" title="rename" onclick={(e) => startRename(e, s)}><Icon name="pencil" size={12} /></button>
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
  .sidebar { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--sidebar); border-right: 1px solid var(--border); }
  .brand { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3); }
  .brandbtn { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-2); border-radius: var(--r-sm); }
  .brandbtn:hover { background: var(--surface); }
  .logo { width: 18px; height: 18px; object-fit: contain; }
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
  .group-head { position: relative; display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-6); font-size: var(--text-sm); color: var(--muted); }
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
  .row { position: relative; display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-6); border-radius: var(--r-md); cursor: pointer; }
  .row:hover { background: var(--surface-2); }
  .row.sel { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent); }
  /* Drag-to-reorder grip: a faint rail on the left, revealed on hover, that owns the REORDER
     gesture (pointer-based) — distinct from the row body's native drag-out-to-open. */
  .grip { position: absolute; left: 2px; top: 50%; transform: translateY(-50%); display: grid; place-items: center;
    width: 16px; height: 18px; color: var(--dim); border-radius: var(--r-xs); cursor: grab; opacity: 0; touch-action: none;
    transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .gripicon { display: block; }
  .group-head:hover .grip, .row:hover .grip { opacity: 0.45; }
  .group-head .grip:hover, .row .grip:hover { opacity: 1; color: var(--muted); }
  .grip:active { cursor: grabbing; }
  .row.dragging .grip, .group.dragging .grip { opacity: 1; color: var(--muted); }
  /* Lifted look for the item under the pointer; pointer-events:none lets elementFromPoint read the
     neighbour beneath so the live FLIP reorder tracks the cursor. */
  .row.dragging { background: var(--surface-3); box-shadow: var(--shadow-1); opacity: 0.92; z-index: 2; pointer-events: none; }
  .group.dragging { position: relative; pointer-events: none; z-index: 2; }
  .group.dragging .group-head { background: var(--surface-3); border-radius: var(--r-md); box-shadow: var(--shadow-1); }
  .list.reordering { user-select: none; cursor: grabbing; }
  .rlabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.sel .rlabel { font-weight: var(--fw-medium); }
  .rename-input { flex: 1; min-width: 0; font: inherit; font-size: var(--text-sm); background: var(--surface-3); border: 1px solid var(--border-accent); border-radius: var(--r-xs); padding: 0 0.3rem; color: var(--text); }
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
