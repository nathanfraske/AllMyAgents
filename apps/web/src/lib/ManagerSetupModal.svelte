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
    approvalHelper?: import('./api').ManagerApprovalHelperConfig
    pauseExhaustedAccounts: boolean
    allowWorkerSubagents: boolean
    maxSubagentsPerWorker: number
    maxLiveChildren: number
    parallelismTarget: number
    delegation: Array<'commit' | 'push'>
    allowedTools: string[]
    allowedProfiles: string[]
    allowedModels: Record<string, string[]>
    agentTypes: import('./api').ManagerAgentType[]
  }
</script>

<script lang="ts">
  import { api, type ManagerAgentType, type ProfileInfo, type ProjectInfo, type SessionRecord } from './api'
  import { defaultModelFor, findModel, modelsFor } from './catalog'
  import Icon from './Icon.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import { profileLabel, profileOptionLabel } from './profileLabel'
  import { store } from './store.svelte'

  interface Props {
    onclose?: () => void
    embedded?: boolean
    deferLaunch?: boolean
    initialProjectId?: string
    initialManagerId?: string
    stayInProject?: boolean
    draftProject?: Pick<ProjectInfo, 'name' | 'path'>
    onCreateProject?: () => void
    onConfigured?: (config: ManagerLaunchConfig | null) => void
    onSaved?: (record: SessionRecord) => void
  }

  let {
    onclose = () => {},
    embedded = false,
    deferLaunch = false,
    initialProjectId = '',
    initialManagerId = '',
    stayInProject = false,
    draftProject,
    onCreateProject,
    onConfigured,
    onSaved,
  }: Props = $props()

  type Mode = 'promote' | 'create'
  type Authority = 'commit' | 'push'
  type PermissionMode = 'safe' | 'edits' | 'full'

  const COMMON_CAPABILITIES = [
    { id: 'shell', label: 'Shell commands', detail: 'Claude Bash/PowerShell and Codex command execution' },
    { id: 'file_write', label: 'Write files', detail: 'Claude Edit/Write and Codex file changes' },
    { id: 'file_read', label: 'Read files', detail: 'Read, search, glob, and grep' },
    { id: 'web', label: 'Web research', detail: 'Web search and fetch' },
    { id: 'browser', label: 'Browser', detail: 'Granted interactive browser operations' },
    { id: 'runs', label: 'Durable runs', detail: 'Start, inspect, and control local or remote runs' },
  ] as const

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
  // Initialized by chooseMode once the owning project is known. Keeping this empty here also avoids
  // accidentally choosing a local account before an initial remote project has been hydrated.
  let managerProfileId = $state('')
  let managerTitle = $state('')
  let managerModel = $state('')
  let managerEffort = $state('')
  let permissionMode = $state<PermissionMode>('safe')
  let maxChildPermissionMode = $state<PermissionMode>('safe')
  let maxLiveChildren = $state(4)
  let parallelismTarget = $state(3)
  let delegation = $state<Authority[]>([])
  let allowedTools = $state<string[]>([])
  let customTool = $state('')
  let agentTypes = $state<ManagerAgentType[]>([])
  let orientationBrief = $state('')
  let operatorTask = $state('')
  let standingInstructions = $state('')
  let canApproveChildren = $state(true)
  let approvalHelperEnabled = $state(false)
  let approvalHelperProfileId = $state('')
  let approvalHelperModel = $state('')
  let approvalHelperEffort = $state('')
  let approvalHelperMaxRisk = $state<'low' | 'medium'>('low')
  let pauseExhaustedAccounts = $state(true)
  let allowWorkerSubagents = $state(false)
  let maxSubagentsPerWorker = $state(2)
  let briefTouched = $state(false)
  let standingTouched = $state(false)
  let busy = $state(false)
  let error = $state('')
  let saved = $state(false)
  let lastDeferredConfig = ''

  const selectedRecord = $derived(selectedId ? store.sessions[selectedId]?.record : undefined)
  const availableProfiles = $derived(store.profilesForProject(projectId))
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
  const operatorTaskStale = $derived.by(() => {
    if (!selectedRecord?.managerOperatorTask || !selectedRecord.managerOperatorTaskUpdatedAt) return false
    const reviewedAt = Date.parse(selectedRecord.managerOperatorTaskUpdatedAt)
    return Number.isFinite(reviewedAt) && Date.now() - reviewedAt > 7 * 24 * 60 * 60 * 1000
  })
  const proseProfileReferences = $derived.by(() => {
    const prose = [operatorTask, orientationBrief, standingInstructions].join('\n').toLocaleLowerCase()
    return availableProfiles
      .map((profile) => profile.id)
      .filter((profileId) => prose.includes(profileId.toLocaleLowerCase()))
  })
  const managerProfile = $derived(availableProfiles.find((profile) => profile.id === managerProfileId))
  const managerModels = $derived(managerProfile ? modelsFor(managerProfile.provider, managerProfile.availableModels) : [])
  const managerEffortOptions = $derived(
    (findModel(managerModel, managerProfile?.availableModels)
      ?? (managerProfile ? defaultModelFor(managerProfile.provider, managerProfile.availableModels) : undefined))
      ?.descriptors.find((descriptor) => descriptor.id === 'effort')?.options ?? [],
  )
  const approvalHelperProfile = $derived(
    availableProfiles.find((profile) => profile.id === approvalHelperProfileId),
  )
  const approvalHelperModels = $derived(
    approvalHelperProfile ? modelsFor(approvalHelperProfile.provider, approvalHelperProfile.availableModels) : [],
  )
  const approvalHelperEffortOptions = $derived(
    (findModel(approvalHelperModel, approvalHelperProfile?.availableModels)
      ?? (approvalHelperProfile ? defaultModelFor(approvalHelperProfile.provider, approvalHelperProfile.availableModels) : undefined))
      ?.descriptors.find((descriptor) => descriptor.id === 'effort')?.options ?? [],
  )
  const scope = $derived(scopeFromAgentTypes())

  function approvalHelperDefaultModel(profile: ProfileInfo | undefined) {
    if (!profile) return undefined
    const models = modelsFor(profile.provider, profile.availableModels)
    return profile.provider === 'codex'
      ? (models.find((model) => model.slug.includes('codex-spark'))
        ?? models.find((model) => model.slug.includes('mini'))
        ?? models.find((model) => model.isDefault)
        ?? models[0])
      : (models.find((model) => model.slug.includes('sonnet-5'))
        ?? models.find((model) => model.slug.includes('haiku'))
        ?? models.find((model) => model.isDefault)
        ?? models[0])
  }

  function rawManagerProfileId(id: string): string {
    const prefix = project?.siteId ? `${project.siteId}:` : ''
    return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id
  }

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
          ? `choose the least-used unblocked account from ${(role.profileIds ?? []).map(rawManagerProfileId).join(', ')}`
          : `${role.profileId ? rawManagerProfileId(role.profileId) : 'unselected account'} / ${role.model ?? 'default model'} / ${role.effort || 'default effort'}`
        return `- ${role.name.trim()} — agent_type "${role.id}": ${role.purpose.trim()} (${runner})`
      })
    const authority = delegation.length ? delegation.join(' and ') : 'neither commit nor push'
    return [
      `ROLE\nYou are a project manager in AllMyAgents. You run a team of real AllMyAgents chats on the operator’s behalf: decompose the task, delegate bounded work, watch progress and collisions, and act on what you learn. This full starting prompt is your manager brief; OPERATOR TASK at the end is the assignment to execute now.`,
      `PROJECT\nManage ${projectName} at ${projectPath}.\nWhat is already here: ${existing.length ? existing.join('; ') : 'no other project chats are running yet'}.`,
      `YOUR ALLMYAGENTS TOOLS\n- list_agents: see the active-catalog project teammates you can address.\n- spawn_agent: create a real durable child worker in the active team. It gets an isolated git worktree by default. Every manager-created worker must use an operator-defined agent_type or an explicit durable role; profile_id only selects its account, while prompt is the current assignment.\n- manage_team: list, create, rename, or activate durable teams. Switching shelves the outgoing chats while preserving their ids, culture, transcripts, branches, dirty files, and worktrees. It will not interrupt running agents unless the operator explicitly requests interrupt_active.\n- manage_child: resume a stopped/errored worker or repair its durable role. Legacy reactivate also restores old retired records; creating new retired records is disabled.\n- child_status: get the live running / idle / stopped / errored tally, immutable agent ids, durable roles, team membership, and context-continuity warnings without polling.\n- peek_agent: inspect a worker or enabled one-shot descendant without interrupting it. For your own hierarchy you may request activity, full transcript, changes, tasks, approvals/blockers, worktree state, or all views.\n- assign_child_task: put an audited assignment on any agent in your managed hierarchy; the operator sees that same board. Use the task id to update its state later. A high-context result tells you that the next direct manager wake will use the provider compaction boundary.\n- set_child_authority: grant or revoke only the worker Git actions, exact tools, and permission mode inside your grant ceiling; changes apply on the child’s next tool call.\n- send_message and read_messages: coordinate through the project bus. Prefer a direct message to one session; broadcast only when every project agent must act. A direct message can wake your own high-context worker so its provider compaction preserves continuity; set wake=false for checkpoints/FYIs.\n- practice_write / practice_list / practice_read / practice_edit: manage durable team conventions that future agents should follow.\n- memory_write / memory_search / memory_read: retain and retrieve project facts and decisions.`,
      `CHILD APPROVAL TOOL\n- decide_child_approval: approve or deny one pending request from your managed hierarchy when child approvals are enabled. The hub refuses unrelated agents and anything outside your operator-granted ceiling. Disabled, unavailable, and out-of-ceiling manager requests automatically escalate to the Overseer/operator; do not ask a blocked worker to repeat the request.`,
      `IMPORTANT — TOOL LAYERS\nUse the hub-provided AllMyAgents tools described above. Native spawn_agent is not an AllMyAgents project tool. In Codex, choose the fully-qualified mcp__allmyagents__spawn_agent and mcp__allmyagents__list_agents tools (some clients render those names as mcp__allmyagents.spawn_agent and mcp__allmyagents.list_agents). Never call collaboration.spawn_agent, collaboration.list_agents, or another native collabAgentToolCall for project work. The native Codex or Claude harness may expose similar names, but those tools do not create the real app chats and worktrees you are managing. If a worker does not appear in the AllMyAgents sidebar with a session id, parentSessionId, and worktree, treat that as a failed delegation and retry with the mcp__allmyagents tool.`,
      `GRANTED BRIEF AND LIMITS\n- Grant ceiling means the maximum scope the operator gave you; every child grant must stay inside it.\n- At most ${maxLiveChildren} live direct children. The hub refuses an additional spawn at the bound; reuse an existing role or switch teams rather than churning identities.\n- Parallel staffing target: ${parallelismTarget} useful direct worker lanes whenever the task supports them. Recheck this at every new task or material slice; use independent implementation, reproduction, research, or cross-check lanes, and explain a concrete dependency when fewer lanes are honestly useful. Never invent or duplicate work just to fill the target.\n- Child permission modes may not exceed ${maxChildPermissionMode}.\n- Exact worker profile_id values you may pass to spawn_agent: ${workerScope.profiles.length ? workerScope.profiles.map(rawManagerProfileId).join(', ') : 'none'}.\n- Worker Git permissions you may grant or approve once: ${delegation.length ? authority : 'none'}.\n- Additional exact worker tools you may grant or approve once: ${allowedTools.length ? allowedTools.join(', ') : 'none'}.\n- Child approval decisions: ${canApproveChildren ? 'enabled for your managed descendants, within the exact Git/tool ceiling above; broader requests automatically escalate to the Overseer/operator' : 'disabled; every request automatically escalates to the Overseer/operator'}.\n- Exhausted-account dispatch guard: ${pauseExhaustedAccounts ? 'enabled; the hub refuses new child spawns and messages at a hard 100% usage limit unless paid overage or usage credits are active' : 'disabled; account exhaustion does not add a manager-specific dispatch block'}.\n- Context continuity: direct manager wakes may restart a high-context child so Claude auto-compaction or Codex native compaction can preserve its role knowledge. Lifecycle chatter and unrelated system mail remain guarded.\n- Worker one-shot sub-agents: ${allowWorkerSubagents ? `enabled, with at most ${maxSubagentsPerWorker} concurrently running beneath each direct worker; they inherit that worker's exact account, role, and grant` : 'disabled'}.\n- Delegation only narrows: a manager cannot grant what it does not hold — including an authority, account, model, permission mode, or tool.\n- You have full non-interfering visibility into your own managed hierarchy, and only that hierarchy.\n${roles.length ? `Worker roles (prefer their exact agent_type id when one fits):\n${roles.join('\n')}` : `No named worker roles are configured; every spawn_agent call must provide both profile_id and a concise durable role distinct from its prompt.`}`,
      `OPERATING CADENCE\nTurn the operator task into bounded assignments with an expected output and a clear completion check. In each assignment, name the worker’s durable role, the temporary task, and the exact granted tools it may use. Spawn only useful parallel work and give every new worker a durable role. At decision points use child_status; use peek_agent when status alone is insufficient. Reuse an idle worker whose role fits, resume a stopped/errored worker rather than replacing it, and let the provider compact high context while preserving the role and project state. If a task needs a genuinely different type of expertise nobody on the active team owns, create or activate another team and stash the current lineup intact. Never retire a worker merely because a task ended, a turn failed transiently, or its context is large. Verify a child’s transcript and worktree changes before relying on its result. If a child stalls, blocks, errors, exceeds scope, or collides: inspect it and send one direct corrective message. When it asks for an ungranted tool, redirect it to a granted alternative instead of widening authority or waiting; otherwise reassign or re-sequence when possible, and report any decision that needs the operator in this manager chat. Send one useful update per meaningful event rather than narrating every step. Finish with a concise report of each child’s final status, findings, files/commits changed, verification performed, and unresolved decisions.`,
      `REMEMBERED CHILD APPROVALS\nWhen a recurring, understood ordinary tool or Git action from a direct worker should no longer interrupt you, call decide_child_approval with approve=true and remember=true. The hub stores only that exact class on that worker, rechecks it against your live ceiling on every use, journals it, and lets you revoke it with set_child_authority. Use one-time approval for unusual or high-blast-radius requests. One-shot descendants inherit their direct worker's grant.`,
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
    const withoutConfigurationSnapshot = withoutTask.replace(
      /\n\nGRANTED BRIEF AND LIMITS\n[\s\S]*?(?=\n\nOPERATING CADENCE)/,
      '\n\nLIVE GRANT\nAccounts, models, role assignments, usage headroom, capabilities, Git actions, approval scope, and concurrency are generated from live hub state at every turn. That generated block is authoritative; do not preserve or infer those values from prose.',
    )
    return [
      withoutConfigurationSnapshot,
      'DELEGATION DEFAULT\nDelegate all bounded project work by default to real AllMyAgents workers. Keep decomposition, coordination, inspection, and verification yourself; do not perform worker tasks in the native vendor harness.',
    ].join('\n\n')
  }

  function defaultStandingInstructions(): string {
    return [
      '## Project manager standing rules',
      '',
      '- Delegate all bounded project work by default to real AllMyAgents workers through the hub-provided spawn_agent tool; your job is to decompose, coordinate, inspect, and verify.',
      '- Meet the live operator-configured parallel staffing target whenever the work has honest independent lanes. Recheck it at each new task or slice, use cross-check/review as useful lanes, and explain a concrete dependency when fewer workers are appropriate instead of inventing work.',
      '- Use the AllMyAgents tool layer, never the vendor harness equivalents. In Codex, call mcp__allmyagents__spawn_agent and mcp__allmyagents__list_agents (sometimes rendered mcp__allmyagents.spawn_agent and mcp__allmyagents.list_agents). Never call collaboration.spawn_agent, collaboration.list_agents, or another native collabAgentToolCall for project work. Only the AllMyAgents tools create real app chats with isolated worktrees, lifecycle reporting, collision detection, and operator visibility.',
      '- Your workers are real chats. If the operator cannot see a worker in the sidebar, you did not create it through AllMyAgents.',
      '- Give every manager-created worker a durable role: use agent_type when configured, otherwise pass role explicitly. profile_id chooses an account and prompt carries the temporary task; neither substitutes for identity.',
      '- Reuse workers whose durable role fits. Idle is available, stopped/errored workers can be resumed, and high-context direct manager wakes may proceed through provider compaction so relevant knowledge survives.',
      '- New retirement is disabled. Use manage_team for a genuinely different lineup; switching stashes chats without deleting their identities, culture, transcripts, branches, dirty files, or worktrees. Never request interrupt_active unless the operator explicitly wants running outgoing turns stopped.',
      '- Keep your own task board current. Inspect managed descendants with peek_agent view "tasks" and use assign_child_task so delegated intent appears on the operator-visible board. Keep each returned task id and update it to in_progress, completed, or abandoned when the real child transition occurs.',
      '- Use send_message wake=false for checkpoints/FYIs that need no immediate response. A direct assignment may wake your own high-context worker so provider compaction can preserve continuity; do not nudge-loop or replace the worker around that boundary.',
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
    const profile = availableProfiles.find((candidate) => candidate.id === managerProfileId)
    managerTitle = ''
    managerModel = profile ? defaultModelFor(profile.provider, profile.availableModels)?.slug ?? '' : ''
    managerEffort = ''
    permissionMode = 'safe'
    maxChildPermissionMode = 'safe'
    maxLiveChildren = 4
    parallelismTarget = 3
    delegation = []
    allowedTools = []
    customTool = ''
    agentTypes = []
    operatorTask = ''
    orientationBrief = ''
    standingInstructions = ''
    canApproveChildren = true
    approvalHelperEnabled = false
    approvalHelperProfileId = managerProfileId
    const helperModel = approvalHelperDefaultModel(profile)
    approvalHelperModel = helperModel?.slug ?? ''
    approvalHelperEffort = helperModel?.descriptors.find((descriptor) => descriptor.id === 'effort')
      ?.options?.find((option) => option.value === 'low')?.value ?? ''
    approvalHelperMaxRisk = 'low'
    pauseExhaustedAccounts = true
    allowWorkerSubagents = false
    maxSubagentsPerWorker = 2
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
    managerTitle = record.title ?? chatLabel(record)
    const recordProfile = availableProfiles.find((candidate) => candidate.id === record.profileId)
    managerModel = record.model
      ?? defaultModelFor(record.provider, recordProfile?.availableModels)?.slug
      ?? ''
    managerEffort = record.effort ?? ''
    // An explicit one-chat operator override is not the manager's reusable grant. Editing the manager
    // must start from the persisted grant ceiling or merely pressing Save would silently widen it.
    permissionMode = record.managerPermissionModeCeiling
      ?? (record.permissionMode as PermissionMode | undefined)
      ?? 'safe'
    maxChildPermissionMode = record.managerMaxChildPermissionMode ?? 'safe'
    maxLiveChildren = record.managerMaxLiveChildren ?? 4
    parallelismTarget = record.managerParallelismTarget ?? Math.min(3, maxLiveChildren)
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
    approvalHelperEnabled = record.managerApprovalHelper?.enabled ?? false
    approvalHelperProfileId = record.managerApprovalHelper?.profileId ?? record.profileId
    const helperProfile = availableProfiles.find((candidate) => candidate.id === approvalHelperProfileId)
    approvalHelperModel = record.managerApprovalHelper?.model
      ?? approvalHelperDefaultModel(helperProfile)?.slug
      ?? ''
    approvalHelperEffort = record.managerApprovalHelper?.effort ?? ''
    approvalHelperMaxRisk = record.managerApprovalHelper?.maxRisk ?? 'low'
    pauseExhaustedAccounts = record.managerPauseExhaustedAccounts ?? false
    allowWorkerSubagents = record.managerAllowWorkerSubagents ?? false
    maxSubagentsPerWorker = record.managerMaxSubagentsPerWorker ?? 2
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
    managerProfileId = store.defaultProfileId(projectId) ?? ''
    resetGrantDefaults()
  }

  function chooseManagerProfile(profileId: string): void {
    managerProfileId = profileId
    const profile = availableProfiles.find((candidate) => candidate.id === profileId)
    managerModel = profile ? defaultModelFor(profile.provider, profile.availableModels)?.slug ?? '' : ''
    managerEffort = ''
    if (!approvalHelperProfileId) chooseApprovalHelperProfile(profileId)
  }

  function chooseApprovalHelperProfile(profileId: string): void {
    approvalHelperProfileId = profileId
    const profile = availableProfiles.find((candidate) => candidate.id === profileId)
    const model = approvalHelperDefaultModel(profile)
    approvalHelperModel = model?.slug ?? ''
    approvalHelperEffort = model?.descriptors.find((descriptor) => descriptor.id === 'effort')
      ?.options?.find((option) => option.value === 'low')?.value
      ?? model?.descriptors.find((descriptor) => descriptor.id === 'effort')
        ?.options?.find((option) => option.isDefault)?.value
      ?? ''
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
    const profile = availableProfiles[0]
    const model = profile ? defaultModelFor(profile.provider, profile.availableModels) : undefined
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
        profileIds: availableProfiles.map((profile) => profile.id),
      })
      return
    }
    const profile = availableProfiles[0]
    updateAgentType(index, {
      selection,
      profileId: profile?.id,
      profileIds: undefined,
      model: profile ? defaultModelFor(profile.provider, profile.availableModels)?.slug : undefined,
    })
  }

  function chooseRoleProfile(index: number, profileId: string): void {
    const profile = availableProfiles.find((candidate) => candidate.id === profileId)
    const model = profile ? defaultModelFor(profile.provider, profile.availableModels) : undefined
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
    const profile = availableProfiles.find((candidate) => candidate.id === role.profileId)
    return findModel(role.model, profile?.availableModels)?.descriptors.find((descriptor) => descriptor.id === 'effort')?.options ?? []
  }

  function usageLabel(profileId: string): string {
    const snapshot = store.usage.find((item) => item.profileId === profileId)
    if (!snapshot) return 'usage not reported'
    if (snapshot.entitlement === 'denied') return `not entitled${snapshot.entitlementReason ? `: ${snapshot.entitlementReason}` : ''}`
    if (snapshot.blocked) return `blocked${snapshot.blockedReason ? `: ${snapshot.blockedReason}` : ''}`
    if (typeof snapshot.headroom === 'number') return `${Math.round(snapshot.headroom * 100)}% headroom`
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
    const profile = availableProfiles.find((item) => item.id === profileId)
    const models = scope.models[profileId] ?? []
    return `${profile ? profileOptionLabel(profile) : profileId} · ${models.length ? models.join(', ') : `${profile?.provider ?? 'account'} default model`}`
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
      approvalHelper: canApproveChildren
        ? {
            enabled: approvalHelperEnabled,
            profileId: approvalHelperProfileId,
            model: approvalHelperModel || undefined,
            effort: approvalHelperEffort || undefined,
            maxRisk: approvalHelperMaxRisk,
          }
        : undefined,
      pauseExhaustedAccounts,
      allowWorkerSubagents,
      maxSubagentsPerWorker,
      maxLiveChildren,
      parallelismTarget,
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
    if (config.approvalHelper?.enabled && !config.approvalHelper.profileId) {
      return 'Choose an account for the Manager Helper.'
    }
    if (!Number.isInteger(maxLiveChildren) || maxLiveChildren < 1 || maxLiveChildren > 16) {
      return 'The live child limit must be from 1 to 16.'
    }
    if (!Number.isInteger(parallelismTarget) || parallelismTarget < 1 || parallelismTarget > maxLiveChildren) {
      return 'The parallel worker target must be from 1 through the live child limit.'
    }
    if (!Number.isInteger(maxSubagentsPerWorker) || maxSubagentsPerWorker < 1 || maxSubagentsPerWorker > 8) {
      return 'The per-worker one-shot sub-agent limit must be from 1 to 8.'
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
        const name = managerTitle.trim() || `${project?.name ?? 'Project'} manager`
        managerTitle = name
        record.title = name
        record.titleSource = 'user'
        store.upsertSessionRecord(record)
        const renamed = await api.rename(record.id, name)
        if (renamed?.error) throw new Error(renamed.error)
      }
      if (!record) throw new Error('Choose the chat to promote.')
      if (wasActive && managerProfileId !== record.profileId) {
        const previousManagerId = record.id
        const reassigned = await api.reassignProjectManager(record.id, {
          profileId: managerProfileId,
          model: managerModel || undefined,
          effort: managerEffort || undefined,
        })
        if ('error' in reassigned) throw new Error(reassigned.error)
        record = reassigned
        selectedId = reassigned.id
        store.upsertSessionRecord(reassigned)
        const previous = store.sessions[previousManagerId]?.record
        if (previous) {
          previous.isProjectManager = false
          previous.status = 'stopped'
          previous.managerReassignedToSessionId = reassigned.id
          previous.managerReassignedAt = reassigned.managerReassignedAt
          previous.title = previous.title?.endsWith('(snapshot)')
            ? previous.title
            : `${previous.title ?? 'Previous manager'} (snapshot)`
        }
        for (const view of Object.values(store.sessions)) {
          if (view.record.parentSessionId === previousManagerId) view.record.parentSessionId = reassigned.id
          if (view.record.managerRootSessionId === previousManagerId) view.record.managerRootSessionId = reassigned.id
        }
        // Reconcile every copied grant/detail from the authoritative roster without holding the Save UI.
        void store.syncRecordsFromHub()
      }
      const desiredTitle = managerTitle.trim()
      if (desiredTitle && desiredTitle !== record.title) {
        const renamed = await api.rename(record.id, desiredTitle)
        if (renamed?.error) throw new Error(renamed.error)
        record.title = desiredTitle
        record.titleSource = 'user'
      }
      const settingsResult = await api.setSettings(record.id, {
        model: managerModel || undefined,
        effort: managerEffort || undefined,
      })
      if (settingsResult && 'error' in settingsResult) throw new Error(settingsResult.error)
      const configured = await api.configureProjectManager(record.id, {
        enabled: true,
        maxLiveChildren,
        parallelismTarget,
        delegation,
        allowedProfiles: config.allowedProfiles,
        allowedModels: config.allowedModels,
        allowedTools,
        agentTypes,
        // The composed launch message is sent once below. Persisting a second copy beside orientation
        // and operatorTask made stale account/layout claims survive forever in three different fields.
        startingPrompt: '',
        orientationBrief: config.orientationBrief,
        operatorTask: config.operatorTask,
        standingInstructions: config.standingInstructions,
        canApproveChildren: config.canApproveChildren,
        approvalHelper: config.approvalHelper,
        pauseExhaustedAccounts: config.pauseExhaustedAccounts,
        allowWorkerSubagents: config.allowWorkerSubagents,
        maxSubagentsPerWorker: config.maxSubagentsPerWorker,
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
      onSaved?.(configured)
      if (!stayInProject) {
        store.select(configured.id)
        if (!wasActive) onclose()
      }
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
        parallelismTarget: Math.min(parallelismTarget, maxLiveChildren),
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
        pauseExhaustedAccounts: false,
        allowWorkerSubagents: false,
        maxSubagentsPerWorker: 2,
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
    const startingId = initialManagerId || (!embedded ? store.managerSetupSessionId ?? '' : '')
    if (startingId) {
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
    parallelismTarget
    delegation
    agentTypes
    if (!briefTouched) orientationBrief = generatedOrientationBrief()
    if (!standingTouched) standingInstructions = defaultStandingInstructions()
  })

  $effect(() => {
    if (Number.isInteger(maxLiveChildren) && maxLiveChildren >= 1 && parallelismTarget > maxLiveChildren) {
      parallelismTarget = maxLiveChildren
    }
  })

  // In the stepped project flow, enabling the manager is the inclusion decision. Synchronize the
  // in-memory launch draft as fields change; there is deliberately no second "add to launch" action.
  $effect(() => {
    if (!embedded || !deferLaunch || !initialized) return
    const config = launchConfig()
    if (validate(config)) {
      if (lastDeferredConfig) {
        lastDeferredConfig = ''
        onConfigured?.(null)
      }
      saved = false
      return
    }
    const serialized = JSON.stringify(config)
    if (serialized === lastDeferredConfig) return
    lastDeferredConfig = serialized
    saved = true
    onConfigured?.(config)
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
        {#if embedded && initialManagerId}
          <div class="manager-target">
            <span>Editing existing manager</span>
            <strong>{selectedRecord ? chatLabel(selectedRecord) : 'Manager unavailable'}</strong>
          </div>
        {:else}
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
        {/if}

        {#if selectedRecord}
          <label>
            <span>Manager display name</span>
            <input bind:value={managerTitle} aria-label="Manager display name" />
          </label>
          <div class="row two">
            <label>
              <span>Manager account</span>
              <select aria-label="Manager account" value={managerProfileId} onchange={(event) => chooseManagerProfile((event.target as HTMLSelectElement).value)}>
                {#each availableProfiles as profile (profile.id)}
                  <option value={profile.id}>{profileOptionLabel(profile)} · {profile.provider}</option>
                {/each}
              </select>
              <small>Changing accounts creates a fresh vendor thread, moves the live manager role and complete team hierarchy, and keeps this chat as a stopped snapshot.</small>
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
      {:else}
        <div class="row two">
          <label>
            <span>Manager account</span>
            <select value={managerProfileId} onchange={(event) => chooseManagerProfile((event.target as HTMLSelectElement).value)}>
              {#each availableProfiles as profile (profile.id)}
                <option value={profile.id}>{profileOptionLabel(profile)} · {profile.provider}</option>
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
        <span>Parallel worker target</span>
        <div class="limit">
          <input type="number" min="1" max={maxLiveChildren} bind:value={parallelismTarget} />
          <span>useful worker lanes</span>
        </div>
        <small>The manager is reminded on every turn to reach this target with independent work or cross-checks when useful, and to explain why a narrower task cannot.</small>
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
        {#if operatorTaskStale}
          <small class="warning">This task has not been reviewed for over seven days. Confirm or replace it before relying on it after compaction or restart.</small>
        {/if}
      </label>

      <details class="brief-editor">
        <summary>Edit the full brief and standing rules</summary>
        <p>The orientation is sent at launch. Standing rules are reapplied through the manager's instruction scope on later turns, including after compaction.</p>
        {#if proseProfileReferences.length}
          <p class="warning">Account names ({proseProfileReferences.join(', ')}) appear in editable prose. Live account, model, role, and capability configuration is rendered automatically and overrides this text; remove those references so the brief cannot go stale.</p>
        {/if}
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
            <label class="isolation-group">
              <span>Account isolation group <em>optional</em></span>
              <input value={role.independenceGroup ?? ''} placeholder="e.g. implementation-review" oninput={(event) => updateAgentType(index, { independenceGroup: (event.target as HTMLInputElement).value || undefined })} />
              <small>Roles with the same group are kept on different accounts in the active team, preserving reviewer/implementer independence.</small>
            </label>
            {#if role.selection === 'fixed'}
              {@const roleProfile = availableProfiles.find((profile) => profile.id === role.profileId)}
              <div class="row three">
                <label>
                  <span>Worker account</span>
                  <select value={role.profileId} onchange={(event) => chooseRoleProfile(index, (event.target as HTMLSelectElement).value)}>
                    {#each availableProfiles as profile (profile.id)}
                      <option value={profile.id}>{profileOptionLabel(profile)} · {profile.provider}</option>
                    {/each}
                  </select>
                </label>
                <label>
                  <span>Worker model</span>
                  <select value={role.model} onchange={(event) => updateAgentType(index, { model: (event.target as HTMLSelectElement).value })}>
                    {#each modelsFor(roleProfile?.provider ?? 'codex', roleProfile?.availableModels) as model (model.slug)}
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
                {#each availableProfiles as profile (profile.id)}
                  <label class="usage-profile">
                    <input
                      type="checkbox"
                      checked={role.profileIds?.includes(profile.id) ?? false}
                      onchange={(event) => toggleUsageProfile(index, profile.id, (event.target as HTMLInputElement).checked)}
                    />
                    <ProviderLogo provider={profile.provider} size={14} />
                    <b title={profile.id}>{profileLabel(profile)}</b>
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
            <small>Any descendant in this manager’s hierarchy, and only for actions inside the exact grant ceiling below. Every decision is journaled. Turn this off to route every request to the Overseer/operator. Disabled, unavailable, and out-of-ceiling manager requests automatically escalate for blast-radius review and an explicit operator decision.</small>
          </span>
        </label>
        {#if canApproveChildren}
          <label class="approval-toggle">
            <input type="checkbox" bind:checked={approvalHelperEnabled} />
            <span>
              <b>Use a fast Manager Helper</b>
              <small>Runs one hidden, stateless model review for each in-ceiling request. It has no chat or tools, cannot lower the hubâ€™s risk floor, and wakes the manager whenever it is uncertain or the risk exceeds this policy.</small>
            </span>
          </label>
          {#if approvalHelperEnabled}
            <div class="helper-grid">
              <label>
                <span>Helper account</span>
                <select value={approvalHelperProfileId} onchange={(event) => chooseApprovalHelperProfile((event.target as HTMLSelectElement).value)}>
                  {#each availableProfiles as profile (profile.id)}
                    <option value={profile.id}>{profileOptionLabel(profile)}</option>
                  {/each}
                </select>
              </label>
              <label>
                <span>Fast model</span>
                <select bind:value={approvalHelperModel}>
                  {#each approvalHelperModels as model (model.slug)}<option value={model.slug}>{model.name}</option>{/each}
                </select>
              </label>
              {#if approvalHelperEffortOptions.length}
                <label>
                  <span>Effort</span>
                  <select bind:value={approvalHelperEffort}>
                    {#each approvalHelperEffortOptions as option (option.value)}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                </label>
              {/if}
              <label>
                <span>May decide through</span>
                <select bind:value={approvalHelperMaxRisk}>
                  <option value="low">Low risk only</option>
                  <option value="medium">Low and medium risk</option>
                </select>
              </label>
            </div>
          {/if}
        {/if}
        <label class="approval-toggle">
          <input type="checkbox" bind:checked={pauseExhaustedAccounts} />
          <span>
            <b>Pause dispatch to exhausted accounts</b>
            <small>Stops new child spawns and manager messages at a hard 100% limit. If the provider reports active paid overage or usage credits, dispatch continues.</small>
          </span>
        </label>
        <label class="approval-toggle">
          <input type="checkbox" bind:checked={allowWorkerSubagents} />
          <span>
            <b>Workers may spawn one-shot sub-agents</b>
            <small>Each direct worker may create same-account descendants that inherit its exact permission/tool/Git grant. They appear nested as Name II, Name III, and so on.</small>
          </span>
        </label>
        {#if allowWorkerSubagents}
          <label class="opt row2">Concurrent sub-agents per worker
            <input type="number" min="1" max="8" bind:value={maxSubagentsPerWorker} />
          </label>
        {/if}
      </fieldset>

      <fieldset>
        <legend>Git actions the manager may grant or approve once</legend>
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
        <legend>Capabilities the manager may grant or approve once <em>optional</em></legend>
        <p>Capabilities work across Claude and Codex. Requests outside this list go to the operator or Overseer. Exact custom MCP/plugin tools can still be added below.</p>
        <div class="tool-grid">
          {#each COMMON_CAPABILITIES as capability}
            <label title={capability.detail}><input type="checkbox" checked={allowedTools.includes(capability.id)} onchange={(event) => toggleTool(capability.id, (event.target as HTMLInputElement).checked)} /> {capability.label}</label>
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
        <div><dt>Parallel target</dt><dd>{parallelismTarget} useful worker lanes when the task supports them</dd></div>
        <div><dt>Child permission ceiling</dt><dd>{maxChildPermissionMode}</dd></div>
        <div><dt>Worker approvals</dt><dd>{canApproveChildren ? 'manager decides in-ceiling; broader requests escalate to Overseer/operator' : 'all requests escalate to Overseer/operator'}</dd></div>
        {#if canApproveChildren && approvalHelperEnabled}
          <div><dt>Manager Helper</dt><dd>{approvalHelperProfileId} · {approvalHelperModel || 'default model'} · through {approvalHelperMaxRisk} risk; uncertainty wakes manager</dd></div>
        {/if}
        <div><dt>Exhausted accounts</dt><dd>{pauseExhaustedAccounts ? 'pause new spawns and messages unless credits/overage are active' : 'no manager-specific dispatch pause'}</dd></div>
        <div><dt>Worker sub-agents</dt><dd>{allowWorkerSubagents ? `up to ${maxSubagentsPerWorker} one-shot descendants per worker` : 'disabled'}</dd></div>
        <div><dt>Worker Git grants</dt><dd>{delegationLabel()}</dd></div>
        <div><dt>Tool approval/grant ceiling</dt><dd>{allowedTools.length ? allowedTools.join(', ') : 'none'}</dd></div>
        <div>
          <dt>Visibility</dt>
          <dd>Full activity, transcript, approvals, changes, and worktree state for its own managed hierarchy, and only that hierarchy.</dd>
        </div>
      </dl>
      <p class="audit"><Icon name="history" size={13} /> Grants, changes, use, role selection, and revocations are journaled.</p>

      {#if error}<p class="error">{error}</p>{/if}
      {#if embedded && deferLaunch}
        <div class="included">
          <b>{saved ? 'Included in project launch' : 'Finish the required manager fields'}</b>
          <span>{saved ? 'Changes here update the launch automatically.' : 'The project will not launch until this manager configuration is valid.'}</span>
        </div>
      {:else}
      <button class="primary" disabled={busy || (mode === 'promote' && !selectedRecord)} onclick={grant}>
        {busy
          ? stayInProject ? 'Saving…' : 'Launching…'
          : isActiveManager || saved
              ? stayInProject ? 'Save manager settings' : 'Update granted scope'
              : mode === 'create'
                ? 'Create and launch manager'
                : 'Make this chat a manager and launch'}
      </button>
      {/if}
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
  .manager-target { display: grid; gap: .2rem; padding: .7rem .8rem; border: 1px solid var(--border-accent);
    border-radius: var(--r-md); background: color-mix(in srgb, var(--accent) 8%, var(--surface-2)); }
  .manager-target span { color: var(--dim); font-size: var(--text-xs); }
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
  .included { display: grid; gap: .18rem; padding: .65rem .75rem; border: 1px solid var(--border-accent);
    border-radius: var(--r-md); background: color-mix(in srgb, var(--accent) 10%, var(--surface-2)); }
  .included span { color: var(--dim); font-size: var(--text-xs); }
  .grant-state b { font-size: .75rem; }
  .grant-state span { color: var(--dim); font-size: .7rem; }
  .choices, .tool-grid { display: flex; flex-wrap: wrap; gap: .5rem .8rem; }
  .helper-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .55rem; margin: .65rem 0 .8rem 1.55rem; padding: .7rem; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
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
    .body, .row.two, .row.three, .helper-grid { grid-template-columns: 1fr; }
    .setup { border-right: 0; border-bottom: 1px solid var(--border); }
    aside { position: static; }
    .project-choice, .custom-tool { grid-template-columns: 1fr; flex-direction: column; }
  }
</style>
