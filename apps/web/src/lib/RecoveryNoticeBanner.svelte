<script lang="ts">
  import { onDestroy } from 'svelte'
  import { store } from './store.svelte'

  let dismissing = $state<Set<string>>(new Set())
  let dismissError = $state('')
  let previousNoticeIds: string[] = []
  let arrival = $state('')
  let arrivalGeneration = $state(0)
  let arrivalTimer: ReturnType<typeof setTimeout> | undefined

  function announce(message: string): void {
    if (arrivalTimer) clearTimeout(arrivalTimer)
    const generation = ++arrivalGeneration
    arrival = message
    arrivalTimer = setTimeout(() => {
      if (arrivalGeneration !== generation) return
      arrival = ''
      arrivalTimer = undefined
    }, 1_500)
  }

  onDestroy(() => {
    if (arrivalTimer) clearTimeout(arrivalTimer)
  })

  $effect(() => {
    const currentIds = store.recoveryNotices.slice(0, 8).map((notice) => notice.planId)
    const previous = new Set(previousNoticeIds)
    const arrived = currentIds.filter((id) => !previous.has(id)).length
    if (arrived > 0) {
      announce(
        arrived === 1
          ? `New journal recovery notice. ${currentIds.length} pending review.`
          : `${arrived} new journal recovery notices. ${currentIds.length} pending review.`
      )
    }
    previousNoticeIds = currentIds
  })

  async function dismiss(planId: string): Promise<void> {
    if (dismissing.has(planId)) return
    dismissError = ''
    dismissing = new Set([...dismissing, planId])
    try {
      const dismissed = await store.dismissRecoveryNotice(planId)
      if (!dismissed) {
        dismissError = 'The recovery notice was not dismissed. It remains visible; reconnect and try again.'
      }
    } catch {
      dismissError = 'The recovery notice was not dismissed. It remains visible; reconnect and try again.'
    } finally {
      const next = new Set(dismissing)
      next.delete(planId)
      dismissing = next
    }
  }
</script>

{#if store.recoveryNotices.length > 0}
  <section class="recovery-notices" aria-label="Journal recovery notices">
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {#key arrivalGeneration}<span>{arrival}</span>{/key}
    </div>
    {#if dismissError}<p class="dismiss-error" role="status">{dismissError}</p>{/if}
    {#each store.recoveryNotices as notice (notice.planId)}
      <article class="recovery-notice">
        <div>
          <strong>Journal recovery completed.</strong>
          <p>
            Restored verified generation {notice.generation} at snapshot event high-water
            {notice.snapshotEventHighWater} (maximum retained row sequence {notice.snapshotMaxSeq}).
            The damaged SQLite family was quarantined at <code>{notice.quarantineDir}</code>;
            its continued retention has not been reverified.
          </p>
          <p class="warning">
            Post-snapshot tail outcome unknown. No lost-row count is inferred.
          </p>
        </div>
        <button
          type="button"
          disabled={dismissing.has(notice.planId)}
          onclick={() => void dismiss(notice.planId)}
          aria-label="Dismiss recovery generation {notice.generation}, incident {notice.planId.slice(0, 8)}"
        >
          {dismissing.has(notice.planId) ? 'Dismissing...' : 'Dismiss'}
        </button>
      </article>
    {/each}
  </section>
{/if}

<style>
  .recovery-notices {
    z-index: 20;
    max-height: min(34vh, 18rem);
    overflow-y: auto;
    border-bottom: 1px solid var(--warn, rgba(180, 120, 0, 0.4));
    background: var(--warn-bg, rgba(180, 120, 0, 0.14));
  }
  .recovery-notice {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    color: var(--warn-text, #d08700);
    font-size: var(--text-xs);
    line-height: 1.45;
  }
  .recovery-notice + .recovery-notice {
    border-top: 1px solid color-mix(in srgb, currentColor 24%, transparent);
  }
  p { margin: var(--space-1) 0 0; }
  .warning { font-weight: 650; }
  .dismiss-error { margin: 0; padding: var(--space-2) var(--space-4); color: var(--bad); }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  code {
    overflow-wrap: anywhere;
    color: inherit;
  }
  button {
    flex: none;
    border: 1px solid currentColor;
    border-radius: var(--r-md);
    padding: var(--space-1) var(--space-3);
    color: inherit;
    background: transparent;
  }
  button:disabled { opacity: 0.55; }
  @media (max-width: 520px) {
    .recovery-notice { flex-direction: column; }
    button { align-self: flex-end; }
  }
</style>
