<script lang="ts">
  import { store } from './store.svelte'
  import { settings } from './settings.svelte'
  import { relativeTime } from './time'
  import { api, type StatsResult, type DayStat } from './api'
  import ProviderLogo from './ProviderLogo.svelte'

  let nameInput = $state('')
  let stats = $state<StatsResult | null>(null)
  let hovered = $state<DayStat | null>(null)
  let tipX = $state(0)
  let tipY = $state(0)
  // Pinned day for the detail panel. Null → default to the most recent day (today).
  let selectedDate = $state<string | null>(null)

  $effect(() => {
    void api.stats().then((s) => (stats = s))
  })

  const sessions = $derived(store.sessionList)
  const totalSessions = $derived(sessions.length)
  const claudeCount = $derived(sessions.filter((s) => s.record.provider === 'claude').length)
  const codexCount = $derived(sessions.filter((s) => s.record.provider === 'codex').length)

  const days = $derived(stats?.days ?? [])
  const maxTurns = $derived(Math.max(1, ...days.map((d) => d.turns)))
  const firstWeekday = $derived(days.length ? new Date(days[0].date + 'T00:00:00Z').getUTCDay() : 0)
  // The pinned day, falling back to the newest day so the panel is never empty on load.
  const selectedDay = $derived(
    (selectedDate ? days.find((d) => d.date === selectedDate) : null) ?? days[days.length - 1] ?? null
  )

  function shade(turns: number): string {
    if (turns === 0) return 'var(--surface-3)'
    const t = turns / maxTurns
    const pct = t < 0.2 ? 30 : t < 0.5 ? 50 : t < 0.8 ? 72 : 100
    return `color-mix(in srgb, var(--accent) ${pct}%, var(--surface-2))`
  }
  function monthLabel(date: string): string {
    return new Date(date + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  function fullDate(date: string): string {
    return new Date(date + 'T00:00:00Z').toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    })
  }

  interface ProjRow { id: string; name: string; count: number; last: string }
  const projectRows = $derived.by(() => {
    const map = new Map<string, ProjRow>()
    for (const s of sessions) {
      const key = s.record.projectId ?? '__none__'
      const nm = key === '__none__' ? 'Unfiled' : (store.projects.find((p) => p.id === key)?.name ?? key)
      const row = map.get(key) ?? { id: key, name: nm, count: 0, last: '' }
      row.count++
      if (!row.last || s.lastActivity > row.last) row.last = s.lastActivity
      map.set(key, row)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  })
  const maxProjCount = $derived(Math.max(1, ...projectRows.map((r) => r.count)))

  const greeting = $derived.by(() => {
    const name = settings.ownerName || 'operator'
    const h = new Date().getHours()
    const tod = h < 5 ? 'Burning the midnight oil' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
    const turns = stats?.totalTurns ?? 0
    const lines = [
      `${tod}, ${name}. The fleet is warmed up and waiting.`,
      `Welcome back, ${name}. ${totalSessions} sessions and the agents still haven't unionized.`,
      `${tod}, ${name}. ${projectRows.length} project${projectRows.length === 1 ? '' : 's'} on the board — no pressure.`,
      `Back for more, ${name}? The tokens don't spend themselves.`,
      `${tod}, ${name}. ${turns} turns and counting. Someone's been busy.`,
    ]
    return lines[(h + totalSessions) % lines.length]
  })

  function saveName(): void {
    const n = nameInput.trim()
    if (n) settings.set('ownerName', n)
  }
  function onEnter(d: DayStat, e: MouseEvent): void {
    hovered = d
    tipX = e.clientX
    tipY = e.clientY
  }
  function topProjects(d: DayStat): Array<[string, { turns: number; cost: number }]> {
    return Object.entries(d.projects).sort((a, b) => b[1].turns - a[1].turns)
  }
</script>

<div class="dashwrap scroll">
  <div class="dash">
    <div class="top">
      {#if store.lastLayout}
        <button class="back" onclick={() => store.goBack()}>← back to your chats</button>
      {/if}
      <div class="hero">
        <div class="logo"></div>
        {#if settings.ownerName}
          <h1>{greeting}</h1>
        {:else}
          <h1>Welcome to CEC AiMesh.</h1>
          <div class="nameask">
            <input placeholder="What should I call you?" bind:value={nameInput} onkeydown={(e) => { if (e.key === 'Enter') saveName() }} />
            <button class="primary" onclick={saveName}>Set</button>
          </div>
        {/if}
        <p class="dim">Drag a chat from the sidebar into this space to open it — drop it beside another to split, or above/below to stack.</p>
      </div>

      <div class="tiles">
        <div class="tile"><div class="num">{totalSessions}</div><div class="lbl dim">sessions</div></div>
        <div class="tile"><div class="num">{projectRows.length}</div><div class="lbl dim">projects</div></div>
        <div class="tile"><div class="num">{stats?.totalTurns ?? '—'}</div><div class="lbl dim">turns (14 wks)</div></div>
        <div class="tile"><div class="num">${(stats?.totalCost ?? 0).toFixed(2)}</div><div class="lbl dim">spend (14 wks)</div></div>
        <div class="tile split">
          <div class="prov"><ProviderLogo provider="claude" size={13} /> {claudeCount}</div>
          <div class="prov"><ProviderLogo provider="codex" size={13} /> {codexCount}</div>
        </div>
      </div>
    </div>

    <div class="left">
      <section class="card">
        <h3>Daily usage — click a day for the full breakdown</h3>
        {#if days.length === 0}
          <div class="dim empty2">loading…</div>
        {:else}
          <div class="cal">
            {#each Array(firstWeekday) as _, i (i)}<div class="cell pad"></div>{/each}
            {#each days as d (d.date)}
              <button type="button" class="cell" class:selected={selectedDay?.date === d.date} style="background: {shade(d.turns)}"
                aria-label="{d.date}: {d.turns} turns" aria-pressed={selectedDay?.date === d.date}
                onmouseenter={(e) => onEnter(d, e)} onmousemove={(e) => onEnter(d, e)} onmouseleave={() => (hovered = null)}
                onclick={() => (selectedDate = d.date)}></button>
            {/each}
          </div>
          <div class="legend dim"><span>less</span><span class="k" style="background: var(--surface-3)"></span><span class="k" style="background: color-mix(in srgb, var(--accent) 50%, var(--surface-2))"></span><span class="k" style="background: var(--accent)"></span><span>more</span></div>
        {/if}
      </section>

      <section class="card">
        <h3>Projects by usage</h3>
        {#if projectRows.length === 0}
          <div class="dim empty2">no projects yet — create one from the sidebar</div>
        {:else}
          <div class="projs">
            {#each projectRows as r (r.id)}
              <div class="proj">
                <div class="ptop"><span class="pname">{r.name}</span><span class="dim pmeta">{r.count} · {r.last ? relativeTime(r.last) : '—'}</span></div>
                <div class="pbar"><div class="pfill" style="width: {Math.round((r.count / maxProjCount) * 100)}%"></div></div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>

    <aside class="detail">
      <h3>Day detail</h3>
      <div class="dbody">
        {#if selectedDay}
          <div class="dhead">{fullDate(selectedDay.date)}</div>
          <div class="dstats">
            <div class="dstat"><div class="num">{selectedDay.turns}</div><div class="lbl dim">turns</div></div>
            <div class="dstat"><div class="num">${selectedDay.cost.toFixed(2)}</div><div class="lbl dim">spend</div></div>
          </div>
          {#if selectedDay.turns === 0}
            <div class="dim empty2">No activity on this day.</div>
          {:else}
            <div class="dbreak-h dim">By project</div>
            <div class="dbreak">
              {#each topProjects(selectedDay) as [name, p] (name)}
                <div class="drow">
                  <span class="dn">{name}</span>
                  <span class="dv">{p.turns} turn{p.turns === 1 ? '' : 's'}{#if p.cost > 0} · ${p.cost.toFixed(2)}{/if}</span>
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <div class="dim empty2">Select a day to see its breakdown.</div>
        {/if}
      </div>
    </aside>
  </div>
</div>

{#if hovered}
  <div class="tip" style="left: {tipX + 14}px; top: {tipY + 14}px">
    <div class="tiphead">{monthLabel(hovered.date)} · {hovered.turns} turns{#if hovered.cost > 0} · ${hovered.cost.toFixed(2)}{/if}</div>
    {#if hovered.turns === 0}
      <div class="dim">no activity</div>
    {:else}
      {#each topProjects(hovered) as [name, p] (name)}
        <div class="tiprow"><span class="tn">{name}</span><span class="tv dim">{p.turns}{#if p.cost > 0} · ${p.cost.toFixed(2)}{/if}</span></div>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .dashwrap { height: 100%; overflow-y: auto; container-type: inline-size; }
  /* Two-column composition: a full-width header row (greeting + stat tiles), then the
     calendar/projects stack on the left paired with the day-detail panel on the right.
     The detail panel stretches to fill the height of the left stack so the right side
     no longer leaves a void. Collapses to a single column when the pane is narrow
     (container query, not viewport, so it reacts to the resizable sidebar and split panes). */
  .dash { max-width: 1180px; margin: 0 auto; padding: 2rem 1.5rem;
    display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 1.25rem; align-items: start;
    grid-template-areas: "top top" "left detail"; }
  .top { grid-area: top; min-width: 0; }
  .left { grid-area: left; min-width: 0; display: flex; flex-direction: column; gap: 1.25rem; }
  @container (max-width: 880px) {
    .dash { grid-template-columns: minmax(0, 1fr); grid-template-areas: "top" "left" "detail"; }
  }
  .back { color: var(--muted); border: 1px solid var(--border); border-radius: 8px; padding: 0.3rem 0.7rem; margin-bottom: 1.2rem; font-size: 0.82rem; }
  .back:hover { border-color: var(--accent); color: var(--text); }
  .hero { margin-bottom: 1.6rem; }
  .hero .logo { width: 34px; height: 34px; border-radius: 9px; background: linear-gradient(135deg, var(--accent), var(--cyan)); margin-bottom: 0.9rem; }
  h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.5rem; }
  .nameask { display: flex; gap: 0.5rem; margin: 0.6rem 0; }
  .nameask input { flex: 1; max-width: 320px; }
  .primary { background: var(--accent); color: #fff; border-radius: 8px; padding: 0.35rem 0.9rem; font-weight: 500; }
  .hero p { font-size: 0.85rem; margin: 0.4rem 0 0; }
  .tiles { display: flex; gap: 0.6rem; flex-wrap: wrap; }

  /* Modern surface treatment shared by every card-like panel: a soft low-contrast border,
     a faint top inner-highlight and a gentle layered drop shadow for depth, plus a barely
     there top-down sheen. Tuned understated for the near-black CEC theme — no neon. */
  .tile, .card, .detail {
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0) 55%),
      var(--surface);
    border: 1px solid color-mix(in srgb, var(--border) 62%, transparent);
    border-radius: 14px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.045),
      0 1px 2px rgba(0, 0, 0, 0.28),
      0 12px 30px -8px rgba(0, 0, 0, 0.32);
  }
  .tile { padding: 0.8rem 1rem; min-width: 100px; }
  .tile .num { font-size: 1.5rem; font-weight: 600; font-family: var(--mono); }
  .tile .lbl { font-size: 0.72rem; margin-top: 0.2rem; }
  .tile.split { display: flex; flex-direction: column; gap: 0.35rem; justify-content: center; }
  .prov { display: flex; align-items: center; gap: 0.4rem; font-family: var(--mono); font-size: 0.95rem; }
  .card { padding: 0.9rem 1rem; min-width: 0; }
  .card h3, .detail h3 { margin: 0 0 0.8rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); }
  .cal { display: grid; grid-template-rows: repeat(7, 13px); grid-auto-flow: column; grid-auto-columns: 13px; gap: 3px; }
  .cell { border-radius: 3px; padding: 0; border: 0; }
  .cell:not(.pad) { cursor: pointer; }
  .cell:not(.pad):hover { outline: 1px solid var(--text); }
  .cell.selected { outline: 2px solid var(--text); }
  .legend { display: flex; align-items: center; gap: 4px; font-size: 0.66rem; margin-top: 0.6rem; }
  .legend .k { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .projs { display: flex; flex-direction: column; gap: 0.6rem; }
  .ptop { display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 0.25rem; }
  .pname { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pmeta { font-size: 0.72rem; font-family: var(--mono); flex: none; }
  .pbar { height: 6px; background: var(--surface-3); border-radius: 4px; overflow: hidden; }
  .pfill { height: 100%; background: linear-gradient(90deg, var(--cyan), var(--accent)); }
  .empty2 { font-size: 0.82rem; padding: 0.5rem 0; }

  /* Day-detail panel — stretches to the full height of the calendar/projects stack and
     centres its content vertically so it reads as a deliberate pair, not a floating card. */
  .detail { grid-area: detail; align-self: stretch; display: flex; flex-direction: column; padding: 0.9rem 1rem; }
  .dbody { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .dhead { font-size: 0.98rem; font-weight: 600; margin-bottom: 0.8rem; line-height: 1.35; }
  .dstats { display: flex; gap: 0.6rem; margin-bottom: 1rem; }
  .dstat { flex: 1; background: var(--surface-2); border: 1px solid color-mix(in srgb, var(--border) 40%, transparent); border-radius: 11px; padding: 0.6rem 0.7rem; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03); }
  .dstat .num { font-size: 1.35rem; font-weight: 600; font-family: var(--mono); }
  .dstat .lbl { font-size: 0.68rem; margin-top: 0.15rem; }
  .dbreak-h { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.35rem; }
  .dbreak { display: flex; flex-direction: column; }
  .drow { display: flex; justify-content: space-between; gap: 0.6rem; font-size: 0.8rem; padding: 0.4rem 0; border-top: 1px solid var(--border); }
  .drow:first-child { border-top: none; }
  .dn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dv { font-family: var(--mono); font-size: 0.73rem; flex: none; color: var(--muted); }

  .tip { position: fixed; z-index: 60; pointer-events: none; background: var(--surface-2); border: 1px solid var(--border-strong);
    border-radius: 9px; padding: 0.5rem 0.65rem; box-shadow: 0 10px 30px rgba(0,0,0,0.55); min-width: 150px; max-width: 240px; }
  .tiphead { font-size: 0.76rem; font-weight: 500; margin-bottom: 0.3rem; }
  .tiprow { display: flex; justify-content: space-between; gap: 0.6rem; font-size: 0.74rem; }
  .tn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tv { font-family: var(--mono); flex: none; }

  @media (prefers-reduced-motion: no-preference) {
    .tile, .card, .detail { transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
    .tile:hover { transform: translateY(-2px); border-color: var(--border-strong);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 2px 4px rgba(0, 0, 0, 0.3), 0 16px 34px -8px rgba(0, 0, 0, 0.4); }
    .cell { transition: outline-color var(--dur) var(--ease), background var(--dur-slow) var(--ease); }
    .pfill { transition: width var(--dur-slow) var(--ease); }
    .detail { animation: fade-in var(--dur-slow) var(--ease); }
    .tip { animation: pop-in 120ms var(--ease); }
  }
</style>
