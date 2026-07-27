<script lang="ts">
  import { api, type SessionRecord } from './api'
  import { modelsFor } from './catalog'
  import Icon from './Icon.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import { store } from './store.svelte'

  let { onclose }: { onclose: () => void } = $props()

  type Mode = 'promote' | 'create'
  type Authority = 'commit' | 'push'

  const eligibleChats = $derived(
    store.sessionList.filter(
      (view) => !view.record.siteId && !view.record.parentSessionId && Boolean(view.record.projectId),
    ),
  )
  const firstEligibleId = (): string =>
    store.sessionList.find(
      (view) => !view.record.siteId && !view.record.parentSessionId && Boolean(view.record.projectId),
    )?.record.id ?? ''
  let mode = $state<Mode>(store.managerSetupSessionId ? 'promote' : 'create')
  let selectedId = $state(store.managerSetupSessionId ?? firstEligibleId())
  let projectId = $state('')
  let managerProfileId = $state(store.defaultProfileId() ?? '')
  let allowedProfiles = $state<string[]>([])
  let allowedModels = $state<Record<string, string[]>>({})
  let maxLiveChildren = $state(4)
  let delegation = $state<Authority[]>([])
  let allowedToolsText = $state('')
  let busy = $state(false)
  let error = $state('')
  let saved = $state(false)

  const selectedRecord = $derived(selectedId ? store.sessions[selectedId]?.record : undefined)
  const project = $derived(store.projects.find((item) => item.id === projectId))
  const isActiveManager = $derived(selectedRecord?.isProjectManager === true)

  function resetGrantDefaults(): void {
    allowedProfiles = managerProfileId ? [managerProfileId] : []
    allowedModels = {}
    maxLiveChildren = 4
    delegation = []
    allowedToolsText = ''
    error = ''
    saved = false
  }

  function loadChat(id: string): void {
    selectedId = id
    const record = store.sessions[id]?.record
    if (!record) return
    projectId = record.projectId ?? ''
    managerProfileId = record.profileId
    allowedProfiles = [...(record.managerAllowedProfiles ?? [record.profileId])]
    allowedModels = Object.fromEntries(
      Object.entries(record.managerAllowedModels ?? {}).map(([profileId, models]) => [profileId, [...models]]),
    )
    maxLiveChildren = record.managerMaxLiveChildren ?? 4
    delegation = [...(record.managerDelegation ?? [])]
    allowedToolsText = (record.managerAllowedTools ?? []).join(', ')
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
    projectId = store.projects[0]?.id ?? ''
    managerProfileId = store.defaultProfileId() ?? ''
    resetGrantDefaults()
  }

  function toggleProfile(profileId: string, enabled: boolean): void {
    allowedProfiles = enabled
      ? [...new Set([...allowedProfiles, profileId])]
      : allowedProfiles.filter((id) => id !== profileId)
    if (!enabled) {
      const { [profileId]: _removed, ...rest } = allowedModels
      allowedModels = rest
    }
  }

  function toggleModel(profileId: string, model: string, enabled: boolean): void {
    const current = allowedModels[profileId] ?? []
    allowedModels = {
      ...allowedModels,
      [profileId]: enabled
        ? [...new Set([...current, model])]
        : current.filter((slug) => slug !== model),
    }
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

  function profileScope(profileId: string): string {
    const profile = store.profiles.find((item) => item.id === profileId)
    const models = allowedModels[profileId] ?? []
    return `${profileId} · ${models.length ? models.join(', ') : `${profile?.provider ?? 'account'} default model`}`
  }

  function chatLabel(record: SessionRecord): string {
    return record.title || record.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || record.id.slice(0, 8)
  }

  async function grant(): Promise<void> {
    error = ''
    if (!projectId) {
      error = 'Choose the project this manager will oversee.'
      return
    }
    if (allowedProfiles.length === 0) {
      error = 'Choose at least one worker account.'
      return
    }
    if (!Number.isInteger(maxLiveChildren) || maxLiveChildren < 1 || maxLiveChildren > 16) {
      error = 'The live child limit must be from 1 to 16.'
      return
    }
    busy = true
    try {
      let record = selectedRecord
      if (mode === 'create') {
        if (!managerProfileId) throw new Error('Choose the account that will run the manager.')
        const created = await api.spawn({
          profileId: managerProfileId,
          projectId,
          useWorktree: false,
          permissionMode: 'safe',
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
      const configured = await api.configureProjectManager(record.id, {
        enabled: true,
        maxLiveChildren,
        delegation,
        allowedProfiles,
        allowedModels,
        allowedTools: allowedToolsText.split(',').map((value) => value.trim()).filter(Boolean),
      })
      if ('error' in configured) throw new Error(configured.error)
      store.upsertSessionRecord(configured)
      selectedId = configured.id
      mode = 'promote'
      saved = true
      store.select(configured.id)
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
    if (event.key === 'Escape') onclose()
  }

  let initialized = false
  $effect(() => {
    if (initialized) return
    initialized = true
    if (selectedId) loadChat(selectedId)
    else chooseMode('create')
  })
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="button" tabindex="-1" onclick={onclose} onkeydown={() => {}}></div>
<div class="manager-modal" role="dialog" aria-modal="true" aria-label="Project managers">
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
        <label>
          <span>Manager account</span>
          <select bind:value={managerProfileId} onchange={resetGrantDefaults}>
            {#each store.profiles as profile (profile.id)}
              <option value={profile.id}>{profile.id} · {profile.provider}</option>
            {/each}
          </select>
        </label>
      {/if}

      <div class="field">
        <span class="field-label">Project</span>
        {#if mode === 'promote'}
          <div class="fixed-value"><Icon name="folder" size={14} />{project?.name ?? 'No project'}</div>
        {:else}
          <select bind:value={projectId}>
            <option value="" disabled>Choose a project</option>
            {#each store.projects as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
          </select>
        {/if}
        <small>The manager and every worker it creates stay attached to this project.</small>
      </div>

      <div class="field">
        <span class="field-label">Worker accounts &amp; models</span>
        <div class="profiles">
          {#each store.profiles as profile (profile.id)}
            <div class="profile" class:chosen={allowedProfiles.includes(profile.id)}>
              <label class="profile-head">
                <input
                  type="checkbox"
                  checked={allowedProfiles.includes(profile.id)}
                  onchange={(event) => toggleProfile(profile.id, (event.target as HTMLInputElement).checked)}
                />
                <ProviderLogo provider={profile.provider} size={14} />
                <b>{profile.id}</b><span>{profile.provider}</span>
              </label>
              {#if allowedProfiles.includes(profile.id)}
                <div class="models">
                  <span>Default model is always available</span>
                  {#each modelsFor(profile.provider).slice(0, 4) as model (model.slug)}
                    <label>
                      <input
                        type="checkbox"
                        checked={allowedModels[profile.id]?.includes(model.slug) ?? false}
                        onchange={(event) => toggleModel(profile.id, model.slug, (event.target as HTMLInputElement).checked)}
                      />
                      {model.name}
                    </label>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>

      <label>
        <span>Live child limit</span>
        <div class="limit">
          <input type="number" min="1" max="16" bind:value={maxLiveChildren} />
          <span>agents at once</span>
        </div>
        <small>The hub refuses another spawn when this bound is reached.</small>
      </label>

      <fieldset>
        <legend>Delegated Git actions</legend>
        <p>The manager may hand these actions to a worker as part of its brief.</p>
        <div class="choices">
          <label><input type="checkbox" checked={delegation.includes('commit')} onchange={(event) => toggleAuthority('commit', (event.target as HTMLInputElement).checked)} /> Commit</label>
          <label><input type="checkbox" checked={delegation.includes('push')} onchange={(event) => toggleAuthority('push', (event.target as HTMLInputElement).checked)} /> Push</label>
          {#if delegation.length === 0}<span class="off">Neither · delegation is off</span>{/if}
        </div>
      </fieldset>

      <label>
        <span>Other tools workers may receive <em>optional</em></span>
        <input bind:value={allowedToolsText} placeholder="Bash, WebFetch" />
        <small>Exact tool names, comma separated. A manager can only narrow this list.</small>
      </label>
    </section>

    <aside>
      <div class="scope-head">
        <span>{isActiveManager || saved ? 'CURRENT GRANT' : 'GRANT PREVIEW'}</span>
        {#if isActiveManager || saved}<b>Manager active</b>{/if}
      </div>
      <h3>{mode === 'create' ? `${project?.name ?? 'Project'} manager` : selectedRecord ? chatLabel(selectedRecord) : 'Choose a chat'}</h3>
      <dl>
        <div><dt>Project</dt><dd>{project?.name ?? 'Not chosen'}</dd></div>
        <div>
          <dt>Workers</dt>
          <dd>{#if allowedProfiles.length}{allowedProfiles.map(profileScope).join(' · ')}{:else}None chosen{/if}</dd>
        </div>
        <div><dt>Bound</dt><dd>{maxLiveChildren} live children</dd></div>
        <div><dt>Git delegation</dt><dd>{delegationLabel()}</dd></div>
        <div><dt>Other tools</dt><dd>{allowedToolsText.trim() || 'none'}</dd></div>
        <div>
          <dt>Visibility</dt>
          <dd>Full activity, transcript, approvals, changes, and worktree state for its own children, and only those.</dd>
        </div>
      </dl>
      <p class="audit"><Icon name="history" size={13} /> Grants, changes, use, and revocations are journaled.</p>

      {#if error}<p class="error">{error}</p>{/if}
      <button class="primary" disabled={busy || (mode === 'promote' && !selectedRecord)} onclick={grant}>
        {busy ? 'Saving…' : isActiveManager || saved ? 'Update granted scope' : mode === 'create' ? 'Create manager' : 'Make this chat a manager'}
      </button>
      {#if isActiveManager || saved}
        <button class="revoke" disabled={busy} onclick={revoke}>Revoke manager role</button>
      {/if}
    </aside>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 110; background: color-mix(in srgb, #05050a 72%, transparent); backdrop-filter: blur(3px); }
  .manager-modal { position: fixed; z-index: 111; inset: 4vh 4vw; max-width: 1080px; max-height: 92vh; margin: auto;
    color: var(--text); background: var(--surface-1); border: 1px solid var(--border-accent); border-radius: var(--r-xl);
    box-shadow: 0 28px 80px #0009; overflow: auto; }
  header { display: flex; justify-content: space-between; gap: var(--space-5); padding: 1.4rem 1.6rem 1rem;
    background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, var(--surface-1)), var(--surface-1) 58%); }
  header h2 { margin: .18rem 0 .3rem; font-size: 1.55rem; }
  header p { margin: 0; color: var(--dim); font-size: var(--text-sm); }
  .eyebrow, .scope-head > span { color: var(--accent); font-size: .65rem; font-weight: var(--fw-semibold); letter-spacing: .12em; }
  .close { align-self: flex-start; color: var(--dim); padding: .35rem; }
  .close:hover { color: var(--text); }
  .mode-tabs { display: grid; grid-template-columns: 1fr 1fr; border-block: 1px solid var(--border); }
  .mode-tabs button { padding: .8rem; color: var(--dim); background: var(--surface-2); font-weight: var(--fw-medium); }
  .mode-tabs button.active { color: var(--text); background: var(--surface-1); box-shadow: inset 0 -2px var(--accent); }
  .body { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(270px, .8fr); }
  .setup { display: flex; flex-direction: column; gap: 1.05rem; padding: 1.35rem 1.6rem 1.6rem; border-right: 1px solid var(--border); }
  label, .field { display: flex; flex-direction: column; gap: .42rem; }
  label > span, .field-label, legend { font-size: var(--text-xs); font-weight: var(--fw-semibold); }
  label > span em { color: var(--dim); font-style: normal; font-weight: var(--fw-normal); margin-left: .3rem; }
  select, label > input:not([type]), label > input[placeholder] { width: 100%; }
  select, input { color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-md); padding: .52rem .6rem; }
  small { color: var(--dim); line-height: 1.35; }
  .fixed-value { display: flex; align-items: center; gap: .45rem; padding: .55rem .65rem; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
  .profiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .55rem; }
  .profile { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); padding: .65rem; }
  .profile.chosen { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .profile-head { flex-direction: row; align-items: center; gap: .45rem; }
  .profile-head input, .models input, .choices input { width: auto; }
  .profile-head span { color: var(--dim); font-size: var(--text-xs); margin-left: auto; }
  .models { display: flex; flex-direction: column; gap: .35rem; margin: .55rem 0 0 1.45rem; }
  .models > span { color: var(--dim); font-size: .68rem; }
  .models label { flex-direction: row; align-items: center; gap: .38rem; font-size: .72rem; }
  .limit { display: flex; align-items: center; gap: .55rem; }
  .limit input { width: 4.5rem; }
  .limit span { color: var(--dim); font-size: var(--text-xs); }
  fieldset { margin: 0; padding: .75rem; border: 1px solid var(--border); border-radius: var(--r-md); }
  fieldset p { margin: -.1rem 0 .65rem; color: var(--dim); font-size: var(--text-xs); }
  .choices { display: flex; align-items: center; gap: .8rem; }
  .choices label { flex-direction: row; align-items: center; gap: .35rem; font-size: var(--text-xs); }
  .off { color: var(--dim); font-size: var(--text-xs); }
  aside { position: sticky; top: 0; align-self: start; padding: 1.35rem; }
  .scope-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .scope-head b { color: #7de3a1; font-size: .7rem; }
  aside h3 { margin: .5rem 0 1rem; font-size: 1.1rem; }
  dl { display: flex; flex-direction: column; gap: .75rem; margin: 0; }
  dl div { padding-bottom: .7rem; border-bottom: 1px solid var(--border); }
  dt { color: var(--dim); font-size: .66rem; text-transform: uppercase; letter-spacing: .08em; }
  dd { margin: .26rem 0 0; font-size: var(--text-xs); line-height: 1.45; overflow-wrap: anywhere; }
  .audit { display: flex; align-items: center; gap: .4rem; color: var(--dim); font-size: .7rem; line-height: 1.4; margin: 1rem 0; }
  .primary, .revoke { width: 100%; border-radius: var(--r-md); padding: .66rem; font-weight: var(--fw-semibold); }
  .primary { color: white; background: var(--accent); }
  .primary:disabled { opacity: .5; }
  .revoke { margin-top: .55rem; color: var(--text); border: 1px solid var(--border); background: var(--surface-2); }
  .error, .empty { color: var(--danger); font-size: var(--text-xs); line-height: 1.4; }
  @media (max-width: 760px) {
    .manager-modal { inset: 1rem; }
    .body { grid-template-columns: 1fr; }
    .setup { border-right: 0; border-bottom: 1px solid var(--border); }
    aside { position: static; }
    .profiles { grid-template-columns: 1fr; }
  }
</style>
