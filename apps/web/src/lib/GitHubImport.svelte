<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type GitHubCloneJob, type GitHubRepository, type ProjectInfo } from './api'
  import Icon from './Icon.svelte'

  let {
    onImported,
    onClose,
  }: {
    onImported: (project: ProjectInfo) => void | Promise<void>
    onClose: () => void
  } = $props()

  let checking = $state(true)
  let unavailable = $state('')
  let error = $state('')
  let repositories = $state<GitHubRepository[]>([])
  let query = $state('')
  let job = $state<GitHubCloneJob | null>(null)
  let disposed = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollFailures = 0

  const filtered = $derived(
    repositories.filter((repo) => {
      const needle = query.trim().toLowerCase()
      return !needle || repo.nameWithOwner.toLowerCase().includes(needle) || repo.description.toLowerCase().includes(needle)
    })
  )

  onMount(() => {
    void load()
    return () => {
      disposed = true
      if (pollTimer) clearTimeout(pollTimer)
    }
  })

  async function load(): Promise<void> {
    checking = true
    error = ''
    try {
      const capability = await api.githubCapability()
      if (!capability.available) {
        unavailable = capability.reason ?? 'GitHub import is not available on this device.'
        return
      }
      repositories = await api.githubRepositories()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load GitHub repositories.'
    } finally {
      checking = false
    }
  }

  async function clone(repository: GitHubRepository): Promise<void> {
    if (!repository.supported || job) return
    error = ''
    const started = await api.startGitHubClone(repository.nameWithOwner)
    if (!started || 'error' in started) {
      error = (started as { error?: string } | null)?.error ?? 'Could not start the clone.'
      return
    }
    job = started
    pollFailures = 0
    schedulePoll()
  }

  function schedulePoll(): void {
    if (!disposed) pollTimer = setTimeout(() => void poll(), 500)
  }

  async function poll(): Promise<void> {
    if (!job || disposed) return
    try {
      const next = await api.githubClone(job.id)
      pollFailures = 0
      job = next
      if (next.status === 'complete' && next.project) {
        await onImported(next.project)
        return
      }
      if (next.status === 'failed' || next.status === 'cancelled') {
        error = next.error ?? 'The clone did not complete. No project was created.'
        return
      }
    } catch (cause) {
      pollFailures += 1
      if (pollFailures >= 3) {
        error = `Clone status was lost: ${cause instanceof Error ? cause.message : 'hub unavailable'}. No partial clone is added as a project.`
        return
      }
    }
    schedulePoll()
  }
</script>

<div class="github-import">
  <div class="head">
    <span><Icon name="git-branch" size={13} /> Clone from GitHub</span>
    <button class="close" title="close GitHub picker" aria-label="close GitHub picker" onclick={onClose}><Icon name="x" size={14} /></button>
  </div>

  {#if checking}
    <div class="message dim">Checking this device for an existing GitHub sign-in…</div>
  {:else if unavailable}
    <div class="message">
      <div>{unavailable}</div>
      <div class="dim">You can still add any local folder above.</div>
    </div>
  {:else if error && !job}
    <div class="message err">{error}</div>
    <button class="retry" onclick={load}>Try again</button>
  {:else if job}
    <div class="clone-status">
      <div class="repo-name">{job.repository.nameWithOwner}</div>
      <div class="progress-copy">
        <span>{job.progress.message}</span>
        {#if job.progress.percent != null}<span>{job.progress.percent}%</span>{/if}
      </div>
      <progress max="100" value={job.progress.percent ?? 0}></progress>
      <div class="dim safe-note">The project is created only after the clone finishes and validates.</div>
      {#if error}<div class="err">{error}</div>{/if}
    </div>
  {:else}
    <div class="scope dim">Up to 100 repositories owned by the signed-in account. Organization repositories and SSH sessions are not supported in this version.</div>
    <input class="filter" type="search" placeholder="Filter repositories" bind:value={query} />
    {#if filtered.length}
      <div class="repos scroll">
        {#each filtered as repository (repository.nameWithOwner)}
          <button
            class="repo"
            disabled={!repository.supported}
            title={repository.supported ? `Clone ${repository.nameWithOwner}` : repository.unsupportedReason}
            onclick={() => clone(repository)}
          >
            <span class="repo-top">
              <span class="repo-name">{repository.nameWithOwner}</span>
              {#if repository.private}<span class="badge">private</span>{/if}
              {#if repository.archived}<span class="badge">archived</span>{/if}
            </span>
            {#if repository.description}<span class="description dim">{repository.description}</span>{/if}
            {#if !repository.supported}<span class="unsupported">{repository.unsupportedReason}</span>{/if}
          </button>
        {/each}
      </div>
    {:else}
      <div class="message dim">No matching repositories.</div>
    {/if}
  {/if}
</div>

<style>
  .github-import { display: flex; flex-direction: column; gap: var(--space-2); padding-top: var(--space-1); border-top: 1px solid var(--border-subtle); }
  .head { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: var(--text-xs); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: var(--ls-label); }
  .head span { display: inline-flex; align-items: center; gap: var(--space-2); }
  .close { display: grid; place-items: center; width: 20px; height: 20px; border-radius: var(--r-xs); color: var(--dim); }
  .close:hover { background: var(--surface-2); color: var(--text); }
  .message, .scope, .safe-note, .err { font-size: var(--text-xs); line-height: 1.4; }
  .err, .unsupported { color: var(--bad-text); }
  .scope { padding-bottom: var(--space-1); }
  .filter { width: 100%; }
  .repos { display: flex; flex-direction: column; gap: 2px; max-height: 230px; overflow-y: auto; }
  .repo { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: var(--space-2); border-radius: var(--r-sm); text-align: left; }
  .repo:hover:not(:disabled) { background: var(--surface-2); }
  .repo:disabled { cursor: default; opacity: 0.62; }
  .repo-top { display: flex; align-items: center; gap: var(--space-1); width: 100%; }
  .repo-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: var(--fw-medium); }
  .description { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; font-size: var(--text-xs); }
  .badge { flex: none; border: 1px solid var(--border-strong); border-radius: var(--r-xs); padding: 0 0.25rem; color: var(--dim); font-size: var(--text-2xs); font-weight: var(--fw-normal); }
  .unsupported { font-size: var(--text-2xs); }
  .retry { align-self: flex-start; color: var(--accent); font-size: var(--text-xs); }
  .clone-status { display: flex; flex-direction: column; gap: var(--space-2); }
  .progress-copy { display: flex; justify-content: space-between; gap: var(--space-2); color: var(--muted); font-size: var(--text-xs); }
  progress { width: 100%; height: 6px; accent-color: var(--accent); }
</style>
