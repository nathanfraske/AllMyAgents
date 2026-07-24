<script lang="ts">
  import { store } from './store.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import type { SessionView } from './store.svelte'

  let { view }: { view: SessionView } = $props()
  let open = $state(false)

  const current = $derived(store.profiles.find((p) => p.id === view.record.profileId))
  const hasHistory = $derived(view.items.some((i) => i.kind === 'user' || i.kind === 'assistant'))

  async function pick(profileId: string): Promise<void> {
    open = false
    if (profileId === view.record.profileId) return
    if (hasHistory) {
      const ok = confirm(
        `Move this chat to "${profileId}"?\n\nThe conversation context and working files are ported to a new chat on that account (auth can't be swapped mid-conversation, so the work is moved, not the login). The original chat is kept as a snapshot.`
      )
      if (!ok) return
    }
    await store.useAccount(profileId)
  }
</script>

<div class="wrap">
  <button class="pill-btn" onclick={() => (open = !open)} title="account (swap opens a fresh chat once this one has history)">
    {#if current}<ProviderLogo provider={current.provider} size={12} />{/if}
    {view.record.profileId}
    <span class="chev">▾</span>
  </button>
  {#if open}
    <button class="scrim" onclick={() => (open = false)} aria-label="close"></button>
    <div class="menu">
      {#if hasHistory}<div class="note dim">switching ports this chat's context + files to that account</div>{/if}
      {#each store.profiles as p (p.id)}
        <button class="row" class:sel={p.id === view.record.profileId} onclick={() => pick(p.id)}>
          <ProviderLogo provider={p.provider} size={13} />
          <span class="id">{p.id}</span>
          <span class="prov dim">{p.provider}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .chev { font-size: 0.6rem; opacity: 0.7; }
  .scrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 200px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 10px; padding: 0.3rem; box-shadow: 0 8px 28px rgba(0,0,0,0.5); }
  @media (prefers-reduced-motion: no-preference) { .menu { animation: pop-in 0.12s var(--ease); } }
  .note { font-size: 0.66rem; padding: 0.2rem 0.4rem 0.35rem; }
  .row { display: flex; align-items: center; gap: 0.45rem; width: 100%; text-align: left; padding: 0.35rem 0.5rem; border-radius: 7px; font-size: 0.82rem; }
  .row:hover { background: var(--surface-3); }
  .row.sel { background: var(--surface-3); color: var(--accent); }
  .id { font-weight: 500; }
  .prov { margin-left: auto; font-size: 0.72rem; }
</style>
