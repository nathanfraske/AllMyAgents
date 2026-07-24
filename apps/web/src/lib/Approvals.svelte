<script lang="ts">
  import { api } from './api'
  import { store } from './store.svelte'

  async function decide(id: string, approve: boolean): Promise<void> {
    await api.decide(id, approve)
    await store.refreshSideData()
  }

  function summarize(payload: unknown): string {
    const p = payload as { toolName?: string; input?: unknown; threadId?: string }
    if (p.toolName) return `${p.toolName} ${JSON.stringify(p.input ?? {}).slice(0, 120)}`
    return JSON.stringify(payload).slice(0, 140)
  }
</script>

<div class="approvals">
  {#if store.approvals.length === 0}
    <div class="muted small">no pending approvals</div>
  {/if}
  {#each store.approvals as a (a.id)}
    <div class="card">
      <div class="top">
        <span class="warn">{a.kind}</span>
        <button class="jump" onclick={() => store.select(a.sessionId)}>{a.sessionId.slice(0, 8)}</button>
      </div>
      <code class="body">{summarize(a.payload)}</code>
      <div class="actions">
        <button class="ok" onclick={() => decide(a.id, true)}>allow</button>
        <button class="bad" onclick={() => decide(a.id, false)}>deny</button>
      </div>
    </div>
  {/each}
</div>

<style>
  .approvals { display: flex; flex-direction: column; gap: 0.5rem; }
  .card { background: var(--surface); border: 1px solid var(--warn); border-radius: 8px; padding: 0.5rem 0.6rem; }
  .top { display: flex; justify-content: space-between; align-items: center; }
  .warn { color: var(--warn); font-size: 0.8rem; }
  .jump { padding: 0.05rem 0.35rem; font-size: 0.72rem; font-family: var(--mono); }
  .body { display: block; margin: 0.4rem 0; font-size: 0.74rem; color: var(--muted); word-break: break-all; }
  .actions { display: flex; gap: 0.4rem; }
  .small { font-size: 0.75rem; }
</style>
