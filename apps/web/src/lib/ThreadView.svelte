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
  import AgentPanel from './AgentPanel.svelte'
  import TaskStrip from './TaskStrip.svelte'
  import { findModel, defaultModelFor } from './catalog'
  import { settings } from './settings.svelte'
  import { untrack } from 'svelte'
  import { loadComposerDrafts, saveComposerDrafts } from './uiState'
  import { resolveSlash, builtinsForProvider, builtinNeedsArg, loadProfileCommands, type SlashResult } from './commands'
  import type { CommandInfo } from './api'

  let { sessionId, paneIndex = 0, multiPane = false }: { sessionId?: string; paneIndex?: number; multiPane?: boolean } =
    $props()

  let text = $state('')
  // Unsent composer text lives with the CHAT, not this component: switching panes, tabbing away, or
  // reloading keeps whatever you were mid-way through writing. `drafts` is a plain cache (never $state)
  // so writing it from an effect cannot feed back into reactivity.
  let drafts = loadComposerDrafts()
  let draftFor = $state('')

  // Swap the composer's contents when the pane points at a different chat: stash the outgoing text,
  // restore the incoming one. untrack() so reading/writing `text` here never re-triggers this effect.
  $effect(() => {
    const id = sid
    untrack(() => {
      if (id === draftFor) return
      if (draftFor) {
        drafts = { ...drafts, [draftFor]: text }
        saveComposerDrafts(drafts)
      }
      text = drafts[id] ?? ''
      draftFor = id
    })
  })

  // Persist while typing, debounced. Sending clears `text`, which prunes the entry on the next tick.
  $effect(() => {
    const t = text
    const id = draftFor
    if (!id) return
    const timer = setTimeout(() => {
      drafts = { ...drafts, [id]: t }
      saveComposerDrafts(drafts)
    }, 300)
    return () => clearTimeout(timer)
  })
  let sendErr = $state('')
  let scroller = $state<HTMLDivElement | null>(null)
  let stick = $state(true)
  // `/` command picker: the textarea (for refocus after completion), the profile's on-disk custom
  // commands, the highlighted row, and an Escape-dismissal latch.
  let taRef = $state<HTMLTextAreaElement | null>(null)
  let customCommands = $state<CommandInfo[]>([])
  let cmdIndex = $state(0)
  let cmdDismissed = $state(false)

  const activeId = $derived(sessionId ?? store.selectedId ?? null)
  const view = $derived(activeId ? (store.sessions[activeId] ?? null) : null)
  const sid = $derived(view?.record.id ?? '')
  // Both drafts and real sessions now source their picks from the RECORD — a draft's live on the local
  // draft record, a real session's are persisted hub-side (setModel/setOption write through). One source
  // of truth means the pills always show what the next turn will actually use, for either vendor.
  const isDraft = $derived(!!view?.draft)
  // The main transcript shows only the MAIN thread; sub-agent output lives in the agent panel.
  const mainItems = $derived((view?.items ?? []).filter((i) => !i.agentId))
  const model = $derived(view?.record.model ?? '')
  const options = $derived<Record<string, string>>({
    ...(view?.record.effort ? { effort: view.record.effort } : {}),
    ...(view?.record.serviceTier ? { serviceTier: view.record.serviceTier } : {}),
  })
  const modelDef = $derived(
    view ? (findModel(model) ?? defaultModelFor(view.record.provider)) : undefined
  )
  const active = $derived(view?.record.status === 'active' || view?.record.status === 'starting')
  // A stopped chat is otherwise a dead end — stop() had no inverse, so the composer bounced every send
  // off the hub's 'stopped' guard forever. Surface a Reopen affordance instead of interrupt/stop so the
  // operator can revive it in one click (api.reopen → hub setStatus idle → journaled status un-sticks it).
  const stopped = $derived(view?.record.status === 'stopped')
  // Worktree intent: for a draft there is no real worktree path yet, so read the pre-spawn flag.
  const worktreeOn = $derived(view?.draft ? !!view.draftUseWorktree : !!view?.record.worktree)
  // Draft-only inline permission picker (the real PermissionPicker posts to the hub, which a draft
  // has no session for). Mirrors the real picker's modes; writes the choice into the draft record.
  const PERM_MODES = [
    { id: 'safe', icon: 'lock', label: 'Safe', desc: 'ask before every tool' },
    { id: 'edits', icon: 'pencil', label: 'Edits', desc: 'auto-approve file edits' },
    { id: 'full', icon: 'zap', label: 'Full access', desc: 'no approvals (careful)' },
  ]
  let permOpen = $state(false)
  const draftMode = $derived(view?.record.permissionMode ?? 'safe')
  const draftModeDef = $derived(PERM_MODES.find((m) => m.id === draftMode) ?? PERM_MODES[0])
  // Codex can append input to a running turn (steer); Claude has no steer, so it queues.
  const steerable = $derived(active && view?.record.provider === 'codex')
  const st = $derived(view ? store.status(view) : { key: 'idle', label: '' })
  const approvals = $derived(view ? store.approvals.filter((a) => a.sessionId === view.record.id) : [])
  const queue = $derived(sid ? store.queueFor(sid) : [])

  // --- `/` command picker ------------------------------------------------------------------------
  type PickItem = { name: string; description: string; kind: 'builtin' | 'custom'; argHint?: string }
  // Shown while typing a command NAME: a leading "/" then a partial token with no space yet. Once a
  // space is typed (→ arguments) or the text goes multiline, the query is null and the picker closes.
  const cmdQuery = $derived.by<string | null>(() => {
    const m = /^\/(\S*)$/.exec(text)
    return m ? (m[1] as string).toLowerCase() : null
  })
  const allCommands = $derived.by<PickItem[]>(() => {
    const provider = view?.record.provider ?? 'claude'
    const builtins = builtinsForProvider(provider).map(
      (b): PickItem => ({ name: b.name, description: b.description, kind: 'builtin', argHint: b.argHint })
    )
    const custom = customCommands.map((c): PickItem => ({ name: c.name, description: c.description, kind: 'custom' }))
    return [...builtins, ...custom]
  })
  const cmdShown = $derived.by<PickItem[]>(() => {
    if (cmdQuery === null) return []
    const q = cmdQuery
    return allCommands
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const sa = a.name.toLowerCase().startsWith(q) ? 0 : 1
        const sb = b.name.toLowerCase().startsWith(q) ? 0 : 1
        return sa !== sb ? sa - sb : a.name.localeCompare(b.name)
      })
      .slice(0, 8)
  })
  // Open while typing a command name, unless Escape-dismissed or the query already exactly names the
  // sole remaining command (nothing left to complete — just press Enter to run it).
  const cmdOpen = $derived(
    cmdQuery !== null &&
      !cmdDismissed &&
      cmdShown.length > 0 &&
      !(cmdShown.length === 1 && cmdShown[0]?.name.toLowerCase() === cmdQuery)
  )

  // Load the profile's custom commands for the picker (memoized in the commands module).
  $effect(() => {
    const pid = view?.record.profileId
    if (!pid) {
      customCommands = []
      return
    }
    let cancelled = false
    void loadProfileCommands(pid).then((list) => {
      if (!cancelled) customCommands = list
    })
    return () => {
      cancelled = true
    }
  })
  // Reset the highlighted row + any Escape-dismissal whenever the query changes.
  $effect(() => {
    cmdQuery // track
    cmdIndex = 0
    cmdDismissed = false
  })

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
  // In flight while we have a start time OR the record itself says active/starting. The status check is
  // the safety net for a turn this client never watched BEGIN — one kicked off by a teammate's bus
  // message rather than by you typing, or one already running when the app loaded — where no optimistic
  // start time was ever set locally. Status is hub-owned and replayed, so it is the honest signal.
  const thinking = $derived(
    !!view && (view.turnStartedAt != null || view.record.status === 'active' || view.record.status === 'starting')
  )
  const liveTok = $derived(view?.liveTokens)
  let now = $state(Date.now())
  $effect(() => {
    if (!thinking) return
    const iv = setInterval(() => (now = Date.now()), 250)
    return () => clearInterval(iv)
  })
  const elapsedMs = $derived(thinking && view?.turnStartedAt ? Math.max(0, now - view.turnStartedAt) : 0)
  // Blank rather than a fake "0s" when we are thinking but never learned when the turn began.
  const elapsedLabel = $derived(view?.turnStartedAt != null ? fmtElapsed(elapsedMs) : '')
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

  // Model / thinking-effort / tier picks WRITE THROUGH to the hub immediately for a real session, so the
  // choice belongs to the record and survives switching panes, reloading, and a hub restart (it used to
  // live in this component's state and silently reverted). Optimistic locally, then confirmed by the
  // hub's `session/settings` event. A draft has no hub session yet, so its picks stay on the draft record.
  function setModel(slug: string): void {
    if (!sid || !view) return
    if (view.draft) {
      store.updateDraft(sid, { model: slug || undefined }) // draft picks live on the record
      return
    }
    view.record.model = slug || undefined
    void api.setSettings(sid, { model: slug })
  }
  function setOption(id: string, value: string): void {
    if (!sid || !view) return
    if (view.draft) {
      if (id === 'effort') store.updateDraft(sid, { effort: value || undefined })
      else if (id === 'serviceTier') store.updateDraft(sid, { serviceTier: value || undefined })
      return
    }
    if (id === 'effort') view.record.effort = value || undefined
    else if (id === 'serviceTier') view.record.serviceTier = value || undefined
    void api.setSettings(sid, { [id]: value })
  }

  // Accept the highlighted picker row. `runIfComplete` (Enter/click) runs a no-arg command straight
  // away; an arg-taking command (or Tab) just completes the name and waits for the argument.
  function acceptCmd(i: number, runIfComplete: boolean): void {
    const c = cmdShown[i]
    if (!c) return
    const needsArg = c.kind === 'builtin' && builtinNeedsArg(c.name)
    if (runIfComplete && !needsArg) {
      text = `/${c.name}`
      void send()
      return
    }
    text = `/${c.name}${needsArg ? ' ' : ''}`
    cmdDismissed = true
    queueMicrotask(() => taRef?.focus())
  }

  // Inline `/usage` (and `/cost`) summary from the account snapshot + this session's live counters.
  function usageSummary(): string {
    if (!view) return 'no usage data yet'
    const u = store.usage.find((x) => x.profileId === view.record.profileId)
    const parts: string[] = []
    if (u?.claudeUsage?.length) {
      for (const l of u.claudeUsage) parts.push(`${l.label} ${l.percent}%`)
    } else if (u?.codex?.usedPercent != null) {
      parts.push(`weekly ${u.codex.usedPercent}% used`)
    }
    if (view.contextUsed && view.contextWindow) {
      parts.push(`context ${Math.round((view.contextUsed / view.contextWindow) * 100)}% (${fmtTokens(view.contextUsed)}/${fmtTokens(view.contextWindow)})`)
    }
    if (view.costUsd) parts.push(`$${view.costUsd.toFixed(4)} this session`)
    else if (typeof u?.totalCostUsd === 'number') parts.push(`$${u.totalCostUsd.toFixed(4)} this hub run`)
    return parts.length ? `usage · ${parts.join(' · ')}` : 'no usage data yet'
  }

  // Execute a resolved built-in against the hub / store (the composer's side of the mapping). Draft
  // vs. real session is handled here: a draft has no hub session, so model/mode write to the draft
  // record; a real session posts to the hub. Feedback lands as a local note in the thread.
  async function runSlash(res: SlashResult, sid0: string): Promise<void> {
    if (!view) return
    switch (res.kind) {
      case 'model':
        setModel(res.model) // same write-through the pill uses (draft → record, real → hub)
        store.pushLocalNote(sid0, `model → ${res.label} · applies to your next message`)
        break
      case 'mode':
        if (view.draft) {
          store.updateDraft(sid0, { permissionMode: res.mode })
          store.pushLocalNote(sid0, `permission mode → ${res.mode}`)
        } else {
          await api.setMode(sid0, res.mode) // hub journals session/mode → renders its own note
        }
        break
      case 'usage':
        store.pushLocalNote(sid0, usageSummary())
        break
      case 'new':
        // Claude-focused: /clear starts a fresh chat (Codex doesn't reset context this way, but a new
        // chat is the shared analog — a new thread). Reuses the "new chat" path.
        await store.newSession(view.record.profileId, view.record.projectId)
        break
      case 'compact': {
        if (view.draft) {
          store.pushLocalNote(sid0, 'compaction needs a started chat — send a first message, then /compact')
          break
        }
        const out = await api.compact(sid0)
        store.pushLocalNote(
          sid0,
          out?.reason ?? out?.error ?? (out?.supported ? 'compaction requested' : 'compaction not yet supported by the driver')
        )
        break
      }
      case 'message':
        store.pushLocalNote(sid0, res.tone === 'error' ? `⚠ ${res.text}` : res.text)
        break
      case 'passthrough':
        break
    }
  }

  async function send(): Promise<void> {
    if (!view || !text.trim()) return
    const sid0 = view.record.id
    const body = text
    text = ''
    sendErr = ''
    // Slash-command interception. A leading "/" may map to a hub feature (built-in) — run that action
    // instead of sending text. CUSTOM commands (commands/*.md) resolve to `passthrough` and continue
    // down the normal send path, where the driver expands them.
    if (body.trim().startsWith('/')) {
      const res = resolveSlash(body.trim(), view.record.provider)
      if (res.kind !== 'passthrough') {
        await runSlash(res, sid0)
        return
      }
    }
    // A DRAFT has no hub session: the first send spawns the real session with this prompt, then the
    // store swaps this pane over to it. No steering/queueing (there is no running turn to steer).
    if (view.draft) {
      stick = true
      const out = await store.materializeDraft(sid0, body)
      if (out.error) {
        text = body // spawn failed — hand the prompt back and keep the draft as it was
        sendErr = out.error
      }
      return
    }
    // Busy? Codex steers the running turn; Claude queues (combined/sent on turn end).
    if (active) {
      if (view.record.provider === 'codex') {
        const out = await api.steer(sid0, body)
        if (out.error) {
          text = body // steer failed — give the draft back
          sendErr = out.error
        }
      } else {
        store.enqueue(sid0, body)
      }
      return
    }
    stick = true
    store.noteSent(sid0) // immediate "received / thinking" feedback
    const key = store.pushUserEcho(sid0, body) // echo the message immediately
    const out = await api.send(sid0, body, {
      model: model || undefined,
      effort: options.effort ?? undefined,
      serviceTier: options.serviceTier ?? undefined,
    })
    if (out.error) {
      store.removeItem(sid0, key) // roll back the optimistic bubble
      text = body // and restore the draft so nothing is lost
      sendErr = out.error
    }
  }

  async function stop(): Promise<void> {
    if (view) await api.interrupt(view.record.id)
  }

  async function decide(id: string, approve: boolean): Promise<void> {
    await api.decide(id, approve)
    await store.refreshSideData()
  }

  /** "Always allow" — grant the tool for this chat FIRST, then approve the request that prompted it, so
   *  the operator is not asked again for the same tool. The grant is hub-side, so it applies immediately. */
  let grantError = $state<string | null>(null)
  async function allowAlways(id: string, toolName: string): Promise<void> {
    if (!view) return
    grantError = null
    // jpost RESOLVES with {error} rather than throwing, so an unchecked await here looked like success.
    // Approving anyway would have quietly downgraded "always allow" to "approve once" — the operator gets
    // prompted again later with no idea the grant never took.
    const res = (await api.allowTool(view.record.id, toolName)) as { error?: string }
    if (res?.error) {
      grantError = `could not always-allow ${toolName}: ${res.error}`
      return
    }
    await decide(id, true)
  }

  /** The tool a pending approval is about, when it is a tool approval at all (kind 'claude/tool'). */
  function approvalTool(payload: unknown): string | null {
    const name = (payload as { toolName?: unknown } | null)?.toolName
    return typeof name === 'string' && name ? name : null
  }

  function onKey(e: KeyboardEvent): void {
    // The command picker owns the arrow/Tab/Enter/Escape keys while it is open.
    if (cmdOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        cmdIndex = (cmdIndex + 1) % cmdShown.length
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        cmdIndex = (cmdIndex - 1 + cmdShown.length) % cmdShown.length
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        acceptCmd(cmdIndex, false)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        cmdDismissed = true
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        acceptCmd(cmdIndex, true)
        return
      }
    }
    // Don't send mid-IME-composition (e.g. selecting a candidate with Enter in CJK input).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  /**
   * Render what is actually being asked. This used to be `toolName + JSON.stringify(input).slice(0, 200)`
   * on ONE line, which was unreadable for anything structured — a tool whose input carries a question and
   * a list of options got truncated mid-JSON, so the operator could not even see what they were approving,
   * let alone answer it. Pretty-print, and give it enough room to be legible (the box scrolls).
   */
  function summarizeApproval(payload: unknown): string {
    const p = payload as { toolName?: string; input?: unknown }
    const body = p?.toolName ? p.input : payload
    let text: string
    try {
      text = typeof body === 'string' ? body : JSON.stringify(body ?? {}, null, 2)
    } catch {
      text = String(body)
    }
    return text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text
  }
</script>

{#if !view}
  <div class="empty dim">select a session, or press + to spawn one</div>
{:else}
  <div class="head">
    <ProviderLogo provider={view.record.provider} size={16} />
    {#if isDraft}
      <span class="title draftpill" title="new chat — not on the hub until you send the first message">New chat <span class="draftbadge">draft</span></span>
    {:else if multiPane}
      <select class="paneselect" value={view.record.id} onchange={(e) => store.setPaneSession(paneIndex, (e.target as HTMLSelectElement).value)}>
        {#each store.sessionList as s (s.record.id)}
          <option value={s.record.id}>{s.record.title ?? `${s.record.profileId} · ${(s.record.worktree ?? s.record.cwd).split(/[\\/]/).pop()}`}</option>
        {/each}
      </select>
    {:else}
      <span class="title">{view.record.title ?? view.record.profileId}</span>
    {/if}
    <span class="statuschip {st.key}"><span class="dot {st.key}"></span>{st.label}</span>
    <span class="sub dim">{view.record.model ?? view.record.provider}</span>
    <span class="spacer"></span>
    {#if !isDraft && view.record.worktree}
      <span class="wt" title="isolated git worktree at {view.record.worktree}"><Icon name="git-branch" size={12} /> {view.record.branch ?? view.record.worktree.split(/[\\/]/).pop()}</span>
    {:else if isDraft && view.record.projectId}
      <span class="wt dim" title={worktreeOn ? 'will spawn in an isolated git worktree' : 'will work directly in the project directory'}><Icon name={worktreeOn ? 'git-branch' : 'folder'} size={12} /> {worktreeOn ? 'new worktree' : 'in project'}</span>
    {:else if view.record.projectId}
      <span class="wt dim" title="working directly in the project directory ({view.record.cwd})"><Icon name="folder" size={12} /> in project</span>
    {/if}
    <button class="hicon" title="split view" onclick={() => store.startSplit()}><Icon name="columns" size={15} /></button>
    <button class="hicon" title="close (keeps the chat)" onclick={() => store.closePane(paneIndex)}><Icon name="x" size={15} /></button>
  </div>

  <div class="stream scroll" bind:this={scroller} onscroll={onScroll}>
    <!-- Items produced INSIDE a spawned sub-agent are excluded here and rendered in the agent panel
         instead: a background agent's tool spam would otherwise bury the conversation you are actually
         having. `agentId` is set only for sub-agent output, so the main thread is unaffected. -->
    {#each mainItems as item (item.key)}
      <ItemCard {item} />
    {/each}
    {#if view.items.length === 0 && !thinking}<div class="dim pad">{isDraft ? 'New chat — set the account, model and worktree below, then send your first message to start it.' : 'no activity yet — send a message below'}</div>{/if}
    {#if thinking}
      <div class="thinking">
        <span class="dots"><i></i><i></i><i></i></span>
        <span class="tlabel">thinking</span>
        <span class="tmeta">{elapsedLabel}{#if liveTok?.total}{elapsedLabel ? ' · ' : ''}{fmtTokens(liveTok.total)} tokens{/if}</span>
      </div>
    {/if}
  </div>

  <!-- Sub-agents this chat spawned. Self-contained popout anchored to THIS pane, so split view gets one
       panel per pane; renders nothing until an agent is actually spawned. -->
  <AgentPanel items={view.items} sessionId={view.record.id} />

  <div class="composer-wrap">
    <!-- The agent's task board, directly above the chatbar. -->
    <TaskStrip items={view.items} />

    {#each approvals as a (a.id)}
      <div class="approval">
        <div class="atop">
          <span class="alabel">PENDING APPROVAL</span>
          <span class="dim">{approvalTool(a.payload) ?? a.kind}</span>
        </div>
        <pre class="abody">{summarizeApproval(a.payload)}</pre>
        <div class="aacts">
          <button class="abtn ok" onclick={() => decide(a.id, true)}>Approve once</button>
          {#if approvalTool(a.payload)}
            <!-- The answer this prompt never offered. Without it, a long task re-asks for the SAME tool
                 indefinitely, and any prompt the operator misses fails closed after the timeout. -->
            <button
              class="abtn"
              title="Stop asking about this tool in this chat. Revoke it in the permission menu."
              onclick={() => allowAlways(a.id, approvalTool(a.payload) as string)}
            >
              Always allow {approvalTool(a.payload)}
            </button>
          {/if}
          <button class="abtn" onclick={() => decide(a.id, false)}>Decline</button>
        </div>
        {#if grantError}<div class="aerr">{grantError}</div>{/if}
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

    {#if sendErr}<div class="senderr" role="alert">⚠ {sendErr} — your message was kept in the box.</div>{/if}
    <div class="composer">
      {#if cmdOpen}
        <div class="cmdmenu">
          <div class="cmdhint dim">Commands · type to filter · Enter runs or completes · Tab completes · Esc dismisses</div>
          {#each cmdShown as c, i (c.kind + ':' + c.name)}
            <button class="cmdrow" class:sel={i === cmdIndex} onmouseenter={() => (cmdIndex = i)} onclick={() => acceptCmd(i, true)}>
              <span class="cmdname">/{c.name}{#if c.argHint}&nbsp;<span class="cmdarg dim">{c.argHint}</span>{/if}</span>
              <span class="cmddesc dim">{c.description}</span>
              <span class="cmdtag {c.kind}">{c.kind === 'builtin' ? 'hub' : 'custom'}</span>
            </button>
          {/each}
        </div>
      {/if}
      <textarea rows="2" placeholder={isDraft ? 'Describe the first task… (Enter to start the chat, Shift+Enter for newline)' : steerable ? 'Steer the running turn… (appended to what Codex is doing now)' : active ? 'Queue a message… (sends when the current turn finishes)' : 'Ask for follow-up changes…  (Enter to send, Shift+Enter for newline)'}
        bind:this={taRef} bind:value={text} onkeydown={onKey}></textarea>
      <div class="cfoot">
        <AccountPicker {view} />
        <ModelPicker provider={view.record.provider} {model} onselect={setModel} />
        {#if modelDef}<TraitsControl descriptors={modelDef.descriptors} values={options} onchange={setOption} />{/if}
        {#if isDraft}
          <div class="dperm">
            <button class="pill-btn" class:full={draftMode === 'full'} class:open={permOpen} title="permission mode for this chat" onclick={() => (permOpen = !permOpen)}>
              <span class="dlead"><Icon name={draftModeDef.icon} size={13} /></span> {draftModeDef.label} <span class="dchev"><Icon name="chevron-down" size={12} /></span>
            </button>
            {#if permOpen}
              <button class="dscrim" onclick={() => (permOpen = false)} aria-label="close"></button>
              <div class="dmenu">
                {#each PERM_MODES as m (m.id)}
                  <button class="dopt" class:sel={m.id === draftMode} onclick={() => { store.updateDraft(view.record.id, { permissionMode: m.id }); permOpen = false }}>
                    <span class="dic"><Icon name={m.icon} size={15} /></span>
                    <span class="dtxt"><span class="dl">{m.label}</span><span class="dd dim">{m.desc}</span></span>
                    {#if m.id === draftMode}<span class="dtick"><Icon name="check" size={13} /></span>{/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <PermissionPicker
            sessionId={view.record.id}
            mode={view.record.permissionMode ?? 'safe'}
            allowedTools={view.record.allowedTools ?? []}
          />
        {/if}
        {#if store.canToggleWorktree(view)}
          <button class="pill-btn" title="Isolated git worktree vs. work directly in the project — switch before your first message" onclick={() => store.toggleWorktree()}>
            <Icon name={worktreeOn ? 'git-branch' : 'folder'} size={13} /> {worktreeOn ? 'worktree' : 'in project'}
          </button>
        {/if}
        <span class="spacer"></span>
        {#if !isDraft}
          {#if stopped}
            <button class="foot-act" onclick={() => api.reopen(view.record.id)} title="reopen this stopped chat so you can use it again">reopen</button>
          {:else}
            <button class="foot-act" onclick={stop} disabled={!active} title="interrupt current turn">interrupt</button>
            <button class="foot-act" onclick={() => api.stop(view.record.id)} title="stop session">stop</button>
          {/if}
        {/if}
        <button class="send-btn" class:queue={active} title={isDraft ? 'start this chat' : steerable ? 'steer into the running turn' : active ? 'queue message' : 'send'} onclick={send} disabled={!text.trim()}><Icon name={steerable ? 'corner-down-right' : active ? 'timer' : 'arrow-up'} size={16} /></button>
      </div>
    </div>
    <div class="checkout dim">
      <ContextMeter {view} />
      {#if settings.showTokenEstimate && estTokens > 0}
        <span class="est" title="rough estimate of the next call's input tokens (re-read context + your draft), ≈ chars/4">~{fmtTokens(estTokens)} tokens next call</span>
      {/if}
      <span class="spacer"></span>
      <span>{#if isDraft}draft · not started yet{:else}{view.record.repo ? '▣ worktree' : '▣ local'} · {view.record.id.slice(0, 8)}{/if}</span>
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
  .wt { font-size: 0.75rem; font-family: var(--mono); color: var(--muted); display: inline-flex; align-items: center; gap: 0.25rem; }
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
  /* Taller + break-word (not break-all): the body is now pretty-printed, so it must stay readable rather
     than shattering identifiers mid-token. Still capped and scrollable so it can't push out the composer. */
  .abody { margin: 0.35rem 0; font-size: 0.74rem; color: var(--muted); max-height: 14rem; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); }
  .aacts { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .aerr { margin-top: 0.35rem; font-size: 0.74rem; color: var(--bad-text); }
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
  .senderr { color: var(--bad-text); font-size: 0.76rem; margin-bottom: 0.45rem; }
  .tmeta, .est { font-variant-numeric: tabular-nums; }
  .composer { position: relative; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 14px; padding: 0.6rem 0.7rem 0.5rem; }
  .composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
  @media (prefers-reduced-motion: no-preference) { .composer { transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); } }
  .composer textarea { width: 100%; background: none; border: none; resize: none; padding: 0.1rem 0.2rem; }
  .cfoot { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.35rem; }

  /* `/` command picker — floats above the composer, type-ahead filtered. */
  .cmdmenu { position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; z-index: 11; max-height: 320px; overflow-y: auto;
    background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--space-1);
    box-shadow: var(--shadow-3), var(--edge-hi); }
  @media (prefers-reduced-motion: no-preference) { .cmdmenu { animation: pop-in var(--dur-fast) var(--ease); } }
  .cmdhint { font-size: 0.64rem; padding: 0.15rem 0.45rem 0.3rem; }
  .cmdrow { display: flex; align-items: baseline; gap: 0.55rem; width: 100%; text-align: left; padding: var(--space-2) var(--space-3); border-radius: var(--r-md); }
  .cmdrow:hover, .cmdrow.sel { background: var(--surface-3); }
  .cmdname { font-family: var(--mono); font-size: 0.8rem; flex: none; white-space: nowrap; }
  .cmdarg { font-weight: 400; }
  .cmddesc { flex: 1; font-size: 0.74rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmdtag { flex: none; font-size: 0.58rem; letter-spacing: 0.05em; text-transform: uppercase; border-radius: var(--r-xs);
    padding: 0 0.32rem; border: 1px solid var(--border-strong); color: var(--muted); }
  .cmdtag.builtin { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
  .foot-act { font-size: 0.75rem; color: var(--muted); border: 1px solid var(--border); border-radius: 7px; padding: 0.22rem 0.5rem; }
  .foot-act:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text); }
  .foot-act:disabled { opacity: 0.35; cursor: default; }
  .mode { cursor: default; }
  .checkout { display: flex; gap: 0.5rem; font-size: 0.72rem; padding: 0.35rem 0.4rem 0; }

  /* Draft chat: title badge in the head. */
  .draftpill { display: inline-flex; align-items: center; gap: 0.4rem; }
  .draftbadge { font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase; font-weight: var(--fw-semibold);
    color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: var(--r-pill); padding: 0.05rem 0.4rem; }

  /* Draft-only inline permission picker — mirrors PermissionPicker (which can't target a draft,
     since it posts to the hub and a draft has no session there). */
  .dperm { position: relative; }
  .pill-btn.full { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
  .pill-btn.full .dlead { color: var(--warn); }
  .dlead { display: inline-grid; color: var(--muted); }
  .dchev { display: inline-grid; opacity: 0.6; }
  .dscrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .dmenu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 210px; background: var(--surface-2);
    border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--space-1); box-shadow: var(--shadow-3), var(--edge-hi); }
  @media (prefers-reduced-motion: no-preference) { .dmenu { animation: pop-in var(--dur-fast) var(--ease); } }
  .dopt { display: flex; align-items: center; gap: var(--space-3); width: 100%; text-align: left; padding: var(--space-3); border-radius: var(--r-md); }
  .dopt:hover, .dopt.sel { background: var(--surface-3); }
  .dic { display: inline-grid; place-items: center; width: 1.2rem; color: var(--muted); }
  .dopt.sel .dic { color: var(--accent); }
  .dtxt { display: flex; flex-direction: column; }
  .dopt.sel .dl { font-weight: var(--fw-medium); }
  .dl { font-size: var(--text-sm); }
  .dd { font-size: var(--text-xs); }
  .dtick { margin-left: auto; display: inline-grid; color: var(--accent); flex: none; }
</style>
