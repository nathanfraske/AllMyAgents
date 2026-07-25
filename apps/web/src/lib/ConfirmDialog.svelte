<script lang="ts">
  import { dialog } from './dialog.svelte'

  // Focus the primary button when a dialog opens and restore focus to whatever was focused before
  // when it closes — standard modal focus handling for keyboard + screen-reader users. Keyed by
  // `d.id` below so each dialog gets a fresh mount (and thus a fresh focus lifecycle).
  function focusReturn(node: HTMLElement): { destroy: () => void } {
    const prev = document.activeElement as HTMLElement | null
    node.focus()
    return { destroy: () => prev?.focus?.() }
  }

  // Enter confirms, Esc cancels — handled on the window so it works regardless of which control
  // holds focus. Inert unless a dialog is actually open.
  function onKey(e: KeyboardEvent): void {
    if (!dialog.current) return
    if (e.key === 'Escape') {
      e.preventDefault()
      dialog.cancel()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      dialog.accept()
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if dialog.current}
  {@const d = dialog.current}
  {#key d.id}
    <div class="dlg-backdrop" role="button" tabindex="-1" aria-label="dismiss" onclick={() => dialog.cancel()} onkeydown={() => {}}></div>
    <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-msg">
      <p class="dlg-msg" id="dlg-msg">{d.message}</p>
      <div class="dlg-actions">
        {#if d.kind === 'confirm'}
          <button class="btn btn-ghost" onclick={() => dialog.cancel()}>{d.cancelLabel}</button>
        {/if}
        <button class="btn {d.danger ? 'btn-danger' : 'btn-primary'}" use:focusReturn onclick={() => dialog.accept()}>{d.confirmLabel}</button>
      </div>
    </div>
  {/key}
{/if}

<style>
  .dlg-backdrop { position: fixed; inset: 0; background: rgba(7, 7, 17, 0.55); backdrop-filter: blur(6px); z-index: 60; }
  .dlg { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 61;
    width: min(420px, 92vw);
    background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-xl);
    box-shadow: var(--shadow-4), var(--edge-hi);
    padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-5); }
  .dlg-msg { margin: 0; font-size: var(--text-base); line-height: 1.55; color: var(--text); white-space: pre-wrap; }
  .dlg-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
  @media (prefers-reduced-motion: no-preference) {
    .dlg-backdrop { animation: dlg-fade var(--dur-fast) var(--ease); }
    .dlg { animation: dlg-pop var(--dur) var(--ease); }
    @keyframes dlg-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes dlg-pop { from { opacity: 0; transform: translate(-50%, -48%) scale(0.98); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
  }
</style>
