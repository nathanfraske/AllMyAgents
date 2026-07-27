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


  function titleFor(id: Mode, desc: string): string {
    const location = id === 'worktree' ? worktreePath : projectPath
    const path = location ? ` — ${location}` : ''
    const locked = draft ? '' : ' This cannot be changed after the chat starts.'
    return `${desc}${path}.${locked}`.trim()
  }
</script>

<!-- The segmented control alone. The prose that used to sit around it ("Will work in …" above, the selected
     mode's description below) said what the two labelled, icon'd segments already say, and cost two lines
     in a composer footer that is fighting for room in every split pane. The wording survives where it is
     actually useful: the per-segment `title` (which also carries the real path) and the aria-label, so
     hover and assistive tech still explain the choice. -->
<div class="workmode" role="group" aria-label={draft ? 'Where this chat will work' : 'Where this chat works'}>
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
</div>

<style>
  /* One row, one control. The two-row grid existed to place the phase label and the description; with
     those gone a grid buys nothing and the footer gets two lines back in every split pane. */
  .workmode { display: inline-flex; align-items: center; min-width: 0; }
  .segments { display: inline-flex; flex: none; padding: 2px; gap: 2px; border: 1px solid var(--border);
    border-radius: var(--r-md); background: var(--surface-2); }
  .segment { display: inline-flex; align-items: center; gap: var(--space-1); padding: 0.2rem 0.45rem;
    border-radius: var(--r-sm); color: var(--muted); font-size: var(--text-xs); }
  .segment:hover:not(:disabled) { color: var(--text); background: var(--surface-3); }
  .segment.sel { color: var(--text); background: var(--surface-3); box-shadow: var(--edge-hi); font-weight: var(--fw-medium); }
  .segment.sel :global(svg) { color: var(--accent); }
  .segments.readonly .segment { cursor: default; }
  .segments.readonly .segment:not(.sel) { opacity: 0.38; }
  .segment:disabled { opacity: 1; }
</style>
