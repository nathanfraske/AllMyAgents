<script lang="ts">
  import { store } from './store.svelte'
  import { settings } from './settings.svelte'
  import { api, type MeshStatus } from './api'
  import ProviderLogo from './ProviderLogo.svelte'
  import { modelsFor } from './catalog'

  let { onclose }: { onclose: () => void } = $props()

  // Mesh remote-access status (loaded once; refreshed after a toggle).
  let mesh = $state<MeshStatus | null>(null)
  let meshBusy = $state(false)
  $effect(() => {
    void api.mesh().then((m) => (mesh = m))
  })
  async function toggleMesh(on: boolean): Promise<void> {
    meshBusy = true
    try {
      mesh = await api.setMesh(on)
    } finally {
      meshBusy = false
    }
  }

  let addProvider = $state<'claude' | 'codex'>('claude')
  let addName = $state('')
  let rescanning = $state(false)

  let loginState = $state<'idle' | 'waiting' | 'done' | 'error'>('idle')
  let loginMsg = $state('')

  const loginCmd = $derived(
    `pnpm login:${addProvider} profiles/${addName.trim() || (addProvider + '-b')}`
  )

  async function rescan(): Promise<void> {
    rescanning = true
    await store.rescanProfiles()
    rescanning = false
  }

  // One-click login: opens a terminal/browser on the hub, then waits for the account to
  // register. Local component state only — no store state for the in-flight login.
  async function login(): Promise<void> {
    const name = addName.trim()
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      loginState = 'error'
      loginMsg = 'Enter a profile name first (letters, numbers, dashes or underscores).'
      return
    }
    loginState = 'waiting'
    loginMsg =
      addProvider === 'claude'
        ? 'A terminal will open with Claude — type /login there and finish the browser sign-in…'
        : 'A terminal and browser will open for Codex sign-in — complete it there…'
    try {
      const r = await api.login(addProvider, name)
      if (r.ok) {
        loginState = 'done'
        loginMsg = `Added ${r.added ?? name}. It now appears in your accounts.`
        await store.rescanProfiles()
        addName = ''
      } else {
        loginState = 'error'
        loginMsg = r.error ?? 'Login did not complete. Finish the sign-in, then Rescan.'
      }
    } catch (e) {
      loginState = 'error'
      loginMsg = e instanceof Error ? e.message : 'Login request failed.'
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onclose()
  }

  // --- Auto monthly budget from subscription level -------------------------------------
  // Monthly USD budget per known subscription tier. Deliberately simple, documented anchors
  // (edit to taste): the entry "Pro" / "Plus" tier ≈ $20, Claude Max 5× ≈ $100, Max 20× ≈ $200.
  // Keyed by the tier string (normalised to lowercase alphanumerics) as it appears in the live
  // usage snapshot. The Max* keys are only reachable if a usage source ever reports such a tier
  // string — Claude accounts today expose only session/week percentages, no dollar tier.
  const PLAN_BUDGETS: Record<string, number> = {
    free: 0,
    plus: 20, // ChatGPT Plus
    pro: 20, // Claude Pro / ChatGPT entry "Pro"
    team: 30,
    business: 30,
    enterprise: 60,
    max: 100, max5: 100, max5x: 100, // Claude Max 5×
    max20: 200, max20x: 200, // Claude Max 20×
  }
  // When a tier can't be read (Claude, or an unknown Codex plan), assume the entry tier and flag it.
  const FALLBACK_USD = 20
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

  let autoResult = $state<{ total: number; lines: string[]; assumed: number } | null>(null)

  // Sum a monthly budget across the user's accounts from live usage data — entirely client-side.
  // Codex accounts carry `codex.planType` (e.g. "pro"); Claude accounts have no dollar tier.
  function autoDetectBudget(): void {
    if (store.profiles.length === 0) {
      autoResult = { total: 0, lines: ['No accounts detected yet — add one above, then try again.'], assumed: 0 }
      return
    }
    let total = 0
    let assumed = 0
    const lines: string[] = []
    for (const p of store.profiles) {
      const snap = store.usage.find((u) => u.profileId === p.id)
      // `planType` is present on Codex snapshots but isn't in the web UsageSnapshot type — read it safely.
      const planType = (snap?.codex as { planType?: string } | undefined)?.planType
      if (p.provider === 'codex' && planType && norm(planType) in PLAN_BUDGETS) {
        const usd = PLAN_BUDGETS[norm(planType)]!
        total += usd
        lines.push(`${p.id}: ${planType} → $${usd}/mo`)
      } else {
        total += FALLBACK_USD
        assumed++
        const why = p.provider === 'claude' ? 'Claude tier not in usage data' : planType ? `unknown plan "${planType}"` : 'no usage data yet'
        lines.push(`${p.id}: ${why} → assumed $${FALLBACK_USD}/mo`)
      }
    }
    settings.setBudget(total || null)
    autoResult = { total, lines, assumed }
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
          <select bind:value={addProvider} disabled={loginState === 'waiting'}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <input placeholder="profile name (e.g. claude-work)" bind:value={addName} disabled={loginState === 'waiting'} />
          <button class="btn primary" onclick={login} disabled={loginState === 'waiting'}>
            {loginState === 'waiting' ? 'waiting…' : 'Log in'}
          </button>
        </div>
        {#if loginState !== 'idle'}
          <p class="status {loginState}">{loginMsg}</p>
        {/if}
        <p class="hint dim">One click opens a terminal + browser to sign in (Windows). On other platforms, run this manually then Rescan:</p>
        <code class="cmd">{loginCmd}</code>
        <button class="btn" onclick={rescan} disabled={rescanning}>{rescanning ? 'rescanning…' : 'Rescan accounts'}</button>
      </div>
    </section>

    <section>
      <h3>Defaults for new chats</h3>
      <label class="opt row2">Account
        <select value={settings.defaultAccount} onchange={(e) => settings.set('defaultAccount', (e.target as HTMLSelectElement).value)}>
          <option value="">last used</option>
          {#each store.profiles as p (p.id)}<option value={p.id}>{p.id} · {p.provider}</option>{/each}
        </select>
      </label>
      <label class="opt row2">Permission mode
        <select value={settings.defaultPermissionMode} onchange={(e) => settings.set('defaultPermissionMode', (e.target as HTMLSelectElement).value)}>
          <option value="safe">Safe (ask)</option>
          <option value="edits">Edits free</option>
          <option value="full">Full access</option>
        </select>
      </label>
      <label class="opt row2">Claude model
        <select value={settings.defaultClaudeModel} onchange={(e) => settings.set('defaultClaudeModel', (e.target as HTMLSelectElement).value)}>
          <option value="">catalog default</option>
          {#each modelsFor('claude') as m (m.slug)}<option value={m.slug}>{m.name}</option>{/each}
        </select>
      </label>
      <label class="opt row2">Codex model
        <select value={settings.defaultCodexModel} onchange={(e) => settings.set('defaultCodexModel', (e.target as HTMLSelectElement).value)}>
          <option value="">catalog default</option>
          {#each modelsFor('codex') as m (m.slug)}<option value={m.slug}>{m.name}</option>{/each}
        </select>
      </label>
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
      <div class="budget-auto">
        <button class="btn" onclick={autoDetectBudget}>Auto-detect from plan</button>
        <span class="hint dim">Sums a monthly budget from each account's detected subscription tier.</span>
      </div>
      {#if autoResult}
        <div class="auto-result">
          <div class="auto-total">Budget set to <b>${autoResult.total}/mo</b>{#if autoResult.assumed} · {autoResult.assumed} account{autoResult.assumed === 1 ? '' : 's'} fell back to an assumed tier{/if}</div>
          <ul class="auto-list">
            {#each autoResult.lines as l (l)}<li class="dim">{l}</li>{/each}
          </ul>
        </div>
      {/if}
      <p class="hint dim">Spend shows as a percent of the plan budget when set. Claude usage (session / week / model) is polled from the free <code>/usage</code> command — Claude has no dollar tier in the data, so those accounts fall back to the entry tier.</p>
    </section>

    <section>
      <h3>Remote access (mesh)</h3>
      {#if mesh}
        <label class="opt"><input type="checkbox" checked={mesh.enabled} disabled={meshBusy} onchange={(e) => toggleMesh((e.target as HTMLInputElement).checked)} /> Expose this hub to my AllMyStuff fleet</label>
        <div class="mesh-status">
          {#if !mesh.nodePresent && mesh.enabled}
            <span class="mstate off">No AllMyStuff node detected on this PC — hub stays local-only.</span>
          {:else if mesh.exposed}
            <span class="mstate on">Live as "{mesh.label}" ({mesh.siteId}). On another fleet PC, open:</span>
            <code class="cmd">{mesh.peerUrl}</code>
          {:else if mesh.enabled}
            <span class="mstate warn">Enabled, but not exposed{mesh.error ? ` — ${mesh.error}` : ''}.</span>
          {:else}
            <span class="dim">Off — your hub stays bound to 127.0.0.1 only.</span>
          {/if}
        </div>
        <p class="hint dim">Rides your AllMyStuff mesh as a "site" (no Tailscale). The hub always stays on loopback — the local node tunnels it to your own devices, which need no grant. <b>Heads-up:</b> the hub grants full control and has no auth yet, so only expose it on a fleet you trust — a per-device token is coming before this is safe to leave on.</p>
      {:else}
        <p class="dim">Checking mesh…</p>
      {/if}
    </section>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(7,7,17,0.55); backdrop-filter: blur(3px); z-index: 40; }
  .modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 41;
    width: min(560px, 92vw); max-height: 84vh; overflow-y: auto;
    background: var(--surface); border: 1px solid var(--border-strong); border-radius: 14px;
    box-shadow: 0 24px 70px rgba(0,0,0,0.6); }
  @keyframes modal-in { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: no-preference) {
    .backdrop { animation: modal-in 0.15s var(--ease); }
    .modal { animation: modal-in 0.16s var(--ease); }
  }
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
  .add-row .btn { flex: none; align-self: stretch; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .status { font-size: 0.78rem; line-height: 1.45; margin: 0.1rem 0 0.15rem; }
  .status.waiting { color: var(--warn); }
  .status.done { color: var(--ok); }
  .status.error { color: var(--bad); }
  .opt { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .opt.budget { flex-wrap: wrap; }
  .opt.budget input { width: 6rem; margin-left: auto; }
  .opt.row2 { justify-content: space-between; }
  .opt.row2 select { min-width: 11rem; }
  .hint { font-size: 0.75rem; line-height: 1.5; }
  .hint code { background: var(--bg); padding: 0 0.25rem; border-radius: 4px; }
  .budget-auto { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
  .budget-auto .hint { flex: 1; min-width: 12rem; }
  .auto-result { background: var(--surface-2); border: 1px solid var(--border); border-radius: 9px; padding: 0.55rem 0.7rem; margin-bottom: 0.6rem; }
  .auto-total { font-size: 0.8rem; margin-bottom: 0.35rem; }
  .auto-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; }
  .auto-list li { font-size: 0.73rem; font-family: var(--mono); }
  .mesh-status { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.5rem; }
  .mstate { font-size: 0.78rem; line-height: 1.45; }
  .mstate.on { color: var(--ok); }
  .mstate.warn { color: var(--warn); }
  .mstate.off { color: var(--muted); }
</style>
