<script lang="ts">
  import { untrack } from 'svelte'
  import { api } from './api'
  import { store, type SessionView } from './store.svelte'
  import { relativeTime } from './time'
  import Usage from './Usage.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import Icon from './Icon.svelte'
  import ImportChats from './ImportChats.svelte'
  import { flip } from 'svelte/animate'
  import { cubicOut } from 'svelte/easing'

  let filter = $state('')
  let showCreate = $state(false)
  let newName = $state('')
  let newPath = $state('')
  let createErr = $state('')

  function pathFor(id: string): string {
    return store.projects.find((p) => p.id === id)?.path ?? ''
  }
  function openImport(e: MouseEvent, id: string): void {
    e.stopPropagation()
    store.openImportPanel(id, pathFor(id))
  }
  let showUsage = $state(true)
  let collapsed = $state(new Set<string>())

  function toggleCollapse(id: string): void {
    const next = new Set(collapsed)
    const expanding = next.has(id)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    collapsed = next
    // Expanding a project is an "open project" gesture — offer any un-imported chats (once/session).
    if (expanding && id !== '__none__') void store.maybePromptImport(id, pathFor(id))
  }

  // --- Materialize / rename glitch --------------------------------------------------------------
  // The store stamps a chat id into `recentlyChanged` when it MATERIALIZES (draft → real) or is
  // (re)TITLED. We flip a transient `.glitch` class on that row's label for a short window, then
  // clear it so a later change can retrigger. `prefers-reduced-motion` is honoured by the CSS
  // (the keyframes live behind a no-preference media query, so reduced motion just updates instantly).
  let glitching = $state(new Set<string>())
  const glitchSeen = new Map<string, number>()
  $effect(() => {
    const marks = store.recentlyChanged
    for (const id in marks) {
      const ts = marks[id]
      if (ts == null || glitchSeen.get(id) === ts) continue
      glitchSeen.set(id, ts)
      untrack(() => {
        const next = new Set(glitching)
        next.add(id)
        glitching = next
      })
      setTimeout(() => {
        const next = new Set(glitching)
        next.delete(id)
        glitching = next
      }, 760)
    }
  })

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

  // --- Drag-to-reorder (native HTML5 DnD) ------------------------------------------------------
  // The whole chat ROW and the project group HEADER are the drag affordance — the SAME native drag a
  // chat already used to open/split OUT in the pane area. `dragstart` arms a reorder; then `dragover`
  // fires CONTINUOUSLY on whatever row/header sits under the cursor, so we reorder live in the store
  // and the keyed {#each} items FLIP to open a gap. Because dragover streams, one gesture slides an
  // item past many neighbours (continuous multi-move) and a new drag can start immediately — no
  // pointer-events:none / elementFromPoint / remount fragility.
  //
  // A CHAT drag ALSO sets `store.dragSession`, so dragging it OUT over the panes still opens/splits
  // it (App.svelte drives that off dragSession + cursor position). While the cursor is over the
  // sidebar we keep `store.dropZone` cleared, so the pane drop-ghost never shows: over the sidebar it
  // is a REORDER, over the panes it is an OPEN. A PROJECT drag never sets dragSession — reordering
  // groups is sidebar-local and must never open a pane.
  type DragState = { kind: 'chat'; groupId: string; id: string } | { kind: 'project'; id: string }
  let dragging = $state<DragState | null>(null)
  // Last target id we reordered onto — skip repeats so a stationary cursor can't oscillate.
  let lastOverId: string | null = null

  const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // FLIP only WHILE dragging (the list otherwise re-sorts by recency as agents work; keeping those
  // instant avoids constant shuffling, so the glide is reserved for a deliberate reorder). Crucially
  // the params know WHICH kind is dragging: a PROJECT drag animates the whole GROUP as one unit
  // (header + its chats glide together) while the per-row flip is turned OFF so the chats ride along
  // instead of double-animating/snapping; a CHAT drag animates the rows to open a gap. Reduced-motion
  // disables both (instant reorder, no glide).
  const dragKind = $derived(dragging?.kind ?? null)
  const groupFlip = $derived({ duration: dragKind === 'project' && !reduceMotion ? 190 : 0, easing: cubicOut })
  const rowFlip = $derived({ duration: dragKind === 'chat' && !reduceMotion ? 190 : 0, easing: cubicOut })

  function isDragging(kind: 'project' | 'chat', id: string): boolean {
    return dragging?.kind === kind && dragging.id === id
  }

  // dragstart on a CHAT row: arm a chat reorder AND set dragSession, so dragging OUT into the panes
  // opens/splits it (the drop-to-open path in App.svelte).
  function startChatDrag(e: DragEvent, groupId: string, id: string): void {
    dragging = { kind: 'chat', groupId, id }
    lastOverId = null
    store.dragSession = id
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  // dragstart on a group HEADER: arm a project reorder. Deliberately does NOT touch dragSession — a
  // project drag reorders groups within the sidebar and never opens a pane.
  function startProjectDrag(e: DragEvent, id: string): void {
    dragging = { kind: 'project', id }
    lastOverId = null
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function endDrag(): void {
    dragging = null
    lastOverId = null
    store.endDragSession() // clears dragSession + dropZone (a no-op harmless path when a project was dragged)
  }

  // Live reorder driven by a continuous `dragover`. `groupId` is the group under the cursor; `chatId`
  // is the chat row under it (undefined over a header). preventDefault marks a valid drop target (so
  // dragover keeps firing and the move cursor shows); clearing dropZone keeps the pane ghost hidden
  // while we reorder inside the sidebar. The lastOverId guard — reset to null whenever we hover the
  // dragged item itself — stops oscillation yet allows immediate re-entry, so a drag can sweep an
  // item back and forth across the same neighbours fluidly.
  function dragOverTarget(e: DragEvent, groupId: string, chatId?: string): void {
    const cur = dragging
    if (!cur) return
    e.preventDefault()
    store.dropZone = null
    if (cur.kind === 'project') {
      // Hovering a group's header OR any of its rows counts as hovering that whole group.
      if (groupId === cur.id) { lastOverId = null; return }
      if (groupId === lastOverId || groupId === '__none__') return
      store.reorderProjects(cur.id, groupId)
      lastOverId = groupId
    } else {
      // A chat reorders only within its OWN group; a header (no chatId) is an inert target.
      const overId = chatId ?? groupId
      if (overId === cur.id) { lastOverId = null; return }
      if (overId === lastOverId) return
      if (chatId && cur.groupId === groupId) {
        store.reorderChats(cur.groupId, cur.id, chatId)
        lastOverId = overId
      }
    }
  }

  const preventIfDragging = (e: DragEvent): void => { if (dragging) e.preventDefault() }

  // Over sidebar chrome that is not itself a row/header (gaps, empty list space): still a reorder
  // surface, so keep the pane ghost hidden and accept the drop (which just finalises via dragend).
  function onListDragOver(e: DragEvent): void {
    if (!dragging) return
    e.preventDefault()
    store.dropZone = null
  }
  function onListDrop(e: DragEvent): void {
    if (!dragging) return
    e.preventDefault()
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
    // Offer to adopt any existing Claude/Codex chats that already live for this folder.
    store.openImportPanel(out.id, out.path)
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

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="list scroll" class:reordering={!!dragging} role="presentation" ondragover={onListDragOver} ondrop={onListDrop}>
    {#each groups as g (g.id)}
      {@const isCollapsed = collapsed.has(g.id)}
      {@const reorderable = g.id !== '__none__'}
      <div class="group" class:dragging={isDragging('project', g.id)} animate:flip={groupFlip}>
        <!-- The whole header is the project drag handle; '__none__' (Unfiled) is not reorderable. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="group-head" class:draghandle={reorderable} draggable={reorderable}
          ondragstart={(e) => startProjectDrag(e, g.id)}
          ondragend={endDrag}
          ondragover={(e) => dragOverTarget(e, g.id)}
          ondragenter={preventIfDragging}>
          {#if reorderable}
            <span class="grip" aria-hidden="true">{@render gripIcon()}</span>
          {/if}
          <button class="folder" title={isCollapsed ? 'expand' : 'collapse'} onclick={() => toggleCollapse(g.id)}><Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} /></button>
          <span class="gname">{g.name}</span>
          <span class="gcount dim tnum">{g.sessions.length}</span>
          {#if g.id !== '__none__'}
            <button class="gadd" title="import existing chats" onclick={(e) => openImport(e, g.id)}><Icon name="download" size={13} /></button>
            <button class="gadd" title="new chat here" onclick={() => store.newSession(undefined, g.id)}><Icon name="plus" size={14} /></button>
          {/if}
        </div>
        {#if store.importPanelFor?.projectId === g.id}
          <ImportChats projectId={g.id} path={store.importPanelFor.path} preloaded={store.importPanelFor.preloaded} onClose={() => store.closeImportPanel()} />
        {/if}
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
            animate:flip={rowFlip}
            ondragstart={(e) => startChatDrag(e, g.id, s.record.id)}
            ondragend={endDrag}
            ondragover={(e) => dragOverTarget(e, g.id, s.record.id)}
            ondragenter={preventIfDragging}
            onclick={() => store.select(s.record.id)}
            onkeydown={(e) => { if (e.key === 'Enter') store.select(s.record.id) }}>
            <span class="grip" aria-hidden="true">{@render gripIcon()}</span>
            <span class="dot {st.key}" title={st.label}></span>
            <ProviderLogo provider={s.record.provider} size={13} />
            {#if s.record.imported}<span class="ibadge" title="imported from an existing {s.record.provider} chat"><Icon name="download" size={10} /></span>{/if}
            {#if editingId === s.record.id}
              <input class="rename-input" bind:value={draft} use:focusInput
                onclick={(e) => e.stopPropagation()}
                onpointerdown={(e) => e.stopPropagation()}
                onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') editingId = null }}
                onblur={commitRename} />
            {:else}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <span class="rlabel" class:glitch={glitching.has(s.record.id)} ondblclick={(e) => startRename(e, s)}>{label(s)}</span>
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
  /* Drag hint: a faint grip rail on the left, revealed on hover, signalling the whole ROW/HEADER is
     draggable. Purely decorative now (aria-hidden, pointer-events:none) — the native drag lives on
     the row/header itself, which both REORDERS (over the sidebar) and OPENS/SPLITS (dragged out over
     the panes). */
  .grip { position: absolute; left: 2px; top: 50%; transform: translateY(-50%); display: grid; place-items: center;
    width: 16px; height: 18px; color: var(--dim); border-radius: var(--r-xs); opacity: 0; pointer-events: none;
    transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .gripicon { display: block; }
  /* The header is primarily a drag handle now; the row's main gesture is still click-to-select, so it
     keeps its pointer cursor and reveals the grip hint on hover. */
  .group-head.draghandle { cursor: grab; }
  .group-head:hover .grip, .row:hover .grip { opacity: 0.55; }
  .row.dragging .grip, .group.dragging .grip { opacity: 1; color: var(--muted); }
  /* Lifted look for the item being dragged. No pointer-events:none needed — native dragover streams
     the row/header under the cursor directly, so the live FLIP reorder tracks it with no hit-testing. */
  .row.dragging { background: var(--surface-3); box-shadow: var(--shadow-1); opacity: 0.9; z-index: 2; }
  .group.dragging { position: relative; z-index: 2; }
  .group.dragging .group-head { background: var(--surface-3); border-radius: var(--r-md); box-shadow: var(--shadow-1); }
  .list.reordering { user-select: none; cursor: grabbing; }
  .ibadge { flex: none; display: inline-grid; place-items: center; color: var(--dim); }
  .rlabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.sel .rlabel { font-weight: var(--fw-medium); }
  /* One-shot glitch when a chat materializes into the list or is renamed. Kept subtle (small
     jitter + clip slices + a quick accent/secondary RGB-split, opacity never below ~0.8 — no
     hard flashing). Behind no-preference so reduced motion updates the label instantly. */
  @media (prefers-reduced-motion: no-preference) {
    .rlabel.glitch { animation: rlabel-glitch 0.72s var(--ease) 1; }
    @keyframes rlabel-glitch {
      0%   { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 1; text-shadow: none; }
      12%  { transform: translate(-1.5px, 0); clip-path: inset(0 0 62% 0); opacity: 0.82; text-shadow: 1.5px 0 var(--accent), -1.5px 0 var(--secondary); }
      24%  { transform: translate(1.5px, 0); clip-path: inset(58% 0 0 0); opacity: 1; text-shadow: none; }
      36%  { transform: translate(-1px, 0); clip-path: inset(30% 0 34% 0); opacity: 0.9; text-shadow: -1.5px 0 var(--accent), 1px 0 var(--secondary); }
      50%  { transform: translate(1px, 0); clip-path: inset(0 0 18% 0); opacity: 0.86; text-shadow: none; }
      64%  { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 1; }
      78%  { transform: translate(-0.5px, 0); opacity: 0.95; text-shadow: 0.5px 0 var(--accent); }
      100% { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 1; text-shadow: none; }
    }
  }
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
