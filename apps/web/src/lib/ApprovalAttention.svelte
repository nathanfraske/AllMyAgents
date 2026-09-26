<script lang="ts">
  import { store } from './store.svelte'
  // Only hub-authored routing metadata. A conversational "should I approve?" is not a decision
  // request. Never manufacture an approval or copy its tool permission onto the reviewer's chat.
  const requests = $derived(store.approvals.filter(a => a.status === 'pending' &&
    a.reviewSessionId === store.selectedId && a.sessionId !== store.selectedId))
</script>

{#if requests.length}
  <aside class="approval-attention" aria-label="Approval review pending" aria-live="polite">
    <strong>{requests.length} approval request{requests.length === 1 ? '' : 's'} awaiting a decision</strong>
    <span>The requesting chat is still waiting. Discussing a request does not approve it.</span>
    {#each requests.slice(0, 5) as request (request.id)}
      <button onclick={() => { store.settingsOpen = false; store.select(request.sessionId) }}>
        Review {store.sessions[request.sessionId]?.record.title ?? 'requesting chat'}’s pending request
      </button>
    {/each}
  </aside>
{/if}

<style>
  .approval-attention { position: fixed; bottom: 24px; right: 18px; z-index: 109; display: grid;
    gap: 8px; width: min(350px, calc(100vw - 36px)); padding: 14px; border: 1px solid var(--secondary);
    border-radius: 10px; background: var(--surface); box-shadow: var(--shadow-3); color: var(--text); font-size: 13px; }
  span { color: var(--muted); }
  button { padding: 6px 9px; border: 1px solid var(--border); border-radius: 6px; }
</style>
