<script lang="ts">
  import { store } from './lib/store.svelte'
  import Sidebar from './lib/Sidebar.svelte'
  import ThreadView from './lib/ThreadView.svelte'
  import SettingsModal from './lib/SettingsModal.svelte'

  void store.init()
</script>

<div class="shell">
  <Sidebar />
  <main class="center"><ThreadView /></main>
</div>
{#if store.settingsOpen}
  <SettingsModal onclose={() => (store.settingsOpen = false)} />
{/if}

<style>
  .shell { display: grid; grid-template-columns: 264px 1fr; height: 100vh; }
  .center { display: flex; flex-direction: column; min-width: 0; }
</style>
