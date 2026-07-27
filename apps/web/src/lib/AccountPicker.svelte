<script lang="ts">
  import { store } from './store.svelte'
  import { confirmDialog } from './dialog.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import Icon from './Icon.svelte'
  import type { SessionView } from './store.svelte'

  let { view }: { view: SessionView } = $props()
  let open = $state(false)

  const current = $derived(store.profiles.find((p) => p.id === view.record.profileId))
  const hasHistory = $derived(view.items.some((i) => i.kind === 'user' || i.kind === 'assistant'))
  const buttonLabel = $derived(current?.id ?? (store.profiles.length ? 'Choose account' : 'Add account'))

  async function pick(profileId: string): Promise<void> {
    open = false
    if (profileId === view.record.profileId) return
    if (hasHistory) {
      const ok = await confirmDialog(
        `Move this chat to "${profileId}"?\n\nThe conversation context and working files are ported to a new chat on that account (auth can't be swapped mid-conversation, so the work is moved, not the login). The original chat is kept as a snapshot.`,
        { confirmLabel: 'Move chat' }
      )
      if (!ok) return
    }
    await store.useAccount(profileId)
  }

  function openAccountSettings(): void {
    open = false
    store.settingsOpen = true
  }
</script>

<div class="wrap">
  <button class="pill-btn" class:open onclick={() => (open = !open)} title="account (swap opens a fresh chat once this one has history)">
    {#if current}<ProviderLogo provider={current.provider} size={12} />{/if}
    {buttonLabel}
    <span class="chev"><Icon name="chevron-down" size={12} /></span>
  </button>
  {#if open}
    <button class="scrim" onclick={() => (open = false)} aria-label="close"></button>
    <div class="menu">
      {#if hasHistory}<div class="note dim">switching ports this chat's context + files to that account</div>{/if}
      {#if store.profiles.length === 0}
        <div class="empty">
          <div>No accounts yet.</div>
          <div class="dim">Add a Claude or Codex account in Settings to start a chat.</div>
          <button class="settings-link" onclick={openAccountSettings}>
            <Icon name="settings" size={13} />
            Open Settings
          </button>
        </div>
      {:else}
        {#each store.profiles as p (p.id)}
          <button class="row" class:sel={p.id === view.record.profileId} onclick={() => pick(p.id)}>
            <ProviderLogo provider={p.provider} size={13} />
            <span class="id">{p.id}</span>
            <span class="prov dim">{p.provider}</span>
            {#if p.id === view.record.profileId}<span class="tick"><Icon name="check" size={13} /></span>{/if}
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .chev { display: inline-grid; opacity: 0.6; }
  .scrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 200px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--space-1); box-shadow: var(--shadow-3), var(--edge-hi); }
  @media (prefers-reduced-motion: no-preference) { .menu { animation: pop-in var(--dur-fast) var(--ease); } }
  .note { font-size: var(--text-2xs); padding: 0.2rem 0.4rem 0.35rem; }
  .empty { display: grid; gap: var(--space-2); padding: var(--space-3); font-size: var(--text-xs); line-height: 1.4; }
  .settings-link { display: flex; align-items: center; justify-content: center; gap: var(--space-2); width: 100%; margin-top: var(--space-1); padding: var(--space-2) var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--r-md); background: var(--surface-3); font-size: var(--text-xs); font-weight: var(--fw-medium); }
  .settings-link:hover { border-color: var(--accent); }
  .row { display: flex; align-items: center; gap: var(--space-2); width: 100%; text-align: left; padding: var(--space-2) var(--space-3); border-radius: var(--r-md); font-size: var(--text-sm); }
  .row:hover { background: var(--surface-3); }
  .row.sel { background: var(--surface-3); }
  .row.sel .id { font-weight: var(--fw-semibold); }
  .id { font-weight: var(--fw-medium); }
  .prov { margin-left: auto; font-size: var(--text-xs); }
  .tick { display: inline-grid; color: var(--accent); flex: none; }
</style>
