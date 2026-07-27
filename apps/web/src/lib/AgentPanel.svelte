<script lang="ts">
  // Popout side panel: Claude tool-use agents and Codex child-thread agents spawned by this chat, what
  // each is doing, and how its vendor lifecycle ended.
  // Self-contained — it renders its own edge toggle and overlays the right side of ITS pane (so split
  // view gets one panel per pane). Reads only derived data (agentTree.ts) from the items it is given.
  import { buildAgentRuns, summarizeRuns, latestActivity, type AgentRun } from './agentTree'
  import { loadOpenAgentPanels, saveOpenAgentPanels } from './uiState'
  import type { ThreadItem } from './store.svelte'
  import { api } from './api'
  import ItemCard from './ItemCard.svelte'
  import Icon from './Icon.svelte'

  let {
    items,
    sessionId,
    provider,
  }: { items: ThreadItem[]; sessionId: string; provider: 'claude' | 'codex' } = $props()

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
  let stopping = $state(new Set<string>())
  let stopError = $state<Record<string, string>>({})
  let now = $state(Date.now())

  // `now` is threaded in rather than read inside, because staleness is a function of elapsed time: with a
  // frozen clock a wedged agent would keep reading "running" until some unrelated event re-rendered it.
  const runs = $derived(buildAgentRuns(items, now))
  const summary = $derived(summarizeRuns(runs))
  // Newest first: a live agent is what you opened the panel for.
  const ordered = $derived([...runs].reverse())

  // Tick only while something is non-terminal and visible — no idle timers. Stalled runs keep the tick
  // alive so one that comes back to life (a late heartbeat) returns to "running" instead of staying stuck.
  $effect(() => {
    if (!open || summary.running + summary.stalled === 0) return
    const t = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(t)
  })

  /** Status → dot class. Four states, four colours: a failed agent must never read like a done one. */
  function dot(s: AgentRun<ThreadItem>['status']): string {
    return s === 'running' ? 'run' : s === 'failed' ? 'fail' : s === 'stalled' ? 'stall' : 'ok'
  }

  /** The label under the result. `stopped` is called out separately from an error — one is a deliberate
   *  kill, the other is a crash, and collapsing them loses the only thing you'd want to know. */
  function resultLabel(r: AgentRun<ThreadItem>): string {
    if (r.outcome === 'stopped') return 'stopped'
    return r.status === 'failed' ? 'error' : 'returned'
  }

  function elapsed(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000))
    if (!Number.isFinite(s)) return ''
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  }
  function dur(r: AgentRun<ThreadItem>): string {
    const end = r.endedAt ? Date.parse(r.endedAt) : now
    return elapsed(end - Date.parse(r.startedAt))
  }
  /** How long since we last heard anything — the number that actually explains a stalled run. */
  function silentFor(r: AgentRun<ThreadItem>): string {
    return elapsed(now - r.lastSignalAt)
  }

  function stopTarget(r: AgentRun<ThreadItem>): string | undefined {
    return provider === 'claude' ? r.taskId : r.id
  }

  async function stopAgent(r: AgentRun<ThreadItem>): Promise<void> {
    const target = stopTarget(r)
    if (!target) return
    stopping = new Set(stopping).add(r.id)
    stopError = { ...stopError, [r.id]: '' }
    const out = await api.interruptAgent(sessionId, target, r.description)
    if (out.error) {
      const next = new Set(stopping)
      next.delete(r.id)
      stopping = next
      stopError = { ...stopError, [r.id]: `stop failed: ${out.error}` }
    }
  }

  /** One line describing the agent's most recent signal — the "what is it doing right now" answer. */
  function nowDoing(r: AgentRun<ThreadItem>): string {
    if (r.status === 'stalled') return `no signal for ${silentFor(r)} — last seen ${r.lastTool ?? 'working'}`
    const last = latestActivity(r)
    // A background agent's own messages are not always attributed back to this chat, so the vendor's
    // heartbeat (`task_progress.last_tool_name`) is often the ONLY thing that can answer this.
    if (!last) return r.lastTool ?? (r.status === 'running' ? 'starting…' : 'no activity recorded')
    if (last.kind === 'tool') return `${last.toolName ?? 'tool'}`
    if (last.kind === 'thinking') return 'thinking…'
    return (last.text ?? '').replace(/\s+/g, ' ').slice(0, 120)
  }
</script>

{#if runs.length}
  {#if !open}
    <button class="tab" class:live={summary.running > 0} onclick={() => setOpen(true)} title="Show the agents this chat spawned">
      <!-- Worst-status-wins on the collapsed badge: a failure must not be hidden behind a green dot just
           because something else is still running. -->
      <span class="dot {summary.failed ? 'fail' : summary.stalled ? 'stall' : summary.running ? 'run' : 'ok'}"></span>
      {summary.running ? `${summary.running} running` : `${summary.total} agent${summary.total === 1 ? '' : 's'}`}
    </button>
  {:else}
    <aside class="panel" aria-label="Agents">
      <header class="phead">
        <span class="ptitle">Agents</span>
        <span class="dim counts">
          {#if summary.running}{summary.running} running · {/if}{summary.done} done{#if summary.failed} · {summary.failed} failed{/if}{#if summary.stalled} · {summary.stalled} stalled{/if}
        </span>
        <button class="x" onclick={() => setOpen(false)} title="Close">✕</button>
      </header>

      <div class="plist scroll">
        {#each ordered as r (r.id)}
          <!-- `toolCount` counts what this chat SAW; `toolUses` is the vendor's own count, which is the
               only number available for an agent whose steps were never attributed back here.
               Declared HERE rather than beside its use below: `{@const}` has to be the immediate child of
               a block ({#each}/{#if}/…), and inside the plain <div> it reads most naturally in, it is a
               compile error rather than a runtime one — so it takes the whole dev server down. -->
          {@const tools = r.toolCount || r.toolUses || 0}
          <div class="run" class:nested={!!r.parentId}>
            <button class="rhead" onclick={() => (expanded = expanded === r.id ? null : r.id)}>
              <span class="dot {dot(r.status)}"></span>
              <span class="rdesc" title={r.description}>{r.description}</span>
              <span class="rmeta dim">{dur(r)}</span>
            </button>
            <div class="rsub dim">
              <!-- The status word is spelled out, not left to the dot alone: colour is the fast read, but
                   "failed" vs "done" is exactly the distinction that must survive a colourblind viewer. -->
              <span class="chip st {dot(r.status)}">{r.outcome === 'stopped' ? 'stopped' : r.status}</span>
              {#if r.subagentType}<span class="chip">{r.subagentType}</span>{/if}
              {#if r.background}<span class="chip">background</span>{/if}
              {#if tools}<span class="chip">{tools} tool{tools === 1 ? '' : 's'}</span>{/if}
              <span class="doing">{nowDoing(r)}</span>
              {#if (r.status === 'running' || r.status === 'stalled') && stopTarget(r)}
                <button
                  class="stop-agent"
                  title={`Stop ${r.description}`}
                  disabled={stopping.has(r.id)}
                  onclick={() => stopAgent(r)}
                >
                  {stopping.has(r.id) ? 'stopping…' : 'stop'}
                </button>
              {/if}
            </div>
            {#if stopError[r.id]}<div class="stoperr" role="alert">{stopError[r.id]}</div>{/if}

            {#if expanded === r.id}
              <div class="detail">
                {#if r.activity.length}
                  <!-- Rendered with the SAME ItemCard the main transcript uses, so a sub-agent's tool
                       calls, diffs, reasoning and messages read exactly as they would in a chat — just
                       segregated into this panel instead of flooding the conversation. -->
                  <div class="acts">
                    {#each r.activity.slice(-120) as a (a.key)}
                      <ItemCard item={a} />
                    {/each}
                  </div>
                {:else}
                  <div class="dim empty">This agent hasn't reported anything yet.</div>
                {/if}
                <!-- Claude: this block used to print the spawn's raw launch ACK — ~1KB of internal
                     metadata — as though the agent had said it. agentTree now refuses that ACK and uses
                     only the vendor's terminal summary. Codex 0.145 has no separate terminal summary:
                     after the hub subscribes to the child thread, its report stays in the attributed
                     activity cards above. If that subscription is unavailable there is no report to
                     invent, so no collab-state/message blob is rendered. -->
                {#if r.result}
                  <div class="result" class:bad={r.status === 'failed'}>
                    <div class="rlabel dim">{resultLabel(r)}</div>
                    <pre>{r.result.slice(0, 4000)}</pre>
                  </div>
                {:else if r.status === 'failed'}
                  <div class="result bad">
                    <div class="rlabel dim">{resultLabel(r)}</div>
                    <pre>The agent {r.outcome === 'stopped' ? 'was stopped' : 'failed'} without returning a report.</pre>
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
  .stop-agent {
    flex: none; border: 1px solid var(--border-strong); border-radius: 999px; padding: 0 0.38rem;
    background: transparent; color: inherit; font-size: 0.66rem; cursor: pointer;
  }
  .stop-agent:hover:not(:disabled) { border-color: var(--bad, #e06c6c); color: var(--bad, #e06c6c); }
  .stop-agent:disabled { cursor: wait; opacity: 0.6; }
  .stoperr { margin-top: 0.25rem; color: var(--bad, #e06c6c); font-size: 0.68rem; }
  .detail { margin-top: 0.45rem; border-top: 1px dashed var(--border); padding-top: 0.4rem; }
  .acts { display: flex; flex-direction: column; gap: 0.2rem; max-height: 40vh; overflow-y: auto; }
  .empty { font-size: 0.72rem; padding: 0.2rem 0; }
  .result { margin-top: 0.4rem; }
  .rlabel { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .result pre { margin: 0.15rem 0 0; white-space: pre-wrap; word-break: break-word; font-size: 0.72rem; max-height: 32vh; overflow-y: auto; }
  .result.bad pre { color: var(--bad, #e06c6c); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--border-strong); }
  .dot.ok { background: #2e9e63; }
  .dot.fail { background: #e06c6c; }
  .dot.run { background: var(--accent); }
  /* Amber, and NOT pulsing — a stalled agent is precisely the one that is no longer moving. */
  .dot.stall { background: #d9a441; }
  .chip.st { text-transform: uppercase; letter-spacing: 0.03em; font-size: 0.62rem; }
  .chip.st.ok { color: #2e9e63; border-color: #2e9e6355; }
  .chip.st.fail { color: #e06c6c; border-color: #e06c6c55; }
  .chip.st.stall { color: #d9a441; border-color: #d9a44155; }
  .chip.st.run { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
  @media (prefers-reduced-motion: no-preference) {
    .dot.run { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  }
</style>
