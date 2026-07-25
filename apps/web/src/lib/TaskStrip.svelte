<script lang="ts">
  // The agent's task board, sitting directly above the composer: what it is working on, what is done,
  // and the full history of how the board changed. Derived entirely from the agent's own task tool
  // calls (taskBoard.ts) — nothing is stored or invented here.
  import { buildTaskBoard, summarizeBoard, type TaskBoardItem } from './taskBoard'

  let { items }: { items: TaskBoardItem[] } = $props()

  let open = $state(false)
  let showHistory = $state(false)

  const board = $derived(buildTaskBoard(items))
  const sum = $derived(summarizeBoard(board))
  const hasBoard = $derived(board.tasks.length > 0 || board.changes.length > 0)

  function cls(status: string): string {
    if (status === 'completed' || status === 'done') return 'done'
    if (status === 'in_progress' || status === 'active') return 'active'
    return 'pending'
  }
  function timeOf(ts: string): string {
    const d = new Date(ts)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
</script>

{#if hasBoard}
  <div class="strip" class:open>
    <button class="shead" onclick={() => (open = !open)} title="The task board this agent is working from">
      <span class="caret">{open ? '▾' : '▸'}</span>
      <span class="label">Tasks</span>
      <span class="counts dim">
        {sum.done}/{sum.total} done{#if sum.active} · {sum.active} in progress{/if}
      </span>
      {#if sum.total}
        <span class="bar" aria-hidden="true"><span class="fill" style="width: {Math.round((sum.done / sum.total) * 100)}%"></span></span>
      {/if}
    </button>

    {#if open}
      <div class="body">
        {#if board.tasks.length}
          <ul class="tasks">
            {#each board.tasks as t (t.id)}
              <li class="task {cls(t.status)}">
                <span class="mark" aria-hidden="true"></span>
                <span class="title">{t.title}</span>
                <span class="status dim">{t.status.replace('_', ' ')}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <div class="dim none">No tasks on the board — only history below.</div>
        {/if}

        {#if board.changes.length}
          <button class="hlink dim" onclick={() => (showHistory = !showHistory)}>
            {showHistory ? 'hide' : 'show'} history · {board.changes.length} change{board.changes.length === 1 ? '' : 's'}
          </button>
          {#if showHistory}
            <ol class="hist">
              {#each board.changes.slice(-60) as c, i (i)}
                <li>
                  <span class="dim ht">{timeOf(c.ts)}</span>
                  <span class="hk">{c.kind}</span>
                  {#if c.title}<span class="htitle">{c.title}</span>{/if}
                  {#if c.status}<span class="dim">→ {c.status.replace('_', ' ')}</span>{/if}
                  {#if c.taskId && !c.title}<span class="dim">#{c.taskId}</span>{/if}
                </li>
              {/each}
            </ol>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .strip { border: 1px solid var(--border); border-radius: 10px; background: var(--surface); margin-bottom: 0.5rem; overflow: hidden; }
  .shead { display: flex; align-items: center; gap: 0.45rem; width: 100%; background: none; border: none; color: inherit; cursor: pointer; padding: 0.35rem 0.55rem; text-align: left; font: inherit; }
  .shead:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .caret { flex: none; opacity: 0.7; font-size: 0.7rem; }
  .label { font-size: 0.76rem; font-weight: 600; flex: none; }
  .counts { font-size: 0.72rem; flex: 1; }
  .bar { flex: none; width: 64px; height: 4px; border-radius: 999px; background: var(--border); overflow: hidden; }
  .fill { display: block; height: 100%; background: #2e9e63; }
  .body { padding: 0.15rem 0.55rem 0.5rem; border-top: 1px solid var(--border); }
  .tasks { list-style: none; margin: 0.35rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; max-height: 30vh; overflow-y: auto; }
  .task { display: flex; align-items: center; gap: 0.45rem; font-size: 0.76rem; }
  .mark { width: 8px; height: 8px; border-radius: 50%; flex: none; border: 1px solid var(--border-strong); }
  .task.done .mark { background: #2e9e63; border-color: #2e9e63; }
  .task.active .mark { background: var(--accent); border-color: var(--accent); }
  .task.done .title { opacity: 0.6; text-decoration: line-through; }
  .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { font-size: 0.68rem; flex: none; }
  .none { font-size: 0.74rem; padding: 0.3rem 0; }
  .hlink { background: none; border: none; color: inherit; cursor: pointer; font-size: 0.7rem; padding: 0.35rem 0 0; text-decoration: underline; }
  .hist { list-style: none; margin: 0.25rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.1rem; max-height: 26vh; overflow-y: auto; font-size: 0.72rem; }
  .hist li { display: flex; gap: 0.35rem; align-items: baseline; }
  .ht { flex: none; }
  .hk { flex: none; opacity: 0.85; }
  .htitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (prefers-reduced-motion: no-preference) {
    .fill { transition: width var(--dur-slow, 0.3s) var(--ease, ease); }
  }
</style>
