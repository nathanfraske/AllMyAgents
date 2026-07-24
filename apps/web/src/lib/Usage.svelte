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
              <span class="reset dim">{line.percent}%{#if line.resetsAt} · {resetIn(line.resetsAt)}{/if}</span></div>
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
  .usage { display: flex; flex-direction: column; gap: var(--space-3); }
  .card { background: var(--surface); border: 1px solid var(--border-subtle); border-radius: var(--r-md); padding: var(--space-3); box-shadow: var(--edge-hi); }
  .card.blocked { background: color-mix(in srgb, var(--bad) 8%, var(--surface)); border-color: color-mix(in srgb, var(--bad) 35%, transparent); }
  .head { display: flex; gap: var(--space-2); align-items: baseline; font-size: var(--text-sm); }
  .tag { font-size: var(--text-2xs); border-radius: var(--r-xs); padding: 0 0.3rem; }
  .tag.bad { color: var(--bad-text); background: color-mix(in srgb, var(--bad) 15%, transparent); }
  .line { display: flex; gap: var(--space-2); align-items: center; margin-top: var(--space-2); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .line.small { font-size: var(--text-2xs); margin-top: 0.15rem; }
  .state { font-weight: var(--fw-semibold); }
  .state.ok { color: var(--ok); }
  .state.warn { color: var(--warn); }
  .state.bad { color: var(--bad-text); }
  .state.idle { color: var(--dim); }
  .reset { margin-left: auto; }
  .bar { flex: 1; height: 5px; background: var(--surface-3); border-radius: var(--r-pill); overflow: hidden; }
  .fill { height: 100%; border-radius: var(--r-pill); background: linear-gradient(90deg, var(--accent), var(--accent-hover)); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2); }
  .fill.hot { background: var(--warn); }
  .spend { font-size: var(--text-2xs); margin-top: var(--space-1); font-variant-numeric: tabular-nums; }
  .bad { color: var(--bad-text); }
  .small { font-size: var(--text-2xs); }
  .bars { margin-top: var(--space-2); }
  .hint { font-size: var(--text-2xs); margin-top: var(--space-1); }
  @media (prefers-reduced-motion: no-preference) {
    .fill { transition: width var(--dur-slow) var(--ease); }
  }
</style>
