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
  let failed = $state<Record<string, boolean>>({})
  let retries = $state<Record<string, number>>({})
  const src = (a: AttachmentMeta): string => {
    const url = attachmentUrl(sessionId, a.id)
    return retries[a.id] ? `${url}${url.includes('?') ? '&' : '?'}previewRetry=${retries[a.id]}` : url
  }
</script>

<div class="atts">
  {#each attachments as a (a.id)}
    {#if a.kind === 'image'}
      <div class="image-card" class:wide={expanded === a.id}>
      {#if failed[a.id]}
        <div class="preview-error" role="status">
          Preview unavailable for {a.name}.
          <button onclick={() => { retries[a.id] = (retries[a.id] ?? 0) + 1; failed[a.id] = false }}>Retry preview</button>
        </div>
      {:else}
      <button
        class="thumb"
        class:expanded={expanded === a.id}
        onclick={() => (expanded = expanded === a.id ? null : a.id)}
        aria-expanded={expanded === a.id}
        aria-label={`${expanded === a.id ? 'Shrink' : 'Expand'} ${a.name}`}
        title={expanded === a.id ? 'Click to shrink' : `${a.name} — click to expand`}
      >
        <img src={src(a)} alt={a.name} loading="lazy" decoding="async" onerror={() => { failed[a.id] = true }} />
      </button>
      {/if}
      <div class="image-meta"><span title={a.name}>{a.name}</span><a href={src(a)} download={a.name}>Download</a></div>
      </div>
    {:else}
      <a class="chip" href={src(a)} download={a.name} target="_blank" rel="noreferrer" title="Download {a.name}">
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
  .image-card { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; max-width: 100%; }
  .image-card.wide { width: 100%; }
  .image-meta { display: flex; gap: 0.7rem; justify-content: space-between; font-size: 0.7rem; color: var(--muted); }
  .image-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
  .image-meta a { color: var(--cyan); }
  .preview-error { max-width: 300px; padding: 0.8rem; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 0.8rem; }
  .preview-error button { display: block; margin-top: 0.4rem; }
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
