<script lang="ts">
  import { store } from './store.svelte'
  import { api, type QuestionRecord } from './api'
  import QuestionCard from './QuestionCard.svelte'
  import QuestionDeadline from './QuestionDeadline.svelte'
  import { captureViewerKeys } from './imageGallery'
  let hidden = $state(typeof document !== 'undefined' && document.visibilityState === 'hidden')
  let blurred = $state(false)
  let dismissed = $state<string[]>([])
  let openedId = $state<string | null>(null)
  let shown = $state<string[]>([])
  let error = $state('')
  const pending = $derived(store.questions.filter(q => q.status === 'pending' && !dismissed.includes(q.id)))
  const question = $derived(pending[0])
  const opened = $derived(store.questions.find(q => q.id === openedId && q.status === 'pending'))
  const label = $derived(question ? store.sessions[question.sessionId]?.record.title ?? 'Agent' : '')
  $effect(() => {
    const live = new Set(store.questions.map(q => q.id))
    if (dismissed.some(id => !live.has(id))) dismissed = dismissed.filter(id => live.has(id))
    if (shown.some(id => !live.has(id))) shown = shown.filter(id => live.has(id))
    if (openedId && !live.has(openedId)) openedId = null
  })

  // A card at the bottom of a long transcript is not a visible question prompt. Show a new
  // selected-chat request once, even when the operator is scrolled up; background chats keep
  // a content-free notification until explicitly opened (including secret questions).
  $effect(() => {
    const next = pending.find(q => q.sessionId === store.selectedId && !shown.includes(q.id))
    if (next && !opened && !hidden && !blurred && !store.settingsOpen && !document.querySelector('dialog[open]')) openQuestion(next)
  })
  function openQuestion(q: QuestionRecord): void {
    if (!shown.includes(q.id)) shown = [...shown, q.id]
    error = ''
    openedId = q.id
  }
  async function decide(q: QuestionRecord, answers?: Record<string, string>): Promise<void> {
    error = ''
    const result = answers === undefined ? await api.cancelQuestion(q.id) : await api.answerQuestion(q.id, answers)
    if (result.ok) store.questions = store.questions.filter(item => item.id !== q.id)
    else {
      await store.refreshSideData().catch(() => {})
      if (store.questions.some(item => item.id === q.id)) {
        if (openedId === q.id) error = result.error ?? 'The response was not accepted. The question is still pending.'
      }
      else store.pushLocalNote(q.sessionId, 'That question was already resolved; your response did not decide it.')
    }
  }
  function modal(node: HTMLDialogElement): { destroy: () => void } {
    const previous = document.activeElement as HTMLElement | null
    node.showModal()
    // Also contain held Escape repeats and keyup after unmount; leave text-editing arrows alone.
    const releaseKeys = captureViewerKeys(() => { openedId = null })
    return { destroy: () => {
      releaseKeys()
      node.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    } }
  }
</script>

<svelte:document onvisibilitychange={() => { hidden = document.visibilityState === 'hidden' }} />
<svelte:window onblur={() => { blurred = true }} onfocus={() => { blurred = false }} />
{#if question}
  <aside class="question-attention" aria-label="Question notification" aria-live="polite">
    <strong>{label} {question.blocking === false ? 'has a question' : 'needs your answer'}</strong>
    <span>{question.provider === 'codex' ? 'Codex' : 'Claude'} · {pending.length} pending request{pending.length === 1 ? '' : 's'}</span>
    <QuestionDeadline expiresAt={question.expiresAt} />
    <div>
      <button onclick={() => { store.select(question.sessionId); store.settingsOpen = false; openQuestion(question) }}>Open question</button>
      <button aria-label="Dismiss question notification" onclick={() => { dismissed = [...dismissed, question.id] }}>Dismiss</button>
    </div>
  </aside>
{/if}

{#if opened}
  {#key opened.id}
    <dialog use:modal aria-label="Agent question" oncancel={(event) => { event.preventDefault(); openedId = null }}>
      <div class="question-heading">
        <strong>{store.sessions[opened.sessionId]?.record.title ?? 'Agent'} — {opened.blocking === false ? 'optional question' : 'waiting for your answer'}</strong>
        <button aria-label="Close question without answering" onclick={() => { openedId = null }}>Close</button>
      </div>
      <QuestionCard record={opened} idPrefix="question-popup" {error} onsubmit={(answers) => decide(opened!, answers)} oncancel={() => decide(opened!)} />
    </dialog>
  {/key}
{/if}

<style>
  .question-attention { position: fixed; top: 52px; right: 18px; z-index: 110; display: grid; gap: 7px;
    width: min(330px, calc(100vw - 36px)); padding: 14px; border: 1px solid var(--secondary); border-radius: 10px;
    background: var(--surface); box-shadow: var(--shadow-3); color: var(--text); font-size: 13px; }
  .question-attention > span { color: var(--muted); }
  .question-attention div { display: flex; gap: 12px; }
  button { padding: 6px 9px; border: 1px solid var(--border); border-radius: 6px; }
  dialog { width: min(660px, calc(100vw - 40px)); max-height: calc(100dvh - 60px); overflow: auto;
    padding: 16px; border: 1px solid var(--secondary); border-radius: 12px; background: var(--surface); color: var(--text); }
  dialog::backdrop { background: #0008; }
  .question-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
</style>
