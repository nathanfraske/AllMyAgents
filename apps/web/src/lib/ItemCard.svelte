<script lang="ts">
  import type { ThreadItem } from './store.svelte'

  let { item }: { item: ThreadItem } = $props()
  let open = $state(false)
  let showFull = $state(false)

  const longUser = $derived(
    item.kind === 'user' && !!item.text && (item.text.length > 600 || item.text.split('\n').length > 8)
  )
</script>

{#if item.kind === 'status'}
  <div class="status muted">→ {item.status}</div>
{:else if item.kind === 'note'}
  <div class="note dim">{item.text}</div>
{:else if item.kind === 'error'}
  <div class="err">{item.text}</div>
{:else if item.kind === 'assistant' || item.kind === 'user'}
  <div class="msg {item.kind}">
    <div class="who">{item.kind}</div>
    <div class="text" class:clamp={longUser && !showFull}>{item.text}</div>
    {#if longUser}
      <button class="more" onclick={() => (showFull = !showFull)}>{showFull ? 'Show less' : 'Show full message'}</button>
    {/if}
  </div>
{:else if item.kind === 'thinking' || item.kind === 'reasoning'}
  <div class="think">
    <button class="hd" onclick={() => (open = !open)}>{open ? '▾' : '▸'} {item.kind}</button>
    {#if open}<div class="text think-body">{item.text}</div>{/if}
  </div>
{:else if item.kind === 'tool'}
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

<style>
  .status { font-size: 0.72rem; margin: 0.15rem 0; }
  .note { font-size: 0.72rem; font-family: var(--mono); }
  .err { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); border: 1px solid var(--bad); border-radius: 6px; padding: 0.4rem 0.6rem; font-size: 0.8rem; }
  .msg { border-radius: 8px; padding: 0.5rem 0.7rem; }
  .msg.assistant { background: var(--surface); border: 1px solid var(--border); }
  .msg.user { background: color-mix(in srgb, var(--accent) 10%, transparent); border: 1px solid var(--border-strong); }
  .who { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dim); margin-bottom: 0.2rem; }
  .text { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .text.clamp { max-height: 8.4rem; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
  .more { margin-top: 0.3rem; font-size: 0.74rem; color: var(--accent); }
  .think { border-left: 2px solid var(--border-strong); padding-left: 0.5rem; }
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
</style>
