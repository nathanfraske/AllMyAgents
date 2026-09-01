<script lang="ts">
  import { api, type DurableRunInfo, type DurableRunLogPage } from './api'
  import Icon from './Icon.svelte'

  let { sessionId, open = false, onopen = () => {}, onclose = () => {} }: {
    sessionId: string
    open?: boolean
    onopen?: () => void
    onclose?: () => void
  } = $props()

  let runs = $state<DurableRunInfo[]>([])
  let selected = $state('')
  let logs = $state<DurableRunLogPage | null>(null)
  let completedOpen = $state(false)
  let error = $state('')
  let now = $state(Date.now())

  const active = $derived(runs.filter((run) => run.state === 'queued' || run.state === 'running'))
  const completed = $derived(runs.filter((run) => run.state !== 'queued' && run.state !== 'running'))
  const selectedRun = $derived(runs.find((run) => run.id === selected) ?? null)

  $effect(() => {
    const id = sessionId
    const intervalMs = open ? 2_000 : 10_000
    void refresh(id)
    const timer = setInterval(() => void refresh(id), intervalMs)
    return () => clearInterval(timer)
  })

  $effect(() => {
    if (!open || !selected) return
    void loadLogs(selected)
  })

  $effect(() => {
    if (!open && !active.length) return
    const timer = setInterval(() => { now = Date.now() }, 1_000)
    return () => clearInterval(timer)
  })

  async function refresh(id = sessionId): Promise<void> {
    try {
      const result = await api.durableRuns(id, { limit: 50 })
      if (id !== sessionId) return
      runs = Array.isArray(result?.runs) ? result.runs : []
      error = ''
      if (selected && !runs.some((run) => run.id === selected)) selected = ''
      if (selected && (selectedRun?.state === 'queued' || selectedRun?.state === 'running')) void loadLogs(selected)
    } catch (cause) {
      if (id === sessionId) error = cause instanceof Error ? cause.message : 'Could not load project runs.'
    }
  }

  async function loadLogs(runId: string): Promise<void> {
    try {
      const result = await api.durableRun(sessionId, runId)
      if (selected === runId) logs = result.logs
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load retained logs.'
    }
  }

  function choose(run: DurableRunInfo): void {
    selected = selected === run.id ? '' : run.id
    logs = null
  }

  function elapsed(run: DurableRunInfo): string {
    const start = Date.parse(run.startedAt ?? run.createdAt)
    const end = run.completedAt ? Date.parse(run.completedAt) : now
    const seconds = Math.max(0, Math.floor((end - start) / 1_000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }
</script>

{#if !open}
  <button class="tab" class:hot={active.length > 0} onclick={onopen} title="Open project runs" aria-label="Open project runs">
    <Icon name="terminal" size={13} /><span>Runs{active.length ? ` · ${active.length}` : ''}</span>
  </button>
{:else}
  <aside class="panel" aria-label="Project runs">
    <header>
      <span class="title"><Icon name="terminal" size={14} /> Runs</span>
      <span class="count">{active.length} active</span>
      <button class="close" onclick={onclose} title="Close" aria-label="Close runs panel">×</button>
    </header>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="list">
      {#if !active.length}<p class="empty">No commands are running.</p>{/if}
      {#each active as run (run.id)}
        <button class="run active" onclick={() => choose(run)}>
          <span class="runhead"><b>{run.kind}</b><span>{run.state} · {elapsed(run)}</span></span>
          <span class="command">{run.commandSummary}</span>
          <span class="owner">{run.actorLabel} · {run.executionTarget.kind}</span>
        </button>
        {#if selected === run.id}<div class="detail"><pre>{logs ? `${logs.stdout}${logs.stderr}` : 'Loading retained output…'}</pre></div>{/if}
      {/each}
      <button class="completed-toggle" onclick={() => (completedOpen = !completedOpen)}>
        <Icon name={completedOpen ? 'chevron-down' : 'chevron-right'} size={12} /> Completed · {completed.length}
      </button>
      {#if completedOpen}
        {#each completed as run (run.id)}
          <button class="run" class:bad={run.state === 'failed' || run.state === 'outcome_unknown'} onclick={() => choose(run)}>
            <span class="runhead"><b>{run.kind}</b><span>{run.state} · {elapsed(run)}</span></span>
            <span class="command">{run.commandSummary}</span>
            <span class="owner">{run.actorLabel}{run.exitCode != null ? ` · exit ${run.exitCode}` : ''}</span>
          </button>
          {#if selected === run.id}<div class="detail"><pre>{logs ? `${logs.stdout}${logs.stderr}` : 'Loading retained output…'}</pre></div>{/if}
        {/each}
      {/if}
    </div>
  </aside>
{/if}

<style>
  .tab { position: absolute; top: 10.15rem; right: 0; z-index: 5; display: flex; align-items: center; gap: .38rem;
    padding: .27rem .55rem; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong);
    border-right: 0; border-radius: 999px 0 0 999px; font-size: .74rem; }
  .tab:hover, .tab.hot { border-color: var(--good); }
  .tab.hot { color: var(--good); }
  .panel { position: relative; flex: 0 0 clamp(280px, 40%, 440px); width: clamp(280px, 40%, 440px); min-width: 0;
    min-height: 0; display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--border-strong); }
  header { display: flex; align-items: center; gap: .45rem; padding: .5rem .65rem; border-bottom: 1px solid var(--border); }
  .title { display: flex; align-items: center; gap: .4rem; font-size: .82rem; font-weight: 600; }
  .count { margin-left: auto; color: var(--muted); font-size: .7rem; }
  .close { padding: 0 .2rem; color: inherit; opacity: .7; }
  .list { flex: 1; min-height: 0; overflow: auto; padding: .5rem; }
  .run { width: 100%; display: flex; flex-direction: column; gap: .18rem; margin-bottom: .35rem; padding: .48rem;
    text-align: left; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
  .run.active { border-color: color-mix(in srgb, var(--good) 45%, var(--border)); }
  .run.bad { border-color: color-mix(in srgb, var(--bad-text) 45%, var(--border)); }
  .runhead { display: flex; justify-content: space-between; gap: .4rem; font-size: .7rem; text-transform: capitalize; }
  .runhead span, .owner { color: var(--muted); }
  .command { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: .7rem var(--mono); }
  .owner { font-size: .66rem; }
  .detail { margin: -.15rem 0 .45rem; border: 1px solid var(--border); border-top: 0; border-radius: 0 0 var(--r-md) var(--r-md); }
  .detail pre { max-height: 280px; overflow: auto; margin: 0; padding: .5rem; white-space: pre-wrap; overflow-wrap: anywhere; font: .68rem/1.4 var(--mono); }
  .completed-toggle { display: flex; align-items: center; gap: .3rem; width: 100%; padding: .5rem .2rem; color: var(--muted); font-size: .72rem; }
  .empty, .error { margin: .35rem; color: var(--muted); font-size: .74rem; }
  .error { color: var(--bad-text); }
  @container thread-body (max-width: 620px) {
    .panel { flex: 0 0 300px; width: 100%; border-left: 0; border-top: 1px solid var(--border-strong); }
  }
</style>
