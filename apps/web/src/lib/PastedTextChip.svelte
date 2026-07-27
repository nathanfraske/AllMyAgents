<script lang="ts">
  import { pasteChipLabel, type PastedText } from './pastePromote'

  // A promoted large paste, shown in the composer as a chip instead of a wall. The user can SEE what
  // happened and undo it: expand to read, remove, or put it back inline as plain text if they actually
  // wanted it in the box. The content is delivered to the agent on send (inlined into the prompt) — the
  // chip is a UI affordance, not a change to delivery.
  let {
    paste,
    onremove,
    oninline,
  }: { paste: PastedText; onremove: (id: string) => void; oninline: (id: string) => void } = $props()

  let open = $state(false)
</script>

<div class="pchip">
  <div class="row">
    <span class="ico" aria-hidden="true">¶</span>
    <span class="label">{pasteChipLabel(paste.content)}</span>
    <button class="act" title={open ? 'Hide' : 'Expand to read'} onclick={() => (open = !open)}>{open ? 'hide' : 'view'}</button>
    <button class="act" title="Insert back into the message as plain text" onclick={() => oninline(paste.id)}>as text</button>
    <button class="rm" title="Remove" aria-label="Remove pasted text" onclick={() => onremove(paste.id)}>✕</button>
  </div>
  {#if open}
    <pre class="body">{paste.content}</pre>
  {/if}
</div>

<style>
  .pchip { border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface-2); margin-bottom: 0.5rem; }
  .row { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.5rem; }
  .ico { color: var(--muted); flex: none; }
  .label { flex: 1; min-width: 0; font-size: 0.76rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .act { flex: none; font-size: 0.7rem; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 0.1rem 0.4rem; }
  .act:hover { color: var(--text); border-color: var(--border-strong); }
  .rm { flex: none; width: 20px; height: 20px; border-radius: 5px; color: var(--dim); }
  .rm:hover { background: var(--surface-3); color: var(--bad-text); }
  .body { margin: 0; padding: 0.5rem 0.6rem; border-top: 1px solid var(--border); max-height: 14rem; overflow: auto;
    white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 0.72rem; color: var(--muted); }
</style>
