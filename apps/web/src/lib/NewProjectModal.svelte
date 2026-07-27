<script module lang="ts">
  import type { ProjectInfo } from './api'

  export interface ProjectLaunchItem {
    agentId: string
    label: string
    sessionId?: string
    error?: string
  }

  export interface ProjectLaunchResult {
    project: ProjectInfo
    started: ProjectLaunchItem[]
    failed: ProjectLaunchItem[]
  }
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import { api, type SessionRecord } from './api'
  import { defaultModelFor, findModel, modelsFor } from './catalog'
  import { settings } from './settings.svelte'
  import { store } from './store.svelte'
  import GitHubImport from './GitHubImport.svelte'
  import Icon from './Icon.svelte'
  import ProviderLogo from './ProviderLogo.svelte'

  let {
    onclose,
    onlaunched,
    onconfiguremanager,
    suspended = false,
  }: {
    onclose: () => void
    onlaunched: (result: ProjectLaunchResult) => void | Promise<void>
    onconfiguremanager: (project: ProjectInfo) => void | Promise<void>
    suspended?: boolean
  } = $props()

  type Step = 1 | 2 | 3
  type AgentStatus = 'ready' | 'launching' | 'started' | 'failed'

  interface StartingAgent {
    id: string
    profileId: string
    model: string
    effort: string
    permissionMode: 'safe' | 'edits' | 'full'
    prompt: string
    scope: string
    useWorktree: boolean
    status: AgentStatus
    sessionId?: string
    error?: string
  }

  let step = $state<Step>(1)
  let project = $state<ProjectInfo | null>(null)
  let projectName = $state('')
  let projectPath = $state('')
  let gitGuidance = $state('')
  let environmentGuidance = $state('')
  let showGitHub = $state(false)
  let creating = $state(false)
  let createError = $state('')
  let agents = $state<StartingAgent[]>([])
  let nextAgentNumber = 1
  let teamError = $state('')
  let launching = $state(false)
  let launchAttempted = $state(false)
  let managerSetupOpened = $state(false)
  let teamSection = $state<HTMLElement | null>(null)
  let finalizeSection = $state<HTMLElement | null>(null)

  const failed = $derived(agents.filter((agent) => agent.status === 'failed'))
  const started = $derived(agents.filter((agent) => agent.status === 'started'))
  const readyToReview = $derived(
    agents.every((agent) => Boolean(agent.profileId && agent.prompt.trim())),
  )

  function defaultProfileId(): string {
    return store.defaultProfileId() ?? store.profiles[0]?.id ?? ''
  }

  function defaultsFor(profileId: string): Pick<StartingAgent, 'model' | 'effort'> {
    const profile = store.profiles.find((item) => item.id === profileId)
    if (!profile) return { model: '', effort: '' }
    const model =
      (profile.provider === 'codex' ? settings.defaultCodexModel : settings.defaultClaudeModel) ||
      defaultModelFor(profile.provider)?.slug ||
      ''
    const effortDescriptor = findModel(model)?.descriptors.find((item) => item.id === 'effort')
    return {
      model,
      effort: effortDescriptor?.options?.find((item) => item.isDefault)?.value ?? '',
    }
  }

  function addAgent(): void {
    const profileId = defaultProfileId()
    agents = [
      ...agents,
      {
        id: `starting-agent-${nextAgentNumber++}`,
        profileId,
        ...defaultsFor(profileId),
        permissionMode: settings.defaultPermissionMode === 'full'
          ? 'full'
          : settings.defaultPermissionMode === 'edits'
            ? 'edits'
            : 'safe',
        prompt: '',
        scope: '',
        useWorktree: settings.defaultUseWorktree,
        status: 'ready',
      },
    ]
  }

  function updateAgent(id: string, patch: Partial<StartingAgent>): void {
    agents = agents.map((agent) => agent.id === id ? { ...agent, ...patch } : agent)
  }

  function changeProfile(agent: StartingAgent, profileId: string): void {
    updateAgent(agent.id, { profileId, ...defaultsFor(profileId), status: 'ready', error: undefined })
  }

  function changeModel(agent: StartingAgent, model: string): void {
    const effortDescriptor = findModel(model)?.descriptors.find((item) => item.id === 'effort')
    updateAgent(agent.id, {
      model,
      effort: effortDescriptor?.options?.find((item) => item.isDefault)?.value ?? '',
      status: 'ready',
      error: undefined,
    })
  }

  function removeAgent(id: string): void {
    agents = agents.filter((agent) => agent.id !== id)
  }

  async function browse(): Promise<void> {
    createError = ''
    try {
      const picked = await api.pickFolder()
      if (picked.path) {
        projectPath = picked.path
        if (!projectName.trim()) {
          projectName = picked.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
        }
      }
    } catch (cause) {
      createError = cause instanceof Error ? cause.message : 'Could not open the folder picker.'
    }
  }

  function rememberProject(created: ProjectInfo): void {
    project = created
    if (!store.projects.some((item) => item.id === created.id)) {
      store.projects = [...store.projects, created]
    }
    showGitHub = false
    createError = ''
    step = 2
    void reveal('team')
  }

  async function reveal(target: 'team' | 'finalize'): Promise<void> {
    await tick()
    const section = target === 'team' ? teamSection : finalizeSection
    section?.scrollIntoView?.({ block: 'start' })
  }

  async function createLocalProject(): Promise<void> {
    const name = projectName.trim()
    const path = projectPath.trim()
    createError = ''
    if (!name || !path) {
      createError = 'Choose a working directory and give the project a name.'
      return
    }
    creating = true
    try {
      const created = await api.createProject(name, path)
      if (!created || 'error' in created) {
        createError = (created as { error?: string } | null)?.error ?? 'Could not create the project.'
        return
      }
      rememberProject(created)
    } catch (cause) {
      createError = cause instanceof Error ? cause.message : 'Could not create the project.'
    } finally {
      creating = false
    }
  }

  async function githubImported(created: ProjectInfo): Promise<void> {
    projectName = created.name
    projectPath = created.path
    rememberProject(created)
  }

  function review(): void {
    teamError = ''
    if (!readyToReview) {
      teamError = 'Every starting agent needs an account and a starting prompt.'
      return
    }
    step = 3
    void reveal('finalize')
  }

  function labelFor(agent: StartingAgent): string {
    return `Agent ${agents.findIndex((item) => item.id === agent.id) + 1} · ${agent.profileId}`
  }

  function promptFor(agent: StartingAgent): string {
    const sections = [agent.prompt.trim()]
    if (agent.scope.trim()) sections.push(`Scope: ${agent.scope.trim()}`)
    if (gitGuidance.trim()) sections.push(`Git configuration for this project:\n${gitGuidance.trim()}`)
    if (environmentGuidance.trim()) {
      sections.push(`Environment setup for this project:\n${environmentGuidance.trim()}`)
    }
    return sections.filter(Boolean).join('\n\n')
  }

  function launchResult(): ProjectLaunchResult {
    return {
      project: project!,
      started: agents
        .filter((agent) => agent.status === 'started')
        .map((agent) => ({
          agentId: agent.id,
          label: labelFor(agent),
          sessionId: agent.sessionId,
        })),
      failed: agents
        .filter((agent) => agent.status === 'failed')
        .map((agent) => ({
          agentId: agent.id,
          label: labelFor(agent),
          error: agent.error ?? 'The agent did not start.',
        })),
    }
  }

  async function launch(targets: StartingAgent[]): Promise<void> {
    if (!project || launching) return
    launchAttempted = true
    launching = true
    teamError = ''
    const targetIds = new Set(targets.map((agent) => agent.id))
    agents = agents.map((agent) =>
      targetIds.has(agent.id) ? { ...agent, status: 'launching', error: undefined } : agent
    )

    const outcomes = await Promise.all(
      targets.map(async (agent) => {
        try {
          const body: Record<string, unknown> = {
            profileId: agent.profileId,
            projectId: project!.id,
            useWorktree: agent.useWorktree,
            permissionMode: agent.permissionMode,
            prompt: promptFor(agent),
          }
          if (agent.model) body.model = agent.model
          if (agent.effort) body.effort = agent.effort
          if (agent.scope.trim()) body.role = agent.scope.trim()
          const created = await api.spawn(body)
          if (!created || 'error' in created) {
            return {
              id: agent.id,
              error: (created as { error?: string } | null)?.error ?? 'The agent did not start.',
            }
          }
          return { id: agent.id, record: created as SessionRecord }
        } catch (cause) {
          return {
            id: agent.id,
            error: cause instanceof Error ? cause.message : 'The agent did not start.',
          }
        }
      }),
    )

    for (const outcome of outcomes) {
      if (outcome.record) {
        store.upsertSessionRecord(outcome.record)
        updateAgent(outcome.id, {
          status: 'started',
          sessionId: outcome.record.id,
          error: undefined,
        })
      } else {
        updateAgent(outcome.id, {
          status: 'failed',
          sessionId: undefined,
          error: outcome.error,
        })
      }
    }
    launching = false
    await onlaunched(launchResult())
  }

  function launchAll(): Promise<void> {
    return launch(agents.filter((agent) => agent.status !== 'started'))
  }

  function retryFailed(): Promise<void> {
    return launch(agents.filter((agent) => agent.status === 'failed'))
  }

  async function openManagerSetup(): Promise<void> {
    if (!project) return
    managerSetupOpened = true
    await onconfiguremanager(project)
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !suspended && !creating && !launching) onclose()
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" class:suspended role="button" tabindex="-1" onclick={onclose} onkeydown={() => {}}></div>
<div class="modal" class:suspended role="dialog" aria-modal={!suspended} aria-hidden={suspended} aria-label="New project">
  <header>
    <div>
      <span class="eyebrow">NEW PROJECT</span>
      <h2>Launch a project and its team</h2>
      <p>Choose where the work lives, configure the agents you want, then start them together.</p>
    </div>
    <button class="close" aria-label="close" onclick={onclose} disabled={creating || launching}>
      <Icon name="x" size={18} />
    </button>
  </header>

  <nav aria-label="Project setup steps">
    <span class:active={step === 1} class:done={step > 1}>1. Project</span>
    <span class:active={step === 2} class:done={step > 2}>2. The team</span>
    <span class:active={step === 3}>3. Finalize</span>
  </nav>

  <div class="body scroll">
    <section class="step project-step" class:complete={Boolean(project)}>
      <div class="step-head">
        <div>
          <span class="step-number">STEP 1</span>
          <h3>Project</h3>
        </div>
        {#if project}<span class="ready"><Icon name="check" size={14} /> Project ready</span>{/if}
      </div>

      {#if project}
        <div class="project-summary">
          <div><b>{project.name}</b><span>{project.path}</span></div>
          <span class="created-label">Created</span>
        </div>
        {#if gitGuidance || environmentGuidance}
          <div class="setup-summary">
            {#if gitGuidance}<span><b>Git:</b> {gitGuidance}</span>{/if}
            {#if environmentGuidance}<span><b>Environment:</b> {environmentGuidance}</span>{/if}
          </div>
        {/if}
      {:else}
        <div class="source-actions">
          <button class="source active" onclick={() => (showGitHub = false)}>
            <Icon name="folder" size={17} />
            <span><b>Choose a directory</b><small>Use a folder already on this computer.</small></span>
          </button>
          <button class="source" class:active={showGitHub} aria-label="Clone a GitHub repository" onclick={() => (showGitHub = true)}>
            <Icon name="git-branch" size={17} />
            <span><b>Clone a GitHub repository</b><small>Use your existing GitHub sign-in.</small></span>
          </button>
        </div>

        {#if showGitHub}
          <GitHubImport onImported={githubImported} onClose={() => (showGitHub = false)} />
        {:else}
          <div class="fields two">
            <label>
              <span>Project name</span>
              <input aria-label="Project name" bind:value={projectName} placeholder="Control room" />
            </label>
            <label>
              <span>Working directory</span>
              <div class="path-input">
                <input aria-label="Working directory" bind:value={projectPath} placeholder="C:\work\control-room" />
                <button class="browse" onclick={browse}>Browse</button>
              </div>
            </label>
          </div>
        {/if}

        <div class="fields two guidance">
          <label>
            <span>Git configuration <em>optional</em></span>
            <textarea bind:value={gitGuidance} placeholder="Branch, identity, remote, or commit conventions for the agents"></textarea>
            <small>Added to every starting agent’s brief. Describe policy, not credentials.</small>
          </label>
          <label>
            <span>Environment setup <em>optional</em></span>
            <textarea bind:value={environmentGuidance} placeholder="Setup commands and variable names — do not paste secrets"></textarea>
            <small>Describe what agents should use; keep credentials in their normal secure store.</small>
          </label>
        </div>

        {#if createError}<div class="error" role="alert">{createError}</div>{/if}
        {#if !showGitHub}
          <button class="primary" onclick={createLocalProject} disabled={creating}>
            {creating ? 'Creating project…' : 'Create project'}
          </button>
        {/if}
      {/if}
    </section>

    {#if project}
      <section class="step" class:current={step === 2} bind:this={teamSection}>
        <div class="step-head">
          <div>
            <span class="step-number">STEP 2</span>
            <h3>The team</h3>
          </div>
          <span class="count">{agents.length} starting agent{agents.length === 1 ? '' : 's'}</span>
        </div>

        {#if step === 2}
          <p class="intro">Add as many starting agents as you need. Zero is fine if you only want the project.</p>
          <div class="agents">
            {#each agents as agent, index (agent.id)}
              {@const effort = findModel(agent.model)?.descriptors.find((item) => item.id === 'effort')}
              <article class="agent">
                <div class="agent-head">
                  <div><span class="agent-number">{index + 1}</span><b>Starting agent</b></div>
                  <button class="remove" aria-label={`Remove starting agent ${index + 1}`} onclick={() => removeAgent(agent.id)}>
                    <Icon name="trash" size={14} /> Remove
                  </button>
                </div>

                <div class="fields three">
                  <label>
                    <span>Account {index + 1}</span>
                    <select aria-label={`Account ${index + 1}`} value={agent.profileId} onchange={(event) => changeProfile(agent, (event.target as HTMLSelectElement).value)}>
                      {#each store.profiles as profile (profile.id)}
                        <option value={profile.id}>{profile.id} · {profile.provider}</option>
                      {/each}
                    </select>
                  </label>
                  <label>
                    <span>Model</span>
                    <select value={agent.model} onchange={(event) => changeModel(agent, (event.target as HTMLSelectElement).value)}>
                      {#each modelsFor(store.profiles.find((item) => item.id === agent.profileId)?.provider ?? 'claude') as model (model.slug)}
                        <option value={model.slug}>{model.name}</option>
                      {/each}
                    </select>
                  </label>
                  {#if effort?.options?.length}
                    <label>
                      <span>{effort.label}</span>
                      <select value={agent.effort} onchange={(event) => updateAgent(agent.id, { effort: (event.target as HTMLSelectElement).value })}>
                        {#each effort.options as option (option.value)}
                          <option value={option.value}>{option.label}</option>
                        {/each}
                      </select>
                    </label>
                  {/if}
                </div>

                <div class="fields two">
                  <label>
                    <span>Starting prompt {index + 1}</span>
                    <textarea aria-label={`Starting prompt ${index + 1}`} value={agent.prompt} oninput={(event) => updateAgent(agent.id, { prompt: (event.target as HTMLTextAreaElement).value })} placeholder="Describe the first concrete task"></textarea>
                  </label>
                  <label>
                    <span>Scope {index + 1} <em>optional</em></span>
                    <textarea aria-label={`Scope ${index + 1}`} value={agent.scope} oninput={(event) => updateAgent(agent.id, { scope: (event.target as HTMLTextAreaElement).value })} placeholder="Files, subsystem, or responsibility"></textarea>
                  </label>
                </div>

                <div class="agent-controls">
                  <label>
                    <span>Permission</span>
                    <select value={agent.permissionMode} onchange={(event) => updateAgent(agent.id, { permissionMode: (event.target as HTMLSelectElement).value as StartingAgent['permissionMode'] })}>
                      <option value="safe">Safe · ask before changes</option>
                      <option value="edits">Edits · allow workspace changes</option>
                      <option value="full">Full access</option>
                    </select>
                  </label>
                  <label class="toggle">
                    <input type="checkbox" checked={agent.useWorktree} onchange={(event) => updateAgent(agent.id, { useWorktree: (event.target as HTMLInputElement).checked })} />
                    <span><b>Use a worktree</b><small>Give this agent an isolated branch and folder.</small></span>
                  </label>
                </div>
              </article>
            {/each}
          </div>

          <div class="team-actions">
            <button class="add" aria-label="Add starting agent" onclick={addAgent}><Icon name="plus" size={14} /> Starting agent</button>
            <div class="manager">
              <div>
                <b>Project manager</b>
                <span>{managerSetupOpened ? 'Manager setup opened for this project.' : 'Optional · configure the manager’s own role and worker policy.'}</span>
              </div>
              <button onclick={openManagerSetup} aria-label="Configure a project manager">
                {managerSetupOpened ? 'Open setup again' : 'Configure'}
              </button>
            </div>
          </div>

          {#if teamError}<div class="error" role="alert">{teamError}</div>{/if}
          <div class="footer-actions">
            <button class="secondary" onclick={() => (step = 1)}>Back</button>
            <button class="primary" onclick={review}>Review and finalize</button>
          </div>
        {/if}
      </section>

      {#if step === 3}
        <section class="step current" bind:this={finalizeSection}>
          <div class="step-head">
            <div>
              <span class="step-number">STEP 3</span>
              <h3>Finalize</h3>
            </div>
          </div>

          <div class="review">
            <div class="review-project">
              <Icon name="folder" size={18} />
              <div><b>{project.name}</b><span>{project.path}</span></div>
            </div>
            {#if agents.length}
              <div class="review-agents">
                {#each agents as agent, index (agent.id)}
                  <div class="review-agent">
                    <ProviderLogo provider={store.profiles.find((item) => item.id === agent.profileId)?.provider ?? 'claude'} size={15} />
                    <span><b>{index + 1}. {agent.profileId}</b><small>{agent.scope || agent.prompt}</small></span>
                    <em class:ok={agent.status === 'started'} class:bad={agent.status === 'failed'}>
                      {agent.status === 'launching' ? 'Starting…' : agent.status === 'started' ? 'Started' : agent.status === 'failed' ? 'Did not start' : 'Ready'}
                    </em>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="zero">No starting agents. This will create the project and open its overview.</div>
            {/if}
            {#if managerSetupOpened}
              <div class="manager-review">
                <Icon name="flag" size={16} />
                <span><b>Project manager setup opened</b><small>Any manager saved there is already attached to this project and will appear in its overview.</small></span>
              </div>
            {/if}
          </div>

          {#if launchAttempted && !launching}
            <div class="launch-summary" class:has-failures={failed.length > 0}>
              {#if failed.length}
                <b>{started.length} agent{started.length === 1 ? '' : 's'} started; {failed.length} did not.</b>
                <p>The project is open with the agents that started. Fix the problem below, then retry only the failures.</p>
                <ul>
                  {#each failed as agent (agent.id)}
                    <li><span>{labelFor(agent)}</span><strong>{agent.error}</strong></li>
                  {/each}
                </ul>
                <button class="primary" onclick={retryFailed}>Retry failed agent{failed.length === 1 ? '' : 's'}</button>
              {:else if agents.length}
                <b>All {started.length} agents started.</b>
                <p>The project overview is open.</p>
              {:else}
                <b>Project ready.</b>
                <p>The project overview is open with no starting agents.</p>
              {/if}
            </div>
          {/if}

          {#if !launchAttempted}
            <div class="footer-actions">
              <button class="secondary" onclick={() => { step = 2; void reveal('team') }}>Back to team</button>
              <button class="launch" onclick={launchAll} disabled={launching}>
                {agents.length ? 'Launch project with team' : 'Create project without agents'}
              </button>
            </div>
          {/if}
        </section>
      {/if}
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, 0.72); backdrop-filter: blur(4px); }
  .backdrop.suspended, .modal.suspended { visibility: hidden; }
  .modal { position: fixed; z-index: 71; inset: max(24px, 5vh) max(24px, 6vw); max-width: 1060px; margin: auto;
    display: flex; flex-direction: column; overflow: hidden; color: var(--text); background: var(--bg);
    border: 1px solid var(--border-strong); border-radius: var(--r-xl); box-shadow: var(--shadow-4); }
  header { display: flex; justify-content: space-between; gap: var(--space-5); padding: var(--space-6) var(--space-7) var(--space-5);
    border-bottom: 1px solid var(--border); background: var(--surface); }
  .eyebrow, .step-number { color: var(--accent); font-size: var(--text-2xs); font-weight: var(--fw-semibold); letter-spacing: var(--ls-label); }
  h2 { margin: var(--space-1) 0 var(--space-2); font-size: var(--text-xl); }
  header p, .intro { margin: 0; color: var(--muted); font-size: var(--text-sm); line-height: 1.45; }
  .close { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--r-md); color: var(--muted); }
  .close:hover { color: var(--text); background: var(--surface-2); }
  nav { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--border); background: var(--surface); }
  nav span { padding: var(--space-3) var(--space-5); color: var(--dim); font-size: var(--text-xs); text-align: center;
    border-bottom: 2px solid transparent; }
  nav span.active { color: var(--text); border-bottom-color: var(--accent); }
  nav span.done { color: var(--ok); }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6) var(--space-7) var(--space-7); }
  .step { padding: var(--space-5); margin-bottom: var(--space-4); border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); }
  .step.complete:not(.current) { padding-block: var(--space-4); }
  .step-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
  .step-head h3 { margin: 2px 0 0; font-size: var(--text-lg); }
  .ready { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--ok); font-size: var(--text-xs); font-weight: var(--fw-medium); }
  .count { color: var(--muted); font-size: var(--text-xs); }
  .project-summary, .review-project { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
  .project-summary > div, .review-project > div { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .project-summary span, .review-project span { overflow: hidden; color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
  .created-label { flex: none; color: var(--ok) !important; font-family: inherit !important; }
  .setup-summary { display: flex; flex-direction: column; gap: var(--space-1); margin-top: var(--space-3); color: var(--muted); font-size: var(--text-xs); }
  .setup-summary span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .source-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); margin-bottom: var(--space-4); }
  .source { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4); text-align: left; border: 1px solid var(--border);
    border-radius: var(--r-md); background: var(--surface-2); }
  .source.active { border-color: var(--border-accent); color: var(--accent); }
  .source span { display: flex; flex-direction: column; gap: 2px; }
  .source small { color: var(--muted); font-size: var(--text-xs); font-weight: 400; }
  .fields { display: grid; gap: var(--space-4); margin-bottom: var(--space-4); }
  .fields.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fields.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  label { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; color: var(--muted); font-size: var(--text-xs); font-weight: var(--fw-medium); }
  label em { color: var(--dim); font-weight: 400; }
  label small { color: var(--dim); font-weight: 400; line-height: 1.35; }
  input, select, textarea { width: 100%; }
  textarea { min-height: 70px; resize: vertical; }
  .path-input { display: flex; gap: var(--space-2); }
  .path-input input { min-width: 0; }
  .browse, .secondary { flex: none; padding: var(--space-2) var(--space-4); border: 1px solid var(--border); border-radius: var(--r-md); }
  .guidance { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--border-subtle); }
  .primary, .launch { padding: var(--space-2) var(--space-5); border-radius: var(--r-md); color: #fff; font-weight: var(--fw-semibold);
    background: var(--accent); }
  .primary:disabled, .launch:disabled { opacity: 0.55; cursor: default; }
  .error { margin: var(--space-3) 0; padding: var(--space-3); color: var(--bad-text); background: color-mix(in srgb, var(--bad) 10%, transparent);
    border: 1px solid var(--bad); border-radius: var(--r-md); font-size: var(--text-sm); }
  .agents { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-4); }
  .agent { padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
  .agent-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-4); }
  .agent-head > div { display: flex; align-items: center; gap: var(--space-2); }
  .agent-number { display: grid; place-items: center; width: 22px; height: 22px; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: var(--r-pill); font-family: var(--mono); font-size: var(--text-xs); }
  .remove { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--dim); font-size: var(--text-xs); }
  .remove:hover { color: var(--bad-text); }
  .agent-controls { display: grid; grid-template-columns: minmax(180px, 0.6fr) minmax(220px, 1fr); gap: var(--space-4); align-items: end; }
  .toggle { flex-direction: row; align-items: center; padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--r-md); }
  .toggle input { width: auto; }
  .toggle span { display: flex; flex-direction: column; }
  .team-actions { display: grid; grid-template-columns: minmax(180px, 0.45fr) minmax(260px, 1fr); gap: var(--space-3); margin-top: var(--space-4); }
  .add { display: flex; align-items: center; justify-content: center; gap: var(--space-2); min-height: 64px; color: var(--accent);
    border: 1px dashed var(--border-accent); border-radius: var(--r-md); background: color-mix(in srgb, var(--accent) 5%, transparent); font-weight: var(--fw-medium); }
  .manager { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border); border-radius: var(--r-md); }
  .manager div { display: flex; flex-direction: column; gap: 2px; }
  .manager span { color: var(--muted); font-size: var(--text-xs); }
  .manager button { flex: none; color: var(--accent); }
  .footer-actions { display: flex; justify-content: flex-end; gap: var(--space-3); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border-subtle); }
  .review { display: flex; flex-direction: column; gap: var(--space-4); }
  .review-project { padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
  .review-agents { display: flex; flex-direction: column; gap: var(--space-2); }
  .review-agent { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3);
    padding: var(--space-3); border-bottom: 1px solid var(--border-subtle); }
  .review-agent > span { display: flex; flex-direction: column; min-width: 0; }
  .review-agent small { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
  .review-agent em { color: var(--muted); font-size: var(--text-xs); font-style: normal; }
  .review-agent em.ok { color: var(--ok); }
  .review-agent em.bad { color: var(--bad-text); }
  .manager-review { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4);
    color: var(--muted); border: 1px solid var(--border); border-radius: var(--r-md); }
  .manager-review span { display: flex; flex-direction: column; gap: 2px; }
  .manager-review small { color: var(--dim); }
  .zero { padding: var(--space-5); color: var(--muted); text-align: center; border: 1px dashed var(--border); border-radius: var(--r-md); }
  .launch { background: linear-gradient(135deg, var(--accent), var(--cyan)); box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 20%, transparent); }
  .launch-summary { padding: var(--space-4); margin-top: var(--space-4); color: var(--ok);
    background: color-mix(in srgb, var(--ok) 9%, transparent); border: 1px solid var(--ok); border-radius: var(--r-md); }
  .launch-summary.has-failures { color: var(--bad-text); background: color-mix(in srgb, var(--bad) 10%, transparent); border-color: var(--bad); }
  .launch-summary p { margin: var(--space-2) 0; color: var(--muted); font-size: var(--text-sm); }
  .launch-summary ul { display: flex; flex-direction: column; gap: var(--space-2); padding: 0; list-style: none; }
  .launch-summary li { display: flex; justify-content: space-between; gap: var(--space-4); font-size: var(--text-xs); }
  .launch-summary li strong { font-weight: var(--fw-medium); }

  @media (max-width: 720px) {
    .modal { inset: 8px; }
    header, .body { padding-inline: var(--space-4); }
    .source-actions, .fields.two, .fields.three, .agent-controls, .team-actions { grid-template-columns: minmax(0, 1fr); }
    nav span { padding-inline: var(--space-2); }
  }
</style>
