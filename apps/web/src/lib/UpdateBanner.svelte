<script lang="ts">
  // Check-on-launch NOTIFICATION for a new app version. Deliberately a banner and
  // not an auto-install: the updater is a code-exec path, so nothing is downloaded
  // or applied until the operator clicks "Update now" (docs/alpha-release-plan.md,
  // "UX + consent"). Invisible outside the desktop shell, when auto-check is off,
  // and when there's nothing to install.
  import { updater } from './updater.svelte'
  import { store } from './store.svelte'

  void updater.checkOnLaunch()

  /**
   * Installing kills the whole process tree — hub, agent worker, and every agent mid-thought. The
   * restart machinery survives a hub going away, but not the app that hosts it being replaced under it,
   * so an update accepted during a live turn is simply work thrown away. The banner used to offer one
   * button and no hint that anything was running.
   */
  const liveTurns = $derived(
    Object.values(store.sessions).filter((s) => s.record.status === 'active' || s.record.status === 'starting').length
  )

  /** Armed by "Update when idle": install as soon as the last live turn finishes, rather than making
   *  the operator sit and watch for it. */
  let waitForIdle = $state(false)

  $effect(() => {
    if (waitForIdle && liveTurns === 0 && !updater.busy) {
      waitForIdle = false
      void updater.install()
    }
  })
</script>

{#if updater.bannerVisible}
  {@const info = updater.info!}
  <div class="upd" role="status">
    <div class="upd-text">
      <b>AllMyAgents {info.version} is available.</b>
      <span class="dim">You're on {info.currentVersion}. The update is signature-verified before it installs, and the app restarts afterwards.</span>
      {#if liveTurns > 0}
        <span class="warn">
          {liveTurns} {liveTurns === 1 ? 'chat is' : 'chats are'} mid-turn. Updating restarts everything,
          so that work would be lost.
        </span>
      {/if}
      {#if waitForIdle}
        <span class="warn">Waiting for {liveTurns} {liveTurns === 1 ? 'turn' : 'turns'} to finish, then updating…</span>
      {/if}
      {#if updater.error}<span class="err">{updater.error}</span>{/if}
    </div>
    <div class="upd-actions">
      {#if waitForIdle}
        <button class="btn btn-ghost" onclick={() => (waitForIdle = false)}>Cancel</button>
      {:else}
        <button class="btn btn-ghost" onclick={() => updater.dismiss()} disabled={updater.busy}>Later</button>
        {#if liveTurns > 0}
          <button class="btn btn-ghost" onclick={() => updater.install()} disabled={updater.busy}>
            {updater.busy ? 'Updating…' : 'Update anyway'}
          </button>
          <button class="btn btn-primary" onclick={() => (waitForIdle = true)} disabled={updater.busy}>
            Update when idle
          </button>
        {:else}
          <button class="btn btn-primary" onclick={() => updater.install()} disabled={updater.busy}>
            {updater.busy ? 'Updating…' : 'Update now'}
          </button>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .upd {
    position: fixed; right: var(--space-5); bottom: var(--space-5); z-index: 55;
    width: min(420px, 92vw);
    display: flex; flex-direction: column; gap: var(--space-4);
    background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-xl);
    box-shadow: var(--shadow-4), var(--edge-hi);
    padding: var(--space-5);
  }
  .upd-text { display: flex; flex-direction: column; gap: var(--space-2); font-size: var(--text-sm); line-height: 1.5; }
  .upd-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
  .err { color: var(--bad); }
  .warn { color: var(--warn-text, #d08700); }
  @media (prefers-reduced-motion: no-preference) {
    .upd { animation: upd-in var(--dur) var(--ease); }
    @keyframes upd-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  }
</style>
