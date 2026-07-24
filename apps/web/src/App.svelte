<script lang="ts">
  import { store } from './lib/store.svelte'
  import Sidebar from './lib/Sidebar.svelte'
  import ThreadView from './lib/ThreadView.svelte'
  import SettingsModal from './lib/SettingsModal.svelte'

  void store.init()

  let sidebarWidth = $state(Number(localStorage.getItem('aiagentapp.sidebarWidth')) || 264)
  let dragging = $state(false)

  function startDrag(e: MouseEvent): void {
    dragging = true
    e.preventDefault()
  }
  function onMove(e: MouseEvent): void {
    if (!dragging) return
    sidebarWidth = Math.min(480, Math.max(200, e.clientX))
  }
  function endDrag(): void {
    if (!dragging) return
    dragging = false
    localStorage.setItem('aiagentapp.sidebarWidth', String(sidebarWidth))
  }
</script>

<svelte:window onmousemove={onMove} onmouseup={endDrag} />

<div class="shell" class:dragging style="grid-template-columns: {sidebarWidth}px 5px 1fr">
  <Sidebar />
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="handle" class:active={dragging} role="separator" aria-label="resize sidebar" tabindex="-1" onmousedown={startDrag}></div>
  <main class="center"><ThreadView /></main>
</div>
{#if store.settingsOpen}
  <SettingsModal onclose={() => (store.settingsOpen = false)} />
{/if}

<style>
  .shell { display: grid; height: 100vh; }
  .shell.dragging { cursor: col-resize; user-select: none; }
  .center { display: flex; flex-direction: column; min-width: 0; }
  .handle { cursor: col-resize; background: transparent; transition: background 0.12s; }
  .handle:hover, .handle.active { background: var(--accent); }
</style>
