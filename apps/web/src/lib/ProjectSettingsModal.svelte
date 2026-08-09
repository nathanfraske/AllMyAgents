<script lang="ts">
  import Icon from './Icon.svelte'
  import ManagerSetupModal from './ManagerSetupModal.svelte'
  import {
    api,
    type GitHubAutomationCapability,
    type SessionRecord,
  } from './api'
  import { store } from './store.svelte'
  import { profileOptionLabel } from './profileLabel'

  let { projectId, onclose }: { projectId: string; onclose: () => void } = $props()

  let tab = $state<'project' | 'manager'>('project')
  let name = $state('')
  let loadedProjectId = $state('')
  let saving = $state(false)
  let error = $state('')
  let saved = $state('')
  let githubCapabilities = $state<GitHubAutomationCapability[]>([])
  let savedGithubCapabilities = $state<GitHubAutomationCapability[]>([])
  let githubLoading = $state(false)
  let githubSaving = $state(false)

  const GITHUB_CAPABILITIES: Array<{
    id: GitHubAutomationCapability
    label: string
    description: string
  }> = [
    { id: 'pull_requests', label: 'Pull-request work', description: 'Create, edit, comment on, review, close, reopen, and inspect PRs.' },
    { id: 'pull_request_merges', label: 'Merge pull requests', description: 'Merge remains separate because it changes the protected branch.' },
    { id: 'workflow_runs', label: 'GitHub Actions runs', description: 'Dispatch, inspect, rerun, or cancel workflow runs.' },
    { id: 'repository_pushes', label: 'Repository pushes', description: 'Allow each single non-force push to origin; force/delete pushes and active hooks still ask.' },
  ]

  const project = $derived(store.projects.find((item) => item.id === projectId))
  const manager = $derived(
    store.sessionList.find(
      (view) => view.record.projectId === projectId && view.record.isProjectManager,
    ),
  )
  const managerProfile = $derived(
    manager ? store.profiles.find((profile) => profile.id === manager.record.profileId) : undefined,
  )

  $effect(() => {
    if (!project || loadedProjectId === project.id) return
    loadedProjectId = project.id
    name = project.name
    void loadGitHubPolicy(project.id)
  })

  async function loadGitHubPolicy(id: string): Promise<void> {
    githubLoading = true
    try {
      const policy = await api.projectGitHubAutomation(id)
      githubCapabilities = [...policy.capabilities]
      savedGithubCapabilities = [...policy.capabilities]
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      githubLoading = false
    }
  }

  function toggleGitHubCapability(capability: GitHubAutomationCapability): void {
    githubCapabilities = githubCapabilities.includes(capability)
      ? githubCapabilities.filter((item) => item !== capability)
      : [...githubCapabilities, capability]
  }

  function sameGitHubCapabilities(): boolean {
    return [...githubCapabilities].sort().join(',') === [...savedGithubCapabilities].sort().join(',')
  }

  async function saveGitHubPolicy(): Promise<void> {
    if (!project) return
    error = ''
    saved = ''
    githubSaving = true
    try {
      const policy = await api.setProjectGitHubAutomation(project.id, githubCapabilities)
      if ('error' in policy) throw new Error(policy.error)
      githubCapabilities = [...policy.capabilities]
      savedGithubCapabilities = [...policy.capabilities]
      saved = policy.capabilities.length
        ? 'GitHub automation policy saved.'
        : 'GitHub automation policy revoked.'
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      githubSaving = false
    }
  }

  async function saveProject(): Promise<void> {
    if (!project) return
    error = ''
    saved = ''
    if (!name.trim()) {
      error = 'Project name is required.'
      return
    }
    saving = true
    try {
      const updated = await api.updateProject(project.id, { name: name.trim() })
      if ('error' in updated) throw new Error(updated.error)
      store.projects = store.projects.map((item) => item.id === updated.id ? { ...item, ...updated } : item)
      name = updated.name
      saved = 'Project settings saved.'
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      saving = false
    }
  }

  function managerSaved(record: SessionRecord): void {
    store.upsertSessionRecord(record)
    saved = 'Manager settings saved.'
    error = ''
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') onclose()
  }
</script>

<svelte:window onkeydown={onKey} />
<button class="backdrop" aria-label="Close project settings" onclick={onclose}></button>
<div class="modal" role="dialog" aria-modal="true" aria-label="Edit project and manager">
  <header>
    <div>
      <span class="eyebrow">PROJECT CONTROL</span>
      <h2>Edit project &amp; manager</h2>
      <p>{project?.name ?? 'Project unavailable'}</p>
    </div>
    <button class="close" aria-label="Close project settings" onclick={onclose}><Icon name="x" size={18} /></button>
  </header>

  <nav aria-label="Project settings sections">
    <button class:active={tab === 'project'} onclick={() => (tab = 'project')}>Project</button>
    <button class:active={tab === 'manager'} onclick={() => (tab = 'manager')}>
      {manager ? 'Manager' : 'Add manager'}
    </button>
  </nav>

  {#if !project}
    <div class="missing">This project is no longer available.</div>
  {:else if tab === 'project'}
    <div class="project-form">
      <section>
        <label>
          <span>Project name</span>
          <input bind:value={name} aria-label="Project name" />
        </label>
        <div class="field">
          <span>Project folder</span>
          <div class="fixed-path" title={project.path}>{project.path}</div>
          <small>The folder is fixed while project chats and worktrees reference it. Create a new project to point at another folder.</small>
        </div>
        {#if project.location}
          <div class="field">
            <span>Execution environment</span>
            <div class="fixed-path">WSL · {project.location.distro} · {project.location.linuxPath}</div>
          </div>
        {/if}
        <div class="github-policy">
          <div>
            <span class="field-title">GitHub automation</span>
            <small>
              Always allow only these recognized operations for every chat attached to this project,
              including manager-driven turns. Commands remain confined to this project's live GitHub
              remote. Generic Bash, <code>gh api</code>, auth/secrets, repository administration,
              composed shell commands, and force/delete pushes still ask.
            </small>
          </div>
          {#if githubLoading}
            <div class="policy-loading">Loading policyâ€¦</div>
          {:else}
            <div class="policy-options">
              {#each GITHUB_CAPABILITIES as capability (capability.id)}
                <label class="policy-option">
                  <input
                    type="checkbox"
                    checked={githubCapabilities.includes(capability.id)}
                    onchange={() => toggleGitHubCapability(capability.id)}
                  />
                  <span><b>{capability.label}</b><small>{capability.description}</small></span>
                </label>
              {/each}
            </div>
            <button
              class="secondary"
              disabled={githubSaving || sameGitHubCapabilities()}
              onclick={saveGitHubPolicy}
            >
              {githubSaving ? 'Savingâ€¦' : 'Save GitHub automation'}
            </button>
          {/if}
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if saved}<p class="saved" role="status">{saved}</p>{/if}
        <button class="primary" disabled={saving || name.trim() === project.name} onclick={saveProject}>
          {saving ? 'Saving…' : 'Save project settings'}
        </button>
      </section>

      <aside>
        <span class="eyebrow">PROJECT MANAGER</span>
        {#if manager}
          <h3>{store.sessionLabel(manager.record.id)}</h3>
          <dl>
            <div><dt>Account</dt><dd>{managerProfile ? profileOptionLabel(managerProfile) : manager.record.profileId}</dd></div>
            <div><dt>Model</dt><dd>{manager.record.model || 'account default'}</dd></div>
            <div><dt>Live children</dt><dd>up to {manager.record.managerMaxLiveChildren ?? 4}</dd></div>
            <div><dt>Parallel target</dt><dd>{manager.record.managerParallelismTarget ?? Math.min(3, manager.record.managerMaxLiveChildren ?? 4)} useful worker lanes</dd></div>
            <div><dt>Child ceiling</dt><dd>{manager.record.managerMaxChildPermissionMode ?? 'safe'}</dd></div>
          </dl>
          <button class="secondary" onclick={() => (tab = 'manager')}>Edit manager settings</button>
        {:else}
          <h3>No manager configured</h3>
          <p>Add a manager here without leaving the project overview.</p>
          <button class="secondary" onclick={() => (tab = 'manager')}>Configure manager</button>
        {/if}
      </aside>
    </div>
  {:else}
    <div class="manager-form">
      <ManagerSetupModal
        embedded
        stayInProject
        initialProjectId={project.id}
        initialManagerId={manager?.record.id}
        onSaved={managerSaved}
      />
      {#if saved}<p class="manager-saved" role="status">{saved}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 110; border: 0; background: color-mix(in srgb, #05050a 72%, transparent); backdrop-filter: blur(3px); }
  .modal { position: fixed; z-index: 111; inset: 3vh 3vw; max-width: 1240px; max-height: 94vh; margin: auto;
    overflow: auto; color: var(--text); background: var(--surface-1); border: 1px solid var(--border-accent);
    border-radius: var(--r-xl); box-shadow: 0 28px 80px #0009; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); padding: 1.35rem 1.55rem 1rem;
    background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, var(--surface-1)), var(--surface-1) 58%); }
  header h2 { margin: .18rem 0 .25rem; font-size: 1.5rem; }
  header p { margin: 0; color: var(--dim); font-size: var(--text-sm); }
  .eyebrow { color: var(--accent); font-size: .65rem; font-weight: var(--fw-semibold); letter-spacing: .12em; }
  .close { color: var(--dim); padding: .35rem; }
  nav { display: grid; grid-template-columns: 1fr 1fr; border-block: 1px solid var(--border); }
  nav button { padding: .78rem; color: var(--dim); background: var(--surface-2); font-weight: var(--fw-medium); }
  nav button.active { color: var(--text); background: var(--surface-1); box-shadow: inset 0 -2px var(--accent); }
  .project-form { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(270px, .7fr); }
  .project-form > section { display: grid; align-content: start; gap: 1rem; padding: 1.5rem; border-right: 1px solid var(--border); }
  label, .field { display: grid; gap: .42rem; }
  label > span, .field > span { font-size: var(--text-xs); font-weight: var(--fw-semibold); }
  input { width: 100%; padding: .58rem .65rem; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-md); }
  .fixed-path { padding: .62rem .68rem; overflow-wrap: anywhere; color: var(--text-dim); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-md); font-size: var(--text-xs); }
  small { color: var(--dim); font-size: var(--text-xs); line-height: 1.4; }
  aside { padding: 1.4rem; }
  aside h3 { margin: .5rem 0 1rem; }
  aside p { color: var(--dim); font-size: var(--text-sm); line-height: 1.5; }
  dl { display: grid; gap: .65rem; margin: 0 0 1rem; }
  dl div { padding-bottom: .55rem; border-bottom: 1px solid var(--border); }
  dt { color: var(--dim); font-size: .65rem; text-transform: uppercase; letter-spacing: .08em; }
  dd { margin: .2rem 0 0; font-size: var(--text-xs); }
  .primary, .secondary { justify-self: start; padding: .58rem .8rem; border-radius: var(--r-md); font-size: var(--text-xs); font-weight: var(--fw-semibold); }
  .primary { color: white; background: var(--accent); }
  .primary:disabled { opacity: .45; }
  .secondary { color: var(--text); border: 1px solid var(--border); background: var(--surface-2); }
  .secondary:disabled { opacity: .45; }
  .github-policy { display: grid; gap: .7rem; padding: .85rem; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface-2); }
  .github-policy > div:first-child { display: grid; gap: .35rem; }
  .field-title { font-size: var(--text-xs); font-weight: var(--fw-semibold); }
  .github-policy code { color: var(--text-dim); font-family: var(--mono); }
  .policy-options { display: grid; gap: .45rem; }
  .policy-option { display: grid; grid-template-columns: auto 1fr; align-items: start; gap: .58rem; padding: .55rem; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-1); cursor: pointer; }
  .policy-option input { width: auto; margin-top: .15rem; accent-color: var(--accent); }
  .policy-option span { display: grid; gap: .12rem; }
  .policy-option b { font-size: var(--text-xs); }
  .policy-option small { font-weight: var(--fw-normal); }
  .policy-loading { color: var(--dim); font-size: var(--text-xs); }
  .error { margin: 0; color: var(--danger); }
  .saved, .manager-saved { margin: 0; color: var(--ok); font-size: var(--text-xs); }
  .manager-form { position: relative; }
  .manager-saved { position: sticky; bottom: 0; padding: .7rem 1.3rem; background: color-mix(in srgb, var(--ok) 10%, var(--surface-1)); border-top: 1px solid var(--border); }
  .missing { padding: 2rem; color: var(--dim); }
  @media (max-width: 760px) {
    .modal { inset: 1vh 1vw; max-height: 98vh; }
    .project-form { grid-template-columns: 1fr; }
    .project-form > section { border-right: 0; border-bottom: 1px solid var(--border); }
  }
</style>
