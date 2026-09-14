<script lang="ts">
  let { expiresAt }: { expiresAt?: string } = $props()
  let now = $state(Date.now())
  const remaining = $derived(expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000)) : null)
  $effect(() => {
    if (!expiresAt) return
    now = Date.now()
    const timer = window.setInterval(() => { now = Date.now() }, 1000)
    return () => window.clearInterval(timer)
  })
</script>

{#if remaining !== null && Number.isFinite(remaining)}
  <span class="question-deadline" title="The hub skips without submitting an answer, even when this tab is hidden. Codex deadlines take precedence; optional questions otherwise get two minutes.">
    {remaining > 0 ? `Auto-skips in ${remaining}s` : 'Skipping unanswered question…'}
  </span>
{/if}

<style>
  .question-deadline { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
