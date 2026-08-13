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
  import { tick, untrack } from 'svelte'
  import {
    api,
    type GitHubCloneJob,
    type GitHubRepository,
    type SessionRecord,
    type WslCapability,
  } from './api'
  import { defaultModelFor, findModel, modelsFor } from './catalog'
  import { settings } from './settings.svelte'
  import { store } from './store.svelte'
  import GitHubImport from './GitHubImport.svelte'
  import Icon from './Icon.svelte'
  import ManagerSetupModal, { type ManagerLaunchConfig } from './ManagerSetupModal.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import { profileLabel, profileOptionLabel } from './profileLabel'

  let { onclose, onlaunched, tutorialStep }: {
    onclose: () => void
    onlaunched: (result: ProjectLaunchResult) => void | Promise<void>
    tutorialStep?: number
  } = $props()

  type Step = 1 | 2 | 3
  type AgentStatus = 'ready' | 'launching' | 'started' | 'failed'
  type ProjectSource =
    | { kind: 'local'; name: string; path: string; location?: ProjectInfo['location'] }
    | { kind: 'github'; name: string; repository: GitHubRepository; distro?: string }
    | { kind: 'managed'; name: string; distro?: string }

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
    promptSent?: boolean
    error?: string
  }

  let step = $state<Step>(1)
  let project = $state<ProjectInfo | null>(null)
  let projectDraft = $state<ProjectSource | null>(null)
  let projectName = $state('')
  let projectPath = $state('')
  let projectDistro = $state('')
  let wslCapability = $state<WslCapability | null>(null)
  let wslLoading = $state(false)
  let githubRepository = $state<GitHubRepository | null>(null)
  let projectStatus = $state('')
  let gitGuidance = $state('')
  let environmentGuidance = $state('')
  let projectSource = $state<'local' | 'github' | 'managed'>('local')
  let editingProjectSource = $state(false)
  let creating = $state(false)
  let createError = $state('')
  let agents = $state<StartingAgent[]>([])
  let nextAgentNumber = 1
  let teamError = $state('')
  let launching = $state(false)
  let launchAttempted = $state(false)
  let managerEnabled = $state(false)
  let managerConfig = $state<ManagerLaunchConfig | null>(null)
  let managerStatus = $state<AgentStatus>('ready')
  let managerSessionId = $state<string | undefined>()
  let managerPromptSent = $state(false)
  let managerError = $state<string | undefined>()
  let projectSection = $state<HTMLElement | null>(null)
  let teamSection = $state<HTMLElement | null>(null)
  let finalizeSection = $state<HTMLElement | null>(null)
  let tutorialWasActive = false

  const failed = $derived(agents.filter((agent) => agent.status === 'failed'))
  const started = $derived(agents.filter((agent) => agent.status === 'started'))
  const failedCount = $derived(failed.length + (managerStatus === 'failed' ? 1 : 0))
  const startedCount = $derived(started.length + (managerStatus === 'started' ? 1 : 0))
  const readyToReview = $derived(
    agents.every((agent) => Boolean(agent.profileId && agent.prompt.trim())),
  )
  const tutorialMode = $derived(tutorialStep !== undefined)

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

  function resetProjectForm(): void {
    step = 1
    project = null
    projectDraft = null
    projectName = ''
    projectPath = ''
    projectDistro = ''
    githubRepository = null
    projectStatus = ''
    gitGuidance = ''
    environmentGuidance = ''
    projectSource = 'local'
    editingProjectSource = false
    creating = false
    createError = ''
    agents = []
    nextAgentNumber = 1
    teamError = ''
    launching = false
    launchAttempted = false
    managerEnabled = false
    managerConfig = null
    managerStatus = 'ready'
    managerSessionId = undefined
    managerPromptSent = false
    managerError = undefined
  }

  function tutorialAgent(profileId: string): StartingAgent {
    return {
      id: 'tutorial-starting-agent',
      profileId,
      ...defaultsFor(profileId),
      permissionMode: 'safe',
      prompt: 'Investigate the first task and report what you find.',
      scope: 'A focused part of the project',
      useWorktree: true,
      status: 'ready',
    }
  }

  function tutorialManager(profileId: string): ManagerLaunchConfig {
    const defaults = defaultsFor(profileId)
    return {
      projectId: '__tutorial-project__',
      managerProfileId: profileId,
      managerModel: defaults.model,
      managerEffort: defaults.effort,
      permissionMode: 'safe',
      maxChildPermissionMode: 'safe',
      startingPrompt: '',
      orientationBrief: '',
      operatorTask: 'Coordinate the sample project and verify the team’s work.',
      standingInstructions: '',
      canApproveChildren: true,
      pauseExhaustedAccounts: true,
      allowWorkerSubagents: false,
      maxSubagentsPerWorker: 2,
      maxLiveChildren: 4,
      parallelismTarget: 3,
      delegation: [],
      allowedTools: [],
      allowedProfiles: profileId ? [profileId] : [],
      allowedModels: profileId && defaults.model ? { [profileId]: [defaults.model] } : {},
      agentTypes: [{
        id: 'tutorial-worker-role',
        name: 'Focused worker',
        purpose: 'Handle one bounded part of the project',
        selection: 'fixed',
        profileId,
        model: defaults.model,
        effort: defaults.effort,
      }],
    }
  }

  function showTutorialStep(stage: number): void {
    if (stage < 2) {
      resetProjectForm()
      return
    }

    const profileId = defaultProfileId()
    project = null
    projectDraft = { kind: 'managed', name: 'Tutorial project (dry run)' }
    projectName = 'Tutorial project (dry run)'
    projectPath = ''
    githubRepository = null
    projectSource = 'managed'
    editingProjectSource = false
    createError = ''
    agents = [tutorialAgent(profileId)]
    nextAgentNumber = 2
    teamError = ''
    launchAttempted = false
    managerEnabled = stage >= 4
    managerConfig = stage >= 5 ? tutorialManager(profileId) : null
    managerStatus = 'ready'
    managerError = undefined
    step = stage >= 5 ? 3 : 2
    void reveal(stage >= 5 ? 'finalize' : 'team')
  }

  $effect(() => {
    const stage = tutorialStep
    untrack(() => {
      if (stage === undefined) {
        if (tutorialWasActive) resetProjectForm()
        tutorialWasActive = false
        return
      }
      tutorialWasActive = true
      showTutorialStep(stage)
    })
  })

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

  function accountName(profileId: string): string {
    const profile = store.profiles.find((item) => item.id === profileId)
    return profile ? profileLabel(profile) : profileId
  }

  async function loadWslCapability(): Promise<void> {
    if (wslCapability || wslLoading) return
    wslLoading = true
    try {
      wslCapability = await api.wslCapability()
    } catch (cause) {
      wslCapability = {
        supported: false,
        reason: cause instanceof Error ? cause.message : 'WSL could not be detected.',
        distros: [],
        docker: { available: false, reason: 'Docker/WSL capability is unknown.' },
      }
    } finally {
      wslLoading = false
    }
  }

  async function reveal(target: 'project' | 'team' | 'finalize'): Promise<void> {
    await tick()
    const section =
      target === 'project'
        ? projectSection
        : target === 'team'
          ? teamSection
          : finalizeSection
    section?.scrollIntoView?.({ block: 'start' })
  }

  async function continueLocalDraft(): Promise<void> {
    const name = projectName.trim()
    const path = projectPath.trim()
    createError = ''
    if (!name || !path) {
      createError = 'Choose a working directory and give the project a name.'
      return
    }
    creating = true
    try {
      const validation = projectDistro
        ? await api.validateProject(name, path, projectDistro)
        : await api.validateProject(name, path)
      if (!validation || 'error' in validation) {
        createError = (validation as { error?: string } | null)?.error ?? 'Could not validate this directory.'
        return
      }
      projectDraft = {
        kind: 'local',
        name: validation.name,
        path: validation.path,
        location: validation.location,
      }
      projectName = validation.name
      projectPath = validation.path
      projectDistro = validation.location?.distro ?? ''
      githubRepository = null
      projectSource = 'local'
      editingProjectSource = false
      step = 2
      void reveal('team')
    } catch (cause) {
      createError = cause instanceof Error ? cause.message : 'Could not validate this directory.'
    } finally {
      creating = false
    }
  }

  function draftPath(): string {
    if (!projectDraft) return ''
    if (projectDraft.kind === 'local') return projectDraft.path
    if (projectDraft.kind === 'github') return `${projectDraft.repository.nameWithOwner} (cloned at launch)`
    return 'App-managed project repository (created at launch)'
  }

  function toggleManager(enabled: boolean): void {
    managerEnabled = enabled
    if (!enabled) {
      managerConfig = null
      managerStatus = 'ready'
      managerError = undefined
    }
  }

  function githubSelected(repository: GitHubRepository): void {
    githubRepository = repository
    projectName = repository.name
    projectPath = ''
    projectDraft = {
      kind: 'github',
      name: repository.name,
      repository,
      ...(projectDistro ? { distro: projectDistro } : {}),
    }
    projectSource = 'github'
    editingProjectSource = false
    createError = ''
    step = 2
    void reveal('team')
  }

  function continueManagedDraft(): void {
    const name = projectName.trim()
    createError = ''
    if (!name) {
      createError = 'Give the project a name.'
      return
    }
    projectPath = ''
    githubRepository = null
    projectDraft = {
      kind: 'managed',
      name,
      ...(projectDistro ? { distro: projectDistro } : {}),
    }
    editingProjectSource = false
    step = 2
    void reveal('team')
  }

  function editProject(): void {
    step = 1
    void reveal('project')
  }

  function changeProjectSource(): void {
    if (projectDraft) {
      projectSource = projectDraft.kind
      projectName = projectDraft.name
      projectPath = projectDraft.kind === 'local' ? projectDraft.path : ''
      projectDistro =
        projectDraft.kind === 'local' ? (projectDraft.location?.distro ?? '') : projectDistro
      githubRepository = projectDraft.kind === 'github' ? projectDraft.repository : null
      if (projectDraft.kind === 'github') projectDistro = projectDraft.distro ?? ''
      if (projectDraft.kind === 'managed') projectDistro = projectDraft.distro ?? ''
    }
    editingProjectSource = true
    createError = ''
    void reveal('project')
  }

  function review(): void {
    teamError = ''
    if (managerEnabled && !managerConfig) {
      teamError = 'Finish the required project manager fields, or turn the manager off.'
      return
    }
    if (!readyToReview) {
      teamError = 'Every starting agent needs an account and a starting prompt.'
      return
    }
    step = 3
    void reveal('finalize')
  }

  function editTeam(): void {
    step = 2
    void reveal('team')
  }

  function configureManager(config: ManagerLaunchConfig | null): void {
    managerConfig = config
    managerStatus = 'ready'
    managerError = undefined
  }

  function labelFor(agent: StartingAgent): string {
    return `Agent ${agents.findIndex((item) => item.id === agent.id) + 1} · ${accountName(agent.profileId)}`
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
    const managerLabel = managerConfig
      ? `Project manager · ${accountName(managerConfig.managerProfileId)}`
      : 'Project manager'
    return {
      project: project!,
      started: [
        ...agents
        .filter((agent) => agent.status === 'started')
        .map((agent) => ({
          agentId: agent.id,
          label: labelFor(agent),
          sessionId: agent.sessionId,
        })),
        ...(managerStatus === 'started'
          ? [{ agentId: 'project-manager', label: managerLabel, sessionId: managerSessionId }]
          : []),
      ],
      failed: [
        ...agents
        .filter((agent) => agent.status === 'failed')
        .map((agent) => ({
          agentId: agent.id,
          label: labelFor(agent),
          error: agent.error ?? 'The agent did not start.',
        })),
        ...(managerStatus === 'failed'
          ? [{
              agentId: 'project-manager',
              label: managerLabel,
              error: managerError ?? 'The project manager did not start.',
            }]
          : []),
      ],
    }
  }

  function rememberCreatedProject(created: ProjectInfo): ProjectInfo {
    project = created
    if (!store.projects.some((item) => item.id === created.id)) {
      store.projects = [...store.projects, created]
    }
    return created
  }

  async function materializeProject(): Promise<ProjectInfo> {
    if (project) return project
    if (!projectDraft) throw new Error('Finish the project step before launching.')
    if (projectDraft.kind === 'local') {
      projectStatus = 'Creating the project…'
      const created = projectDraft.location?.distro
        ? await api.createProject(
            projectDraft.name,
            projectDraft.location.linuxPath,
            projectDraft.location.distro,
          )
        : await api.createProject(projectDraft.name, projectDraft.path)
      if (!created || 'error' in created) {
        throw new Error((created as { error?: string } | null)?.error ?? 'The project could not be created.')
      }
      return rememberCreatedProject(created)
    }
    if (projectDraft.kind === 'managed') {
      projectStatus = 'Creating the project repository…'
      const created = projectDraft.distro
        ? await api.createManagedProject(projectDraft.name, projectDraft.distro)
        : await api.createManagedProject(projectDraft.name)
      if (!created || 'error' in created) {
        throw new Error((created as { error?: string } | null)?.error ?? 'The project could not be created.')
      }
      return rememberCreatedProject(created)
    }

    projectStatus = `Starting clone for ${projectDraft.repository.nameWithOwner}…`
    const started = projectDraft.distro
      ? await api.startGitHubClone(projectDraft.repository.nameWithOwner, projectDraft.distro)
      : await api.startGitHubClone(projectDraft.repository.nameWithOwner)
    if (!started || 'error' in started) {
      throw new Error((started as { error?: string } | null)?.error ?? 'The clone could not be started.')
    }
    let job: GitHubCloneJob = started
    while (job.status !== 'complete') {
      if (job.status === 'failed' || job.status === 'cancelled') {
        throw new Error(job.error ?? 'The clone did not complete.')
      }
      projectStatus = job.progress.percent == null
        ? job.progress.message
        : `${job.progress.message} ${job.progress.percent}%`
      await new Promise((resolve) => setTimeout(resolve, 500))
      job = await api.githubClone(job.id)
    }
    if (!job.project) throw new Error('The clone completed without creating a project.')
    return rememberCreatedProject(job.project)
  }

  async function prepareConfiguredManager(
    config: ManagerLaunchConfig,
    createdProject: ProjectInfo,
  ): Promise<{ record?: SessionRecord; error?: string }> {
    try {
      let record = managerSessionId ? store.sessions[managerSessionId]?.record : undefined
      if (!record) {
        const created = await api.spawn({
          profileId: config.managerProfileId,
          projectId: createdProject.id,
          useWorktree: false,
          permissionMode: config.permissionMode,
          model: config.managerModel,
          effort: config.managerEffort,
        })
        if (!created || 'error' in created) {
          throw new Error((created as { error?: string } | null)?.error ?? 'The project manager did not start.')
        }
        record = created
        managerSessionId = record.id
        record.title = `${createdProject.name} manager`
        record.titleSource = 'user'
        store.upsertSessionRecord(record)
        const renamed = await api.rename(record.id, record.title)
        if (renamed.error) throw new Error(renamed.error)
      }

      const settingsResult = await api.setSettings(record.id, {
        model: config.managerModel,
        effort: config.managerEffort,
      })
      if (settingsResult && 'error' in settingsResult) throw new Error(settingsResult.error)
      const configured = await api.configureProjectManager(record.id, {
        enabled: true,
        maxLiveChildren: config.maxLiveChildren,
        parallelismTarget: config.parallelismTarget,
        delegation: config.delegation,
        allowedProfiles: config.allowedProfiles,
        allowedModels: config.allowedModels,
        allowedTools: config.allowedTools,
        agentTypes: config.agentTypes,
        // Keep the composed launch message ephemeral; orientation and operatorTask are its durable sources.
        startingPrompt: '',
        orientationBrief: config.orientationBrief,
        operatorTask: config.operatorTask,
        standingInstructions: config.standingInstructions,
        canApproveChildren: config.canApproveChildren,
        pauseExhaustedAccounts: config.pauseExhaustedAccounts,
        allowWorkerSubagents: config.allowWorkerSubagents,
        maxSubagentsPerWorker: config.maxSubagentsPerWorker,
        permissionMode: config.permissionMode,
        maxChildPermissionMode: config.maxChildPermissionMode,
      })
      if ('error' in configured) throw new Error(configured.error)
      store.upsertSessionRecord(configured)
      return { record: configured }
    } catch (cause) {
      return {
        error: cause instanceof Error ? cause.message : 'The project manager did not start.',
      }
    }
  }

  async function launch(targets: StartingAgent[], includeManager: boolean): Promise<void> {
    if (!projectDraft || launching) return
    launchAttempted = true
    launching = true
    teamError = ''
    projectStatus = ''
    const targetIds = new Set(targets.map((agent) => agent.id))
    agents = agents.map((agent) =>
      targetIds.has(agent.id) ? { ...agent, status: 'launching', error: undefined } : agent
    )
    if (includeManager) {
      managerStatus = 'launching'
      managerError = undefined
    }

    let createdProject: ProjectInfo
    try {
      createdProject = await materializeProject()
    } catch (cause) {
      teamError = cause instanceof Error ? cause.message : 'The project could not be created.'
      projectStatus = ''
      launching = false
      return
    }

    projectStatus = includeManager ? 'Configuring the project manager…' : 'Starting independent agents…'
    const managerOutcome = includeManager && managerConfig
      ? await prepareConfiguredManager(managerConfig, createdProject)
      : undefined

    projectStatus = targets.length ? 'Starting independent agents…' : 'Sending starting prompts…'
    const outcomes = await Promise.all(targets.map(async (agent) => {
      if (agent.sessionId) {
        const existing = store.sessions[agent.sessionId]?.record
        if (existing) return { id: agent.id, record: existing }
      }
      try {
        const body: Record<string, unknown> = {
          profileId: agent.profileId,
          projectId: createdProject.id,
          useWorktree: agent.useWorktree,
          permissionMode: agent.permissionMode,
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
    }))

    for (const outcome of outcomes) {
      if (outcome.record) {
        store.upsertSessionRecord(outcome.record)
        updateAgent(outcome.id, {
          status: 'launching',
          sessionId: outcome.record.id,
          error: undefined,
        })
      } else {
        updateAgent(outcome.id, {
          status: 'failed',
          error: outcome.error,
        })
      }
    }
    if (managerOutcome) {
      if (managerOutcome.record) {
        managerStatus = 'launching'
        managerError = undefined
      } else {
        managerStatus = 'failed'
        managerError = managerOutcome.error
      }
    }

    projectStatus = 'Sending starting prompts…'
    const promptOutcomes = await Promise.all([
      ...targets.map(async (target) => {
        const agent = agents.find((item) => item.id === target.id)
        if (!agent?.sessionId || agent.status === 'failed') return
        if (agent.promptSent) return { id: agent.id, ok: true }
        try {
          const sent = await api.send(agent.sessionId, promptFor(agent))
          if (sent.error) throw new Error(sent.error)
          return { id: agent.id, ok: true }
        } catch (cause) {
          return {
            id: agent.id,
            error: cause instanceof Error ? cause.message : 'The starting prompt was not sent.',
          }
        }
      }),
      (managerOutcome?.record && managerConfig && !managerPromptSent)
        ? (async () => {
            try {
              const sent = await api.send(managerOutcome.record!.id, managerConfig!.startingPrompt)
              if (sent.error) throw new Error(sent.error)
              return { id: 'project-manager', ok: true }
            } catch (cause) {
              return {
                id: 'project-manager',
                error: cause instanceof Error ? cause.message : 'The manager starting prompt was not sent.',
              }
            }
          })()
        : Promise.resolve(managerOutcome?.record ? { id: 'project-manager', ok: true } : undefined),
    ])

    for (const outcome of promptOutcomes) {
      if (!outcome) continue
      if (outcome.id === 'project-manager') {
        if (outcome.ok) {
          managerPromptSent = true
          managerStatus = 'started'
          managerError = undefined
        } else {
          managerStatus = 'failed'
          managerError = 'error' in outcome ? outcome.error : 'The manager did not start.'
        }
      } else if (outcome.ok) {
        updateAgent(outcome.id, {
          status: 'started',
          promptSent: true,
          error: undefined,
        })
      } else {
        updateAgent(outcome.id, {
          status: 'failed',
          error: 'error' in outcome ? outcome.error : 'The agent did not start.',
        })
      }
    }
    projectStatus = ''
    launching = false
    await onlaunched(launchResult())
  }

  function launchAll(): Promise<void> {
    if (tutorialMode) return Promise.resolve()
    return launch(
      agents.filter((agent) => agent.status !== 'started'),
      Boolean(managerConfig && managerStatus !== 'started'),
    )
  }

  function retryFailed(): Promise<void> {
    return launch(
      agents.filter((agent) => agent.status === 'failed'),
      managerStatus === 'failed',
    )
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !creating && !launching) onclose()
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="button" tabindex="-1" onclick={onclose} onkeydown={() => {}}></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="New project" data-tutorial-anchor="new-project-flow" data-overseer-anchor="new_project">
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
    <section class="step project-step" class:complete={Boolean(projectDraft)} bind:this={projectSection}>
      <div class="step-head">
        <div>
          <span class="step-number">STEP 1</span>
          <h3>Project</h3>
        </div>
        {#if projectDraft}
          <div class="step-status">
            <span class="ready"><Icon name="check" size={14} /> Project draft ready</span>
            {#if step !== 1}
              <button class="edit-step" aria-label="Edit project setup" onclick={editProject}>Edit</button>
            {/if}
          </div>
        {/if}
      </div>

      {#if projectDraft && !editingProjectSource}
        <div class="project-summary">
          <div>
            <b>{projectDraft.name}</b>
            <span>
              {projectDraft.kind === 'local'
                ? `${projectDraft.location ? `${projectDraft.location.distro} · ` : ''}${projectDraft.path}`
                : projectDraft.kind === 'github'
                  ? `Clone ${projectDraft.repository.nameWithOwner} at launch${projectDraft.distro ? ` in ${projectDraft.distro}` : ''}`
                  : `App-managed Git repository created at launch${projectDraft.distro ? ` in ${projectDraft.distro}` : ''}`}
            </span>
          </div>
          <span class="created-label">Not created yet</span>
        </div>
        {#if step === 1}
          <p class="fixed-note">This remains a draft. You can change the source or setup notes; nothing is written until Launch.</p>
          <div class="fields two guidance">
            <label>
              <span>Git configuration <em>optional</em></span>
              <textarea bind:value={gitGuidance} placeholder="Branch, identity, remote, or commit conventions for the agents"></textarea>
            </label>
            <label>
              <span>Environment setup <em>optional</em></span>
              <textarea bind:value={environmentGuidance} placeholder="Setup commands and variable names — do not paste secrets"></textarea>
            </label>
          </div>
          <div class="footer-actions">
            <button class="secondary" aria-label="Change project source" onclick={changeProjectSource}>Change source</button>
            <button class="primary" onclick={editTeam}>Continue to team</button>
          </div>
        {:else if gitGuidance || environmentGuidance}
          <div class="setup-summary">
            {#if gitGuidance}<span><b>Git:</b> {gitGuidance}</span>{/if}
            {#if environmentGuidance}<span><b>Environment:</b> {environmentGuidance}</span>{/if}
          </div>
        {/if}
      {:else}
        <div class="source-actions" data-tutorial-anchor="project-source">
          <button class="source" class:active={projectSource === 'local'} onclick={() => (projectSource = 'local')}>
            <Icon name="folder" size={17} />
            <span><b>Choose a directory</b><small>Use a folder already on this computer.</small></span>
          </button>
          <button class="source" class:active={projectSource === 'github'} aria-label="Clone a GitHub repository" onclick={() => (projectSource = 'github')}>
            <Icon name="git-branch" size={17} />
            <span><b>Clone a GitHub repository</b><small>Use your existing GitHub sign-in.</small></span>
          </button>
          <button class="source" class:active={projectSource === 'managed'} aria-label="Create from just a name" onclick={() => (projectSource = 'managed')}>
            <Icon name="plus" size={17} />
            <span><b>Just a name</b><small>Let the app make a Git-backed project directory.</small></span>
          </button>
        </div>

        {#if projectSource === 'github'}
          <div class="fields two">
            <label>
              <span>Clone destination</span>
              <select
                aria-label="Clone destination"
                bind:value={projectDistro}
                onfocus={loadWslCapability}
                onclick={loadWslCapability}
              >
                <option value="">This machine (Windows)</option>
                {#each wslCapability?.distros ?? [] as distro (distro.name)}
                  <option value={distro.name} disabled={distro.version !== 2}>
                    WSL · {distro.name}{distro.isDefault ? ' (default)' : ''}{distro.version !== 2
                      ? ' — WSL 1 unsupported'
                      : distro.state !== 'running'
                        ? ' — starts when used'
                        : ''}
                  </option>
                {/each}
                <option value="__docker_deferred__" disabled>
                  Docker/WSL container — not supported in this release
                </option>
              </select>
              <small>
                WSL clones require native GitHub CLI and Git signed in inside that distro. Docker
                container targets are explicitly deferred.
              </small>
            </label>
          </div>
          <GitHubImport deferClone onSelected={githubSelected} onClose={() => (projectSource = 'local')} />
        {:else if projectSource === 'local'}
          <div class="fields two">
            <label>
              <span>Filesystem</span>
              <select
                aria-label="Project filesystem"
                bind:value={projectDistro}
                onfocus={loadWslCapability}
                onclick={loadWslCapability}
              >
                <option value="">This machine (Windows)</option>
                {#each wslCapability?.distros ?? [] as distro (distro.name)}
                  <option
                    value={distro.name}
                    disabled={distro.version !== 2}
                  >
                    WSL · {distro.name}{distro.isDefault ? ' (default)' : ''}{distro.version !== 2
                      ? ' — WSL 1 unsupported'
                      : distro.state !== 'running'
                        ? ' — starts when used'
                        : ''}
                  </option>
                {/each}
              </select>
              <small>
                {#if wslLoading}
                  Detecting installed distros…
                {:else if wslCapability && !wslCapability.supported}
                  {wslCapability.reason}
                {:else if wslCapability?.supported && !wslCapability.distros.length}
                  No user WSL distros are installed.
                {:else}
                  WSL projects run Git and agents inside the selected distro.
                {/if}
              </small>
            </label>
          </div>
          <div class="fields two">
            <label>
              <span>Project name</span>
              <input aria-label="Project name" bind:value={projectName} placeholder="Control room" />
            </label>
            <label>
              <span>Working directory</span>
              <div class="path-input">
                <input
                  aria-label="Working directory"
                  bind:value={projectPath}
                  placeholder={projectDistro ? '/home/me/control-room' : 'C:\\work\\control-room'}
                />
                <button class="browse" onclick={browse}>Browse</button>
              </div>
            </label>
          </div>
        {:else}
          <div class="managed-source">
            <label>
              <span>Filesystem</span>
              <select
                aria-label="Managed project filesystem"
                bind:value={projectDistro}
                onfocus={loadWslCapability}
                onclick={loadWslCapability}
              >
                <option value="">This machine (Windows)</option>
                {#each wslCapability?.distros ?? [] as distro (distro.name)}
                  <option value={distro.name} disabled={distro.version !== 2}>
                    WSL · {distro.name}{distro.isDefault ? ' (default)' : ''}{distro.version !== 2
                      ? ' — WSL 1 unsupported'
                      : distro.state !== 'running'
                        ? ' — starts when used'
                        : ''}
                  </option>
                {/each}
              </select>
            </label>
            <label>
              <span>Project name</span>
              <input aria-label="Project name" bind:value={projectName} placeholder="New research tool" />
            </label>
            <p>The app creates a dedicated project repository alongside its managed workspaces and initializes Git so worktree isolation works from the first agent.</p>
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
        {#if projectDraft || projectSource !== 'github'}
          <div class="footer-actions">
            {#if projectDraft}
              <button class="secondary" onclick={() => (editingProjectSource = false)}>Keep current project</button>
            {/if}
            {#if projectSource === 'local'}
              <button class="primary" onclick={continueLocalDraft} disabled={creating}>
                {creating ? 'Checking directory…' : 'Continue to team'}
              </button>
            {:else if projectSource === 'managed'}
              <button class="primary" onclick={continueManagedDraft}>Continue to team</button>
            {/if}
          </div>
        {/if}
      {/if}
    </section>

    {#if projectDraft}
      <section class="step" class:current={step === 2} bind:this={teamSection}>
        <div class="step-head">
          <div>
            <span class="step-number">STEP 2</span>
            <h3>The team</h3>
          </div>
          <div class="step-status">
            <span class="count">
              {managerConfig ? 'Manager configured' : 'No manager'} ·
              {agents.length} independent agent{agents.length === 1 ? '' : 's'}
            </span>
            {#if step !== 2}
              <button class="edit-step" aria-label="Edit team setup" onclick={editTeam}>Edit</button>
            {/if}
          </div>
        </div>

        <div class="team-content" hidden={step !== 2}>
          <p class="intro">
            Use either category, both, or neither. Zero is fine if you only want the project.
          </p>

          <section class="team-category manager-category" aria-labelledby="manager-category-title" data-tutorial-anchor="project-manager">
            <div class="category-head">
              <div>
                <span class="category-label">DELEGATE THE WORK</span>
                <h4 id="manager-category-title">With a manager</h4>
                <p>Enable one manager and define its child-agent roles here. Children it spawns answer to it, nest beneath it, and are covered by its lifecycle and collision oversight.</p>
              </div>
              <span class="optional">Optional</span>
            </div>
            <label class="manager-enable">
              <input
                type="checkbox"
                aria-label="Enable a project manager"
                checked={managerEnabled}
                onchange={(event) => toggleManager((event.target as HTMLInputElement).checked)}
              />
              <span>
                <b>Enable a project manager</b>
                <small>{managerConfig ? 'Configured for this launch. The fields remain here and editable.' : 'Configure the manager and the child roles it may spawn.'}</small>
              </span>
            </label>

            {#if managerEnabled}
              <div class="manager-setup" data-tutorial-anchor="project-manager-setup">
                <ManagerSetupModal
                  embedded
                  deferLaunch
                  draftProject={{ name: projectDraft.name, path: draftPath() }}
                  onConfigured={configureManager}
                />
              </div>
            {/if}
          </section>

          <section class="team-category independent-category" aria-labelledby="independent-category-title" data-tutorial-anchor="project-independent-agents">
            <div class="category-head">
              <div>
                <span class="category-label">FIRE AND FORGET</span>
                <h4 id="independent-category-title">Independent agents</h4>
                <p>These agents launch together as standalone project chats. They do not answer to the manager, do not nest beneath it, and keep their own scope and permissions.</p>
              </div>
              <span class="optional">Optional</span>
            </div>
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
                        <option value={profile.id}>{profileOptionLabel(profile)} · {profile.provider}</option>
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

                <div class="agent-controls" data-tutorial-anchor="project-worktree">
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

            <button class="add" aria-label="Add starting agent" onclick={addAgent}><Icon name="plus" size={14} /> Starting agent</button>
          </section>

          {#if teamError}<div class="error" role="alert">{teamError}</div>{/if}
          <div class="footer-actions">
            <button class="secondary" onclick={editProject}>Back</button>
            <button class="primary" onclick={review}>Review and finalize</button>
          </div>
        </div>
      </section>

      {#if step === 3}
        <section class="step current" bind:this={finalizeSection} data-tutorial-anchor="project-finalize">
          <div class="step-head">
            <div>
              <span class="step-number">STEP 3</span>
              <h3>Finalize</h3>
            </div>
          </div>

          <div class="review">
            <div class="review-project">
              <Icon name="folder" size={18} />
              <div><b>{projectDraft.name}</b><span>{draftPath()}</span></div>
            </div>
            {#if managerConfig}
              <section class="review-group manager-group">
                <span class="category-label">WITH A MANAGER · DELEGATED TEAM</span>
                <div class="manager-review">
                  <Icon name="flag" size={16} />
                  <span>
                    <b>Project manager · {accountName(managerConfig.managerProfileId)}</b>
                    <small>
                      {managerConfig.agentTypes.length} child role{managerConfig.agentTypes.length === 1 ? '' : 's'} defined ·
                      {managerConfig.maxLiveChildren} live children · {managerConfig.parallelismTarget} parallel target · {managerConfig.permissionMode} permission
                    </small>
                  </span>
                  <em class:ok={managerStatus === 'started'} class:bad={managerStatus === 'failed'}>
                    {managerStatus === 'launching' ? 'Starting…' : managerStatus === 'started' ? 'Started' : managerStatus === 'failed' ? 'Did not start' : 'Ready'}
                  </em>
                </div>
              </section>
            {/if}
            {#if agents.length}
              <section class="review-group independent-group">
                <span class="category-label">INDEPENDENT AGENTS · NO MANAGER</span>
                <div class="review-agents">
                  {#each agents as agent, index (agent.id)}
                    <div class="review-agent">
                      <ProviderLogo provider={store.profiles.find((item) => item.id === agent.profileId)?.provider ?? 'claude'} size={15} />
                      <span><b>{index + 1}. {accountName(agent.profileId)}</b><small>{agent.scope || agent.prompt}</small></span>
                      <em class:ok={agent.status === 'started'} class:bad={agent.status === 'failed'}>
                        {agent.status === 'launching' ? 'Starting…' : agent.status === 'started' ? 'Started' : agent.status === 'failed' ? 'Did not start' : 'Ready'}
                      </em>
                    </div>
                  {/each}
                </div>
              </section>
            {/if}
            {#if !managerConfig && agents.length === 0}
              <div class="zero">No manager and no independent agents. This will create the project and open its overview.</div>
            {/if}
          </div>

          {#if launching && projectStatus}
            <div class="launch-progress" role="status">
              <progress></progress>
              <span>{projectStatus}</span>
            </div>
          {/if}

          {#if launchAttempted && !launching}
            <div class="launch-summary" class:has-failures={failedCount > 0}>
              {#if failedCount}
                <b>{startedCount} team member{startedCount === 1 ? '' : 's'} started; {failedCount} did not.</b>
                <p>The project is open with the agents that started. Fix the problem below, then retry only the failures.</p>
                <ul>
                  {#each failed as agent (agent.id)}
                    <li><span>{labelFor(agent)}</span><strong>{agent.error}</strong></li>
                  {/each}
                  {#if managerStatus === 'failed'}
                    <li><span>Project manager · {managerConfig ? accountName(managerConfig.managerProfileId) : ''}</span><strong>{managerError}</strong></li>
                  {/if}
                </ul>
                <button class="primary" onclick={retryFailed}>Retry failed team member{failedCount === 1 ? '' : 's'}</button>
              {:else if agents.length || managerConfig}
                <b>All {startedCount} team member{startedCount === 1 ? '' : 's'} started.</b>
                <p>The project overview is open.</p>
              {:else}
                <b>Project ready.</b>
                <p>The project overview is open with no starting agents.</p>
              {/if}
            </div>
          {/if}

          {#if !launchAttempted}
            {#if tutorialMode}
              <p class="fixed-note">Dry run only. Finish the tutorial to clear this sample and return to a blank project setup.</p>
            {/if}
            <div class="footer-actions">
              <button class="secondary" onclick={() => { step = 2; void reveal('team') }}>Back to team</button>
              <button class="launch" onclick={launchAll} disabled={launching || tutorialMode}>
                {tutorialMode
                  ? 'Dry run complete — nothing created'
                  : agents.length || managerConfig
                    ? 'Launch project with team'
                    : 'Create project without agents'}
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
  .step-status { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-3); min-width: 0; }
  .edit-step { flex: none; color: var(--accent); font-size: var(--text-xs); font-weight: var(--fw-medium); }
  .ready { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--ok); font-size: var(--text-xs); font-weight: var(--fw-medium); }
  .count { color: var(--muted); font-size: var(--text-xs); }
  .project-summary, .review-project { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
  .project-summary > div, .review-project > div { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .project-summary span, .review-project span { overflow: hidden; color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
  .created-label { flex: none; color: var(--ok) !important; font-family: inherit !important; }
  .setup-summary { display: flex; flex-direction: column; gap: var(--space-1); margin-top: var(--space-3); color: var(--muted); font-size: var(--text-xs); }
  .setup-summary span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fixed-note { margin: var(--space-3) 0 0; color: var(--muted); font-size: var(--text-xs); line-height: 1.4; }
  .source-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin-bottom: var(--space-4); }
  .source { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4); text-align: left; border: 1px solid var(--border);
    border-radius: var(--r-md); background: var(--surface-2); }
  .source.active { border-color: var(--border-accent); color: var(--accent); }
  .source span { display: flex; flex-direction: column; gap: 2px; }
  .source small { color: var(--muted); font-size: var(--text-xs); font-weight: 400; }
  .managed-source { display: grid; gap: var(--space-3); }
  .managed-source p { margin: 0; color: var(--muted); font-size: var(--text-xs); line-height: 1.45; }
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
  .team-content[hidden] { display: none; }
  .team-category { padding: var(--space-4); margin-top: var(--space-4); border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface-2); }
  .manager-category { border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); }
  .independent-category { border-color: color-mix(in srgb, var(--cyan) 35%, var(--border)); }
  .category-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
  .category-head > div { min-width: 0; }
  .category-label { display: block; color: var(--accent); font-size: var(--text-2xs); font-weight: var(--fw-semibold); letter-spacing: var(--ls-label); }
  .independent-category .category-label, .independent-group .category-label { color: var(--cyan); }
  .category-head h4 { margin: var(--space-1) 0 var(--space-2); font-size: var(--text-md); }
  .category-head p { margin: 0; color: var(--muted); font-size: var(--text-xs); line-height: 1.5; }
  .optional { flex: none; padding: 2px var(--space-2); color: var(--dim); border: 1px solid var(--border); border-radius: var(--r-pill); font-size: var(--text-2xs); }
  .agents { display: flex; flex-direction: column; gap: var(--space-3); }
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
  .add { display: flex; align-items: center; justify-content: center; gap: var(--space-2); width: 100%; min-height: 56px; margin-top: var(--space-3); color: var(--cyan);
    border: 1px dashed var(--border-accent); border-radius: var(--r-md); background: color-mix(in srgb, var(--accent) 5%, transparent); font-weight: var(--fw-medium); }
  .manager-enable { flex-direction: row; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border); border-radius: var(--r-md); }
  .manager-enable input { flex: none; width: auto; }
  .manager-enable span { display: flex; flex-direction: column; gap: 2px; }
  .manager-setup { margin-top: var(--space-4); overflow: hidden; border: 1px solid var(--border-accent); border-radius: var(--r-lg); }
  .footer-actions { display: flex; justify-content: flex-end; gap: var(--space-3); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border-subtle); }
  .review { display: flex; flex-direction: column; gap: var(--space-4); }
  .review-group { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--r-md); }
  .manager-group { border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); }
  .independent-group { border-color: color-mix(in srgb, var(--cyan) 35%, var(--border)); }
  .review-project { padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
  .review-agents { display: flex; flex-direction: column; gap: var(--space-2); }
  .review-agent { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3);
    padding: var(--space-3); border-bottom: 1px solid var(--border-subtle); }
  .review-agent > span { display: flex; flex-direction: column; min-width: 0; }
  .review-agent small { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
  .review-agent em { color: var(--muted); font-size: var(--text-xs); font-style: normal; }
  .review-agent em.ok { color: var(--ok); }
  .review-agent em.bad { color: var(--bad-text); }
  .manager-review { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4);
    color: var(--muted); border: 1px solid var(--border); border-radius: var(--r-md); }
  .manager-review span { display: flex; flex-direction: column; gap: 2px; }
  .manager-review small { color: var(--dim); }
  .manager-review em { font-size: var(--text-xs); font-style: normal; }
  .manager-review em.ok { color: var(--ok); }
  .manager-review em.bad { color: var(--bad-text); }
  .zero { padding: var(--space-5); color: var(--muted); text-align: center; border: 1px dashed var(--border); border-radius: var(--r-md); }
  .launch { background: linear-gradient(135deg, var(--accent), var(--cyan)); box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 20%, transparent); }
  .launch-summary { padding: var(--space-4); margin-top: var(--space-4); color: var(--ok);
    background: color-mix(in srgb, var(--ok) 9%, transparent); border: 1px solid var(--ok); border-radius: var(--r-md); }
  .launch-summary.has-failures { color: var(--bad-text); background: color-mix(in srgb, var(--bad) 10%, transparent); border-color: var(--bad); }
  .launch-summary p { margin: var(--space-2) 0; color: var(--muted); font-size: var(--text-sm); }
  .launch-summary ul { display: flex; flex-direction: column; gap: var(--space-2); padding: 0; list-style: none; }
  .launch-summary li { display: flex; justify-content: space-between; gap: var(--space-4); font-size: var(--text-xs); }
  .launch-summary li strong { font-weight: var(--fw-medium); }
  .launch-progress { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-4); color: var(--muted); font-size: var(--text-sm); }
  .launch-progress progress { width: 120px; accent-color: var(--accent); }

  @media (max-width: 720px) {
    .modal { inset: 8px; }
    header, .body { padding-inline: var(--space-4); }
    .source-actions, .fields.two, .fields.three, .agent-controls { grid-template-columns: minmax(0, 1fr); }
    .category-head { flex-direction: column; gap: var(--space-2); }
    nav span { padding-inline: var(--space-2); }
  }
</style>
