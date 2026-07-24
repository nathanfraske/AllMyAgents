<script lang="ts">
  import { api } from './api'
  import { store } from './store.svelte'
  import ItemCard from './ItemCard.svelte'
  import ContextMeter from './ContextMeter.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import TraitsControl from './TraitsControl.svelte'
  import PermissionPicker from './PermissionPicker.svelte'
  import AccountPicker from './AccountPicker.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import Icon from './Icon.svelte'
  import { findModel, defaultModelFor } from './catalog'
  import { settings } from './settings.svelte'

  let { sessionId, paneIndex = 0, multiPane = false }: { sessionId?: string; paneIndex?: number; multiPane?: boolean } =
    $props()

  let text = $state('')
  let scroller = $state<HTMLDivElement | null>(null)
  let stick = $state(true)
  // per-session picker state, seeded from the record
  let modelBySession = $state<Record<string, string>>({})
  let optionsBySession = $state<Record<string, Record<string, string>>>({})

  const activeId = $derived(sessionId ?? store.selectedId ?? null)
  const view = $derived(activeId ? (store.sessions[activeId] ?? null) : null)
  const sid = $derived(view?.record.id ?? '')
  const model = $derived(modelBySession[sid] ?? view?.record.model ?? '')
  const options = $derived(optionsBySession[sid] ?? (view?.record.effort ? { effort: view.record.effort } : {}))
  const modelDef = $derived(
    view ? (findModel(model) ?? defaultModelFor(view.record.provider)) : undefined
  )
  const active = $derived(view?.record.status === 'active' || view?.record.status === 'starting')
  // Codex can append input to a running turn (steer); Claude has no steer, so it queues.
  const steerable = $derived(active && view?.record.provider === 'codex')
  const st = $derived(view ? store.status(view) : { key: 'idle', label: '' })
  const approvals = $derived(view ? store.approvals.filter((a) => a.sessionId === view.record.id) : [])
  const queue = $derived(sid ? store.queueFor(sid) : [])

  function fmtTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
  }
  const estTokens = $derived.by(() => {
    if (!view) return 0
    const ctx = view.contextUsed ?? 0
    const pending = queue.join('\n\n')
    const draft = text + (pending ? '\n\n' + pending : '')
    return ctx + Math.ceil(draft.length / 4)
  })

  // "Received / thinking" indicator: a turn is in flight while turnStartedAt is set. A ticking
  // clock drives the elapsed readout; it only runs while thinking (torn down otherwise).
  const thinking = $derived(!!view && view.turnStartedAt != null)
  const liveTok = $derived(view?.liveTokens)
  let now = $state(Date.now())
  $effect(() => {
    if (!thinking) return
    const iv = setInterval(() => (now = Date.now()), 250)
    return () => clearInterval(iv)
  })
  const elapsedMs = $derived(thinking && view?.turnStartedAt ? Math.max(0, now - view.turnStartedAt) : 0)
  function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  $effect(() => {
    view?.items.length
    void thinking // also keep pinned to bottom when the thinking row appears
    if (stick && scroller) scroller.scrollTop = scroller.scrollHeight
  })

  function onScroll(): void {
    if (!scroller) return
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
  }

  function setModel(slug: string): void {
    if (sid) modelBySession = { ...modelBySession, [sid]: slug }
  }
  function setOption(id: string, value: string): void {
    if (sid) optionsBySession = { ...optionsBySession, [sid]: { ...options, [id]: value } }
  }

  async function send(): Promise<void> {
    if (!view || !text.trim()) return
    const body = text
    text = ''
    // Busy? Codex steers the running turn; Claude queues (combined/sent on turn end).
    if (active) {
      if (view.record.provider === 'codex') {
        const out = await api.steer(view.record.id, body)
        if (out.error) alert(out.error)
      } else {
        store.enqueue(view.record.id, body)
      }
      return
    }
    stick = true
    store.noteSent(view.record.id) // immediate "received / thinking" feedback
    const out = await api.send(view.record.id, body, {
      model: model || undefined,
      effort: options.effort ?? undefined,
      serviceTier: options.serviceTier ?? undefined,
    })
    if (out.error) alert(out.error)
  }

  async function stop(): Promise<void> {
    if (view) await api.interrupt(view.record.id)
  }

  async function decide(id: string, approve: boolean): Promise<void> {
    await api.decide(id, approve)
    await store.refreshSideData()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  function summarizeApproval(payload: unknown): string {
    const p = payload as { toolName?: string; input?: unknown }
    if (p.toolName) return `${p.toolName}  ${JSON.stringify(p.input ?? {}).slice(0, 200)}`
    return JSON.stringify(payload).slice(0, 220)
  }
</script>

{#if !view}
  <div class="empty dim">select a session, or press + to spawn one</div>
{:else}
  <div class="head">
    <ProviderLogo provider={view.record.provider} size={16} />
    {#if multiPane}
      <select class="paneselect" value={view.record.id} onchange={(e) => store.setPaneSession(paneIndex, (e.target as HTMLSelectElement).value)}>
        {#each store.sessionList as s (s.record.id)}
          <option value={s.record.id}>{s.record.profileId} · {(s.record.worktree ?? s.record.cwd).split(/[\\/]/).pop()}</option>
        {/each}
      </select>
    {:else}
      <span class="title">{view.record.profileId}</span>
    {/if}
    <span class="statuschip {st.key}"><span class="dot {st.key}"></span>{st.label}</span>
    <span class="sub dim">{view.record.model ?? view.record.provider}</span>
    <span class="spacer"></span>
    {#if view.record.worktree}<span class="wt dim">⑂ {view.record.worktree.split(/[\\/]/).pop()}</span>{/if}
    <button class="hicon" title="split view" onclick={() => store.startSplit()}><Icon name="columns" size={15} /></button>
    <button class="hicon" title="close (keeps the chat)" onclick={() => store.closePane(paneIndex)}><Icon name="x" size={15} /></button>
  </div>

  <div class="stream scroll" bind:this={scroller} onscroll={onScroll}>
    {#each view.items as item (item.key)}
      <ItemCard {item} />
    {/each}
    {#if view.items.length === 0 && !thinking}<div class="dim pad">no activity yet — send a message below</div>{/if}
    {#if thinking}
      <div class="thinking">
        <span class="dots"><i></i><i></i><i></i></span>
        <span class="tlabel">thinking</span>
        <span class="tmeta">{fmtElapsed(elapsedMs)}{#if liveTok?.total} · {fmtTokens(liveTok.total)} tokens{/if}</span>
      </div>
    {/if}
  </div>

  <div class="composer-wrap">
    {#each approvals as a (a.id)}
      <div class="approval">
        <div class="atop"><span class="alabel">PENDING APPROVAL</span><span class="dim">{a.kind}</span></div>
        <pre class="abody">{summarizeApproval(a.payload)}</pre>
        <div class="aacts">
          <button class="abtn ok" onclick={() => decide(a.id, true)}>Approve once</button>
          <button class="abtn" onclick={() => decide(a.id, false)}>Decline</button>
        </div>
      </div>
    {/each}

    {#if queue.length}
      <div class="queue">
        <div class="qhead dim">queued · {queue.length}{#if settings.combineQueued && queue.length > 1} · will combine into one{/if} · sends when the turn finishes</div>
        {#each queue as q, i (i)}
          <div class="qrow">
            <input class="qedit" value={q} onchange={(e) => store.editQueued(view.record.id, i, (e.target as HTMLInputElement).value)} />
            <button class="qx" title="recall" onclick={() => store.removeQueued(view.record.id, i)}>✕</button>
          </div>
        {/each}
      </div>
    {/if}

    <div class="composer">
      <textarea rows="2" placeholder={steerable ? 'Steer the running turn… (appended to what Codex is doing now)' : active ? 'Queue a message… (sends when the current turn finishes)' : 'Ask for follow-up changes…  (Enter to send, Shift+Enter for newline)'}
        bind:value={text} onkeydown={onKey}></textarea>
      <div class="cfoot">
        <AccountPicker {view} />
        <ModelPicker provider={view.record.provider} {model} onselect={setModel} />
        {#if modelDef}<TraitsControl descriptors={modelDef.descriptors} values={options} onchange={setOption} />{/if}
        <PermissionPicker sessionId={view.record.id} mode={view.record.permissionMode ?? 'safe'} />
        <span class="spacer"></span>
        <button class="foot-act" onclick={stop} disabled={!active} title="interrupt current turn">interrupt</button>
        <button class="foot-act" onclick={() => api.stop(view.record.id)} title="stop session">stop</button>
        <button class="send-btn" class:queue={active} title={steerable ? 'steer into the running turn' : active ? 'queue message' : 'send'} onclick={send} disabled={!text.trim()}>{steerable ? '⤵' : active ? '⏲' : '↑'}</button>
      </div>
    </div>
    <div class="checkout dim">
      <ContextMeter {view} />
      {#if settings.showTokenEstimate && estTokens > 0}
        <span class="est" title="rough estimate of the next call's input tokens (re-read context + your draft), ≈ chars/4">~{fmtTokens(estTokens)} tokens next call</span>
      {/if}
      <span class="spacer"></span>
      <span>{view.record.repo ? '▣ worktree' : '▣ local'} · {view.record.id.slice(0, 8)}</span>
    </div>
  </div>
{/if}

<style>
  .empty { display: grid; place-items: center; height: 100%; }
  .head { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1rem; border-bottom: 1px solid var(--border); }
  .title { font-weight: 600; }
  .paneselect { max-width: 15rem; font-size: 0.82rem; padding: 0.2rem 0.4rem; }
  .hicon { display: grid; place-items: center; color: var(--muted); width: 26px; height: 24px; border-radius: 6px; }
  .hicon:hover { background: var(--surface-2); color: var(--text); }
  .statuschip { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.72rem; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.45rem; }
  .statuschip.working { color: var(--working); border-color: var(--working); }
  .statuschip.completed { color: var(--ok); border-color: var(--ok); }
  .statuschip.approval { color: var(--warn); border-color: var(--warn); }
  .statuschip.question { color: var(--secondary); border-color: var(--secondary); }
  .statuschip.error { color: var(--bad-text); border-color: var(--bad); }
  .sub { font-size: 0.78rem; }
  .spacer { flex: 1; }
  .wt { font-size: 0.75rem; font-family: var(--mono); }
  .hbtn { font-size: 0.76rem; color: var(--muted); border: 1px solid var(--border); border-radius: 7px; padding: 0.22rem 0.5rem; }
  .hbtn:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text); }
  .hbtn:disabled { opacity: 0.4; cursor: default; }
  .stream { flex: 1; display: flex; flex-direction: column; gap: 0.55rem; padding: 1rem 1.1rem; max-width: 900px; width: 100%; margin: 0 auto; }
  @media (prefers-reduced-motion: no-preference) { .stream > :global(*) { animation: fade-in 0.22s var(--ease); } }
  .pad { padding: 1rem 0; }
  .thinking { display: flex; align-items: center; gap: 0.5rem; padding: 0.2rem 0.15rem; }
  .thinking .dots { display: inline-flex; gap: 3px; }
  .thinking .dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--working); }
  .tlabel { color: var(--working); font-size: 0.84rem; }
  .tmeta { color: var(--dim); font-family: var(--mono); font-size: 0.74rem; }
  @media (prefers-reduced-motion: no-preference) {
    .thinking .dots i { animation: tbounce 1.1s var(--ease) infinite; }
    .thinking .dots i:nth-child(2) { animation-delay: 0.15s; }
    .thinking .dots i:nth-child(3) { animation-delay: 0.3s; }
    @keyframes tbounce { 0%, 60%, 100% { opacity: 0.35; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
  }
  .composer-wrap { padding: 0.5rem 1rem 0.7rem; max-width: 900px; width: 100%; margin: 0 auto; }
  .approval { background: var(--surface); border: 1px solid var(--warn); border-radius: 10px; padding: 0.5rem 0.7rem; margin-bottom: 0.5rem; }
  .atop { display: flex; gap: 0.5rem; align-items: center; }
  .alabel { font-size: 0.66rem; letter-spacing: 0.08em; color: var(--warn); }
  .abody { margin: 0.35rem 0; font-size: 0.74rem; color: var(--muted); max-height: 6rem; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .aacts { display: flex; gap: 0.4rem; }
  .abtn { font-size: 0.76rem; border: 1px solid var(--border-strong); border-radius: 7px; padding: 0.25rem 0.6rem; color: var(--muted); }
  .abtn.ok { border-color: var(--ok); color: var(--ok); }
  .abtn:hover { color: var(--text); }
  .queue { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.5rem; background: var(--surface); border: 1px dashed var(--border-strong); border-radius: 10px; padding: 0.45rem 0.55rem; }
  .qhead { font-size: 0.68rem; }
  .qrow { display: flex; gap: 0.35rem; align-items: center; }
  .qedit { flex: 1; background: var(--surface-2); font-size: 0.8rem; }
  .qx { color: var(--dim); width: 22px; height: 22px; border-radius: 5px; flex: none; }
  .qx:hover { background: var(--surface-3); color: var(--bad-text); }
  .send-btn.queue { background: var(--warn); color: #1a1206; }
  .est { color: var(--muted); }
  .composer { background: var(--surface); border: 1px solid var(--border-strong); border-radius: 14px; padding: 0.6rem 0.7rem 0.5rem; }
  .composer textarea { width: 100%; background: none; border: none; resize: none; padding: 0.1rem 0.2rem; }
  .cfoot { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.35rem; }
  .foot-act { font-size: 0.75rem; color: var(--muted); border: 1px solid var(--border); border-radius: 7px; padding: 0.22rem 0.5rem; }
  .foot-act:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text); }
  .foot-act:disabled { opacity: 0.35; cursor: default; }
  .mode { cursor: default; }
  .checkout { display: flex; gap: 0.5rem; font-size: 0.72rem; padding: 0.35rem 0.4rem 0; }
</style>
