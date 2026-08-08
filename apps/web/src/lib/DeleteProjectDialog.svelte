<script lang="ts">
  import { onMount } from 'svelte'
  import {
    api,
    type ProjectDeletionInspection,
    type ProjectInfo,
  } from './api'

  let {
    project,
    onclose,
    ondelete,
  }: {
    project: ProjectInfo
    onclose: () => void
    ondelete: (deleteFiles: boolean) => Promise<
      { ok: true } | { ok: false; error: string }
    >
  } = $props()

  let inspection = $state<ProjectDeletionInspection | null>(null)
  let loadError = $state('')
  let actionError = $state('')
  let deleting = $state(false)
  let destructiveAcknowledged = $state(false)
  const INSPECTION_TIMEOUT_MS = 25_000

  onMount(() => {
    const controller = new AbortController()
    let mounted = true
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, INSPECTION_TIMEOUT_MS)
    void api.inspectProjectDeletion(project.id, controller.signal)
      .then((result) => {
        if (!mounted) return
        inspection = result
      })
      .catch((error) => {
        if (!mounted) return
        loadError = timedOut
          ? 'Inspection took longer than 25 seconds. The project record can still be removed safely; file deletion remains disabled.'
          : error instanceof Error ? error.message : 'Deletion details could not be loaded.'
      })
      .finally(() => clearTimeout(timeout))
    return () => {
      mounted = false
      clearTimeout(timeout)
      controller.abort()
    }
  })

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !deleting) onclose()
  }

  async function remove(deleteFiles: boolean): Promise<void> {
    deleting = true
    actionError = ''
    try {
      const result = await ondelete(deleteFiles)
      deleting = false
      if (result.ok) onclose()
      else actionError = result.error
    } catch (error) {
      deleting = false
      actionError = error instanceof Error ? error.message : 'The deletion request failed.'
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="presentation" onclick={() => !deleting && onclose()}></div>
<div
  class="dialog"
  role="dialog"
  aria-modal="true"
  aria-labelledby="delete-project-title"
>
  <header>
    <div>
      <div class="eyebrow">Project settings</div>
      <h1 id="delete-project-title">Delete {project.name}?</h1>
    </div>
    <button class="close" aria-label="Close" disabled={deleting} onclick={onclose}>×</button>
  </header>

  <div class="body">
    <section class="safe-choice">
      <strong>Remove it from AllMyAgents</strong>
      <p>
        This is the safe default. It removes the project record and moves its chats to Unfiled.
        It keeps every file and worktree exactly where it is.
      </p>
      <code title={project.path}>{project.path}</code>
    </section>

    {#if !inspection && !loadError}
      <div class="loading" role="status">Inspecting local work before deletion…</div>
    {:else if loadError}
      <div class="error" role="alert">
        <strong>Local work could not be inspected.</strong>
        <span>{loadError}</span>
        <span>You can still remove the project record, but file deletion is unavailable.</span>
      </div>
    {:else if inspection}
      <section class="inventory" aria-label="Local work inventory">
        <div class="inventory-head">
          <div>
            <h2>Work that stays on disk</h2>
            <p>Review these exact paths before choosing the destructive option.</p>
          </div>
          <span class="count">
            {inspection.changeCount ?? inspection.changes.length} file{(inspection.changeCount ?? inspection.changes.length) === 1 ? '' : 's'} ·
            {inspection.localCommits.length} local commit{inspection.localCommits.length === 1 ? '' : 's'} ·
            {inspection.worktrees.length} worktree{inspection.worktrees.length === 1 ? '' : 's'}
          </span>
        </div>

        {#if inspection.changes.length}
          <div class="group">
            <h3>Uncommitted and untracked files</h3>
            <ul>
              {#each inspection.changes as change (`${change.kind}:${change.checkoutPath}:${change.path}`)}
                <li>
                  <span class="tag">{change.kind}</span>
                  <code title={change.path}>{change.path}</code>
                </li>
              {/each}
            </ul>
            {#if inspection.changesTruncated}
              <p class="truncated">Showing the first {inspection.changes.length} paths. The full directory remains covered by the project-path warning below.</p>
            {/if}
          </div>
        {/if}

        {#if inspection.localCommits.length}
          <div class="group">
            <h3>Commits not known to be pushed</h3>
            <ul>
              {#each inspection.localCommits as commit (`${commit.checkoutPath}:${commit.hash}`)}
                <li class="commit">
                  <code title={commit.hash}>{commit.hash.slice(0, 10)}</code>
                  <span>{commit.subject || '(no commit message)'}</span>
                  <small title={commit.checkoutPath}>{commit.checkoutPath}</small>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if inspection.worktrees.length}
          <div class="group">
            <h3>Project chat worktrees</h3>
            <ul>
              {#each inspection.worktrees as worktree (worktree.sessionId)}
                <li>
                  <span class="tag">{worktree.status}</span>
                  <span class="worktree">
                    <strong>{worktree.title}</strong>
                    <code title={worktree.path}>{worktree.path}</code>
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if !inspection.changes.length && !inspection.localCommits.length && !inspection.worktrees.length}
          <div class="clear">No uncommitted files, local-only commits, or project worktrees were found.</div>
        {/if}

        {#if inspection.inspectionErrors.length}
          <div class="error" role="alert">
            <strong>Some paths could not be inspected.</strong>
            {#each inspection.inspectionErrors as failure (failure.path)}
              <span><code>{failure.path}</code> — {failure.message}</span>
            {/each}
            <span>File deletion is disabled because the inventory is incomplete.</span>
          </div>
        {/if}
      </section>

      <section class="destructive">
        <label>
          <input
            type="checkbox"
            bind:checked={destructiveAcknowledged}
            disabled={inspection.inspectionErrors.length > 0 || deleting}
          />
          <span>
            <strong>Also delete the project files and chats</strong>
            <small>
              This permanently removes <code>{inspection.projectPath}</code>, its listed worktrees,
              and the project’s chat records. This cannot be undone by AllMyAgents.
            </small>
          </span>
        </label>
      </section>
    {/if}

    {#if actionError}
      <div class="error action-error" role="alert">
        <strong>Project was not deleted.</strong>
        <span>{actionError}</span>
      </div>
    {/if}
  </div>

  <footer>
    <button class="btn btn-ghost" disabled={deleting} onclick={onclose}>Go back and clean up</button>
    <span class="spacer"></span>
    <button
      class="btn btn-danger"
      disabled={!inspection || inspection.inspectionErrors.length > 0 || !destructiveAcknowledged || deleting}
      onclick={() => void remove(true)}
    >
      {deleting && destructiveAcknowledged ? 'Deleting…' : 'Delete project and files'}
    </button>
    <button class="btn btn-primary" disabled={deleting} onclick={() => void remove(false)}>
      {deleting && !destructiveAcknowledged ? 'Removing…' : 'Remove from AllMyAgents'}
    </button>
  </footer>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 70; background: rgba(7, 7, 17, .68);
    backdrop-filter: blur(6px);
  }
  .dialog {
    position: fixed; z-index: 71; inset: max(2.5vh, 1rem) auto auto 50%;
    transform: translateX(-50%); width: min(760px, calc(100vw - 2rem));
    max-height: calc(100vh - max(5vh, 2rem)); overflow: hidden;
    display: flex; flex-direction: column;
    background: var(--surface); border: 1px solid var(--border-strong);
    border-radius: var(--r-xl); box-shadow: var(--shadow-4), var(--edge-hi);
  }
  header, footer { flex: none; display: flex; align-items: center; gap: var(--space-3); padding: var(--space-5); }
  header { justify-content: space-between; border-bottom: 1px solid var(--border); }
  footer { border-top: 1px solid var(--border); flex-wrap: wrap; }
  .body { min-height: 0; overflow: auto; padding: var(--space-5); display: grid; gap: var(--space-4); }
  h1, h2, h3, p { margin: 0; }
  h1 { font-size: var(--text-xl); }
  h2 { font-size: var(--text-base); }
  h3 { font-size: var(--text-sm); color: var(--text-dim); }
  p { color: var(--text-dim); line-height: 1.5; }
  code { font: inherit; font-family: var(--font-mono); overflow-wrap: anywhere; }
  .eyebrow { color: var(--accent); font-size: var(--text-xs); font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .close { border: 0; background: transparent; color: var(--text-dim); font-size: 1.65rem; cursor: pointer; }
  .safe-choice, .inventory, .destructive {
    border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--space-4);
  }
  .safe-choice { display: grid; gap: var(--space-2); background: color-mix(in srgb, var(--accent) 6%, transparent); }
  .safe-choice > code { color: var(--text-dim); font-size: var(--text-xs); }
  .inventory { display: grid; gap: var(--space-4); }
  .inventory-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
  .inventory-head p { font-size: var(--text-sm); }
  .count { flex: none; font-size: var(--text-xs); color: var(--text-dim); }
  .group { display: grid; gap: var(--space-2); }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: .4rem; }
  li { min-width: 0; display: flex; align-items: flex-start; gap: var(--space-2); color: var(--text); font-size: var(--text-sm); }
  li > code { min-width: 0; }
  .tag {
    flex: none; padding: .08rem .35rem; border-radius: 999px; background: var(--surface-2);
    color: var(--text-dim); font-size: .65rem; text-transform: uppercase;
  }
  .commit { display: grid; grid-template-columns: auto minmax(0, 1fr); }
  .commit > code { color: var(--accent); }
  .commit small { grid-column: 2; color: var(--dim); overflow-wrap: anywhere; }
  .worktree { min-width: 0; display: grid; gap: .15rem; }
  .worktree code { color: var(--text-dim); font-size: var(--text-xs); }
  .destructive { border-color: color-mix(in srgb, var(--bad) 40%, var(--border)); }
  .destructive label { display: flex; align-items: flex-start; gap: var(--space-3); cursor: pointer; }
  .destructive input { margin-top: .2rem; }
  .destructive span { display: grid; gap: .2rem; }
  .destructive small { color: var(--text-dim); line-height: 1.45; }
  .error {
    display: grid; gap: .25rem; padding: var(--space-3); border-radius: var(--r-md);
    background: color-mix(in srgb, var(--bad) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--bad) 35%, var(--border));
    color: var(--text); font-size: var(--text-sm);
  }
  .loading, .clear { color: var(--text-dim); padding: var(--space-4); text-align: center; }
  .spacer { flex: 1; }
  @media (max-width: 560px) {
    .dialog { inset: .5rem .5rem .5rem .5rem; transform: none; width: auto; max-height: none; }
    header, footer, .body { padding: var(--space-3); }
    .inventory-head { flex-direction: column; }
    footer .btn { flex: 1 1 100%; }
    .spacer { display: none; }
  }
</style>
