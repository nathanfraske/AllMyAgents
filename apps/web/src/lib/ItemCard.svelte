<script lang="ts">
  import type { ThreadItem } from './store.svelte'
  import Markdown from './Markdown.svelte'
  import DiffView from './DiffView.svelte'
  import { fileDiffsFromItem } from './diff'

  let { item }: { item: ThreadItem } = $props()
  let open = $state(false)
  let showFull = $state(false)

  const longUser = $derived(
    item.kind === 'user' && !!item.text && (item.text.length > 600 || item.text.split('\n').length > 8)
  )

  // File-create/edit tool calls (Claude Edit/Write/MultiEdit, Codex fileChange) render as rich
  // syntax-highlighted diffs; null when the item isn't a recognizable file edit, in which case
  // the generic tool rendering below is kept.
  const diffs = $derived(item.kind === 'tool' ? fileDiffsFromItem(item) : null)

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
{:else if item.kind === 'note'}
  <div class="note dim">{item.text}</div>
{:else if item.kind === 'error'}
  <div class="err">{item.text}</div>
{:else if item.kind === 'assistant' || item.kind === 'user'}
  <div class="msg {item.kind}">
    <div class="who">{item.kind}{#if fmtTime(item.ts)}<span class="ts" title={new Date(item.ts).toLocaleString()}>{fmtTime(item.ts)}</span>{/if}</div>
    <div class="body" class:clamp={longUser && !showFull}><Markdown text={item.text ?? ''} /></div>
    {#if longUser}
      <button class="more" onclick={() => (showFull = !showFull)}>{showFull ? 'Show less' : 'Show full message'}</button>
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
  {:else}
    <div class="tool" class:reflex={item.reflex}>
      <button class="hd" onclick={() => (open = !open)}>
        {open ? '▾' : '▸'} <span class="tname">{item.toolName}</span>
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
  <div class="bus {item.busDir ?? 'received'}">
    <div class="bus-hd">
      <span class="bus-dir">{item.busDir === 'sent' ? '→ sent to' : '← from'}</span>
      <span class="bus-peer">{item.busPeer}</span>
      {#if item.busSubject}<span class="bus-subj">{item.busSubject}</span>{/if}
      {#if fmtTime(item.ts)}<span class="ts" title={new Date(item.ts).toLocaleString()}>{fmtTime(item.ts)}</span>{/if}
    </div>
    <div class="bus-body"><Markdown text={item.text ?? ''} /></div>
  </div>
{/if}

<style>
  .status { font-size: 0.72rem; margin: 0.15rem 0; }
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
  .hd { background: none; border: none; color: var(--muted); padding: 0.15rem 0; cursor: pointer; font-size: 0.8rem; }
  .tool { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.3rem 0.5rem; }
  .tool.reflex { border-color: var(--warn); }
  .tname { color: var(--accent); font-family: var(--mono); }
  .reflex-tag { color: var(--warn); font-size: 0.68rem; border: 1px solid var(--warn); border-radius: 999px; padding: 0 0.3rem; margin-left: 0.3rem; }
  .fail { color: var(--bad); font-size: 0.7rem; margin-left: 0.3rem; }
  .io { background: var(--bg); border-radius: 6px; padding: 0.4rem 0.5rem; font-size: 0.72rem; overflow-x: auto; margin: 0.3rem 0 0; }
  .io.out { color: var(--muted); }
  .io.fail { color: var(--bad); }
  .diffs { display: flex; flex-direction: column; gap: 0.4rem; }
  .diff-err { color: var(--bad-text); background: color-mix(in srgb, var(--bad) 12%, transparent); border: 1px solid var(--bad); border-radius: 6px; padding: 0.3rem 0.5rem; font-size: 0.74rem; font-family: var(--mono); word-break: break-word; }
</style>
