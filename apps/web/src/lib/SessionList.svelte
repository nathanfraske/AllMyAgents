<script lang="ts">
  import { api } from './api'
  import { store } from './store.svelte'

  async function act(e: MouseEvent, id: string, verb: 'interrupt' | 'stop'): Promise<void> {
    e.stopPropagation()
    if (verb === 'interrupt') await api.interrupt(id)
    else await api.stop(id)
  }
</script>

<div class="list">
  {#each store.sessionList as s (s.record.id)}
    {@const pending = store.pendingBySession[s.record.id] ?? 0}
    <div class="row" class:sel={store.selectedId === s.record.id} role="button" tabindex="0"
      onclick={() => store.select(s.record.id)}
      onkeydown={(e) => { if (e.key === 'Enter') store.select(s.record.id) }}>
      <div class="l1">
        <span class="pill {s.record.status}">{s.record.status}</span>
        <span class="pid">{s.record.profileId}</span>
        <span class="prov">{s.record.provider}</span>
        {#if pending > 0}<span class="badge">{pending}</span>{/if}
      </div>
      <div class="l2 muted">
        {#if s.record.model}<span>{s.record.model}{s.record.effort ? '/' + s.record.effort : ''}</span>{/if}
        <span class="path">{s.record.worktree ?? s.record.cwd}</span>
      </div>
      <div class="acts">
        <button class="mini" onclick={(e) => act(e, s.record.id, 'interrupt')}>interrupt</button>
        <button class="mini bad" onclick={(e) => act(e, s.record.id, 'stop')}>stop</button>
      </div>
    </div>
  {/each}
  {#if store.sessionList.length === 0}
    <div class="muted empty">no sessions yet — spawn one above</div>
  {/if}
</div>

<style>
  .list { display: flex; flex-direction: column; gap: 0.3rem; }
  .row { text-align: left; display: flex; flex-direction: column; gap: 0.25rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.6rem; }
  .row.sel { border-color: var(--accent); background: var(--surface-2); }
  .l1 { display: flex; gap: 0.4rem; align-items: center; }
  .pid { font-weight: 500; }
  .prov { color: var(--dim); font-size: 0.72rem; }
  .badge { margin-left: auto; background: var(--warn); color: #10131a; border-radius: 999px; padding: 0 0.4rem; font-size: 0.72rem; font-weight: 600; }
  .l2 { display: flex; gap: 0.5rem; font-size: 0.73rem; }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }
  .acts { display: flex; gap: 0.3rem; }
  .mini { font-size: 0.7rem; padding: 0.1rem 0.35rem; }
  .empty { padding: 1rem 0; text-align: center; font-size: 0.8rem; }
</style>
