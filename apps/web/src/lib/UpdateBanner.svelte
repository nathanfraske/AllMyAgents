<script lang="ts">
  // Check-on-launch NOTIFICATION for a new app version. Deliberately a banner and
  // not an auto-install: the updater is a code-exec path, so nothing is downloaded
  // or applied until the operator clicks "Update now" (docs/alpha-release-plan.md,
  // "UX + consent"). Invisible outside the desktop shell, when auto-check is off,
  // and when there's nothing to install.
  import { updater } from './updater.svelte'

  void updater.checkOnLaunch()
</script>

{#if updater.bannerVisible}
  {@const info = updater.info!}
  <div class="upd" role="status">
    <div class="upd-text">
      <b>AllMyAgents {info.version} is available.</b>
      <span class="dim">You're on {info.currentVersion}. The update is signature-verified before it installs, and the app restarts afterwards.</span>
      {#if updater.error}<span class="err">{updater.error}</span>{/if}
    </div>
    <div class="upd-actions">
      <button class="btn btn-ghost" onclick={() => updater.dismiss()} disabled={updater.busy}>Later</button>
      <button class="btn btn-primary" onclick={() => updater.install()} disabled={updater.busy}>
        {updater.busy ? 'Updating…' : 'Update now'}
      </button>
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
  @media (prefers-reduced-motion: no-preference) {
    .upd { animation: upd-in var(--dur) var(--ease); }
    @keyframes upd-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  }
</style>
