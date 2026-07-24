<script lang="ts">
  import { store } from './lib/store.svelte'
  import Sidebar from './lib/Sidebar.svelte'
  import ThreadView from './lib/ThreadView.svelte'
  import SettingsModal from './lib/SettingsModal.svelte'
  import Dashboard from './lib/Dashboard.svelte'

  void store.init()

  const paneIds = $derived(
    store.splitPanes.length
      ? store.splitPanes.filter((id) => store.sessions[id])
      : store.selectedId
        ? [store.selectedId]
        : []
  )

  let sidebarWidth = $state(Number(localStorage.getItem('aiagentapp.sidebarWidth')) || 264)
  let sidebarDrag = $state(false)

  let panesEl = $state<HTMLDivElement | null>(null)
  let paneFlex = $state<number[]>([])
  let paneDrag = $state<{ left: number; startX: number; a: number; b: number } | null>(null)

  // Keep the flex array in sync with the number of panes (reset to equal on count change).
  $effect(() => {
    const n = paneIds.length
    if (paneFlex.length !== n) paneFlex = Array(n).fill(1)
  })

  function startSidebarDrag(e: MouseEvent): void {
    sidebarDrag = true
    e.preventDefault()
  }
  function startPaneDrag(left: number, e: MouseEvent): void {
    paneDrag = { left, startX: e.clientX, a: paneFlex[left] ?? 1, b: paneFlex[left + 1] ?? 1 }
    e.preventDefault()
  }
  function onMove(e: MouseEvent): void {
    if (sidebarDrag) {
      sidebarWidth = Math.min(480, Math.max(200, e.clientX))
      return
    }
    if (paneDrag && panesEl) {
      const w = panesEl.clientWidth || 1
      const totalFlex = paneFlex.reduce((s, x) => s + x, 0)
      let delta = ((e.clientX - paneDrag.startX) / w) * totalFlex
      let a = paneDrag.a + delta
      let b = paneDrag.b - delta
      const min = 0.25
      if (a < min) { b -= min - a; a = min }
      if (b < min) { a -= min - b; b = min }
      const next = [...paneFlex]
      next[paneDrag.left] = a
      next[paneDrag.left + 1] = b
      paneFlex = next
    }
  }
  function endDrag(): void {
    if (sidebarDrag) {
      sidebarDrag = false
      localStorage.setItem('aiagentapp.sidebarWidth', String(sidebarWidth))
    }
    paneDrag = null
  }

  // drag a chat from the sidebar into the pane area → live insertion ghost, drop to place
  function onDragOver(e: DragEvent): void {
    if (!store.dragSession) return
    e.preventDefault()
    const panes = panesEl ? [...panesEl.querySelectorAll<HTMLElement>('.pane')] : []
    let idx = panes.length
    for (let i = 0; i < panes.length; i++) {
      const r = panes[i]!.getBoundingClientRect()
      if (e.clientX < r.left + r.width / 2) {
        idx = i
        break
      }
    }
    store.dropIndex = idx
  }
  function onDrop(e: DragEvent): void {
    if (!store.dragSession) return
    e.preventDefault()
    if (store.dropIndex != null) store.insertPane(store.dropIndex, store.dragSession)
    store.endDragSession()
  }
</script>

<svelte:window onmousemove={onMove} onmouseup={endDrag} />

<div class="shell" class:dragging={sidebarDrag || paneDrag} style="grid-template-columns: {sidebarWidth}px 5px 1fr">
  <Sidebar />
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="handle" class:active={sidebarDrag} role="separator" aria-label="resize sidebar" tabindex="-1" onmousedown={startSidebarDrag}></div>
  <main class="center" ondragover={onDragOver} ondrop={onDrop} role="presentation">
    {#if paneIds.length === 0}
      {#if store.dragSession}
        <div class="empty dropping">drop to open this chat</div>
      {:else}
        <Dashboard />
      {/if}
    {:else}
      <div class="panes" bind:this={panesEl}>
        {#each paneIds as id, i (id + ':' + i)}
          {#if store.dragSession && store.dropIndex === i}
            <div class="ghost-pane"><span>drop here</span></div>
          {/if}
          {#if i > 0}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div class="pane-handle" class:active={paneDrag?.left === i - 1} role="separator" aria-label="resize pane" tabindex="-1" onmousedown={(e) => startPaneDrag(i - 1, e)}></div>
          {/if}
          <div class="pane" style="flex: {paneFlex[i] ?? 1} 1 0"><ThreadView sessionId={id} paneIndex={i} multiPane={paneIds.length > 1} /></div>
        {/each}
        {#if store.dragSession && store.dropIndex === paneIds.length}
          <div class="ghost-pane"><span>drop here</span></div>
        {/if}
      </div>
    {/if}
  </main>
</div>
{#if store.settingsOpen}
  <SettingsModal onclose={() => (store.settingsOpen = false)} />
{/if}

<style>
  .shell { display: grid; height: 100vh; }
  .shell.dragging { cursor: col-resize; user-select: none; }
  .center { display: flex; flex-direction: column; min-width: 0; }
  .empty { display: grid; place-items: center; height: 100%; }
  .panes { flex: 1; display: flex; min-width: 0; min-height: 0; }
  .pane { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
  .ghost-pane { flex: 0.7 1 0; min-width: 60px; margin: 0.5rem; border: 2px dashed var(--accent); border-radius: 12px;
    background: color-mix(in srgb, var(--accent) 12%, transparent); display: grid; place-items: center; }
  .ghost-pane span { color: var(--accent); font-size: 0.8rem; font-weight: 500; }
  .empty.dropping { outline: 2px dashed var(--accent); outline-offset: -1rem; border-radius: 16px; color: var(--accent); }
  .handle, .pane-handle { cursor: col-resize; background: transparent; transition: background 0.12s; flex: none; }
  .pane-handle { width: 5px; border-left: 1px solid var(--border); }
  .handle:hover, .handle.active, .pane-handle:hover, .pane-handle.active { background: var(--accent); }
</style>
