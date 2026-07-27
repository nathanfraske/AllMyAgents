<script lang="ts">
  import type { AttachmentMeta } from './attachments'
  import { formatBytes } from './attachments'
  import { attachmentUrl } from './attachmentUrl'

  // Renders attachments that are PART OF A SENT MESSAGE, in the transcript. The source is always the hub
  // URL (attachmentUrl) — NEVER a composer object URL — so a message attached in a previous session still
  // renders after a reload, when any blob: URL is long dead. This is deliberately a separate component
  // from the composer's AttachmentPreview so the two source paths cannot silently converge.
  let { sessionId, attachments }: { sessionId: string; attachments: AttachmentMeta[] } = $props()

  // Which image is expanded (by id). Per-message local state; images open larger inline, click to close.
  let expanded = $state<string | null>(null)
  const src = (a: AttachmentMeta): string => attachmentUrl(sessionId, a.id)
</script>

<div class="atts">
  {#each attachments as a (a.id)}
    {#if a.kind === 'image'}
      <button
        class="thumb"
        class:expanded={expanded === a.id}
        onclick={() => (expanded = expanded === a.id ? null : a.id)}
        title={expanded === a.id ? 'Click to shrink' : `${a.name} — click to expand`}
      >
        <img src={src(a)} alt={a.name} loading="lazy" />
      </button>
    {:else}
      <a class="chip" href={src(a)} target="_blank" rel="noreferrer" title="Open {a.name}">
        <span class="fico" aria-hidden="true">▤</span>
        <span class="meta">
          <span class="name">{a.name}</span>
          <span class="sub">{a.mime || 'file'}{#if a.size} · {formatBytes(a.size)}{/if}</span>
        </span>
      </a>
    {/if}
  {/each}
</div>

<style>
  .atts { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.4rem; }
  .thumb { padding: 0; border: 1px solid var(--border-strong); border-radius: 8px; overflow: hidden; background: var(--surface-2); cursor: zoom-in; line-height: 0; }
  .thumb img { max-width: 220px; max-height: 160px; object-fit: cover; display: block; }
  .thumb.expanded { cursor: zoom-out; }
  .thumb.expanded img { max-width: min(100%, 720px); max-height: 80vh; object-fit: contain; }
  .chip { display: inline-flex; align-items: center; gap: 0.5rem; max-width: 280px; padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface-2); color: var(--text); text-decoration: none; }
  .chip:hover { border-color: var(--accent); }
  .fico { font-size: 1rem; color: var(--muted); flex: none; }
  .meta { display: flex; flex-direction: column; min-width: 0; }
  .name { font-size: 0.78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: 0.68rem; color: var(--muted); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
