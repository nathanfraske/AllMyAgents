<script lang="ts">
  import { api } from './api'
  import { store } from './store.svelte'
  import ItemCard from './ItemCard.svelte'
  import ContextMeter from './ContextMeter.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import TraitsControl from './TraitsControl.svelte'
  import PermissionPicker from './PermissionPicker.svelte'
  import { findModel, defaultModelFor } from './catalog'

  let text = $state('')
  let scroller = $state<HTMLDivElement | null>(null)
  let stick = $state(true)
  // per-session picker state, seeded from the record
  let modelBySession = $state<Record<string, string>>({})
  let optionsBySession = $state<Record<string, Record<string, string>>>({})

  const view = $derived(store.selectedId ? (store.sessions[store.selectedId] ?? null) : null)
  const sid = $derived(view?.record.id ?? '')
  const model = $derived(modelBySession[sid] ?? view?.record.model ?? '')
  const options = $derived(optionsBySession[sid] ?? (view?.record.effort ? { effort: view.record.effort } : {}))
  const modelDef = $derived(
    view ? (findModel(model) ?? defaultModelFor(view.record.provider)) : undefined
  )
  const active = $derived(view?.record.status === 'active' || view?.record.status === 'starting')
  const approvals = $derived(view ? store.approvals.filter((a) => a.sessionId === view.record.id) : [])

  $effect(() => {
    view?.items.length
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
    stick = true
    const out = await api.send(view.record.id, body, { model: model || undefined, effort: options.effort || undefined })
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
    <span class="dot {view.record.status}"></span>
    <span class="title">{view.record.profileId}</span>
    <span class="sub dim">{view.record.provider}{view.record.model ? ' · ' + view.record.model : ''}</span>
    <span class="spacer"></span>
    <ContextMeter {view} />
    {#if view.record.worktree}<span class="wt dim">⑂ {view.record.worktree.split(/[\\/]/).pop()}</span>{/if}
    <button class="hbtn" onclick={stop} disabled={!active}>interrupt</button>
    <button class="hbtn" onclick={() => api.stop(view.record.id)}>stop</button>
  </div>

  <div class="stream scroll" bind:this={scroller} onscroll={onScroll}>
    {#each view.items as item (item.key)}
      <ItemCard {item} />
    {/each}
    {#if view.items.length === 0}<div class="dim pad">no activity yet — send a message below</div>{/if}
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

    <div class="composer">
      <textarea rows="2" placeholder="Ask for follow-up changes…  (Enter to send, Shift+Enter for newline)"
        bind:value={text} onkeydown={onKey}></textarea>
      <div class="cfoot">
        <ModelPicker provider={view.record.provider} {model} onselect={setModel} />
        {#if modelDef}<TraitsControl descriptors={modelDef.descriptors} values={options} onchange={setOption} />{/if}
        <PermissionPicker sessionId={view.record.id} mode={view.record.permissionMode ?? 'safe'} />
        <span class="spacer"></span>
        {#if active}
          <button class="send-btn stop" title="interrupt" onclick={stop}>◼</button>
        {:else}
          <button class="send-btn" title="send" onclick={send} disabled={!text.trim()}>↑</button>
        {/if}
      </div>
    </div>
    <div class="checkout dim">
      <span>▣ {view.record.repo ? 'worktree checkout' : 'local'}</span>
      <span class="spacer"></span>
      <span>{view.record.id.slice(0, 8)}</span>
    </div>
  </div>
{/if}

<style>
  .empty { display: grid; place-items: center; height: 100%; }
  .head { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1rem; border-bottom: 1px solid var(--border); }
  .title { font-weight: 600; }
  .sub { font-size: 0.78rem; }
  .spacer { flex: 1; }
  .wt { font-size: 0.75rem; font-family: var(--mono); }
  .hbtn { font-size: 0.76rem; color: var(--muted); border: 1px solid var(--border); border-radius: 7px; padding: 0.22rem 0.5rem; }
  .hbtn:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text); }
  .hbtn:disabled { opacity: 0.4; cursor: default; }
  .stream { flex: 1; display: flex; flex-direction: column; gap: 0.55rem; padding: 1rem 1.1rem; max-width: 900px; width: 100%; margin: 0 auto; }
  .pad { padding: 1rem 0; }
  .composer-wrap { padding: 0.5rem 1rem 0.7rem; max-width: 900px; width: 100%; margin: 0 auto; }
  .approval { background: var(--surface); border: 1px solid var(--warn); border-radius: 10px; padding: 0.5rem 0.7rem; margin-bottom: 0.5rem; }
  .atop { display: flex; gap: 0.5rem; align-items: center; }
  .alabel { font-size: 0.66rem; letter-spacing: 0.08em; color: var(--warn); }
  .abody { margin: 0.35rem 0; font-size: 0.74rem; color: var(--muted); max-height: 6rem; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .aacts { display: flex; gap: 0.4rem; }
  .abtn { font-size: 0.76rem; border: 1px solid var(--border-strong); border-radius: 7px; padding: 0.25rem 0.6rem; color: var(--muted); }
  .abtn.ok { border-color: var(--ok); color: var(--ok); }
  .abtn:hover { color: var(--text); }
  .composer { background: var(--surface); border: 1px solid var(--border-strong); border-radius: 14px; padding: 0.6rem 0.7rem 0.5rem; }
  .composer textarea { width: 100%; background: none; border: none; resize: none; padding: 0.1rem 0.2rem; }
  .cfoot { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.35rem; }
  .mode { cursor: default; }
  .checkout { display: flex; gap: 0.5rem; font-size: 0.72rem; padding: 0.35rem 0.4rem 0; }
</style>
