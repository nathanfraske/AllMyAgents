<script lang="ts">
  import type { ThreadItem } from './store.svelte'
  import Markdown from './Markdown.svelte'
  import DiffView from './DiffView.svelte'
  import { fileDiffsFromItem } from './diff'
  import { toolBlurb, agentActivity, parseBusFrame, type AgentDir } from './toolBlurb'
  import MessageAttachments from './MessageAttachments.svelte'
  import { store } from './store.svelte'
  import { initialDiffExpanded } from './diffDisplay'
  import ProviderLogo from './ProviderLogo.svelte'

  let { item, sessionId = '' }: { item: ThreadItem; sessionId?: string } = $props()
  let open = $state(false)
  let showFull = $state(false)

  // Hub agent-tool activity (bus messages, peeks, memory/practice) rendered as a colour-distinct blurb
  // with a direction arrow. Teammate ids resolve to display names via the roster; the arrow carries the
  // direction WITHOUT relying on colour. See toolBlurb.agentActivity.
  const resolveName = (id: string): string | undefined => store.sessionLabel(id) || undefined
  const agentAct = $derived(item.kind === 'tool' ? agentActivity(item, resolveName) : undefined)
  // A user turn that IS a delivered-message frame (defensive: the hub currently delivers via bus/delivered,
  // but if a frame ever lands as prompt text we collapse the wall to an inbound blurb rather than dump it).
  const busFrame = $derived(item.kind === 'user' ? parseBusFrame(item.text) : null)
  // Reuse the ONE density setting: agent-activity detail starts collapsed except under 'verbose'.
  const density = $derived(store.prefs?.fileWriteDiffDensity ?? 'minimal')
  let detailOpen = $state(false)
  let detailInit = false
  $effect(() => {
    if (!detailInit) {
      detailOpen = initialDiffExpanded(density)
      detailInit = true
    }
  })
  const ARROW: Record<AgentDir, string> = { out: '↑', in: '↓', none: '✦' }
  function sendersLabel(senders: string[]): string {
    if (senders.length === 0) return 'a teammate'
    if (senders.length <= 2) return senders.join(' & ')
    return `${senders[0]} +${senders.length - 1}`
  }
  // Names and vendor marks share the store's indexed full-id/prefix resolver. Ambiguous prefixes resolve
  // to neither, so a collision can never put the wrong agent's name beside the wrong vendor logo.
  const providerOf = (id: string | undefined) => id ? store.sessionProvider(id) : undefined
  const agentProvider = $derived(providerOf(agentAct?.counterpartyId))
  const busProvider = $derived(item.kind === 'bus' ? providerOf(item.busPeerId) : undefined)
  const busPeerLabel = $derived(
    item.kind === 'bus' && item.busPeerId
      ? resolveName(item.busPeerId) ?? item.busPeer
      : item.kind === 'bus'
        ? item.busPeer
        : undefined
  )
  const frameProvider = $derived(busFrame && busFrame.senderIds.length === 1 ? providerOf(busFrame.senderIds[0]) : undefined)

  const longUser = $derived(
    item.kind === 'user' && !!item.text && (item.text.length > 600 || item.text.split('\n').length > 8)
  )

  // File-create/edit tool calls (Claude Edit/Write/MultiEdit, Codex fileChange) render as rich
  // syntax-highlighted diffs; null when the item isn't a recognizable file edit, in which case
  // the generic tool rendering below is kept.
  const diffs = $derived(item.kind === 'tool' ? fileDiffsFromItem(item) : null)

  // The tool's SUBJECT (file read, command run, pattern searched) so a row says what it did, not just
  // which tool. Undefined for tools we don't recognise — the header then shows the plain name.
  const blurb = $derived(item.kind === 'tool' ? toolBlurb(item) : undefined)

  function fmtTime(ts: string): string {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ''
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    // Prepend a date for turns not from today (mainly imported history spanning previous days) so a
    // multi-day conversation reads clearly instead of a wall of bare times.
    const now = new Date()
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
    if (sameDay) return time
    const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }
    return `${d.toLocaleDateString(undefined, opts)}, ${time}`
  }
</script>

{#if item.kind === 'status'}
  <div class="status muted">→ {item.status}</div>
{:else if item.kind === 'compaction'}
  <div class="compaction" role="status">
    <span class="compaction-line" aria-hidden="true"></span>
    <span>{item.text ?? `Context compaction ${item.status ?? 'completed'}.`}</span>
    <span class="compaction-line" aria-hidden="true"></span>
  </div>
{:else if item.kind === 'note'}
  <div class="note dim">{item.text}</div>
{:else if item.kind === 'error'}
  <div class="err">{item.text}</div>
{:else if busFrame}
  <div class="agentact in">
    <button class="ahd" onclick={() => (detailOpen = !detailOpen)} title="teammate messages delivered by the hub">
      <span class="aarrow" aria-hidden="true">↓</span>
      <span class="alabel">{busFrame.count} message{busFrame.count === 1 ? '' : 's'} from {sendersLabel(busFrame.senders)}</span>
      {#if frameProvider}<span class="alogo"><ProviderLogo provider={frameProvider} size={14} /></span>{/if}
      {#if fmtTime(item.ts)}<span class="ts" title={new Date(item.ts).toLocaleString()}>{fmtTime(item.ts)}</span>{/if}
    </button>
    {#if detailOpen}<pre class="araw">{item.text}</pre>{/if}
  </div>
{:else if item.kind === 'assistant' || item.kind === 'user'}
  <div class="msg {item.kind}">
    <div class="who">{item.kind}{#if fmtTime(item.ts)}<span class="ts" title={new Date(item.ts).toLocaleString()}>{fmtTime(item.ts)}</span>{/if}</div>
    <div class="body" class:clamp={longUser && !showFull}><Markdown text={item.text ?? ''} /></div>
    {#if longUser}
      <button class="more" onclick={() => (showFull = !showFull)}>{showFull ? 'Show less' : 'Show full message'}</button>
    {/if}
    {#if item.attachments && item.attachments.length && sessionId}
      <MessageAttachments {sessionId} attachments={item.attachments} />
    {/if}
  </div>
{:else if item.kind === 'thinking' || item.kind === 'reasoning'}
  {#if item.text && item.text.trim()}
    <div class="think">
      <button class="hd" onclick={() => (open = !open)}>{open ? '▾' : '▸'} {item.kind}</button>
      {#if open}<div class="think-body"><Markdown text={item.text} /></div>{/if}
    </div>
  {:else}
    <div class="reasoned dim" title="Claude reasoned about this. Claude Code does not expose the reasoning text on subscription accounts.">✦ reasoned</div>
  {/if}
{:else if item.kind === 'tool'}
  {#if diffs && diffs.length}
    <div class="diffs">
      {#each diffs as d, i (i)}
        <DiffView diff={d} />
      {/each}
      {#if item.toolError}
        <div class="diff-err">{item.toolName} failed{#if item.toolResult} — {item.toolResult.slice(0, 300)}{/if}</div>
      {/if}
    </div>
  {:else if agentAct}
    <div class="agentact {agentAct.dir}">
      <button class="ahd" onclick={() => (detailOpen = !detailOpen)}>
        <span class="aarrow" aria-hidden="true">{ARROW[agentAct.dir]}</span>
        <span class="alabel">{agentAct.label}</span>
        {#if agentProvider}<span class="alogo"><ProviderLogo provider={agentProvider} size={14} /></span>{/if}
        {#if item.toolError}<span class="fail">error</span>{/if}
        {#if fmtTime(item.ts)}<span class="ts" title={new Date(item.ts).toLocaleString()}>{fmtTime(item.ts)}</span>{/if}
      </button>
      {#if detailOpen}
        <pre class="araw">{JSON.stringify(item.toolInput, null, 2)}</pre>
        {#if item.toolResult}<pre class="araw out" class:fail={item.toolError}>{item.toolResult.slice(0, 2000)}</pre>{/if}
      {/if}
    </div>
  {:else}
    <div class="tool" class:reflex={item.reflex}>
      <button class="hd" onclick={() => (open = !open)}>
        {open ? '▾' : '▸'} <span class="tname">{item.toolName}</span>
        {#if blurb}<span class="tsubject" title={blurb.title ?? blurb.label}>{blurb.label}</span>{/if}
        {#if item.reflex}<span class="reflex-tag" title="tool call with no preceding reasoning">reflex</span>{/if}
        {#if item.toolError}<span class="fail">error</span>{/if}
      </button>
      {#if open}
        <pre class="io">{JSON.stringify(item.toolInput, null, 2)}</pre>
        {#if item.toolResult}<pre class="io out" class:fail={item.toolError}>{item.toolResult.slice(0, 2000)}</pre>{/if}
      {/if}
    </div>
  {/if}
{:else if item.kind === 'bus'}
  <!-- A SENT bus event is already represented by the send_message agent-activity blurb above, so we
       don't render a second card for it. A RECEIVED (hub-pushed) message renders as the inbound blurb. -->
  {#if item.busDir !== 'sent'}
    <div class="agentact in">
      <button class="ahd" onclick={() => (detailOpen = !detailOpen)}>
        <span class="aarrow" aria-hidden="true">↓</span>
        <span class="alabel">message received from {busPeerLabel}</span>
        {#if busProvider}<span class="alogo"><ProviderLogo provider={busProvider} size={14} /></span>{/if}
        {#if item.busSubject}<span class="asubj">{item.busSubject}</span>{/if}
        {#if fmtTime(item.ts)}<span class="ts" title={new Date(item.ts).toLocaleString()}>{fmtTime(item.ts)}</span>{/if}
      </button>
      {#if detailOpen && item.text}<div class="abody"><Markdown text={item.text} /></div>{/if}
    </div>
  {/if}
{/if}

<style>
  .status { font-size: 0.72rem; margin: 0.15rem 0; }
  .compaction { display: flex; align-items: center; gap: 0.65rem; width: 100%; color: var(--muted); font-size: 0.72rem; font-family: var(--mono); }
  .compaction-line { height: 1px; flex: 1; background: var(--border-strong); }
  .note { font-size: 0.72rem; font-family: var(--mono); }
  .err { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); border: 1px solid var(--bad); border-radius: 6px; padding: 0.4rem 0.6rem; font-size: 0.8rem; }
  .msg { border-radius: 8px; padding: 0.5rem 0.7rem; }
  .msg.assistant { background: var(--surface); border: 1px solid var(--border); }
  .msg.user { background: color-mix(in srgb, var(--accent) 10%, transparent); border: 1px solid var(--border-strong); }
  .who { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dim); margin-bottom: 0.2rem; }
  .ts { font-variant-numeric: tabular-nums; text-transform: none; letter-spacing: 0; }
  .body { word-break: break-word; line-height: 1.5; }
  .body.clamp { max-height: 8.4rem; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
  .more { margin-top: 0.3rem; font-size: 0.74rem; color: var(--accent); }
  .think { border-left: 2px solid var(--border-strong); padding-left: 0.5rem; }
  .reasoned { font-size: 0.72rem; padding: 0.1rem 0; }
  .think-body { font-style: italic; color: var(--muted); font-size: 0.82rem; margin-top: 0.25rem; }
  .hd { display: flex; align-items: baseline; gap: 0.4rem; width: 100%; text-align: left; background: none; border: none; color: var(--muted); padding: 0.15rem 0; cursor: pointer; font-size: 0.8rem; }
  .tool { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.3rem 0.5rem; }
  .tool.reflex { border-color: var(--warn); }
  .tname { color: var(--accent); font-family: var(--mono); flex: none; }
  /* The subject line: one line, never wraps, ellipsised if the pane is narrow. The identifying part
     (basename / command head) is at the front, so an end-ellipsis here still leaves it readable. */
  .tsubject { flex: 1 1 auto; color: var(--muted); font-family: var(--mono); font-size: 0.72rem; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .reflex-tag, .fail { flex: none; }
  .reflex-tag { color: var(--warn); font-size: 0.68rem; border: 1px solid var(--warn); border-radius: 999px; padding: 0 0.3rem; margin-left: 0.3rem; }
  .fail { color: var(--bad); font-size: 0.7rem; margin-left: 0.3rem; }
  .io { background: var(--bg); border-radius: 6px; padding: 0.4rem 0.5rem; font-size: 0.72rem; overflow-x: auto; margin: 0.3rem 0 0; }
  .io.out { color: var(--muted); }
  .io.fail { color: var(--bad); }
  .diffs { display: flex; flex-direction: column; gap: 0.4rem; }
  .diff-err { color: var(--bad-text); background: color-mix(in srgb, var(--bad) 12%, transparent); border: 1px solid var(--bad); border-radius: 6px; padding: 0.3rem 0.5rem; font-size: 0.74rem; font-family: var(--mono); word-break: break-word; }

  /* Hub agent-tool activity (bus messages, peeks, memory/practice) — colour-distinct from ordinary tool
     calls via the theme-safe --secondary token, with a direction arrow (↑ sent, ↓ received, ✦ query) that
     reads WITHOUT colour so it still parses for anyone who can't distinguish the hue. */
  .agentact { border-left: 2px solid var(--secondary); padding: 0.05rem 0 0.05rem 0.5rem; }
  .ahd { display: flex; align-items: baseline; gap: 0.4rem; width: 100%; text-align: left; background: none; border: none; cursor: pointer; font-size: 0.8rem; color: var(--secondary); }
  .ahd:hover .alabel { color: var(--text); }
  .aarrow { flex: none; font-weight: 700; }
  .alabel { color: var(--secondary); }
  .alogo { flex: none; display: inline-flex; align-items: center; }
  .asubj { color: var(--muted); font-size: 0.74rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .abody { margin-top: 0.3rem; }
  .araw { background: var(--bg); border-radius: 6px; padding: 0.4rem 0.5rem; font-size: 0.72rem; margin: 0.3rem 0 0; overflow-x: auto; white-space: pre-wrap; word-break: break-word; color: var(--muted); }
  .araw.fail { color: var(--bad); }
</style>
