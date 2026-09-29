<script lang="ts">
  // The agent's task board, sitting directly above the composer: what it is working on, what is done,
  // and the full history of how the board changed. Derived entirely from the agent's own task tool
  // calls (taskBoard.ts) — nothing is stored or invented here.
  import { buildTaskBoard, summarizeBoard, type TaskBoardItem } from './taskBoard'
  import { api } from './api'

  let { items, sessionId }: { items: TaskBoardItem[]; sessionId?: string } = $props()

  let open = $state(false)
  let showHistory = $state(false)
  let editing = $state<{ sessionId: string; taskId: string; expectedRevision: number; title: string; status: 'pending' | 'in_progress' | 'completed' | 'abandoned'; changeReason: string } | null>(null)
  let saving = $state(false)
  let amendmentError = $state('')
  let amendmentSaved = $state(false)

  async function amend() {
    if (!editing || saving) return
    const { sessionId: target, ...input } = editing
    saving = true
    amendmentError = ''
    try {
      const result = await api.amendTask(target, input)
      if ('error' in result) amendmentError = result.error
      else { editing = null; amendmentSaved = true }
    } catch (error) { amendmentError = error instanceof Error ? error.message : String(error) }
    finally { saving = false }
  }
  function modal(node: HTMLDialogElement) { node.showModal(); return { destroy: () => node.close() } }

  const board = $derived(buildTaskBoard(items))
  const sum = $derived(summarizeBoard(board))
  const priorCompletions = $derived((board.completedHistory ?? []).filter(t =>
    !board.tasks.some(current => current.origin === t.origin && current.title === t.title && cls(current.status) === 'done')))

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

<div class="strip" class:open>
    <button class="shead" onclick={() => (open = !open)} title="The task board this agent is working from">
      <span class="caret">{open ? '▾' : '▸'}</span>
      <span class="label">Tasks</span>
      <span class="counts dim">
        {#if sum.total}{sum.done}/{sum.total} done{#if sum.active} · {sum.active} in progress{/if}{:else}No tasks reported{/if}
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
                <span class="title" title={t.doneWhen ? `Done when: ${t.doneWhen}${t.evidence ? `\nEvidence: ${t.evidence}` : ''}` : undefined}>{t.title}</span>
                <span class="origin" class:manager={t.origin === 'manager'}>
                  {t.origin === 'contract' ? 'execution task' : t.origin === 'manager' ? 'manager assigned' : 'agent reported'}
                </span>
                <span class="status dim">{t.status.replace('_', ' ')}</span>
                {#if sessionId && t.origin === 'manager' && t.revision}
                  <button class="hlink" onclick={() => {
                    editing = { sessionId: sessionId!, taskId: t.id, expectedRevision: t.revision!, title: t.title,
                      status: ['pending', 'in_progress', 'completed', 'abandoned'].includes(t.status) ? t.status as 'pending' | 'in_progress' | 'completed' | 'abandoned' : 'pending', changeReason: '' }
                    amendmentError = ''; amendmentSaved = false
                  }}>Revise assignment</button>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <div class="dim none">No tasks reported. This does not mean the agent has no work.</div>
        {/if}

        {#if board.changes.length}
          <button class="hlink dim" onclick={() => (showHistory = !showHistory)}>
            {showHistory ? 'hide' : 'show'} history · {board.changes.length} change{board.changes.length === 1 ? '' : 's'}
          </button>
          {#if showHistory}
            {#if priorCompletions.length}
              <p class="none dim">Earlier completion reports — retained when the current plan changes, not independent verification:</p>
              <ul class="hist" aria-label="Earlier completion reports">
                {#each priorCompletions as t}
                  <li><span class="htitle">{t.title}</span><span class="dim">{t.origin === 'manager' ? 'manager assigned' : 'agent reported'}</span></li>
                {/each}
              </ul>
            {/if}
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
    {#if amendmentSaved}<p class="none" role="status">Assignment revised. This does not launch work; send a chat message when you want the agent to continue.</p>{/if}
</div>

{#if editing}
  <dialog use:modal aria-label="Revise assignment" oncancel={() => { if (!saving) editing = null }}>
    <h3>Revise assignment</h3>
    <p>This operator-only action changes the durable outcome. It does not grant tool permissions or start an agent turn.</p>
    <label>Outcome <input aria-label="Assignment outcome" bind:value={editing.title} maxlength="500" /></label>
    <label>Status <select aria-label="Assignment status" bind:value={editing.status}>
      <option value="pending">Pending</option><option value="in_progress">In progress</option>
      <option value="completed">Completed</option><option value="abandoned">Abandoned</option>
    </select></label>
    <label>Reason <textarea aria-label="Amendment reason" bind:value={editing.changeReason} maxlength="500"></textarea></label>
    {#if amendmentError}<p role="alert">{amendmentError}</p>{/if}
    <button disabled={saving || !editing.title.trim() || !editing.changeReason.trim()} onclick={amend}>Save revision</button>
    <button disabled={saving} onclick={() => { editing = null }}>Cancel</button>
  </dialog>
{/if}

<style>
  dialog { width: min(600px, calc(100vw - 40px)); max-height: 85vh; overflow: auto; padding: 20px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); }
  dialog::backdrop { background: #0008; }
  dialog label { display: grid; gap: 5px; margin-bottom: 12px; }
  dialog button { margin-right: 8px; }
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
  .origin { font-size: 0.62rem; flex: none; border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.28rem; opacity: 0.72; }
  .origin.manager { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); opacity: 1; }
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
