<script lang="ts">
  import { api } from './api'
  import { store } from './store.svelte'

  let { onspawned }: { onspawned?: () => void } = $props()

  let profileId = $state('')
  let repo = $state('')
  let cwd = $state('')
  let model = $state('')
  let effort = $state('')
  let permissionMode = $state('')
  let prompt = $state('')
  let busy = $state(false)
  let error = $state('')

  $effect(() => {
    if (!profileId && store.profiles.length) profileId = store.profiles[0].id
  })

  async function spawn(): Promise<void> {
    busy = true
    error = ''
    const out = await api.spawn({
      profileId,
      repo: repo || undefined,
      cwd: cwd || undefined,
      model: model || undefined,
      effort: effort || undefined,
      permissionMode: permissionMode || undefined,
      prompt: prompt || undefined,
    })
    busy = false
    if ('error' in out) {
      error = out.error
      return
    }
    prompt = ''
    store.select(out.id)
    onspawned?.()
  }
</script>

<div class="spawn">
  <div class="row">
    <select bind:value={profileId}>
      {#each store.profiles as p (p.id)}
        <option value={p.id}>{p.id} · {p.provider}</option>
      {/each}
    </select>
    <select bind:value={permissionMode}>
      <option value="">safe (ask)</option>
      <option value="edits">edits free</option>
      <option value="full">full access</option>
    </select>
  </div>
  <div class="row">
    <input placeholder="git repo → worktree (optional)" bind:value={repo} />
    <input placeholder="cwd (if no repo)" bind:value={cwd} />
  </div>
  <div class="row">
    <input class="sm" placeholder="model" bind:value={model} />
    <select bind:value={effort}>
      <option value="">effort</option>
      <option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option>
    </select>
  </div>
  <textarea placeholder="first prompt" rows="2" bind:value={prompt}></textarea>
  <button class="primary" disabled={busy || !profileId} onclick={spawn}>{busy ? 'spawning…' : 'spawn session'}</button>
  {#if error}<div class="err">{error}</div>{/if}
</div>

<style>
  .spawn { display: flex; flex-direction: column; gap: 0.4rem; }
  .row { display: flex; gap: 0.4rem; }
  .row > * { flex: 1; min-width: 0; }
  .sm { max-width: 40%; }
  textarea { resize: vertical; }
  .err { color: var(--bad); font-size: 0.78rem; }
</style>
