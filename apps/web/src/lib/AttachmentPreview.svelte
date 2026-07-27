<script lang="ts">
  import { formatBytes, vendorSupport, type AttachmentKind, type Vendor } from './attachments'

  // Composer-side preview of STAGED (not-yet-sent) attachments. Source for images is a composer object
  // URL (`previewUrl`), which is correct here and ONLY here — the transcript uses a hub URL instead (see
  // MessageAttachments). Shows a per-item remove control and, crucially, a "not supported here" badge for
  // an attachment the CURRENT vendor cannot take — silently dropping a file the user deliberately attached
  // is the worst option, so we mark it and (at send time) exclude it with a note rather than pretend.
  export interface StagedAttachment {
    id: string
    name: string
    mime: string
    size: number
    kind: AttachmentKind
    previewUrl?: string
  }
  let {
    attachments,
    vendor,
    onremove,
  }: { attachments: StagedAttachment[]; vendor: Vendor; onremove: (id: string) => void } = $props()
</script>

{#if attachments.length}
  <div class="staged">
    {#each attachments as a (a.id)}
      {@const support = vendorSupport(a, vendor)}
      <div class="item" class:unsupported={!support.ok} title={support.ok ? a.name : support.reason}>
        {#if a.kind === 'image' && a.previewUrl}
          <img class="thumb" src={a.previewUrl} alt={a.name} />
        {:else}
          <span class="fico" aria-hidden="true">▤</span>
        {/if}
        <span class="meta">
          <span class="name">{a.name}</span>
          <span class="sub">{a.mime || 'file'}{#if a.size} · {formatBytes(a.size)}{/if}</span>
          {#if !support.ok}<span class="warn">{support.reason}</span>{/if}
        </span>
        <button class="rm" title="Remove" aria-label="Remove {a.name}" onclick={() => onremove(a.id)}>✕</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .staged { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
  .item { position: relative; display: flex; align-items: center; gap: 0.5rem; max-width: 260px;
    padding: 0.35rem 0.5rem; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface-2); }
  .item.unsupported { border-color: color-mix(in srgb, var(--warn) 55%, var(--border)); opacity: 0.85; }
  .thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 6px; flex: none; }
  .fico { width: 40px; height: 40px; display: grid; place-items: center; font-size: 1.2rem; color: var(--muted); flex: none; }
  .meta { display: flex; flex-direction: column; min-width: 0; }
  .name { font-size: 0.76rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: 0.66rem; color: var(--muted); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .warn { font-size: 0.64rem; color: var(--warn); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rm { flex: none; width: 20px; height: 20px; border-radius: 5px; color: var(--dim); }
  .rm:hover { background: var(--surface-3); color: var(--bad-text); }
</style>
