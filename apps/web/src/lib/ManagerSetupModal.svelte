<script module lang="ts">
  export interface ManagerLaunchConfig {
    projectId: string
    managerProfileId: string
    managerModel?: string
    managerEffort?: string
    permissionMode: 'safe' | 'edits' | 'full'
    maxChildPermissionMode: 'safe' | 'edits' | 'full'
    startingPrompt: string
    orientationBrief: string
    operatorTask: string
    standingInstructions: string
    canApproveChildren: boolean
    maxLiveChildren: number
    delegation: Array<'commit' | 'push'>
    allowedTools: string[]
    allowedProfiles: string[]
    allowedModels: Record<string, string[]>
    agentTypes: import('./api').ManagerAgentType[]
  }
</script>

<script lang="ts">
  import { api, type ManagerAgentType, type ProjectInfo, type SessionRecord } from './api'
  import { defaultModelFor, findModel, modelsFor } from './catalog'
  import Icon from './Icon.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import { store } from './store.svelte'

  interface Props {
    onclose?: () => void
    embedded?: boolean
    deferLaunch?: boolean
    initialProjectId?: string
    draftProject?: Pick<ProjectInfo, 'name' | 'path'>
    onCreateProject?: () => void
    onConfigured?: (config: ManagerLaunchConfig) => void
  }

  let {
    onclose = () => {},
    embedded = false,
    deferLaunch = false,
    initialProjectId = '',
    draftProject,
    onCreateProject,
    onConfigured,
  }: Props = $props()

  type Mode = 'promote' | 'create'
  type Authority = 'commit' | 'push'
  type PermissionMode = 'safe' | 'edits' | 'full'

  const COMMON_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch']

  const eligibleChats = $derived(
    store.sessionList.filter(
      (view) => !view.record.siteId && !view.record.parentSessionId && Boolean(view.record.projectId),
    ),
  )
  const firstEligibleId = (): string =>
    store.sessionList.find(
      (view) => !view.record.siteId && !view.record.parentSessionId && Boolean(view.record.projectId),
    )?.record.id ?? ''

  let mode = $state<Mode>('create')
  let selectedId = $state('')
  let projectId = $state('')
  let managerProfileId = $state(store.defaultProfileId() ?? '')
  let managerModel = $state('')
  let managerEffort = $state('')
  let permissionMode = $state<PermissionMode>('safe')
  let maxChildPermissionMode = $state<PermissionMode>('safe')
  let maxLiveChildren = $state(4)
  let delegation = $state<Authority[]>([])
  let allowedTools = $state<string[]>([])
  let customTool = $state('')
  let agentTypes = $state<ManagerAgentType[]>([])
  let orientationBrief = $state('')
  let operatorTask = $state('')
  let standingInstructions = $state('')
  let canApproveChildren = $state(true)
  let briefTouched = $state(false)
  let standingTouched = $state(false)
  let busy = $state(false)
  let error = $state('')
  let saved = $state(false)

  const selectedRecord = $derived(selectedId ? store.sessions[selectedId]?.record : undefined)
  const project = $derived(
    store.projects.find((item) => item.id === projectId)
      ?? (draftProject
        ? {
            id: '__draft-project__',
            name: draftProject.name,
            path: draftProject.path,
            createdAt: '',
          }
        : undefined),
  )
  const isActiveManager = $derived(selectedRecord?.isProjectManager === true)
  const managerProfile = $derived(store.profiles.find((profile) => profile.id === managerProfileId))
  const managerModels = $derived(managerProfile ? modelsFor(managerProfile.provider) : [])
  const managerEffortOptions = $derived(
    (findModel(managerModel) ?? (managerProfile ? defaultModelFor(managerProfile.provider) : undefined))
      ?.descriptors.find((descriptor) => descriptor.id === 'effort')?.options ?? [],
  )
  const scope = $derived(scopeFromAgentTypes())

  function generatedPrompt(): string {
    const selectedProject = project
    const projectName = selectedProject?.name ?? 'this project'
    const projectPath = selectedProject?.path ?? 'the project directory'
    const existing = Object.values(store.sessions)
      .map((view) => view.record)
      .filter((record) => record.projectId === projectId && record.id !== selectedId)
      .map((record) => `${chatLabel(record)} (${record.status})`)
    const workerScope = scopeFromAgentTypes()
    const roles = agentTypes
      .filter((role) => role.name.trim() && role.purpose.trim())
      .map((role) => {
        const runner = role.selection === 'usage-aware'
          ? `choose the least-used unblocked account from ${(role.profileIds ?? []).join(', ')}`
          : `${role.profileId ?? 'unselected account'} / ${role.model ?? 'default model'} / ${role.effort || 'default effort'}`
        return `- ${role.name.trim()} — agent_type "${role.id}": ${role.purpose.trim()} (${runner})`
      })
    const authority = delegation.length ? delegation.join(' and ') : 'neither commit nor push'
    return [
      `ROLE\nYou are a project manager in AllMyAgents. You run a team of real AllMyAgents chats on the operator’s behalf: decompose the task, delegate bounded work, watch progress and collisions, and act on what you learn. This full starting prompt is your manager brief; OPERATOR TASK at the end is the assignment to execute now.`,
      `PROJECT\nManage ${projectName} at ${projectPath}.\nWhat is already here: ${existing.length ? existing.join('; ') : 'no other project chats are running yet'}.`,
      `YOUR ALLMYAGENTS TOOLS\n- list_agents: see the project teammates you can address.\n- spawn_agent: create a real child chat in this app; it gets an isolated git worktree by default. Use an operator-defined agent_type when one fits.\n- child_status: get the live running / idle / stopped / errored tally without polling.\n- peek_agent: inspect a worker without interrupting it. For your own children you may request activity, full transcript, changes, tasks, approvals/blockers, worktree state, or all views.\n- assign_child_task: put an audited assignment on a direct child’s task board; the operator sees that same board. Use the task id to update its state later.\n- set_child_authority: grant or revoke only the worker Git actions and exact tools inside your grant ceiling; changes apply to that worker’s next tool call.\n- send_message and read_messages: coordinate through the project bus. Prefer a direct message to one session; broadcast only when every project agent must act.\n- practice_write / practice_list / practice_read / practice_edit: manage durable team conventions that future agents should follow.\n- memory_write / memory_search / memory_read: retain and retrieve project facts and decisions.`,
      `CHILD APPROVAL TOOL\n- decide_child_approval: approve or deny one pending request from your own direct child when child approvals are enabled. The hub refuses unrelated children and anything outside your operator-granted ceiling.`,
      `IMPORTANT — TOOL LAYERS\nUse the hub-provided AllMyAgents tools described above. In Codex, choose the fully-qualified mcp__allmyagents__spawn_agent and mcp__allmyagents__list_agents tools (some clients render those names as mcp__allmyagents.spawn_agent and mcp__allmyagents.list_agents). Never call collaboration.spawn_agent, collaboration.list_agents, or another native collabAgentToolCall for project work. The native Codex or Claude harness may expose similar names, but those tools do not create the real app chats and worktrees you are managing. If a worker does not appear in the AllMyAgents sidebar with a session id, parentSessionId, and worktree, treat that as a failed delegation and retry with the mcp__allmyagents tool.`,
      `GRANTED BRIEF AND LIMITS\n- Grant ceiling means the maximum scope the operator gave you; every child grant must stay inside it.\n- At most ${maxLiveChildren} live direct children. The hub refuses an additional spawn at the bound.\n- Child permission modes may not exceed ${maxChildPermissionMode}.\n- Exact worker profile_id values you may pass to spawn_agent: ${workerScope.profiles.length ? workerScope.profiles.join(', ') : 'none'}.\n- Worker Git permissions you may grant: ${delegation.length ? authority : 'none'}.\n- Additional exact worker tools you may grant: ${allowedTools.length ? allowedTools.join(', ') : 'none'}.\n- Child approval decisions: ${canApproveChildren ? 'enabled for your own direct children, within the same grant ceiling' : 'disabled; the operator answers pending approvals'}.\n- Delegation only narrows: a manager cannot grant what it does not hold — including an authority, account, model, permission mode, or tool.\n- You have full non-interfering visibility into your own children, and only those children.\n${roles.length ? `Worker roles (prefer their exact agent_type id when one fits):\n${roles.join('\n')}` : `No named worker roles are configured; call spawn_agent with profile_id "${workerScope.profiles[0] ?? 'unavailable'}" and its default model.`}`,
      `OPERATING CADENCE\nTurn the operator task into bounded assignments with an expected output and a clear completion check. Spawn only useful parallel work. In each assignment, state the exact granted tools and require the worker to stay inside that envelope. At decision points use child_status; use peek_agent when status alone is insufficient. Verify a child’s transcript and worktree changes before relying on its result. If a child stalls, blocks, errors, exceeds scope, or collides: inspect it and send one direct corrective message. When it asks for an ungranted tool, redirect it to a granted alternative instead of widening authority or waiting; otherwise reassign or re-sequence when possible, and report any decision that needs the operator in this manager chat. Send one useful update per meaningful event rather than narrating every step. Finish with a concise report of each child’s final status, findings, files/commits changed, verification performed, and unresolved decisions.`,
      `OPERATOR TASK\nReplace this line with the task to begin, then start immediately.`,
    ].join('\n\n')
  }

  function generatedOrientationBrief(): string {
    const withoutTask = generatedPrompt()
      .replace(/\n\nOPERATOR TASK\n[\s\S]*$/, '')
      .replace(
        'This full starting prompt is your manager brief; OPERATOR TASK at the end is the assignment to execute now.',
        'The operator task is appended to this orientation when the manager launches.',
      )
    return [
      withoutTask,
      'DELEGATION DEFAULT\nDelegate all bounded project work by default to real AllMyAgents workers. Keep decomposition, coordination, inspection, and verification yourself; do not perform worker tasks in the native vendor harness.',
    ].join('\n\n')
  }

  function defaultStandingInstructions(): string {
    return [
      '## Project manager standing rules',
      '',
      '- Delegate all bounded project work by default to real AllMyAgents workers through the hub-provided spawn_agent tool; your job is to decompose, coordinate, inspect, and verify.',
      '- Use the AllMyAgents tool layer, never the vendor harness equivalents. In Codex, call mcp__allmyagents__spawn_agent and mcp__allmyagents__list_agents (sometimes rendered mcp__allmyagents.spawn_agent and mcp__allmyagents.list_agents). Never call collaboration.spawn_agent, collaboration.list_agents, or another native collabAgentToolCall for project work. Only the AllMyAgents tools create real app chats with isolated worktrees, lifecycle reporting, collision detection, and operator visibility.',
      '- Your workers are real chats. If the operator cannot see a worker in the sidebar, you did not create it through AllMyAgents.',
      '- Keep your own task board current. Inspect direct children with peek_agent view "tasks" and use assign_child_task so delegated intent appears on the operator-visible board. Keep each returned task id and update it to in_progress, completed, or abandoned when the real child transition occurs.',
    ].join('\n')
  }

  function composedStartingPrompt(): string {
    const readiness = operatorTask.trim()
      ? 'Acknowledge this manager brief, then call list_agents and child_status from the AllMyAgents tool layer. Briefly report what responded, then proceed with the operator task below.'
      : 'Acknowledge this manager brief, then call list_agents and child_status from the AllMyAgents tool layer. Report what responded. No task has been assigned: do not invent work. Stop after the tooling report and ask the operator what task to begin.'
    const task = operatorTask.trim() || 'No task assigned. Halt after the readiness check and ask the operator for a task.'
    return [
      orientationBrief.trim(),
      `READINESS CHECK\n${readiness}`,
      `OPERATOR TASK\n${task}`,
    ].filter(Boolean).join('\n\n')
  }

  function resetGrantDefaults(): void {
    const profile = store.profiles.find((candidate) => candidate.id === managerProfileId)
    managerModel = profile ? defaultModelFor(profile.provider)?.slug ?? '' : ''
    managerEffort = ''
    permissionMode = 'safe'
    maxChildPermissionMode = 'safe'
    maxLiveChildren = 4
    delegation = []
    allowedTools = []
    customTool = ''
    agentTypes = []
    operatorTask = ''
    orientationBrief = ''
    standingInstructions = ''
    canApproveChildren = true
    briefTouched = false
    standingTouched = false
    error = ''
    saved = false
  }

  function loadChat(id: string): void {
    selectedId = id
    const record = store.sessions[id]?.record
    if (!record) return
    projectId = record.projectId ?? ''
    managerProfileId = record.profileId
    managerModel = record.model ?? defaultModelFor(record.provider)?.slug ?? ''
    managerEffort = record.effort ?? ''
    permissionMode = (record.permissionMode as PermissionMode | undefined) ?? 'safe'
    maxChildPermissionMode = record.managerMaxChildPermissionMode ?? 'safe'
    maxLiveChildren = record.managerMaxLiveChildren ?? 4
    delegation = [...(record.managerDelegation ?? [])]
    allowedTools = [...(record.managerAllowedTools ?? [])]
    agentTypes = (record.managerAgentTypes ?? []).map((role) => ({
      ...role,
      profileIds: role.profileIds ? [...role.profileIds] : undefined,
    }))
    orientationBrief = record.managerOrientationBrief ?? generatedOrientationBrief()
    operatorTask = record.managerOperatorTask ?? ''
    standingInstructions = record.managerStandingInstructions ?? defaultStandingInstructions()
    canApproveChildren = record.managerCanApproveChildren ?? true
    briefTouched = Boolean(record.managerOrientationBrief)
    standingTouched = record.managerStandingInstructions !== undefined
    error = ''
    saved = record.isProjectManager === true
  }

  function chooseMode(next: Mode): void {
    mode = next
    if (next === 'promote') {
      loadChat(store.managerSetupSessionId ?? eligibleChats[0]?.record.id ?? '')
      return
    }
    selectedId = ''
    projectId = initialProjectId || store.projects[0]?.id || ''
    managerProfileId = store.defaultProfileId() ?? ''
    resetGrantDefaults()
  }

  function chooseManagerProfile(profileId: string): void {
    managerProfileId = profileId
    const profile = store.profiles.find((candidate) => candidate.id === profileId)
    managerModel = profile ? defaultModelFor(profile.provider)?.slug ?? '' : ''
    managerEffort = ''
  }

  function toggleAuthority(authority: Authority, enabled: boolean): void {
    delegation = enabled
      ? [...new Set([...delegation, authority])]
      : delegation.filter((item) => item !== authority)
  }

  function delegationLabel(): string {
    if (delegation.length === 0) return 'neither commit nor push'
    if (delegation.length === 1) return `${delegation[0]} only`
    return 'commit and push'
  }

  function chatLabel(record: SessionRecord): string {
    return record.title || record.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || record.id.slice(0, 8)
  }

  function addAgentType(): void {
    const profile = store.profiles[0]
    const model = profile ? defaultModelFor(profile.provider) : undefined
    agentTypes = [
      ...agentTypes,
      {
        id: `role-${Date.now()}-${agentTypes.length}`,
        name: '',
        purpose: '',
        selection: 'fixed',
        profileId: profile?.id,
        model: model?.slug,
        effort: model?.descriptors.find((descriptor) => descriptor.id === 'effort')
          ?.options?.find((option) => option.isDefault)?.value,
      },
    ]
  }

  function updateAgentType(index: number, patch: Partial<ManagerAgentType>): void {
    agentTypes = agentTypes.map((role, roleIndex) => roleIndex === index ? { ...role, ...patch } : role)
  }

  function removeAgentType(index: number): void {
    agentTypes = agentTypes.filter((_, roleIndex) => roleIndex !== index)
  }

  function setAgentTypeSelection(index: number, selection: ManagerAgentType['selection']): void {
    const role = agentTypes[index]
    if (!role) return
    if (selection === 'usage-aware') {
      updateAgentType(index, {
        selection,
        profileId: undefined,
        model: undefined,
        profileIds: store.profiles.map((profile) => profile.id),
      })
      return
    }
    const profile = store.profiles[0]
    updateAgentType(index, {
      selection,
      profileId: profile?.id,
      profileIds: undefined,
      model: profile ? defaultModelFor(profile.provider)?.slug : undefined,
    })
  }

  function chooseRoleProfile(index: number, profileId: string): void {
    const profile = store.profiles.find((candidate) => candidate.id === profileId)
    const model = profile ? defaultModelFor(profile.provider) : undefined
    updateAgentType(index, {
      profileId,
      model: model?.slug,
      effort: model?.descriptors.find((descriptor) => descriptor.id === 'effort')
        ?.options?.find((option) => option.isDefault)?.value,
    })
  }

  function toggleUsageProfile(index: number, profileId: string, enabled: boolean): void {
    const current = agentTypes[index]?.profileIds ?? []
    updateAgentType(index, {
      profileIds: enabled ? [...new Set([...current, profileId])] : current.filter((id) => id !== profileId),
    })
  }

  function roleEffortOptions(role: ManagerAgentType) {
    return findModel(role.model)?.descriptors.find((descriptor) => descriptor.id === 'effort')?.options ?? []
  }

  function usageLabel(profileId: string): string {
    const snapshot = store.usage.find((item) => item.profileId === profileId)
    if (!snapshot) return 'usage not reported'
    if (snapshot.blocked) return `blocked${snapshot.blockedReason ? `: ${snapshot.blockedReason}` : ''}`
    const used = snapshot.codex?.usedPercent ??
      (snapshot.claudeUsage?.length ? Math.max(...snapshot.claudeUsage.map((line) => line.percent)) : undefined)
    return typeof used === 'number' ? `${Math.round(used)}% used` : 'available'
  }

  function toggleTool(tool: string, enabled: boolean): void {
    allowedTools = enabled ? [...new Set([...allowedTools, tool])] : allowedTools.filter((item) => item !== tool)
  }

  function addCustomTool(): void {
    const name = customTool.trim()
    if (!name) return
    allowedTools = [...new Set([...allowedTools, name])]
    customTool = ''
  }

  function scopeFromAgentTypes(): { profiles: string[]; models: Record<string, string[]> } {
    const profiles: string[] = []
    const models: Record<string, string[]> = {}
    for (const role of agentTypes) {
      const roleProfiles = role.selection === 'fixed'
        ? role.profileId ? [role.profileId] : []
        : role.profileIds ?? []
      for (const profileId of roleProfiles) if (!profiles.includes(profileId)) profiles.push(profileId)
      if (role.selection === 'fixed' && role.profileId && role.model) {
        models[role.profileId] = [...new Set([...(models[role.profileId] ?? []), role.model])]
      }
    }
    if (!profiles.length && managerProfileId) profiles.push(managerProfileId)
    return { profiles, models }
  }

  function profileScope(profileId: string): string {
    const profile = store.profiles.find((item) => item.id === profileId)
    const models = scope.models[profileId] ?? []
    return `${profileId} · ${models.length ? models.join(', ') : `${profile?.provider ?? 'account'} default model`}`
  }

  function launchConfig(): ManagerLaunchConfig {
    return {
      projectId,
      managerProfileId,
      managerModel: managerModel || undefined,
      managerEffort: managerEffort || undefined,
      permissionMode,
      maxChildPermissionMode,
      startingPrompt: composedStartingPrompt(),
      orientationBrief: orientationBrief.trim(),
      operatorTask: operatorTask.trim(),
      standingInstructions: standingInstructions.trim(),
      canApproveChildren,
      maxLiveChildren,
      delegation: [...delegation],
      allowedTools: [...allowedTools],
      allowedProfiles: [...scope.profiles],
      allowedModels: Object.fromEntries(Object.entries(scope.models).map(([id, values]) => [id, [...values]])),
      agentTypes: agentTypes.map((role) => ({
        ...role,
        profileIds: role.profileIds ? [...role.profileIds] : undefined,
      })),
    }
  }

  function validate(config: ManagerLaunchConfig): string | undefined {
    if (!projectId) return 'Choose the project this manager will oversee.'
    if (!managerProfileId) return 'Choose the account that will run the manager.'
    if (!config.allowedProfiles.length) return 'Choose at least one worker account.'
    if (!config.orientationBrief) return 'The manager needs an orientation brief.'
    if (!Number.isInteger(maxLiveChildren) || maxLiveChildren < 1 || maxLiveChildren > 16) {
      return 'The live child limit must be from 1 to 16.'
    }
    for (const role of agentTypes) {
      if (!role.name.trim() || !role.purpose.trim()) return 'Every agent type needs a name and purpose.'
      if (role.selection === 'usage-aware' && !(role.profileIds?.length)) {
        return `${role.name} needs at least one account for usage-aware selection.`
      }
    }
    return undefined
  }

  async function grant(): Promise<void> {
    error = ''
    const config = launchConfig()
    const invalid = validate(config)
    if (invalid) {
      error = invalid
      return
    }
    if (embedded && deferLaunch) {
      onConfigured?.(config)
      saved = true
      return
    }
    busy = true
    try {
      let record = selectedRecord
      const wasActive = record?.isProjectManager === true
      if (mode === 'create') {
        const created = await api.spawn({
          profileId: managerProfileId,
          projectId,
          useWorktree: false,
          permissionMode,
          model: managerModel || undefined,
          effort: managerEffort || undefined,
        })
        if ('error' in created) throw new Error(created.error)
        record = created
        const name = `${project?.name ?? 'Project'} manager`
        record.title = name
        record.titleSource = 'user'
        store.upsertSessionRecord(record)
        await api.rename(record.id, name)
      }
      if (!record) throw new Error('Choose the chat to promote.')
      const settingsResult = await api.setSettings(record.id, {
        model: managerModel || undefined,
        effort: managerEffort || undefined,
      })
      if (settingsResult && 'error' in settingsResult) throw new Error(settingsResult.error)
      const configured = await api.configureProjectManager(record.id, {
        enabled: true,
        maxLiveChildren,
        delegation,
        allowedProfiles: config.allowedProfiles,
        allowedModels: config.allowedModels,
        allowedTools,
        agentTypes,
        startingPrompt: config.startingPrompt,
        orientationBrief: config.orientationBrief,
        operatorTask: config.operatorTask,
        standingInstructions: config.standingInstructions,
        canApproveChildren: config.canApproveChildren,
        permissionMode: config.permissionMode,
        maxChildPermissionMode: config.maxChildPermissionMode,
      })
      if ('error' in configured) throw new Error(configured.error)
      if (!wasActive) {
        const sent = await api.send(configured.id, config.startingPrompt)
        if (sent.error) throw new Error(sent.error)
      }
      store.upsertSessionRecord(configured)
      selectedId = configured.id
      mode = 'promote'
      saved = true
      store.select(configured.id)
      if (!wasActive) onclose()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }

  async function revoke(): Promise<void> {
    if (!selectedRecord) return
    busy = true
    error = ''
    try {
      const configured = await api.configureProjectManager(selectedRecord.id, {
        enabled: false,
        maxLiveChildren,
        delegation: [],
        allowedProfiles: [],
        allowedModels: {},
        allowedTools: [],
        agentTypes: [],
        startingPrompt: '',
        orientationBrief: '',
        operatorTask: '',
        standingInstructions: '',
        canApproveChildren: false,
        maxChildPermissionMode: 'safe',
      })
      if ('error' in configured) throw new Error(configured.error)
      store.upsertSessionRecord(configured)
      saved = false
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (!embedded && event.key === 'Escape') onclose()
  }

  let initialized = false
  $effect(() => {
    if (initialized) return
    initialized = true
    const startingId = store.managerSetupSessionId ?? ''
    if (!embedded && startingId) {
      mode = 'promote'
      loadChat(startingId)
    }
    else {
      chooseMode('create')
      if (initialProjectId) projectId = initialProjectId
      else if (draftProject) projectId = '__draft-project__'
    }
  })

  $effect(() => {
    projectId
    draftProject?.name
    draftProject?.path
    maxLiveChildren
    delegation
    agentTypes
    if (!briefTouched) orientationBrief = generatedOrientationBrief()
    if (!standingTouched) standingInstructions = defaultStandingInstructions()
  })
</script>

<svelte:window onkeydown={onKey} />

{#if !embedded}
  <div class="backdrop" role="button" tabindex="-1" onclick={onclose} onkeydown={() => {}}></div>
{/if}
<div
  class="manager-modal"
  class:embedded
  role={embedded ? undefined : 'dialog'}
  aria-modal={embedded ? undefined : 'true'}
  aria-label="Project managers"
>
  {#if !embedded}
    <header>
      <div>
        <span class="eyebrow">PROJECT MANAGERS</span>
        <h2>Delegate a project</h2>
        <p>A project manager spawns and oversees other agents on your behalf.</p>
      </div>
      <button class="close" aria-label="close" onclick={onclose}><Icon name="x" size={18} /></button>
    </header>

    <div class="mode-tabs" aria-label="Manager setup choice">
      <button class:active={mode === 'promote'} onclick={() => chooseMode('promote')}>Promote existing chat</button>
      <button class:active={mode === 'create'} onclick={() => chooseMode('create')}>Create new manager</button>
    </div>
  {/if}

  <div class="body">
    <section class="setup">
      {#if mode === 'promote'}
        <label>
          <span>Chat to promote</span>
          <select value={selectedId} onchange={(event) => loadChat((event.target as HTMLSelectElement).value)}>
            {#each eligibleChats as view (view.record.id)}
              <option value={view.record.id}>{chatLabel(view.record)} · {store.projects.find((p) => p.id === view.record.projectId)?.name}</option>
            {/each}
          </select>
        </label>
        {#if eligibleChats.length === 0}
          <p class="empty">Start a chat inside a project first, or choose “Create new manager.”</p>
        {/if}
      {:else}
        <div class="row two">
          <label>
            <span>Manager account</span>
            <select value={managerProfileId} onchange={(event) => chooseManagerProfile((event.target as HTMLSelectElement).value)}>
              {#each store.profiles as profile (profile.id)}
                <option value={profile.id}>{profile.id} · {profile.provider}</option>
              {/each}
            </select>
          </label>
          <label>
            <span>Manager model</span>
            <select bind:value={managerModel}>
              {#each managerModels as model (model.slug)}<option value={model.slug}>{model.name}</option>{/each}
            </select>
          </label>
        </div>
        {#if managerEffortOptions.length}
          <label>
            <span>Manager reasoning / effort</span>
            <select bind:value={managerEffort}>
              {#each managerEffortOptions as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
        {/if}
      {/if}

      <div class="field">
        <span class="field-label">Project</span>
        <div class="project-choice">
          {#if mode === 'promote' || (embedded && (initialProjectId || draftProject))}
            <div class="fixed-value"><Icon name="folder" size={14} />{project?.name ?? 'No project'}</div>
          {:else}
            <select bind:value={projectId}>
              <option value="" disabled>Choose a project</option>
              {#each store.projects as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
            </select>
          {/if}
          {#if !embedded || onCreateProject}
            <button class="secondary" type="button" onclick={() => onCreateProject?.()}>Create a new project</button>
          {/if}
        </div>
        <small>The manager and every worker it creates stay attached to this project.</small>
      </div>

      <div class="row two">
        <label>
          <span>Manager permission level</span>
          <select bind:value={permissionMode}>
            <option value="safe">Safe · ask before edits and commands</option>
            <option value="edits">Edits · edit freely, ask for commands</option>
            <option value="full">Full · use available tools without asking</option>
          </select>
        </label>
        <label>
          <span>Live child limit</span>
          <div class="limit">
            <input type="number" min="1" max="16" bind:value={maxLiveChildren} />
            <span>agents at once</span>
          </div>
          <small>The hub refuses another spawn when this bound is reached.</small>
        </label>
      </div>

      <label>
        <span>Maximum child permission level</span>
        <select bind:value={maxChildPermissionMode}>
          <option value="safe">Safe · children ask before edits and commands</option>
          <option value="edits">Edits · children may edit freely, but ask for commands</option>
          <option value="full">Full · children may use available tools without asking</option>
        </select>
        <small>The manager may choose a lower level for a child, but the hub rejects anything above this operator grant.</small>
      </label>

      <label>
        <span>Operator task <em>optional</em></span>
        <textarea
          rows="4"
          aria-label="Operator task"
          value={operatorTask}
          oninput={(event) => {
            operatorTask = (event.target as HTMLTextAreaElement).value
          }}
          placeholder="What should this manager and its workers accomplish?"
        ></textarea>
        <small>Leave blank to launch a readiness check: the manager verifies its AllMyAgents tools, reports, then stops and asks you for a task.</small>
      </label>

      <details class="brief-editor">
        <summary>Edit the full brief and standing rules</summary>
        <p>The orientation is sent at launch. Standing rules are reapplied through the manager's instruction scope on later turns, including after compaction.</p>
        <label>
          <span>Manager orientation brief</span>
          <textarea
            rows="12"
            value={orientationBrief}
            oninput={(event) => {
              briefTouched = true
              orientationBrief = (event.target as HTMLTextAreaElement).value
            }}
          ></textarea>
        </label>
        <label>
          <span>Standing manager rules</span>
          <textarea
            rows="7"
            value={standingInstructions}
            oninput={(event) => {
              standingTouched = true
              standingInstructions = (event.target as HTMLTextAreaElement).value
            }}
          ></textarea>
          <small>Editable. These rules survive summarisation: delegate through AllMyAgents, never the vendor's same-named harness tools, and create workers the operator can see.</small>
        </label>
      </details>

      <div class="field agent-types">
        <div class="section-head">
          <div>
            <span class="field-label">Agent types</span>
            <small><b>Worker accounts &amp; models</b> are defined here as reusable roles the manager can request.</small>
          </div>
          <button class="secondary" type="button" onclick={addAgentType}>Add agent type</button>
        </div>
        {#if agentTypes.length === 0}
          <p class="empty-state">Optional. Without named roles, the manager can use its own account’s default model.</p>
        {/if}
        {#each agentTypes as role, index (role.id)}
          <article class="agent-type">
            <div class="role-head">
              <b>Worker role {index + 1}</b>
              <button type="button" aria-label={`Remove ${role.name || `worker role ${index + 1}`}`} onclick={() => removeAgentType(index)}>Remove</button>
            </div>
            <div class="row two">
              <label>
                <span>Agent type name</span>
                <input value={role.name} placeholder="General worker" oninput={(event) => updateAgentType(index, { name: (event.target as HTMLInputElement).value })} />
              </label>
              <label>
                <span>What is this agent for?</span>
                <input value={role.purpose} placeholder="Implement scoped tasks in its worktree" oninput={(event) => updateAgentType(index, { purpose: (event.target as HTMLInputElement).value })} />
              </label>
            </div>
            <div class="selection-tabs">
              <button class:active={role.selection === 'fixed'} type="button" onclick={() => setAgentTypeSelection(index, 'fixed')}>Use this model</button>
              <button class:active={role.selection === 'usage-aware'} type="button" onclick={() => setAgentTypeSelection(index, 'usage-aware')}>Let manager choose using usage limits</button>
            </div>
            {#if role.selection === 'fixed'}
              <div class="row three">
                <label>
                  <span>Worker account</span>
                  <select value={role.profileId} onchange={(event) => chooseRoleProfile(index, (event.target as HTMLSelectElement).value)}>
                    {#each store.profiles as profile (profile.id)}
                      <option value={profile.id}>{profile.id} · {profile.provider}</option>
                    {/each}
                  </select>
                </label>
                <label>
                  <span>Worker model</span>
                  <select value={role.model} onchange={(event) => updateAgentType(index, { model: (event.target as HTMLSelectElement).value })}>
                    {#each modelsFor(store.profiles.find((profile) => profile.id === role.profileId)?.provider ?? 'codex') as model (model.slug)}
                      <option value={model.slug}>{model.name}</option>
                    {/each}
                  </select>
                </label>
                <label>
                  <span>Reasoning / effort</span>
                  <select value={role.effort ?? ''} onchange={(event) => updateAgentType(index, { effort: (event.target as HTMLSelectElement).value || undefined })}>
                    <option value="">Model default</option>
                    {#each roleEffortOptions(role) as option (option.value)}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                </label>
              </div>
            {:else}
              <div class="usage-aware">
                <p>The hub chooses the least-used account that is not blocked. It uses the live limits already shown by Usage Monitor; it never guesses or selects outside this list.</p>
                {#each store.profiles as profile (profile.id)}
                  <label class="usage-profile">
                    <input
                      type="checkbox"
                      checked={role.profileIds?.includes(profile.id) ?? false}
                      onchange={(event) => toggleUsageProfile(index, profile.id, (event.target as HTMLInputElement).checked)}
                    />
                    <ProviderLogo provider={profile.provider} size={14} />
                    <b>{profile.id}</b>
                    <span class:blocked={store.usage.find((item) => item.profileId === profile.id)?.blocked}>{usageLabel(profile.id)}</span>
                  </label>
                {/each}
              </div>
            {/if}
          </article>
        {/each}
      </div>

      <fieldset>
        <legend>Worker approval decisions</legend>
        <label class="approval-toggle">
          <input type="checkbox" bind:checked={canApproveChildren} />
          <span>
            <b>Manager may answer its workers’ approvals</b>
            <small>Direct children only, and only for actions inside the grant ceiling below. Every decision is journaled. Turn this off to keep approvals with the operator.</small>
          </span>
        </label>
      </fieldset>

      <fieldset>
        <legend>What the manager may grant to workers</legend>
        <div class="grant-state" class:on={delegation.length > 0}>
          <b>Worker Git grants: {delegation.length ? 'On' : 'Off'}</b>
          <span>{delegation.length ? `Selected worker actions: ${delegation.join(' and ')}.` : 'No worker can be granted commit or push.'}</span>
        </div>
        <div class="choices">
          <label><input type="checkbox" checked={delegation.includes('commit')} onchange={(event) => toggleAuthority('commit', (event.target as HTMLInputElement).checked)} /> May grant commit</label>
          <label><input type="checkbox" checked={delegation.includes('push')} onchange={(event) => toggleAuthority('push', (event.target as HTMLInputElement).checked)} /> May grant push</label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Other tools the manager may grant to workers <em>optional</em></legend>
        <p>Optional — without a grant, workers request approval normally. Choose common tools below, or add the exact tool name shown in a worker’s tool list or approval card.</p>
        <div class="tool-grid">
          {#each COMMON_TOOLS as tool}
            <label><input type="checkbox" checked={allowedTools.includes(tool)} onchange={(event) => toggleTool(tool, (event.target as HTMLInputElement).checked)} /> {tool}</label>
          {/each}
        </div>
        <div class="custom-tool">
          <label>
            <span>Custom exact tool name</span>
            <input bind:value={customTool} placeholder="e.g. mcp__github__create_issue" onkeydown={(event) => event.key === 'Enter' && (event.preventDefault(), addCustomTool())} />
          </label>
          <button class="secondary" type="button" onclick={addCustomTool}>Add exact name</button>
        </div>
        {#if allowedTools.length}<p class="chips">{allowedTools.join(' · ')}</p>{/if}
      </fieldset>
    </section>

    <aside>
      <div class="scope-head">
        <span>{isActiveManager || saved ? 'CURRENT GRANT' : 'GRANT PREVIEW'}</span>
        {#if isActiveManager || saved}<b>Manager active</b>{/if}
      </div>
      <h3>{mode === 'create' ? `${project?.name ?? 'Project'} manager` : selectedRecord ? chatLabel(selectedRecord) : 'Choose a chat'}</h3>
      <dl>
        <div><dt>Project</dt><dd>{project?.name ?? 'Not chosen'}</dd></div>
        <div><dt>Manager</dt><dd>{managerProfileId || 'Not chosen'} · {managerModel || 'default model'} · {permissionMode}</dd></div>
        <div>
          <dt>Configured roles</dt>
          <dd>{agentTypes.length ? agentTypes.map((role) => `${role.name || 'Unnamed'} (${role.selection === 'usage-aware' ? 'usage-aware' : role.model || 'default'})`).join(' · ') : 'No named roles; manager account default'}</dd>
        </div>
        <div>
          <dt>Worker scope</dt>
          <dd>{#if scope.profiles.length}{scope.profiles.map(profileScope).join(' · ')}{:else}None chosen{/if}</dd>
        </div>
        <div><dt>Bound</dt><dd>{maxLiveChildren} live children</dd></div>
        <div><dt>Child permission ceiling</dt><dd>{maxChildPermissionMode}</dd></div>
        <div><dt>Worker approvals</dt><dd>{canApproveChildren ? 'manager may decide within this grant ceiling' : 'operator decides'}</dd></div>
        <div><dt>Worker Git grants</dt><dd>{delegationLabel()}</dd></div>
        <div><dt>Other worker grants</dt><dd>{allowedTools.length ? allowedTools.join(', ') : 'none'}</dd></div>
        <div>
          <dt>Visibility</dt>
          <dd>Full activity, transcript, approvals, changes, and worktree state for its own children, and only those.</dd>
        </div>
      </dl>
      <p class="audit"><Icon name="history" size={13} /> Grants, changes, use, role selection, and revocations are journaled.</p>

      {#if error}<p class="error">{error}</p>{/if}
      <button class="primary" disabled={busy || (mode === 'promote' && !selectedRecord)} onclick={grant}>
        {busy
          ? 'Launching…'
          : embedded && deferLaunch
            ? 'Add to project launch'
            : isActiveManager || saved
              ? 'Update granted scope'
              : mode === 'create'
                ? 'Create and launch manager'
                : 'Make this chat a manager and launch'}
      </button>
      {#if isActiveManager || (saved && !deferLaunch)}
        <button class="revoke" disabled={busy} onclick={revoke}>Revoke manager role</button>
      {/if}
    </aside>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 110; background: color-mix(in srgb, #05050a 72%, transparent); backdrop-filter: blur(3px); }
  .manager-modal { position: fixed; z-index: 111; inset: 3vh 3vw; max-width: 1180px; max-height: 94vh; margin: auto;
    color: var(--text); background: var(--surface-1); border: 1px solid var(--border-accent); border-radius: var(--r-xl);
    box-shadow: 0 28px 80px #0009; overflow: auto; }
  .manager-modal.embedded { position: static; max-width: none; max-height: none; margin: 0; border: 0; border-radius: 0; box-shadow: none; overflow: visible; }
  header { display: flex; justify-content: space-between; gap: var(--space-5); padding: 1.4rem 1.6rem 1rem;
    background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, var(--surface-1)), var(--surface-1) 58%); }
  header h2 { margin: .18rem 0 .3rem; font-size: 1.55rem; }
  header p { margin: 0; color: var(--dim); font-size: var(--text-sm); }
  .eyebrow, .scope-head > span { color: var(--accent); font-size: .65rem; font-weight: var(--fw-semibold); letter-spacing: .12em; }
  .close { align-self: flex-start; color: var(--dim); padding: .35rem; }
  .mode-tabs { display: grid; grid-template-columns: 1fr 1fr; border-block: 1px solid var(--border); }
  .mode-tabs button { padding: .8rem; color: var(--dim); background: var(--surface-2); font-weight: var(--fw-medium); }
  .mode-tabs button.active { color: var(--text); background: var(--surface-1); box-shadow: inset 0 -2px var(--accent); }
  .body { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(285px, .75fr); }
  .setup { display: flex; flex-direction: column; gap: 1.1rem; padding: 1.35rem 1.6rem 1.6rem; border-right: 1px solid var(--border); }
  label, .field { display: flex; flex-direction: column; gap: .42rem; }
  label > span, .field-label, legend { font-size: var(--text-xs); font-weight: var(--fw-semibold); }
  legend em { color: var(--dim); font-style: normal; font-weight: var(--fw-normal); margin-left: .3rem; }
  select, input, textarea { color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-md); padding: .52rem .6rem; }
  select, label > input, textarea { width: 100%; }
  textarea { resize: vertical; line-height: 1.45; font: inherit; font-size: var(--text-xs); }
  .brief-editor { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); padding: .65rem .75rem; }
  .brief-editor summary { cursor: pointer; color: var(--text); font-weight: 650; }
  .brief-editor[open] summary { margin-bottom: .65rem; }
  .brief-editor > p { margin: 0 0 .75rem; color: var(--muted); font-size: var(--text-xs); line-height: 1.45; }
  .brief-editor label + label { margin-top: .75rem; }
  small { color: var(--dim); line-height: 1.35; }
  .row { display: grid; gap: .65rem; }
  .row.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .row.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .project-choice { display: flex; gap: .5rem; }
  .project-choice > :first-child { flex: 1; }
  .fixed-value { display: flex; align-items: center; gap: .45rem; padding: .55rem .65rem; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
  .secondary { color: var(--text); border: 1px solid var(--border); background: var(--surface-2); border-radius: var(--r-md); padding: .5rem .7rem; font-size: var(--text-xs); }
  .limit { display: flex; align-items: center; gap: .55rem; }
  .limit input { width: 4.5rem; }
  .limit span { color: var(--dim); font-size: var(--text-xs); }
  .section-head, .role-head { display: flex; align-items: start; justify-content: space-between; gap: .75rem; }
  .section-head > div { display: flex; flex-direction: column; gap: .25rem; }
  .agent-types { gap: .65rem; }
  .agent-type { display: flex; flex-direction: column; gap: .75rem; padding: .8rem; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
  .role-head { font-size: var(--text-xs); }
  .role-head button { color: var(--dim); font-size: .7rem; }
  .selection-tabs { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; }
  .selection-tabs button { padding: .48rem; color: var(--dim); background: var(--surface-1); font-size: .72rem; }
  .selection-tabs button.active { color: var(--text); background: color-mix(in srgb, var(--accent) 13%, var(--surface-2)); box-shadow: inset 0 -2px var(--accent); }
  .usage-aware { display: flex; flex-direction: column; gap: .4rem; }
  .usage-aware > p { margin: 0 0 .2rem; color: var(--dim); font-size: .72rem; line-height: 1.4; }
  .usage-profile { flex-direction: row; align-items: center; gap: .45rem; padding: .42rem; background: var(--surface-1); border-radius: var(--r-sm); }
  .usage-profile input, .choices input, .tool-grid input { width: auto; }
  .usage-profile > span { margin-left: auto; color: var(--dim); font-size: .68rem; font-weight: var(--fw-normal); }
  .usage-profile > span.blocked { color: var(--danger); }
  fieldset { margin: 0; padding: .8rem; border: 1px solid var(--border); border-radius: var(--r-md); }
  fieldset > p { margin: .05rem 0 .7rem; color: var(--dim); font-size: .72rem; line-height: 1.4; }
  .grant-state { display: flex; flex-direction: column; gap: .18rem; margin: .15rem 0 .7rem; padding: .58rem; border-radius: var(--r-md); background: var(--surface-2); }
  .grant-state.on { background: color-mix(in srgb, var(--accent) 12%, var(--surface-2)); }
  .grant-state b { font-size: .75rem; }
  .grant-state span { color: var(--dim); font-size: .7rem; }
  .choices, .tool-grid { display: flex; flex-wrap: wrap; gap: .5rem .8rem; }
  .choices label, .tool-grid label { flex-direction: row; align-items: center; gap: .35rem; font-size: .72rem; }
  .tool-grid { padding: .2rem 0 .75rem; }
  .custom-tool { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: .5rem; }
  .chips { color: var(--text); overflow-wrap: anywhere; }
  .empty-state { margin: 0; padding: .65rem; color: var(--dim); background: var(--surface-2); border-radius: var(--r-md); font-size: .72rem; }
  aside { position: sticky; top: 0; align-self: start; padding: 1.35rem; }
  .scope-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .scope-head b { color: #7de3a1; font-size: .7rem; }
  aside h3 { margin: .5rem 0 1rem; font-size: 1.1rem; }
  dl { display: flex; flex-direction: column; gap: .7rem; margin: 0; }
  dl div { padding-bottom: .65rem; border-bottom: 1px solid var(--border); }
  dt { color: var(--dim); font-size: .66rem; text-transform: uppercase; letter-spacing: .08em; }
  dd { margin: .25rem 0 0; font-size: var(--text-xs); line-height: 1.4; overflow-wrap: anywhere; }
  .audit { display: flex; align-items: center; gap: .4rem; color: var(--dim); font-size: .7rem; line-height: 1.4; margin: 1rem 0; }
  .primary, .revoke { width: 100%; border-radius: var(--r-md); padding: .66rem; font-weight: var(--fw-semibold); }
  .primary { color: white; background: var(--accent); }
  .primary:disabled { opacity: .5; }
  .revoke { margin-top: .55rem; color: var(--text); border: 1px solid var(--border); background: var(--surface-2); }
  .error, .empty { color: var(--danger); font-size: var(--text-xs); line-height: 1.4; }
  @media (max-width: 800px) {
    .manager-modal { inset: 1rem; }
    .body, .row.two, .row.three { grid-template-columns: 1fr; }
    .setup { border-right: 0; border-bottom: 1px solid var(--border); }
    aside { position: static; }
    .project-choice, .custom-tool { grid-template-columns: 1fr; flex-direction: column; }
  }
</style>
