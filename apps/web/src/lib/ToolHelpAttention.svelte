<script lang="ts">
  import { api } from './api'
  import { store } from './store.svelte'

  let opened = $state(false)
  let openedKey = $state('')
  let busy = $state(false)
  let error = $state('')
  let deliveryWarning = $state('')
  const pending = $derived(Object.values(store.sessions).filter(s => !s.record.siteId).flatMap(s =>
    (s.record.toolHelp ?? []).filter(item => item.status === 'waiting' || item.status === 'skipped').map(item => ({ session: s.record, item }))))
  const current = $derived(pending.find(p => p.session.id === store.selectedId) ?? pending[0])
  const reviewing = $derived(pending.find(p => `${p.session.id}:${p.item.id}` === openedKey))

  async function decide(action: 'retry' | 'diagnose' | 'skip') {
    if (!reviewing || busy) return
    const request = reviewing
    busy = true
    error = ''
    try {
      const result = await api.resolveToolHelp(request.session.id, request.item.id, action)
      if ('error' in result) error = result.error
      else {
        deliveryWarning = result.warning ?? ''
        opened = false
        // Replace the array so an older in-flight roster cannot resurrect this exact decision.
        const record = store.sessions[request.session.id]?.record
        if (record) record.toolHelp = record.toolHelp?.flatMap(item => item.id !== request.item.id
          ? [item] : action === 'retry' ? [] : [{ ...item, status: action === 'diagnose' ? 'investigating' : 'skipped' }])
      }
      // Side data contains approvals/questions, not tool holds. Read the canonical session record,
      // including the new incident identity issued for a bounded diagnosis.
      await store.syncRecordsFromHub()
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason)
    } finally { busy = false }
  }
  function modal(node: HTMLDialogElement) {
    node.showModal()
    return { destroy: () => node.close() }
  }
</script>

{#if deliveryWarning}
  <aside class="tool-help" role="alert">
    <span>{deliveryWarning}</span>
    <button onclick={() => { deliveryWarning = '' }}>Dismiss</button>
  </aside>
{/if}
{#if current && !deliveryWarning}
  <aside class="tool-help" aria-label="Operator tool help" aria-live="polite">
    <strong>{current.session.title ?? 'Agent'} — {current.item.status === 'skipped' ? 'tool work skipped' : 'needs tool help'}</strong>
    <span>{current.item.tool} · {pending.length} tool hold{pending.length === 1 ? '' : 's'}</span>
    <button onclick={() => { openedKey = `${current.session.id}:${current.item.id}`; store.select(current.session.id); opened = true; error = '' }}>Review tool failure</button>
  </aside>
  {#if opened && reviewing}
    <dialog use:modal aria-label="Review tool failure" oncancel={() => { opened = false }}>
      <h3>{reviewing.item.tool}: {reviewing.item.status === 'skipped' ? 'affected work skipped' : 'waiting for your help'}</h3>
      <p>{reviewing.item.failures >= 2 ? 'The initial attempt and one retry failed.' : 'Replay may be unsafe, so the agent did not retry.'} Affected work is paused.</p>
      <pre>{reviewing.item.summary}</pre>
      <p>Clearing this hold does not grant permissions or replay an operation. Diagnosis is limited to five minutes and existing authority. Inspect uncertain outcomes first.</p>
      {#if error}<p role="alert">{error}</p>{/if}
      <div class="actions">
        <button disabled={busy} onclick={() => decide('retry')}>I fixed it — allow retry</button>
        <button disabled={busy} onclick={() => decide('diagnose')}>Allow 5-minute diagnosis</button>
        <button disabled={busy || reviewing.item.status === 'skipped'} onclick={() => decide('skip')}>Skip affected work</button>
        <button disabled={busy} onclick={() => { opened = false }}>Close</button>
      </div>
    </dialog>
  {/if}
{/if}

<style>
  .tool-help { position: fixed; right: 18px; bottom: 20px; z-index: 110; display: grid; gap: 8px; padding: 14px; max-width: 330px; border: 1px solid var(--secondary); border-radius: 10px; background: var(--surface); box-shadow: var(--shadow-3); color: var(--text); font-size: 13px; }
  dialog { width: min(660px, calc(100vw - 40px)); max-height: 85vh; overflow: auto; padding: 20px; border: 1px solid var(--secondary); border-radius: 12px; background: var(--surface); color: var(--text); }
  dialog::backdrop { background: #0008; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button { padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; }
</style>
