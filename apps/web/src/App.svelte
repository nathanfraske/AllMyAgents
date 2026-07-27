<script lang="ts">
  import { store, type DropZone } from './lib/store.svelte'
  import Sidebar from './lib/Sidebar.svelte'
  import ThreadView from './lib/ThreadView.svelte'
  import SettingsModal from './lib/SettingsModal.svelte'
  import ManagerSetupModal from './lib/ManagerSetupModal.svelte'
  import ConfirmDialog from './lib/ConfirmDialog.svelte'
  import Dashboard from './lib/Dashboard.svelte'
  import ProjectView from './lib/ProjectView.svelte'
  import NewProjectModal, { type ProjectLaunchResult } from './lib/NewProjectModal.svelte'
  import Titlebar from './lib/Titlebar.svelte'
  import UpdateBanner from './lib/UpdateBanner.svelte'
  import { cubicOut } from 'svelte/easing'
  import type { TransitionConfig } from 'svelte/transition'

  void store.init()

  let newProjectOpen = $state(false)

  function projectLaunchSettled(result: ProjectLaunchResult): void {
    // Keep this modal mounted over the Project View only when failures remain, because this is also
    // where retry lives. A complete or zero-agent launch lands directly on the overview.
    store.openProjectView(result.project.id)
    if (result.failed.length === 0) newProjectOpen = false
  }

  function startProjectFromManager(): void {
    store.closeManagerSetup()
    newProjectOpen = true
  }

  // Mirror the open layout (selected chat + split panes) to localStorage on every change, so the
  // next launch can OFFER to reopen it. Reading both here makes the effect reactive; the store only
  // writes a MEANINGFUL layout (never the empty home state), so the offer survives a restart even
  // when the operator ends on the home screen. This never auto-restores — it only records.
  $effect(() => {
    void store.selectedId
    void store.splitPanes
    store.persistCurrentLayout()
  })

  // 2D layout: a vertical stack of rows, each a horizontal set of panes (columns).
  const paneRows = $derived(store.panes)
  const totalPanes = $derived(paneRows.reduce((n, r) => n + r.length, 0))
  // Row-major flat offset for each row, so every pane gets a stable flat index that
  // ThreadView can hand back to setPaneSession/closePane.
  const rowOffsets = $derived.by(() => {
    const offs: number[] = []
    let acc = 0
    for (const row of paneRows) {
      offs.push(acc)
      acc += row.length
    }
    return offs
  })

  let sidebarWidth = $state(Number(localStorage.getItem('allmyagents.sidebarWidth') || localStorage.getItem('aiagentapp.sidebarWidth')) || 264)
  let sidebarDrag = $state(false)

  let panesEl = $state<HTMLDivElement | null>(null)
  // rowFlex sizes the rows vertically; colFlex[r] sizes the columns within row r.
  let rowFlex = $state<number[]>([])
  let colFlex = $state<number[][]>([])
  let colDrag = $state<{ row: number; left: number; startX: number; a: number; b: number } | null>(null)
  let rowDrag = $state<{ top: number; startY: number; a: number; b: number } | null>(null)

  // Keep flex arrays in sync with the structure. A dimension resets to equal only when its
  // own length changes, so resizing one axis doesn't clobber the other.
  $effect(() => {
    const rows = paneRows
    if (rowFlex.length !== rows.length) rowFlex = rows.map((_, r) => rowFlex[r] ?? 1)
    const needsCol =
      colFlex.length !== rows.length || rows.some((row, r) => (colFlex[r]?.length ?? -1) !== row.length)
    if (needsCol) {
      colFlex = rows.map((row, r) => (colFlex[r]?.length === row.length ? colFlex[r]! : Array(row.length).fill(1)))
    }
  })

  function startSidebarDrag(e: MouseEvent): void {
    sidebarDrag = true
    e.preventDefault()
  }
  function startColDrag(row: number, left: number, e: MouseEvent): void {
    const cf = colFlex[row] ?? []
    colDrag = { row, left, startX: e.clientX, a: cf[left] ?? 1, b: cf[left + 1] ?? 1 }
    e.preventDefault()
  }
  function startRowDrag(top: number, e: MouseEvent): void {
    rowDrag = { top, startY: e.clientY, a: rowFlex[top] ?? 1, b: rowFlex[top + 1] ?? 1 }
    e.preventDefault()
  }
  function onMove(e: MouseEvent): void {
    if (sidebarDrag) {
      sidebarWidth = Math.min(480, Math.max(200, e.clientX))
      return
    }
    if (colDrag && panesEl) {
      const w = panesEl.clientWidth || 1
      const cf = [...(colFlex[colDrag.row] ?? [])]
      const totalFlex = cf.reduce((s, x) => s + x, 0) || 1
      const delta = ((e.clientX - colDrag.startX) / w) * totalFlex
      let a = colDrag.a + delta
      let b = colDrag.b - delta
      const min = 0.25
      if (a < min) { b -= min - a; a = min }
      if (b < min) { a -= min - b; b = min }
      cf[colDrag.left] = a
      cf[colDrag.left + 1] = b
      colFlex = colFlex.map((row, r) => (r === colDrag!.row ? cf : row))
      return
    }
    if (rowDrag && panesEl) {
      const h = panesEl.clientHeight || 1
      const totalFlex = rowFlex.reduce((s, x) => s + x, 0) || 1
      const delta = ((e.clientY - rowDrag.startY) / h) * totalFlex
      let a = rowDrag.a + delta
      let b = rowDrag.b - delta
      const min = 0.25
      if (a < min) { b -= min - a; a = min }
      if (b < min) { a -= min - b; b = min }
      const next = [...rowFlex]
      next[rowDrag.top] = a
      next[rowDrag.top + 1] = b
      rowFlex = next
      return
    }
  }
  function endDrag(): void {
    if (sidebarDrag) {
      sidebarDrag = false
      localStorage.setItem('allmyagents.sidebarWidth', String(sidebarWidth))
    }
    colDrag = null
    rowDrag = null
  }

  // Drag a chat from the sidebar into the pane area → compute a live drop zone from where the
  // cursor sits inside the hovered pane: left/right third → new column; top/bottom third → new
  // row. The middle falls back to appending a column to the hovered row.
  //
  // Geometry is FROZEN at the first dragover: once a ghost is shown it reflows the panes, which
  // would shift the rects we measure and make the chosen zone oscillate (the "jittery" bug). By
  // measuring against a snapshot taken before any ghost exists, the zone is stable, and we only
  // reassign dropZone when the target cell actually changes.
  interface RowGeom { bottom: number; panes: { left: number; right: number; top: number; bottom: number }[] }
  let dragGeom: RowGeom[] | null = null
  let paneDragId = $state<string | null>(null)

  function captureGeom(): RowGeom[] {
    const rows = panesEl ? [...panesEl.querySelectorAll<HTMLElement>('.prow')] : []
    return rows.map((rowEl) => ({
      bottom: rowEl.getBoundingClientRect().bottom,
      panes: [...rowEl.querySelectorAll<HTMLElement>('.pane')].map((p) => {
        const b = p.getBoundingClientRect()
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }
      }),
    }))
  }
  function sameZone(a: DropZone | null, b: DropZone | null): boolean {
    if (!a || !b) return a === b
    if (a.kind !== b.kind) return false
    if (a.kind === 'row' && b.kind === 'row') return a.row === b.row
    if (a.kind === 'col' && b.kind === 'col') return a.row === b.row && a.col === b.col
    return false
  }
  function setZone(zone: DropZone): void {
    if (!sameZone(zone, store.dropZone)) store.dropZone = zone
  }

  // Existing panes use the SAME drag session, frozen geometry, zones and ghost as sidebar chats. The
  // pane remains in place until drop (so geometry is stable and the session never remounts mid-drag);
  // store.dropAt performs the single move commit at the end. Only the non-interactive part of the pane
  // header is a grip, so selecting transcript text and using composer/header controls stays normal.
  function startPaneDrag(id: string, e: DragEvent): void {
    const target = e.target
    if (
      target instanceof Element &&
      (target.closest('button, select, input, textarea, a') || (target !== e.currentTarget && !target.closest('.head')))
    ) {
      e.preventDefault()
      return
    }
    paneDragId = id
    store.dragSession = id
    store.dropZone = null
    dragGeom = captureGeom()
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', id)
    }
  }

  function endPaneDrag(): void {
    paneDragId = null
    dragGeom = null
    store.endDragSession()
  }

  // Drop the frozen snapshot whenever a drag ends, from any source.
  $effect(() => {
    if (!store.dragSession) dragGeom = null
  })

  function onDragOver(e: DragEvent): void {
    if (!store.dragSession) return
    e.preventDefault()
    if (!panesEl) {
      setZone({ kind: 'col', row: 0, col: 0 })
      return
    }
    if (!dragGeom) dragGeom = captureGeom()
    const geom = dragGeom
    if (geom.length === 0) return
    let r = geom.length - 1
    for (let i = 0; i < geom.length; i++) {
      if (e.clientY < geom[i]!.bottom) { r = i; break }
    }
    const panes = geom[r]!.panes
    let c = panes.length - 1
    let prect = panes[c]
    for (let i = 0; i < panes.length; i++) {
      if (e.clientX < panes[i]!.right) { c = i; prect = panes[i]; break }
    }
    const fx = prect ? (e.clientX - prect.left) / ((prect.right - prect.left) || 1) : 0.5
    const fy = prect ? (e.clientY - prect.top) / ((prect.bottom - prect.top) || 1) : 0.5
    if (fx < 0.34) setZone({ kind: 'col', row: r, col: c })
    else if (fx > 0.66) setZone({ kind: 'col', row: r, col: c + 1 })
    else if (fy < 0.34) setZone({ kind: 'row', row: r })
    else if (fy > 0.66) setZone({ kind: 'row', row: r + 1 })
    else setZone({ kind: 'col', row: r, col: c + 1 })
  }
  function onDrop(e: DragEvent): void {
    const id = store.dragSession
    if (!id) return
    e.preventDefault()
    if (store.dropZone) store.dropAt(store.dropZone, id)
    paneDragId = null
    dragGeom = null
    store.endDragSession()
  }

  // Reveal a drop-ghost with opacity + scale only. It USED to grow the SPACE it occupies (animating
  // flex-grow / min-size / margin from zero) so the surrounding panes glided aside frame by frame — a
  // deliberate touch, but the single most expensive thing to animate here: changing a flex child's
  // flex-grow reflows every sibling every frame, and with no layout containment each reflow re-lays-out
  // every pane's ENTIRE transcript. In a 6-pane / long-transcript repro that measured ~66ms/frame
  // (≈15fps) — the reported drag lag. The ghost now takes its space STATICALLY (its flex-grow / min-size
  // / margin live in CSS, applied on mount), so the only layout is one reflow when the drop zone changes,
  // not one per frame: ~16.7ms/frame (60fps). Trade, made knowingly: neighbours POP aside once instead
  // of gliding. The transition is still bidirectional, so a leaving ghost crossfades with the arriving
  // one — which keeps the zone-jump "teleport" soft. Honors prefers-reduced-motion (instant, no motion).
  function ghostReveal(_node: Element): TransitionConfig {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return { duration: 0 }
    }
    // Match the app's motion tokens: pull --dur-slow at runtime, fall back into the 180–240ms band.
    const raw =
      (typeof window !== 'undefined'
        ? getComputedStyle(document.documentElement).getPropertyValue('--dur-slow').trim()
        : '') || '220ms'
    const duration = raw.endsWith('ms') ? parseFloat(raw) || 220 : (parseFloat(raw) || 0.22) * 1000
    // Animate ONLY opacity + scale — properties that do not force layout.
    return { duration, easing: cubicOut, css: (t: number) => `opacity:${t};transform:scale(${(0.96 + 0.04 * t).toFixed(4)})` }
  }

  let pairToken = $state('')
  function doPair(): void {
    if (pairToken.trim()) void store.pair(pairToken)
  }
</script>

<svelte:window onmousemove={onMove} onmouseup={endDrag} />

<div class="app">
<Titlebar />
<!--
  Hub outage banner. The supervisor restarts a dead hub by itself, but until it does the app can only
  show stale content, and previously said so with a 6px grey dot in the sidebar — so a hub that had
  actually died looked like an app that had simply stopped working.

  Deliberately NOT shown for the first few seconds: an ordinary blue-green restart drops the socket for
  under a second, and a banner that flashes on every restart teaches you to ignore it. Past that, the
  wording tracks what the supervisor is really doing — retry backoff runs out to 30s between attempts,
  so a long gap is expected behaviour rather than a hang, and saying so is the difference between
  "waiting" and "broken".
-->
{#if store.hubDownSeconds >= 4}
  <div class="hubdown" role="status">
    <span class="spin"></span>
    {#if store.hubDownSeconds < 20}
      Lost connection to the hub — reconnecting…
    {:else}
      The hub stopped. It's being restarted automatically — retries back off to 30s, so this can take a
      moment. Your agents' work is unaffected; they run in a separate process.
    {/if}
    <span class="elapsed">{store.hubDownSeconds}s</span>
  </div>
{/if}
<div
  class="shell"
  class:dragging={sidebarDrag || !!colDrag}
  class:rowdragging={!!rowDrag}
  style="grid-template-columns: {sidebarWidth}px 5px 1fr"
>
  <Sidebar />
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="handle" class:active={sidebarDrag} role="separator" aria-label="resize sidebar" tabindex="-1" onmousedown={startSidebarDrag}></div>
  <main class="center" ondragover={onDragOver} ondrop={onDrop} role="presentation">
    {#if store.projectViewId}
      <ProjectView projectId={store.projectViewId} />
    {:else if totalPanes === 0}
      {#if store.dragSession}
        <div class="empty dropping">drop to open this chat</div>
      {:else}
        <Dashboard onnewproject={() => (newProjectOpen = true)} />
      {/if}
    {:else}
      <div class="panes" bind:this={panesEl}>
        {#each paneRows as row, r (r)}
          {#if store.dragSession && store.dropZone?.kind === 'row' && store.dropZone.row === r}
            <div class="ghost-row" transition:ghostReveal><span>drop here</span></div>
          {/if}
          {#if r > 0}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div class="row-handle" class:active={rowDrag?.top === r - 1} role="separator" aria-label="resize row" tabindex="-1" onmousedown={(e) => startRowDrag(r - 1, e)}></div>
          {/if}
          <div class="prow" style="flex: {rowFlex[r] ?? 1} 1 0">
            {#each row as id, c (id)}
              {#if store.dragSession && store.dropZone?.kind === 'col' && store.dropZone.row === r && store.dropZone.col === c}
                <div class="ghost-pane" transition:ghostReveal><span>drop here</span></div>
              {/if}
              {#if c > 0}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <div class="pane-handle" class:active={colDrag?.row === r && colDrag?.left === c - 1} role="separator" aria-label="resize pane" tabindex="-1" onmousedown={(e) => startColDrag(r, c - 1, e)}></div>
              {/if}
              <div
                class="pane"
                class:panedrag={paneDragId === id}
                style="flex: {colFlex[r]?.[c] ?? 1} 1 0"
                draggable="true"
                role="group"
                aria-label={`Chat pane ${(rowOffsets[r] ?? 0) + c + 1}; drag its header to rearrange`}
                ondragstart={(e) => startPaneDrag(id, e)}
                ondragend={endPaneDrag}
              ><ThreadView sessionId={id} paneIndex={(rowOffsets[r] ?? 0) + c} multiPane={totalPanes > 1} /></div>
            {/each}
            {#if store.dragSession && store.dropZone?.kind === 'col' && store.dropZone.row === r && store.dropZone.col === row.length}
              <div class="ghost-pane" transition:ghostReveal><span>drop here</span></div>
            {/if}
          </div>
        {/each}
        {#if store.dragSession && store.dropZone?.kind === 'row' && store.dropZone.row === paneRows.length}
          <div class="ghost-row" transition:ghostReveal><span>drop here</span></div>
        {/if}
      </div>
    {/if}
  </main>
</div>
</div>
{#if store.settingsOpen}
  <SettingsModal onclose={() => (store.settingsOpen = false)} />
{/if}
{#if store.managerSetupOpen}
  <ManagerSetupModal
    onclose={() => store.closeManagerSetup()}
    onCreateProject={startProjectFromManager}
  />
{/if}
{#if newProjectOpen}
  <NewProjectModal
    onclose={() => (newProjectOpen = false)}
    onlaunched={projectLaunchSettled}
  />
{/if}
{#if store.needsPairing}
  <div class="pairing-overlay">
    <div class="pair-card">
      <h2>Pair this device</h2>
      <p class="dim">This hub requires a device token. On a device that's already connected, open <b>Settings → Mesh</b>, copy the token, and paste it here.</p>
      <input placeholder="device token" bind:value={pairToken} onkeydown={(e) => { if (e.key === 'Enter') doPair() }} />
      <button class="pair-btn" onclick={doPair} disabled={!pairToken.trim()}>Pair device</button>
    </div>
  </div>
{/if}
<!-- In-app confirm/alert (mounted once) — the native dialogs no-op in the desktop webview. -->
<ConfirmDialog />
<!-- Check-on-launch update NOTIFICATION (desktop only, never a silent install). -->
<UpdateBanner />

<style>
  /* The app shell OWNS the viewport: fixed at 100vh and clipped, so the document never scrolls and the
     title bar (with the window controls) can never be scrolled off — critical in a frameless Tauri
     window, where losing the title bar leaves no way to close/unmaximize but the keyboard. Content is not
     lost: everything below the title bar scrolls INSIDE its own pane (the shell row is minmax(0,1fr) and
     the sidebar list + transcript each scroll), so this clip only catches true viewport overflow. */
  .app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .hubdown {
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: var(--warn-bg, rgba(180, 120, 0, 0.14));
    color: var(--warn-text, #d08700);
    border-bottom: 1px solid var(--warn, rgba(180, 120, 0, 0.4));
    font-size: var(--text-xs); line-height: 1.4;
  }
  .hubdown .elapsed { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.75; flex: none; }
  .hubdown .spin {
    width: 10px; height: 10px; flex: none; border-radius: 50%;
    border: 2px solid currentColor; border-right-color: transparent;
    animation: hubspin 0.9s linear infinite;
  }
  @keyframes hubspin { to { transform: rotate(360deg); } }
  /* Respect the OS "reduce motion" setting — a permanent spinner is exactly the kind of thing it exists for. */
  @media (prefers-reduced-motion: reduce) { .hubdown .spin { animation: none; } }
  /* grid-template-rows: minmax(0, 1fr) — WITHOUT this the implicit row is `auto` and sizes to content, so
     a tall sidebar/transcript grows the shell past the viewport and (before .app's clip) scrolled the whole
     window. minmax(0,…) lets the row shrink so its children's own scrollers engage instead. */
  .shell { display: grid; flex: 1; min-height: 0; grid-template-rows: minmax(0, 1fr); }
  .shell.dragging { cursor: col-resize; user-select: none; }
  .shell.rowdragging { cursor: row-resize; user-select: none; }
  /* min-height:0 (with min-width:0) lets this grid cell shrink below its content so `.panes` / Dashboard
     scroll internally rather than pushing the shell past the viewport. */
  .center { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .empty { display: grid; place-items: center; height: 100%; }
  .panes { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .prow { display: flex; flex: 1 1 0; min-width: 0; min-height: 0; }
  /* `position: relative` anchors pane-local edge affordances such as the CLOSED agent-panel tab. The
     open panel itself is in flow inside ThreadView. */
  .pane { flex: 1 1 0; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .pane.panedrag { opacity: 0.72; }
  .ghost-pane { flex: 0.7 1 0; min-width: 60px; margin: 0.5rem; border: 2px dashed var(--accent); border-radius: 12px;
    background: color-mix(in srgb, var(--accent) 12%, transparent); display: grid; place-items: center; }
  .ghost-row { flex: 0.5 1 0; min-height: 48px; margin: 0.5rem; border: 2px dashed var(--accent); border-radius: 12px;
    background: color-mix(in srgb, var(--accent) 12%, transparent); display: grid; place-items: center; }
  .ghost-pane span, .ghost-row span { color: var(--accent); font-size: 0.8rem; font-weight: 500; }
  .empty.dropping { outline: 2px dashed var(--accent); outline-offset: -1rem; border-radius: 16px; color: var(--accent); }
  .pairing-overlay { position: fixed; inset: 0; z-index: 50; background: var(--bg); display: grid; place-items: center; }
  .pair-card { width: min(420px, 90vw); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 14px; padding: 1.5rem; display: flex; flex-direction: column; gap: 0.8rem; box-shadow: var(--shadow-4, 0 24px 70px rgba(0,0,0,0.6)); }
  .pair-card h2 { margin: 0; font-size: 1.1rem; }
  .pair-card p { font-size: 0.82rem; line-height: 1.5; margin: 0; }
  .pair-card input { width: 100%; font-family: var(--mono); }
  .pair-btn { align-self: flex-start; background: var(--accent); color: #fff; border-radius: 8px; padding: 0.45rem 0.9rem; font-weight: 500; }
  .pair-btn:disabled { opacity: 0.5; cursor: default; }
  .handle, .pane-handle, .row-handle { background: transparent; flex: none; }
  .handle, .pane-handle { cursor: col-resize; }
  .pane-handle { width: 5px; border-left: 1px solid var(--border); }
  .row-handle { height: 5px; border-top: 1px solid var(--border); cursor: row-resize; }
  .handle:hover, .handle.active, .pane-handle:hover, .pane-handle.active, .row-handle:hover, .row-handle.active { background: var(--accent); }

  @media (prefers-reduced-motion: no-preference) {
    .handle, .pane-handle, .row-handle { transition: background var(--dur) var(--ease); }
    .empty.dropping { transition: outline-color var(--dur) var(--ease), color var(--dur) var(--ease); }
    /* Animate programmatic flex changes (pane insertion/removal, re-balance) but not while the
       user is actively dragging a divider — that must track the cursor 1:1. */
    .prow, .pane { transition: flex-grow var(--dur-slow) var(--ease), opacity var(--dur-fast) var(--ease); }
    .shell.dragging .prow, .shell.dragging .pane,
    .shell.rowdragging .prow, .shell.rowdragging .pane { transition: none; }
    .pane { animation: pane-in var(--dur-slow) var(--ease); }
    /* The drop-ghost takes its space statically (its flex-grow/min-size/margin are the .ghost-* rules
       below); only its opacity + scale are animated, by the `ghostReveal` transition. It deliberately
       does NOT animate flex-grow — that reflowed every pane's transcript per frame (see script). */
    @keyframes pane-in { from { opacity: 0; } to { opacity: 1; } }
  }
</style>
