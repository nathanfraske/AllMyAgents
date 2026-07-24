<script lang="ts">
  let { provider, size = 14 }: { provider: 'claude' | 'codex'; size?: number } = $props()
</script>

{#if provider === 'claude'}
  <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Claude (Anthropic)">
    <g stroke="#d97757" stroke-width="8" stroke-linecap="round">
      <line x1="50" y1="50" x2="50" y2="9" />
      <line x1="50" y1="50" x2="79" y2="21" />
      <line x1="50" y1="50" x2="91" y2="50" />
      <line x1="50" y1="50" x2="79" y2="79" />
      <line x1="50" y1="50" x2="50" y2="91" />
      <line x1="50" y1="50" x2="21" y2="79" />
      <line x1="50" y1="50" x2="9" y2="50" />
      <line x1="50" y1="50" x2="21" y2="21" />
    </g>
  </svg>
{:else}
  <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Codex (OpenAI)">
    <g fill="none" stroke="#10a37f" stroke-width="9">
      <ellipse cx="50" cy="50" rx="17" ry="38" />
      <ellipse cx="50" cy="50" rx="17" ry="38" transform="rotate(60 50 50)" />
      <ellipse cx="50" cy="50" rx="17" ry="38" transform="rotate(120 50 50)" />
    </g>
  </svg>
{/if}
