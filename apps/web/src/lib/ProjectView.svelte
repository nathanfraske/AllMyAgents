<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api, type WorktreeProjectActivity } from './api'
  import { store, type SessionView, type ThreadItem } from './store.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import DeleteProjectDialog from './DeleteProjectDialog.svelte'
  import TaskStrip from './TaskStrip.svelte'
  import ThreadView from './ThreadView.svelte'
  import { agentActivity } from './toolBlurb'
  import {
    loadProjectViewMode,
    loadProjectTranscriptPeek,
    saveProjectTranscriptPeek,
    saveProjectViewMode,
    type ProjectViewMode,
  } from './uiState'

  let { projectId }: { projectId: string } = $props()

  let activity = $state<WorktreeProjectActivity | null>(null)
  let activityError = $state(false)
  let activityTimer: ReturnType<typeof setInterval> | null = null
  let selectedMode = $state<ProjectViewMode>('overview')
  let peekOpen = $state(true)
  let modeProjectId = $state('')
  let deleteDialogOpen = $state(false)

  $effect.pre(() => {
    if (modeProjectId === projectId) return
    modeProjectId = projectId
    selectedMode = loadProjectViewMode(projectId)
    peekOpen = loadProjectTranscriptPeek(projectId)
  })

  const project = $derived(store.projects.find((candidate) => candidate.id === projectId))
  const projectSessions = $derived(
    store.sessionList.filter((view) => view.record.projectId === projectId),
  )
  const manager = $derived(
    projectSessions.find((view) => view.record.isProjectManager),
  )
  const mode = $derived<ProjectViewMode>(manager ? selectedMode : 'overview')
  const directProjectCount = $derived(
    projectSessions.filter((view) => !view.record.worktree).length,
  )

  function selectMode(next: ProjectViewMode): void {
    selectedMode = next
    saveProjectViewMode(projectId, next)
  }

  function toggleTranscriptPeek(): void {
    peekOpen = !peekOpen
    saveProjectTranscriptPeek(projectId, peekOpen)
  }

  $effect(() => {
    const id = projectId
    let current = true
    const refresh = async (): Promise<void> => {
      const next = await api.projectActivity(id).catch(() => null)
      if (!current) return
      if (next && !('error' in next)) {
        activity = next
        activityError = false
      } else {
        activityError = true
      }
    }
    void refresh()
    activityTimer = setInterval(() => void refresh(), 2_500)
    return () => {
      current = false
      if (activityTimer) clearInterval(activityTimer)
      activityTimer = null
    }
  })

  onDestroy(() => {
    if (activityTimer) clearInterval(activityTimer)
  })

  type ProjectStatus = 'working' | 'idle' | 'done' | 'failed' | 'blocked'
  interface AgentRow {
    view: SessionView
    depth: number
  }

  function projectStatus(view: SessionView): ProjectStatus {
    if (store.approvals.some((approval) => approval.sessionId === view.record.id)) return 'blocked'
    if (view.record.status === 'active' || view.record.status === 'starting') return 'working'
    if (view.record.status === 'error' || view.lastTurnOk === false) return 'failed'
    if (view.record.status === 'stopped' || view.lastTurnOk === true) return 'done'
    return 'idle'
  }

  function statusLabel(status: ProjectStatus): string {
    return status === 'blocked' ? 'blocked on approval' : status
  }

  function agentName(view: SessionView): string {
    const resolved = store.sessionLabel(view.record.id).trim()
    if (view.record.title?.trim()) return resolved || view.record.title.trim()
    // Legacy/malformed worktree records can fall back to their UUID-shaped checkout directory. That is
    // technically the sidebar resolver's answer, but not a human identity; keep the fallback useful.
    if (!resolved || view.record.id.startsWith(resolved) || resolved.startsWith(view.record.id.slice(0, 8))) {
      return view.record.provider === 'codex' ? 'Codex agent' : 'Claude agent'
    }
    return resolved
  }

  function agentRole(view: SessionView): string | undefined {
    const role = view.record.role?.trim() || (view.record.isProjectManager ? 'Project manager' : undefined)
    return role && role.localeCompare(agentName(view), undefined, { sensitivity: 'accent' }) !== 0
      ? role
      : undefined
  }

  const statusCounts = $derived.by(() => {
    const counts: Record<ProjectStatus, number> = {
      working: 0,
      idle: 0,
      done: 0,
      failed: 0,
      blocked: 0,
    }
    for (const view of projectSessions) counts[projectStatus(view)]++
    return counts
  })

  const agentRows = $derived.by(() => {
    const rows: AgentRow[] = []
    const used = new Set<string>()
    const byParent = new Map<string, SessionView[]>()
    for (const view of projectSessions) {
      const parent = view.record.parentSessionId
      if (!parent) continue
      const children = byParent.get(parent) ?? []
      children.push(view)
      byParent.set(parent, children)
    }
    const add = (view: SessionView, depth: number): void => {
      if (used.has(view.record.id)) return
      used.add(view.record.id)
      rows.push({ view, depth })
      for (const child of byParent.get(view.record.id) ?? []) add(child, depth + 1)
    }
    for (const manager of projectSessions.filter((view) => view.record.isProjectManager)) add(manager, 0)
    for (const view of projectSessions) add(view, 0)
    return rows
  })

  const filesBySession = $derived.by(() => {
    const files = new Map<string, WorktreeProjectActivity['agents'][number]>()
    for (const agent of activity?.agents ?? []) files.set(agent.sessionId, agent)
    return files
  })

  interface CollisionGroup {
    file: string
    sessionIds: string[]
  }

  function riskPathKey(file: string): string {
    return file.replaceAll('\\', '/').toLocaleLowerCase()
  }

  function isTestPath(file: string): boolean {
    const normalized = riskPathKey(file)
    return (
      /(?:^|\/)(?:test|tests|__tests__|fixtures?)(?:\/|$)/.test(normalized) ||
      /\.(?:test|spec)\.[^/]+$/.test(normalized)
    )
  }

  const collisionGroups = $derived.by(() => {
    const byFile = new Map<string, CollisionGroup>()
    for (const risk of activity?.risks ?? []) {
      if (risk.risk !== 'concurrent-write') continue
      const key = riskPathKey(risk.file)
      const group = byFile.get(key) ?? { file: risk.file, sessionIds: [] }
      group.sessionIds = [...new Set([...group.sessionIds, ...risk.sessionIds])]
      byFile.set(key, group)
    }
    return [...byFile.values()].sort((left, right) => {
      const participants = right.sessionIds.length - left.sessionIds.length
      if (participants) return participants
      const testRank = Number(isTestPath(left.file)) - Number(isTestPath(right.file))
      return testRank || left.file.localeCompare(right.file)
    })
  })

  const staleRisks = $derived(
    (activity?.risks ?? []).filter((risk) => risk.risk === 'stale-base'),
  )

  function collisionAgents(sessionIds: string[]): string {
    const names = sessionIds
      .map((id) => label(store.sessions[id], id.slice(0, 8)))
      .sort((left, right) => left.localeCompare(right))
    if (names.length < 3) return names.join(' and ')
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  }

  interface CommRow {
    key: string
    ts: string
    source: string
    target: string
    subject?: string
    text?: string
  }

  function label(view: SessionView | undefined, fallback?: string): string {
    return view ? agentName(view) : fallback || 'a teammate'
  }

  function activityInput(item: ThreadItem): Record<string, unknown> | undefined {
    const raw =
      item.toolInput && typeof item.toolInput === 'object' && !Array.isArray(item.toolInput)
        ? (item.toolInput as Record<string, unknown>)
        : undefined
    const nested = raw?.arguments
    return nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : raw
  }

  const comms = $derived.by(() => {
    const rows: CommRow[] = []
    const projectIds = new Set(projectSessions.map((view) => view.record.id))
    const byId = (id: string | undefined): SessionView | undefined => (id ? store.sessions[id] : undefined)
    const duplicate = (candidate: CommRow): boolean =>
      rows.some(
        (row) =>
          row.source === candidate.source &&
          row.target === candidate.target &&
          row.text === candidate.text &&
          row.subject === candidate.subject &&
          Math.abs(Date.parse(row.ts) - Date.parse(candidate.ts)) < 5_000,
      )

    for (const view of projectSessions) {
      const sourceName = label(view)
      const hasCanonicalSentBus = view.items.some(
        (item) => item.kind === 'bus' && item.busDir === 'sent',
      )
      for (const item of view.items) {
        if (item.kind === 'bus') {
          const sent = item.busDir === 'sent'
          const sourceId = sent ? view.record.id : item.busPeerId
          const targetId = sent ? item.busPeerId : view.record.id
          // Inbound traffic from a deleted/external teammate is useful. Inbound duplicates of a sent
          // row collapse below, so one message reads as one project event rather than two journal facts.
          const row: CommRow = {
            key: `${view.record.id}:${item.key}`,
            ts: item.ts,
            source: sent ? sourceName : label(byId(sourceId), item.busPeer),
            target: targetId
              ? label(byId(targetId), item.busPeer)
              : item.busPeer || (sent ? 'project team' : sourceName),
            subject: item.busSubject,
            text: item.text,
          }
          if (!duplicate(row)) rows.push(row)
          continue
        }

        // Older/imported rows may only carry the vendor tool call. Reuse the same classifier as the
        // transcript rather than teaching the dashboard another set of bus tool names.
        if (hasCanonicalSentBus) continue
        const agent = agentActivity(item, (id) => label(byId(id)))
        if (!agent || agent.dir !== 'out') continue
        const input = activityInput(item)
        const targetId =
          typeof input?.to_session === 'string' ? input.to_session : agent.counterpartyId
        if (targetId && !projectIds.has(targetId)) continue
        const row: CommRow = {
          key: `${view.record.id}:${item.key}:tool`,
          ts: item.ts,
          source: sourceName,
          target: targetId ? label(byId(targetId)) : 'project team',
          text: typeof input?.body === 'string' ? input.body : undefined,
        }
        if (!duplicate(row)) rows.push(row)
      }
    }
    return rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 40)
  })

  function openChat(id: string): void {
    store.select(id)
  }

  function timeOf(ts: string): string {
    const parsed = new Date(ts)
    return Number.isNaN(parsed.getTime())
      ? ''
      : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
</script>

<section
  class="project-view"
  data-tutorial-anchor="project-view"
  class:manager-mode={mode === 'manager'}
  aria-label={project ? `${project.name} project ${mode}` : 'Project overview'}
>
  {#if !project}
    <div class="empty hero">
      <h1>Project unavailable</h1>
      <p>This project is no longer in the roster.</p>
    </div>
  {:else}
    <header class="project-head">
      <div>
        <div class="eyebrow">{mode === 'manager' ? 'Manager conversation' : 'Project overview'}</div>
        <h1>{project.name}</h1>
        <div class="path" title={project.path}>{project.path}</div>
      </div>
      <div class="head-actions">
        {#if manager}
          <div class="view-toggle" role="group" aria-label="Project view">
            <button
              class:active={mode === 'overview'}
              aria-pressed={mode === 'overview'}
              onclick={() => selectMode('overview')}
            >Overview</button>
            <button
              class:active={mode === 'manager'}
              aria-pressed={mode === 'manager'}
              onclick={() => selectMode('manager')}
            >Manager</button>
          </div>
        {/if}
        <div class="summary" aria-label="Team status summary">
          <span><strong>{projectSessions.length}</strong> agents</span>
          {#if statusCounts.working}<span class="working">{statusCounts.working} working</span>{/if}
          {#if statusCounts.blocked}<span class="blocked">{statusCounts.blocked} blocked</span>{/if}
          {#if statusCounts.failed}<span class="failed">{statusCounts.failed} failed</span>{/if}
        </div>
        {#if !project.siteId}
          <button class="delete-project" onclick={() => (deleteDialogOpen = true)}>Delete project…</button>
        {/if}
      </div>
    </header>

    {#if mode === 'manager' && manager}
      <div class="manager-thread" aria-label={`${agentName(manager)} manager conversation`}>
        <ThreadView
          sessionId={manager.record.id}
          embedded
          composerLabel={`Message ${agentName(manager)}`}
        />
      </div>
    {:else}
    {#if collisionGroups.length}
      <section class="risks collision-risks" aria-label="Worktree collision risks">
        <details class="risk-fold">
          <summary class="risk-summary">
            <span class="risk-mark" aria-hidden="true">!</span>
            <span class="risk-summary-copy">
              <strong>{collisionGroups.length} file collision{collisionGroups.length === 1 ? '' : 's'}</strong>
              <span>
                Worst: {collisionGroups[0]!.sessionIds.length} agents in {collisionGroups[0]!.file}
              </span>
            </span>
            <span class="fold-hint">Review contention</span>
          </summary>
          <div class="risk-list">
            {#each collisionGroups as risk (riskPathKey(risk.file))}
              <article class="risk">
                <span class="risk-kind">{risk.sessionIds.length} agents</span>
                <span class="risk-file">{risk.file}</span>
                <span class="risk-detail">{collisionAgents(risk.sessionIds)} are changing this file</span>
              </article>
            {/each}
          </div>
        </details>
      </section>
    {/if}

    {#if staleRisks.length}
      <section class="risks stale-risks" aria-label="Stale worktree risks">
        {#each staleRisks as risk (`${risk.file}:${risk.sessionIds.join(':')}`)}
          <article class="risk">
            <span class="risk-kind">Stale base</span>
            <span class="risk-file">{risk.file}</span>
            <span class="risk-detail">
              {label(store.sessions[risk.sessionIds[0]], risk.sessionIds[0]?.slice(0, 8))}
              is {risk.commitsBehind} commit{risk.commitsBehind === 1 ? '' : 's'} behind
            </span>
          </article>
        {/each}
      </section>
    {/if}

    <div class="dashboard-grid">
      <section class="card team">
        <div class="section-head">
          <div>
            <h2>Team</h2>
            <p>Live session state and changed files</p>
          </div>
          {#if activityError}
            <span class="monitor-error">Worktree activity could not be loaded</span>
          {:else if directProjectCount}
            <span
              class="monitor-note"
              title="The collision detector reads isolated git worktrees; agents working in the shared project folder have no separate checkout to inspect."
            >Worktree changes only · direct-project agents are not tracked</span>
          {/if}
        </div>

        {#if agentRows.length === 0}
          <div class="empty">
            <strong>No agents yet</strong>
            <span>Launched agents will appear here with their real session status.</span>
          </div>
        {:else}
          <div class="agent-list">
            {#each agentRows as row (row.view.record.id)}
              {@const view = row.view}
              {@const status = projectStatus(view)}
              {@const fileActivity = filesBySession.get(view.record.id)}
              <article class="agent" class:child={row.depth > 0} style={`--depth:${row.depth}`}>
                <button
                  class="agent-main"
                  aria-label={`Open ${agentName(view)} chat`}
                  onclick={() => openChat(view.record.id)}
                >
                  <ProviderLogo provider={view.record.provider} size={18} />
                  <span class="agent-title">
                    <span class="name">{agentName(view)}</span>
                    <span class="meta">
                      {#if agentRole(view)}
                        <span>{agentRole(view)}</span><span aria-hidden="true">·</span>
                      {/if}
                      <span>{view.record.model || view.record.profileId}</span>
                    </span>
                  </span>
                  <span class="state {status}"><span class="dot"></span>{statusLabel(status)}</span>
                </button>

                <div class="files">
                  {#if fileActivity?.files.length}
                    <details class="file-fold">
                      <summary class="files-summary">
                        {fileActivity.files.length} file{fileActivity.files.length === 1 ? '' : 's'} being worked on
                      </summary>
                      <div class="file-list">
                    {#each fileActivity.files as changed (changed.file)}
                      <span class="file" title={`${fileActivity.worktree}\n${changed.kind}`}>
                        {changed.file}
                        {#if changed.kind !== 'uncommitted'}<em>{changed.kind}</em>{/if}
                      </span>
                    {/each}
                      </div>
                    </details>
                  {:else if !view.record.worktree}
                    <span class="file-empty" title={view.record.cwd}>Works directly in the project</span>
                  {:else if !activity}
                    <span class="file-empty">Checking worktree…</span>
                  {:else}
                    <span class="file-empty">No active file changes</span>
                  {/if}
                </div>

                <TaskStrip items={view.items} />
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <section class="card comms">
        <div class="section-head">
          <div>
            <h2>Comms bus</h2>
            <p>Project-wide teammate traffic</p>
          </div>
        </div>

        {#if comms.length === 0}
          <div class="empty">
            <strong>Quiet right now</strong>
            <span>Messages between teammates will collect here.</span>
          </div>
        {:else}
          <ol class="comms-list">
            {#each comms as message (message.key)}
              <li>
                <div class="comm-top">
                  <strong>{message.source} → {message.target}</strong>
                  <time datetime={message.ts}>{timeOf(message.ts)}</time>
                </div>
                {#if message.subject}<div class="subject">{message.subject}</div>{/if}
                {#if message.text}<p>{message.text}</p>{/if}
              </li>
            {/each}
          </ol>
        {/if}
      </section>
    </div>

    {#if manager}
      <section class="card manager-steer" aria-label={`Message ${agentName(manager)}`}>
        <div class="section-head">
          <div>
            <h2>Steer {agentName(manager)}</h2>
            <p>Message the project manager here, including while a turn is running</p>
          </div>
          <div class="steer-controls">
            <span class="state {projectStatus(manager)}">
              <span class="dot"></span>{statusLabel(projectStatus(manager))}
            </span>
            <button
              class="peek-toggle"
              aria-label={`${peekOpen ? 'Hide' : 'Show'} recent manager activity`}
              aria-expanded={peekOpen}
              onclick={toggleTranscriptPeek}
            >{peekOpen ? 'Hide activity' : 'Show activity'}</button>
          </div>
        </div>
        <div class="manager-composer">
          <ThreadView
            sessionId={manager.record.id}
            composerOnly
            peekItems={peekOpen ? 4 : 0}
            composerLabel={`Message ${agentName(manager)}`}
          />
        </div>
      </section>
    {/if}
    {/if}
  {/if}
</section>

{#if project && deleteDialogOpen}
  <DeleteProjectDialog
    {project}
    onclose={() => (deleteDialogOpen = false)}
    ondelete={(deleteFiles) => store.deleteProject(project.id, deleteFiles)}
  />
{/if}

<style>
  .project-view { box-sizing: border-box; width: 100%; min-width: 0; height: 100%; overflow: hidden auto;
    padding: clamp(1rem, 2.5vw, 2rem); background: var(--bg); }
  .project-view.manager-mode { display: flex; flex-direction: column; overflow: hidden; }
  .project-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem;
    max-width: 1400px; margin: 0 auto 1rem; }
  .manager-mode .project-head { width: 100%; flex: none; }
  .eyebrow { color: var(--accent); font-size: var(--text-2xs); font-weight: var(--fw-semibold);
    letter-spacing: var(--ls-label); text-transform: uppercase; }
  h1 { margin: .18rem 0; font-size: clamp(1.45rem, 3vw, 2.15rem); line-height: 1.1; }
  .path { max-width: min(720px, 100%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); }
  .summary { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .4rem; color: var(--muted);
    font-size: var(--text-xs); }
  .head-actions { display: flex; flex-direction: column; align-items: flex-end; gap: .55rem; }
  .delete-project { color: var(--dim); font-size: var(--text-2xs); text-decoration: underline;
    text-underline-offset: .18rem; }
  .delete-project:hover { color: var(--bad-text); }
  .view-toggle { display: grid; grid-template-columns: 1fr 1fr; padding: 3px; border: 1px solid var(--border);
    border-radius: var(--r-lg); background: var(--surface-2); box-shadow: var(--edge-hi); }
  .view-toggle button { min-width: 7rem; padding: .42rem .75rem; border-radius: calc(var(--r-lg) - 3px);
    color: var(--muted); font-size: var(--text-xs); font-weight: var(--fw-medium); }
  .view-toggle button:hover { color: var(--text); }
  .view-toggle button.active { color: var(--text); background: var(--surface);
    box-shadow: var(--shadow-1), inset 0 0 0 1px var(--border-strong); }
  .summary span { padding: .3rem .55rem; border: 1px solid var(--border); border-radius: var(--r-pill);
    background: var(--surface); }
  .summary .blocked, .summary .failed { color: var(--red); border-color: color-mix(in srgb, var(--red) 35%, var(--border)); }
  .summary .working { color: var(--accent); }
  .risks { max-width: 1400px; margin: 0 auto 1rem; display: grid; gap: .45rem; }
  .risk-fold { overflow: hidden; border: 1px solid color-mix(in srgb, var(--red) 52%, var(--border));
    border-radius: var(--r-lg); background: color-mix(in srgb, var(--red) 8%, var(--surface)); }
  .risk-summary { display: flex; align-items: center; gap: .7rem; padding: .7rem .8rem; cursor: pointer;
    list-style: none; }
  .risk-summary::-webkit-details-marker { display: none; }
  .risk-mark { display: grid; place-items: center; width: 1.35rem; height: 1.35rem; flex: none;
    border-radius: 50%; color: var(--surface); background: var(--red); font-size: var(--text-xs);
    font-weight: var(--fw-semibold); }
  .risk-summary-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: .12rem; }
  .risk-summary-copy strong { color: var(--red); font-size: var(--text-sm); }
  .risk-summary-copy span { overflow: hidden; color: var(--muted); font-family: var(--mono);
    font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
  .fold-hint { flex: none; color: var(--red); font-size: var(--text-2xs); font-weight: var(--fw-medium); }
  .risk-fold[open] .risk-summary { border-bottom: 1px solid color-mix(in srgb, var(--red) 28%, var(--border)); }
  .risk-list { display: grid; }
  .risk { display: grid; grid-template-columns: auto minmax(100px, auto) 1fr; align-items: center; gap: .65rem;
    padding: .65rem .8rem; border: 1px solid color-mix(in srgb, var(--red) 44%, var(--border));
    border-radius: var(--r-lg); background: color-mix(in srgb, var(--red) 7%, var(--surface)); }
  .risk-list .risk { border: 0; border-top: 1px solid var(--border-subtle); border-radius: 0;
    background: transparent; }
  .risk-list .risk:first-child { border-top: 0; }
  .risk-kind { color: var(--red); font-size: var(--text-2xs); font-weight: var(--fw-semibold);
    letter-spacing: var(--ls-label); text-transform: uppercase; }
  .risk-file { font-family: var(--mono); font-size: var(--text-xs); font-weight: var(--fw-medium); }
  .risk-detail { color: var(--muted); font-size: var(--text-xs); }
  .dashboard-grid { max-width: 1400px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(300px, .85fr);
    align-items: start; gap: 1rem; }
  .card { min-width: 0; border: 1px solid var(--border); border-radius: var(--r-xl); background: var(--surface);
    box-shadow: var(--edge-hi); overflow: hidden; }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: .8rem 1rem; border-bottom: 1px solid var(--border-subtle); }
  h2 { margin: 0; font-size: var(--text-md); }
  .section-head p { margin: .15rem 0 0; color: var(--muted); font-size: var(--text-xs); }
  .monitor-error { color: var(--red); font-size: var(--text-2xs); }
  .monitor-note { max-width: 270px; color: var(--dim); font-size: var(--text-2xs); text-align: right; }
  .agent-list { display: flex; flex-direction: column; }
  .agent { padding: .65rem .8rem .7rem; border-top: 1px solid var(--border-subtle);
    margin-left: calc(var(--depth) * 1rem); }
  .agent:first-child { border-top: 0; }
  .agent.child { position: relative; }
  .agent.child::before { content: ''; position: absolute; left: -.45rem; top: 0; bottom: 0;
    border-left: 1px solid var(--border-strong); }
  .agent-main { display: flex; align-items: center; gap: .55rem; width: 100%; padding: 0; color: inherit;
    background: none; border: 0; text-align: left; cursor: pointer; }
  .agent-main:hover .name { color: var(--accent); }
  .agent-title { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm);
    font-weight: var(--fw-semibold); }
  .meta { display: flex; align-items: center; gap: .35rem; overflow: hidden; color: var(--dim); font-size: var(--text-2xs); }
  .state { display: inline-flex; align-items: center; gap: .35rem; flex: none; color: var(--muted);
    font-size: var(--text-2xs); white-space: nowrap; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .state.working { color: var(--accent); }
  .state.done { color: var(--green, #2e9e63); }
  .state.failed, .state.blocked { color: var(--red); }
  .files { display: flex; flex-wrap: wrap; gap: .3rem; margin: .55rem 0 .05rem 1.45rem; }
  .file-fold { width: 100%; min-width: 0; }
  .files-summary { width: fit-content; cursor: pointer; color: var(--muted); font-size: var(--text-2xs);
    font-weight: var(--fw-medium); }
  .files-summary:hover { color: var(--accent); }
  .file-fold[open] .files-summary { margin-bottom: .4rem; }
  .file-list { display: flex; flex-wrap: wrap; gap: .3rem; }
  .file { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: .2rem .4rem;
    border: 1px solid var(--border-subtle); border-radius: var(--r-sm); background: var(--surface-2);
    font-family: var(--mono); font-size: var(--text-2xs); }
  .file em { margin-left: .35rem; color: var(--muted); font-family: inherit; font-style: normal; }
  .file-empty { color: var(--dim); font-size: var(--text-2xs); }
  .agent :global(.strip) { margin: .55rem 0 0 1.45rem; background: var(--surface-2); }
  .comms-list { list-style: none; margin: 0; padding: 0; max-height: min(70vh, 760px); overflow: auto; }
  .comms-list li { padding: .7rem .85rem; border-top: 1px solid var(--border-subtle); }
  .comms-list li:first-child { border-top: 0; }
  .comm-top { display: flex; justify-content: space-between; gap: .7rem; font-size: var(--text-xs); }
  .comm-top strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  time { flex: none; color: var(--dim); font-family: var(--mono); font-size: var(--text-2xs); }
  .subject { margin-top: .25rem; color: var(--accent); font-size: var(--text-2xs); }
  .comms-list p { display: -webkit-box; margin: .22rem 0 0; overflow: hidden; color: var(--muted);
    font-size: var(--text-xs); line-height: 1.4; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; }
  .manager-steer { max-width: 1400px; margin: 1rem auto 0; }
  .manager-composer { padding: .75rem; }
  .steer-controls { display: flex; align-items: center; gap: .65rem; }
  .peek-toggle { padding: .3rem .55rem; border: 1px solid var(--border); border-radius: var(--r-md);
    color: var(--muted); font-size: var(--text-2xs); white-space: nowrap; }
  .peek-toggle:hover { color: var(--text); border-color: var(--border-strong); }
  .manager-thread { flex: 1; width: 100%; min-height: 0; max-width: 1400px; margin: 0 auto;
    border: 1px solid var(--border); border-radius: var(--r-xl); background: var(--surface);
    box-shadow: var(--edge-hi); overflow: hidden; display: flex; flex-direction: column; }
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .25rem;
    min-height: 125px; padding: 1.5rem; color: var(--muted); text-align: center; font-size: var(--text-xs); }
  .empty strong { color: var(--text); font-size: var(--text-sm); }
  .hero { height: 100%; }
  .hero h1, .hero p { margin: 0; }
  @media (max-width: 900px) {
    .dashboard-grid { grid-template-columns: 1fr; }
    .project-head { align-items: flex-start; flex-direction: column; }
    .head-actions { align-items: flex-start; }
    .summary { justify-content: flex-start; }
  }
  @media (max-width: 560px) {
    .project-view { padding: .75rem; }
    .risk { grid-template-columns: 1fr; gap: .2rem; }
    .risk-detail { margin-top: .2rem; }
    .state { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    .view-toggle { width: 100%; }
    .view-toggle button { min-width: 0; }
    .monitor-note { max-width: 180px; }
  }
</style>
