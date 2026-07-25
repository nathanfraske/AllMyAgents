<script lang="ts">
  // Popout side panel: the sub-agents this chat has spawned, what each is doing, and how it ended.
  // Self-contained — it renders its own edge toggle and overlays the right side of ITS pane (so split
  // view gets one panel per pane). Reads only derived data (agentTree.ts) from the items it is given.
  import { buildAgentRuns, summarizeRuns, latestActivity, type AgentTreeItem, type AgentRun } from './agentTree'
  import { loadOpenAgentPanels, saveOpenAgentPanels } from './uiState'
  import Icon from './Icon.svelte'

  let { items, sessionId }: { items: AgentTreeItem[]; sessionId: string } = $props()

  // Popped-out state is remembered PER CHAT, so the panel is still open when you come back to this chat
  // after a reload or a hub restart (the runs themselves rebuild from journal history).
  // `open` is DERIVED from the id set + the current sessionId — a pane can be re-pointed at a different
  // chat without remounting, and reading the set once at init would leave the panel showing the previous
  // chat's state.
  let openIds = $state(new Set(loadOpenAgentPanels()))
  const open = $derived(openIds.has(sessionId))
  function setOpen(v: boolean): void {
    const next = new Set(openIds)
    if (v) next.add(sessionId)
    else next.delete(sessionId)
    openIds = next
    saveOpenAgentPanels([...next])
  }
  let expanded = $state<string | null>(null)
  let now = $state(Date.now())

  const runs = $derived(buildAgentRuns(items))
  const summary = $derived(summarizeRuns(runs))
  // Newest first: a live agent is what you opened the panel for.
  const ordered = $derived([...runs].reverse())

  // Tick only while something is actually running and visible — no idle timers.
  $effect(() => {
    if (!open || summary.running === 0) return
    const t = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(t)
  })

  function dur(r: AgentRun): string {
    const end = r.endedAt ? Date.parse(r.endedAt) : now
    const s = Math.max(0, Math.round((end - Date.parse(r.startedAt)) / 1000))
    if (!Number.isFinite(s)) return ''
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  }

  /** One line describing the agent's most recent signal — the "what is it doing right now" answer. */
  function nowDoing(r: AgentRun): string {
    const last = latestActivity(r)
    if (!last) return r.status === 'running' ? 'starting…' : 'no activity recorded'
    if (last.kind === 'tool') return `${last.toolName ?? 'tool'}`
    if (last.kind === 'thinking') return 'thinking…'
    return (last.text ?? '').replace(/\s+/g, ' ').slice(0, 120)
  }
</script>

{#if runs.length}
  {#if !open}
    <button class="tab" class:live={summary.running > 0} onclick={() => setOpen(true)} title="Show the agents this chat spawned">
      <span class="dot {summary.running ? 'run' : summary.failed ? 'fail' : 'ok'}"></span>
      {summary.running ? `${summary.running} running` : `${summary.total} agent${summary.total === 1 ? '' : 's'}`}
    </button>
  {:else}
    <aside class="panel" aria-label="Agents">
      <header class="phead">
        <span class="ptitle">Agents</span>
        <span class="dim counts">
          {#if summary.running}{summary.running} running · {/if}{summary.done} done{#if summary.failed} · {summary.failed} failed{/if}
        </span>
        <button class="x" onclick={() => setOpen(false)} title="Close">✕</button>
      </header>

      <div class="plist scroll">
        {#each ordered as r (r.id)}
          <div class="run" class:nested={!!r.parentId}>
            <button class="rhead" onclick={() => (expanded = expanded === r.id ? null : r.id)}>
              <span class="dot {r.status === 'running' ? 'run' : r.status === 'failed' ? 'fail' : 'ok'}"></span>
              <span class="rdesc" title={r.description}>{r.description}</span>
              <span class="rmeta dim">{dur(r)}</span>
            </button>
            <div class="rsub dim">
              {#if r.subagentType}<span class="chip">{r.subagentType}</span>{/if}
              {#if r.background}<span class="chip">background</span>{/if}
              {#if r.toolCount}<span class="chip">{r.toolCount} tool{r.toolCount === 1 ? '' : 's'}</span>{/if}
              <span class="doing">{nowDoing(r)}</span>
            </div>

            {#if expanded === r.id}
              <div class="detail">
                {#if r.activity.length}
                  <div class="acts">
                    {#each r.activity.slice(-40) as a, i (i)}
                      <div class="act">
                        <span class="akind dim">{a.kind === 'tool' ? (a.toolName ?? 'tool') : a.kind}</span>
                        {#if a.kind !== 'tool' && a.text}<span class="atext">{a.text.replace(/\s+/g, ' ').slice(0, 240)}</span>{/if}
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="dim empty">This agent hasn't reported anything yet.</div>
                {/if}
                {#if r.result}
                  <div class="result" class:bad={r.status === 'failed'}>
                    <div class="rlabel dim">{r.status === 'failed' ? 'error' : 'returned'}</div>
                    <pre>{r.result.slice(0, 4000)}</pre>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </aside>
  {/if}
{/if}

<style>
  /* Anchored to the pane (App.svelte gives .pane a containing block), so split view gets one per pane. */
  .tab {
    position: absolute; top: 3.1rem; right: 0; z-index: 5;
    display: flex; align-items: center; gap: 0.4rem;
    background: var(--surface); border: 1px solid var(--border-strong); border-right: none;
    border-radius: 999px 0 0 999px; padding: 0.25rem 0.6rem 0.25rem 0.55rem;
    font-size: 0.74rem; color: var(--text); cursor: pointer;
  }
  .tab:hover { border-color: var(--accent); }
  .panel {
    position: absolute; top: 2.9rem; right: 0; bottom: 0; z-index: 6;
    width: min(360px, 62%); display: flex; flex-direction: column;
    background: var(--surface); border-left: 1px solid var(--border-strong);
    box-shadow: -12px 0 28px -22px rgba(0, 0, 0, 0.8);
  }
  .phead { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.65rem; border-bottom: 1px solid var(--border); }
  .ptitle { font-weight: 600; font-size: 0.82rem; }
  .counts { font-size: 0.72rem; flex: 1; }
  .x { background: none; border: none; color: inherit; cursor: pointer; opacity: 0.7; padding: 0 0.2rem; }
  .x:hover { opacity: 1; }
  .plist { flex: 1; overflow-y: auto; padding: 0.4rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .run { border: 1px solid var(--border); border-radius: 10px; padding: 0.4rem 0.5rem; background: var(--bg, transparent); }
  .run.nested { margin-left: 0.75rem; border-left: 2px solid var(--border-strong); }
  .rhead { display: flex; align-items: center; gap: 0.45rem; width: 100%; background: none; border: none; color: inherit; cursor: pointer; padding: 0; text-align: left; }
  .rdesc { flex: 1; font-size: 0.78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rmeta { font-size: 0.7rem; flex: none; }
  .rsub { display: flex; align-items: center; gap: 0.3rem; margin-top: 0.25rem; font-size: 0.7rem; overflow: hidden; }
  .chip { border: 1px solid var(--border); border-radius: 999px; padding: 0 0.35rem; flex: none; }
  .doing { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { margin-top: 0.45rem; border-top: 1px dashed var(--border); padding-top: 0.4rem; }
  .acts { display: flex; flex-direction: column; gap: 0.2rem; max-height: 40vh; overflow-y: auto; }
  .act { display: flex; gap: 0.35rem; font-size: 0.72rem; }
  .akind { flex: none; }
  .atext { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { font-size: 0.72rem; padding: 0.2rem 0; }
  .result { margin-top: 0.4rem; }
  .rlabel { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .result pre { margin: 0.15rem 0 0; white-space: pre-wrap; word-break: break-word; font-size: 0.72rem; max-height: 32vh; overflow-y: auto; }
  .result.bad pre { color: var(--bad, #e06c6c); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--border-strong); }
  .dot.ok { background: #2e9e63; }
  .dot.fail { background: #e06c6c; }
  .dot.run { background: var(--accent); }
  @media (prefers-reduced-motion: no-preference) {
    .dot.run { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  }
</style>
