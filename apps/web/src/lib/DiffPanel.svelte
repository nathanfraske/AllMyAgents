<script lang="ts">
  import { api, type WorkspaceDiffInfo } from './api'
  import { openExternalUrl, prepareExternalTarget } from './externalUrl'
  import Icon from './Icon.svelte'

  let {
    sessionId,
    open = false,
    onopen = () => {},
    onclose = () => {},
  }: {
    sessionId: string
    open?: boolean
    onopen?: () => void
    onclose?: () => void
  } = $props()

  let base = $state('')
  let result = $state<WorkspaceDiffInfo | null>(null)
  let loading = $state(false)
  let error = $state('')
  let loadedFor = $state('')

  $effect(() => {
    if (!open) {
      loadedFor = ''
      return
    }
    if (loadedFor === sessionId) return
    loadedFor = sessionId
    try { base = localStorage.getItem(`allmyagents.diff-base.${sessionId}`) ?? '' } catch { base = '' }
    void refresh()
  })

  async function refresh(): Promise<void> {
    loading = true
    error = ''
    try {
      result = await api.workspaceDiff(sessionId, base || undefined)
      if (!base) base = result.baseRef
      try { localStorage.setItem(`allmyagents.diff-base.${sessionId}`, base) } catch { /* ignore */ }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not read this checkout.'
    } finally {
      loading = false
    }
  }

  function openLink(url: string): void {
    const target = prepareExternalTarget()
    void openExternalUrl(url, target)
  }

  function short(value: string): string { return value.slice(0, 9) }
</script>

{#if !open}
  <button class="tab" onclick={onopen} title="Open working diff" aria-label="Open working diff">
    <Icon name="git-compare" size={13} /><span>Diff</span>
  </button>
{:else}
  <aside class="panel" aria-label="Working diff">
    <header>
      <span class="title"><Icon name="git-compare" size={14} /> Working diff</span>
      <button class="close" onclick={onclose} title="Close" aria-label="Close diff panel">×</button>
    </header>
    <form class="base" onsubmit={(event) => { event.preventDefault(); void refresh() }}>
      <label for={`diff-base-${sessionId}`}>Compare against</label>
      <div><input id={`diff-base-${sessionId}`} bind:value={base} placeholder="main or another ref" /><button disabled={loading}>Refresh</button></div>
    </form>
    {#if error}<p class="error" role="alert">{error}</p>
    {:else if loading && !result}<p class="empty">Reading checkout…</p>
    {:else if result}
      <div class="meta">
        <span>{result.branch || 'detached HEAD'}</span>
        <span title={result.baseCommit}>{short(result.baseCommit)} → {short(result.headCommit)}</span>
      </div>
      {#if result.headUrl || result.compareUrl}
        <div class="links">
          {#if result.headUrl}<button onclick={() => openLink(result!.headUrl!)}>Open commit on GitHub</button>{/if}
          {#if result.compareUrl}<button onclick={() => openLink(result!.compareUrl!)}>Open comparison</button>{/if}
        </div>
      {/if}
      <div class="summary">
        {#each result.files as file (`${file.status}:${file.path}`)}
          <div><code>{file.status}</code><span title={file.path}>{file.path}</span></div>
        {/each}
        {#each result.untracked as file (`untracked:${file}`)}
          <div><code>??</code><span title={file}>{file}</span></div>
        {/each}
        {#if !result.files.length && !result.untracked.length}<p class="empty">No changes against {result.baseRef}.</p>{/if}
      </div>
      {#if result.patch}<pre class="patch">{result.patch}{#if result.truncated}\n\n[diff truncated at 1 MiB]{/if}</pre>{/if}
    {/if}
  </aside>
{/if}

<style>
  .tab { position: absolute; top: 7.8rem; right: 0; z-index: 5; display: flex; align-items: center; gap: .38rem;
    padding: .27rem .55rem; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong);
    border-right: 0; border-radius: 999px 0 0 999px; font-size: .74rem; }
  .tab:hover { border-color: var(--accent); }
  .panel { position: relative; flex: 0 0 clamp(300px, 44%, 520px); width: clamp(300px, 44%, 520px); min-width: 0;
    min-height: 0; display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--border-strong); }
  header { display: flex; align-items: center; gap: .45rem; padding: .5rem .65rem; border-bottom: 1px solid var(--border); }
  .title { display: flex; align-items: center; gap: .4rem; font-size: .82rem; font-weight: 600; }
  .close { margin-left: auto; padding: 0 .2rem; color: inherit; opacity: .7; }
  .base { padding: .55rem .65rem; border-bottom: 1px solid var(--border); font-size: .7rem; color: var(--muted); }
  .base div { display: flex; gap: .35rem; margin-top: .25rem; }
  .base input { min-width: 0; flex: 1; padding: .35rem .45rem; border: 1px solid var(--border); border-radius: var(--r-sm); }
  .base button, .links button { padding: .32rem .48rem; border: 1px solid var(--border); border-radius: var(--r-sm); }
  .meta, .links { display: flex; flex-wrap: wrap; gap: .4rem; padding: .45rem .65rem; font-size: .7rem; }
  .meta { justify-content: space-between; color: var(--muted); }
  .links { padding-top: 0; }
  .summary { max-height: 28%; overflow: auto; border-block: 1px solid var(--border); padding: .4rem .65rem; font-size: .72rem; }
  .summary div { display: flex; gap: .45rem; min-width: 0; }
  .summary code { width: 2rem; flex: none; color: var(--accent); }
  .summary span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .patch { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: .65rem; font: .7rem/1.45 var(--mono); white-space: pre; tab-size: 2; }
  .empty, .error { margin: .7rem; color: var(--muted); font-size: .75rem; }
  .error { color: var(--bad-text); }
  @container thread-body (max-width: 620px) {
    .panel { flex: 0 0 320px; width: 100%; border-left: 0; border-top: 1px solid var(--border-strong); }
  }
</style>
