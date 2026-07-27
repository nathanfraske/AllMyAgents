<script lang="ts">
  import Icon from './Icon.svelte'

  type Mode = 'worktree' | 'project'

  let {
    draft,
    selected,
    worktreePath,
    projectPath,
    onselect,
  }: {
    draft: boolean
    selected: Mode
    worktreePath?: string
    projectPath?: string
    onselect?: (mode: Mode) => void
  } = $props()

  const MODES: Array<{ id: Mode; icon: string; label: string; desc: string }> = [
    { id: 'worktree', icon: 'git-branch', label: 'Worktree', desc: 'isolated copy, your project is untouched' },
    { id: 'project', icon: 'folder', label: 'Project', desc: 'works directly in the project folder' },
  ]

  const current = $derived(MODES.find((mode) => mode.id === selected) ?? MODES[0])
  const phase = $derived(draft ? 'Will work in' : 'Works in')

  function titleFor(id: Mode, desc: string): string {
    const location = id === 'worktree' ? worktreePath : projectPath
    const path = location ? ` — ${location}` : ''
    const locked = draft ? '' : ' This cannot be changed after the chat starts.'
    return `${desc}${path}.${locked}`.trim()
  }
</script>

<div class="workmode" role="group" aria-label={draft ? 'Where this chat will work' : 'Where this chat works'}>
  <span class="phase">{phase}</span>
  <span class="segments" class:readonly={!draft}>
    {#each MODES as mode (mode.id)}
      <button
        class="segment"
        class:sel={mode.id === selected}
        disabled={!draft}
        aria-pressed={mode.id === selected}
        aria-label={`${mode.label} — ${mode.desc}`}
        title={titleFor(mode.id, mode.desc)}
        onclick={() => onselect?.(mode.id)}
      >
        <Icon name={mode.icon} size={12} />
        <span>{mode.label}</span>
      </button>
    {/each}
  </span>
  <span class="desc dim">{current.desc}</span>
</div>

<style>
  .workmode { display: grid; grid-template-columns: auto auto; grid-template-areas: 'phase segments' 'desc desc';
    align-items: center; gap: 1px var(--space-2); min-width: 0; }
  .phase { grid-area: phase; color: var(--dim); font-size: var(--text-xs); }
  .segments { display: inline-flex; flex: none; padding: 2px; gap: 2px; border: 1px solid var(--border);
    border-radius: var(--r-md); background: var(--surface-2); grid-area: segments; }
  .segment { display: inline-flex; align-items: center; gap: var(--space-1); padding: 0.2rem 0.45rem;
    border-radius: var(--r-sm); color: var(--muted); font-size: var(--text-xs); }
  .segment:hover:not(:disabled) { color: var(--text); background: var(--surface-3); }
  .segment.sel { color: var(--text); background: var(--surface-3); box-shadow: var(--edge-hi); font-weight: var(--fw-medium); }
  .segment.sel :global(svg) { color: var(--accent); }
  .segments.readonly .segment { cursor: default; }
  .segments.readonly .segment:not(.sel) { opacity: 0.38; }
  .segment:disabled { opacity: 1; }
  .desc { grid-area: desc; min-width: 0; white-space: nowrap; font-size: var(--text-2xs); }
</style>
