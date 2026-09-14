<script lang="ts">
  import { store } from './store.svelte'
  import QuestionDeadline from './QuestionDeadline.svelte'
  let hidden = $state(typeof document !== 'undefined' && document.visibilityState === 'hidden')
  let blurred = $state(false)
  let dismissed = $state<string[]>([])
  const pending = $derived(store.questions.filter(q => q.status === 'pending' && (q.sessionId !== store.selectedId || hidden || blurred) && !dismissed.includes(q.id)))
  const question = $derived(pending[0])
  const label = $derived(question ? store.sessions[question.sessionId]?.record.title ?? 'Agent' : '')
  $effect(() => {
    const live = new Set(store.questions.map(q => q.id))
    if (dismissed.some(id => !live.has(id))) dismissed = dismissed.filter(id => live.has(id))
  })
</script>

<svelte:document onvisibilitychange={() => { hidden = document.visibilityState === 'hidden' }} />
<svelte:window onblur={() => { blurred = true }} onfocus={() => { blurred = false }} />
{#if question}
  <aside class="question-attention" aria-label="Question notification" aria-live="polite">
    <strong>{label} {question.blocking === false ? 'has a question' : 'needs your answer'}</strong>
    <span>{question.provider === 'codex' ? 'Codex' : 'Claude'} · {pending.length} pending request{pending.length === 1 ? '' : 's'}</span>
    <QuestionDeadline expiresAt={question.expiresAt} />
    <div>
      <button onclick={() => { store.select(question.sessionId); store.settingsOpen = false }}>Open question</button>
      <button aria-label="Dismiss question notification" onclick={() => { dismissed = [...dismissed, question.id] }}>Dismiss</button>
    </div>
  </aside>
{/if}

<style>
  .question-attention { position: fixed; top: 52px; right: 18px; z-index: 110; display: grid; gap: 7px;
    width: min(330px, calc(100vw - 36px)); padding: 14px; border: 1px solid var(--secondary); border-radius: 10px;
    background: var(--surface); box-shadow: var(--shadow-3); color: var(--text); font-size: 13px; }
  .question-attention > span { color: var(--muted); }
  .question-attention div { display: flex; gap: 12px; }
  button { padding: 6px 9px; border: 1px solid var(--border); border-radius: 6px; }
</style>
