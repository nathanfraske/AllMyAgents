<script lang="ts">
  import { store } from './store.svelte'
  import { settings } from './settings.svelte'
  import ProviderLogo from './ProviderLogo.svelte'

  let { onclose }: { onclose: () => void } = $props()

  let addProvider = $state<'claude' | 'codex'>('claude')
  let addName = $state('')
  let rescanning = $state(false)

  const loginCmd = $derived(
    `pnpm login:${addProvider} profiles/${addName.trim() || (addProvider + '-b')}`
  )

  async function rescan(): Promise<void> {
    rescanning = true
    await store.rescanProfiles()
    rescanning = false
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onclose()
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="button" tabindex="-1" onclick={onclose} onkeydown={() => {}}></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="Settings">
  <div class="head">
    <h2>Settings</h2>
    <button class="x" onclick={onclose} aria-label="close">×</button>
  </div>

  <div class="body">
    <section>
      <h3>Accounts</h3>
      <div class="accounts">
        {#each store.profiles as p (p.id)}
          <div class="acct">
            <ProviderLogo provider={p.provider} size={14} />
            <span class="aid">{p.id}</span>
            <span class="aprov dim">{p.provider}</span>
          </div>
        {/each}
      </div>
      <div class="add">
        <div class="add-row">
          <select bind:value={addProvider}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <input placeholder="profile name (e.g. claude-work)" bind:value={addName} />
        </div>
        <p class="hint dim">Run this in the project terminal to log in a new account, then Rescan:</p>
        <code class="cmd">{loginCmd}</code>
        <button class="btn" onclick={rescan} disabled={rescanning}>{rescanning ? 'rescanning…' : 'Rescan accounts'}</button>
      </div>
    </section>

    <section>
      <h3>Composer</h3>
      <label class="opt"><input type="checkbox" checked={settings.showTokenEstimate} onchange={() => settings.toggleTokenEstimate()} /> Show next-call token estimate under the chatbox</label>
      <label class="opt"><input type="checkbox" checked={settings.combineQueued} onchange={() => settings.toggleCombineQueued()} /> Auto-combine queued messages (before the model reads them)</label>
    </section>

    <section>
      <h3>Usage</h3>
      <label class="opt"><input type="checkbox" checked={settings.showSpend} onchange={() => settings.toggleSpend()} /> Show accumulated spend</label>
      <label class="opt budget">Plan budget ($/month)
        <input type="number" min="0" placeholder="e.g. 100" value={settings.planBudgetUsd ?? ''}
          onchange={(e) => settings.setBudget(Number((e.target as HTMLInputElement).value) || null)} />
      </label>
      <p class="hint dim">Spend shows as a percent of the plan budget when set. Claude usage (session / week / model) is polled from the free <code>/usage</code> command.</p>
    </section>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(7,7,17,0.55); backdrop-filter: blur(3px); z-index: 40; }
  .modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 41;
    width: min(560px, 92vw); max-height: 84vh; overflow-y: auto;
    background: var(--surface); border: 1px solid var(--border-strong); border-radius: 14px;
    box-shadow: 0 24px 70px rgba(0,0,0,0.6); }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 0.9rem 1.1rem; border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: 1.05rem; }
  .x { font-size: 1.3rem; color: var(--muted); width: 28px; height: 28px; border-radius: 6px; }
  .x:hover { background: var(--surface-2); color: var(--text); }
  .body { padding: 1rem 1.1rem 1.3rem; display: flex; flex-direction: column; gap: 1.3rem; }
  section h3 { margin: 0 0 0.5rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); }
  .accounts { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.6rem; }
  .acct { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.5rem; background: var(--surface-2); border-radius: 7px; }
  .aid { font-weight: 500; }
  .aprov { font-size: 0.72rem; margin-left: auto; }
  .add { display: flex; flex-direction: column; gap: 0.45rem; }
  .add-row { display: flex; gap: 0.4rem; }
  .add-row select { flex: none; }
  .add-row input { flex: 1; }
  .cmd { display: block; background: var(--bg); border: 1px solid var(--border); border-radius: 7px; padding: 0.45rem 0.6rem; font-size: 0.78rem; color: var(--cyan); }
  .btn { align-self: flex-start; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 8px; padding: 0.35rem 0.7rem; }
  .btn:hover { border-color: var(--accent); }
  .opt { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .opt.budget { flex-wrap: wrap; }
  .opt.budget input { width: 6rem; margin-left: auto; }
  .hint { font-size: 0.75rem; line-height: 1.5; }
  .hint code { background: var(--bg); padding: 0 0.25rem; border-radius: 4px; }
</style>
