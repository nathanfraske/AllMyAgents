<script lang="ts">
  import { store } from './store.svelte'
  import { settings } from './settings.svelte'
  import { resetIn } from './time'

  function spendLabel(cost: number): string {
    if (settings.planBudgetUsd && settings.planBudgetUsd > 0) {
      return `${Math.round((cost / settings.planBudgetUsd) * 100)}% of plan`
    }
    return `$${cost.toFixed(3)} this run`
  }

  function claudeState(status?: string): { label: string; cls: string } {
    if (!status) return { label: 'unknown', cls: 'idle' }
    if (status === 'allowed') return { label: 'OK', cls: 'ok' }
    if (status.includes('warning')) return { label: 'near limit', cls: 'warn' }
    return { label: status, cls: 'bad' }
  }
</script>

<div class="usage">
  {#each store.usage as u (u.profileId)}
    {@const cs = claudeState(u.claude?.status)}
    <div class="card" class:blocked={u.blocked}>
      <div class="head">
        <b>{u.profileId}</b>
        {#if u.claude?.isUsingOverage}<span class="tag bad">overage</span>{/if}
      </div>
      {#if u.claudeUsage && u.claudeUsage.length}
        {#each u.claudeUsage as line (line.label)}
          <div class="bars">
            <div class="line small"><span class="muted">{line.label.replace('Current ', '')}</span>
              <span class="reset dim">{line.percent}%</span></div>
            <div class="bar"><div class="fill" class:hot={line.percent > 85} style="width:{line.percent}%"></div></div>
          </div>
        {/each}
      {:else if u.claude}
        <div class="line">
          <span class="state {cs.cls}">{cs.label}</span>
          <span class="muted">{u.claude.rateLimitType ?? '5h'} window</span>
          {#if u.claude.resetsAt}<span class="reset dim">resets {resetIn(u.claude.resetsAt)}</span>{/if}
        </div>
        <div class="hint dim">detailed usage loading…</div>
      {/if}
      {#if u.claude && settings.showSpend && typeof u.totalCostUsd === 'number' && u.totalCostUsd > 0}
        <div class="spend dim" title="spend this hub run">{spendLabel(u.totalCostUsd)}</div>
      {/if}
      {#if u.codex}
        <div class="line">
          <div class="bar"><div class="fill" class:hot={(u.codex.usedPercent ?? 0) > 85} style="width:{u.codex.usedPercent ?? 0}%"></div></div>
        </div>
        <div class="line small">
          <span class="muted">{u.codex.usedPercent ?? '?'}% weekly</span>
          {#if u.codex.resetsAt}<span class="reset dim">resets {resetIn(u.codex.resetsAt)}</span>{/if}
        </div>
      {/if}
      {#if u.blocked}<div class="bad small">blocked: {u.blockedReason}</div>{/if}
    </div>
  {/each}
</div>

<style>
  .usage { display: flex; flex-direction: column; gap: 0.45rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.45rem 0.55rem; }
  .card.blocked { border-color: var(--bad); }
  .head { display: flex; gap: 0.4rem; align-items: baseline; font-size: 0.82rem; }
  .tag { font-size: 0.62rem; border-radius: 4px; padding: 0 0.25rem; }
  .tag.bad { color: var(--bad); border: 1px solid var(--bad); }
  .line { display: flex; gap: 0.4rem; align-items: center; margin-top: 0.3rem; font-size: 0.74rem; }
  .line.small { font-size: 0.68rem; margin-top: 0.15rem; }
  .state { font-weight: 600; }
  .state.ok { color: var(--ok); }
  .state.warn { color: var(--warn); }
  .state.bad { color: var(--bad); }
  .state.idle { color: var(--dim); }
  .reset { margin-left: auto; }
  .bar { flex: 1; height: 5px; background: var(--surface-3); border-radius: 4px; overflow: hidden; }
  .fill { height: 100%; background: var(--accent); }
  .fill.hot { background: var(--warn); }
  .spend { font-size: 0.66rem; margin-top: 0.2rem; }
  .bad { color: var(--bad); }
  .small { font-size: 0.68rem; }
  .bars { margin-top: 0.35rem; }
  .hint { font-size: 0.66rem; margin-top: 0.2rem; }
</style>
