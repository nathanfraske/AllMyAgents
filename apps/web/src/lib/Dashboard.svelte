<script lang="ts">
  import { untrack } from 'svelte'
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
  // The calendar is a fixed-cell, horizontally-scrollable "rolling buffer": it shows the weeks that
  // fit the card and you scroll back/forth through the ~year of history, with brief month markers.
  let calScrollEl = $state<HTMLDivElement | null>(null)
  const CELL = 15 // px — square heatmap tile

  $effect(() => {
    void api.stats().then((s) => (stats = s))
  })

  const sessions = $derived(store.sessionList)
  const totalSessions = $derived(sessions.length)
  const claudeCount = $derived(sessions.filter((s) => s.record.provider === 'claude').length)
  const codexCount = $derived(sessions.filter((s) => s.record.provider === 'codex').length)

  const days = $derived(stats?.days ?? [])
  // Group the days into calendar MONTHS. Each renders as its own 7-row heatmap block (weeks =
  // columns) with the month name on top and its first day padded to the right weekday; a gap
  // separates the blocks so it reads like a proper calendar, and navigation is per-month (pageMonth).
  interface MonthGroup { key: string; label: string; pad: number; days: DayStat[] }
  const months = $derived.by(() => {
    const out: MonthGroup[] = []
    let cur: MonthGroup | null = null
    for (const d of days) {
      const dt = new Date(d.date + 'T00:00:00Z')
      const key = `${dt.getUTCFullYear()}-${dt.getUTCMonth()}`
      if (!cur || cur.key !== key) {
        // Year shown on January so a ~year window that crosses a new year stays unambiguous.
        const label = dt.toLocaleDateString(undefined, {
          month: 'short',
          year: dt.getUTCMonth() === 0 ? '2-digit' : undefined,
          timeZone: 'UTC',
        })
        cur = { key, label, pad: dt.getUTCDay(), days: [] }
        out.push(cur)
      }
      cur.days.push(d)
    }
    return out
  })
  // Page the horizontal buffer one month at a time via the ‹ › controls (the scrollbar is hidden
  // — see .calscroll). Positions are measured from the live month blocks, so varying month widths
  // are handled without any layout math.
  function pageMonth(dir: 1 | -1): void {
    const el = calScrollEl
    if (!el) return
    const base = el.getBoundingClientRect().left
    const offs = [...el.querySelectorAll<HTMLElement>('.month')].map(
      (b) => b.getBoundingClientRect().left - base + el.scrollLeft
    )
    const cur = el.scrollLeft
    const target =
      dir > 0 ? (offs.find((o) => o > cur + 2) ?? el.scrollWidth) : ([...offs].reverse().find((o) => o < cur - 2) ?? 0)
    el.scrollTo({ left: target, behavior: 'smooth' })
  }
  // Default the scroll to the most recent week (right edge) on load / when the range changes; a
  // manual scroll afterwards is preserved (deps only re-fire on a new day range, not on scroll).
  $effect(() => {
    void days.length
    const el = calScrollEl
    if (el) requestAnimationFrame(() => (el.scrollLeft = el.scrollWidth))
  })
  // The pinned day, falling back to the newest day so the panel is never empty on load.
  const selectedDay = $derived(
    (selectedDate ? days.find((d) => d.date === selectedDate) : null) ?? days[days.length - 1] ?? null
  )

  // GitHub-style intensity: fixed turns/day thresholds so the heatmap visibly SCALES with usage even
  // on sparse days (relative-to-max washed every low-activity day to one shade). 0 → faint empty tile.
  function shade(turns: number): string {
    if (turns <= 0) return 'color-mix(in srgb, var(--accent) 6%, var(--surface-2))'
    const pct = turns >= 10 ? 100 : turns >= 6 ? 74 : turns >= 3 ? 50 : 28
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
  const heroText = $derived(settings.ownerName ? greeting : 'Welcome to AllMyAgents.')

  // Matrix-decode entrance. On mount the heading resolves from scrambled glyphs into the real
  // sentence; when it settles we flip `revealed`, which triggers the staggered card/tile/detail
  // reveal in CSS. `displayText` feeds the <h1> while scrambling; afterwards the <h1> shows the
  // live `heroText` so a later name change / stats load stays in sync. All gated on
  // prefers-reduced-motion — under reduce-motion nothing scrambles and everything shows at once.
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  const GLYPHS = '01<>[]{}/|=+*#abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const randGlyph = (): string => GLYPHS.charAt((Math.random() * GLYPHS.length) | 0)
  const scrambleOf = (text: string): string => {
    let out = ''
    for (const ch of text) out += ch === ' ' ? ' ' : randGlyph()
    return out
  }
  // untrack: seed the first scramble frame from the current heroText without subscribing —
  // subsequent target changes are picked up live inside the rAF loop below.
  let displayText = $state(reduceMotion ? '' : scrambleOf(untrack(() => heroText)))
  let scrambling = $state(!reduceMotion)
  let revealed = $state(reduceMotion)

  $effect(() => {
    if (reduceMotion) return
    let raf = 0
    const duration = 700
    const start = performance.now()
    let thresholds: number[] = []
    const step = (now: number): void => {
      const target = heroText
      const len = target.length
      if (thresholds.length !== len) {
        thresholds = Array.from({ length: len }, (_, i) =>
          Math.min(0.92, (i / Math.max(1, len)) * 0.35 + Math.random() * 0.7))
      }
      const p = Math.min(1, (now - start) / duration)
      let out = ''
      for (let i = 0; i < len; i++) {
        const ch = target.charAt(i)
        const th = thresholds[i] ?? 1
        out += ch === ' ' ? ' ' : p >= th ? ch : randGlyph()
      }
      displayText = out
      if (p < 1) {
        raf = requestAnimationFrame(step)
      } else {
        displayText = target
        scrambling = false
        revealed = true
      }
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
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
  <div class="dash" class:revealed>
    <div class="top">
      {#if store.lastLayout}
        <button class="back" onclick={() => store.goBack()}>← back to your chats</button>
      {/if}
      <div class="hero">
        <img class="logo" src="/logo.png" alt="" />
        <div class="herotext">
          <h1>{scrambling ? displayText : heroText}</h1>
          {#if !settings.ownerName}
            <div class="nameask">
              <input placeholder="What should I call you?" bind:value={nameInput} onkeydown={(e) => { if (e.key === 'Enter') saveName() }} />
              <button class="btn btn-primary" onclick={saveName}>Set</button>
            </div>
          {/if}
          <p class="dim">Drag a chat from the sidebar into this space to open it — drop it beside another to split, or above/below to stack.</p>
        </div>
      </div>

      <div class="tiles">
        <div class="tile"><div class="num">{totalSessions}</div><div class="lbl dim">sessions</div></div>
        <div class="tile"><div class="num">{projectRows.length}</div><div class="lbl dim">projects</div></div>
        <div class="tile"><div class="num">{stats?.totalTurns ?? '—'}</div><div class="lbl dim">turns (past yr)</div></div>
        <div class="tile"><div class="num">${(stats?.totalCost ?? 0).toFixed(2)}</div><div class="lbl dim">spend (past yr)</div></div>
        <div class="tile split">
          <div class="prov"><ProviderLogo provider="claude" size={13} /> {claudeCount}</div>
          <div class="prov"><ProviderLogo provider="codex" size={13} /> {codexCount}</div>
        </div>
      </div>
    </div>

    <div class="left">
      <section class="card">
        <div class="cardhd">
          <h3>Daily usage — click a day for the full breakdown</h3>
          {#if days.length}
            <div class="calnav">
              <button class="calbtn" title="earlier months" aria-label="earlier months" onclick={() => pageMonth(-1)}>‹</button>
              <button class="calbtn" title="later months" aria-label="later months" onclick={() => pageMonth(1)}>›</button>
            </div>
          {/if}
        </div>
        {#if days.length === 0}
          <div class="dim empty2">loading…</div>
        {:else}
          <div class="calscroll" bind:this={calScrollEl}>
            <div class="calmonthsrow">
              {#each months as mo (mo.key)}
                <div class="month">
                  <div class="mlabel">{mo.label}</div>
                  <div class="mgrid" style="grid-template-rows: repeat(7, {CELL}px); grid-auto-columns: {CELL}px;">
                    {#each Array(mo.pad) as _, i (i)}<div class="cell pad"></div>{/each}
                    {#each mo.days as d (d.date)}
                      <button type="button" class="cell" class:selected={selectedDay?.date === d.date} style="background: {shade(d.turns)}"
                        aria-label="{d.date}: {d.turns} turns" aria-pressed={selectedDay?.date === d.date}
                        onmouseenter={(e) => onEnter(d, e)} onmousemove={(e) => onEnter(d, e)} onmouseleave={() => (hovered = null)}
                        onclick={() => (selectedDate = d.date)}></button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
          <div class="legend dim"><span>less</span>
            <span class="k" style="background: {shade(0)}"></span>
            <span class="k" style="background: {shade(1)}"></span>
            <span class="k" style="background: {shade(3)}"></span>
            <span class="k" style="background: {shade(6)}"></span>
            <span class="k" style="background: {shade(10)}"></span>
            <span>more</span></div>
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
  .dashwrap { position: relative; height: 100%; overflow-y: auto; container-type: inline-size; }
  /* One soft radial accent glow behind the hero so the landing reads as depth, not a flat void. */
  .dashwrap::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 440px; z-index: 0; pointer-events: none;
    background: radial-gradient(60% 40% at 20% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 72%); }
  /* Two-column composition: a full-width header row (greeting + stat tiles), then the
     calendar/projects stack on the left paired with the day-detail panel on the right.
     The detail panel stretches to fill the height of the left stack so the right side
     no longer leaves a void. Collapses to a single column when the pane is narrow
     (container query, not viewport, so it reacts to the resizable sidebar and split panes). */
  .dash { position: relative; z-index: 1; max-width: 1180px; margin: 0 auto; padding: var(--space-8) var(--space-7);
    display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--space-6); align-items: start;
    grid-template-areas: "top top" "left detail"; }
  .top { grid-area: top; min-width: 0; }
  .left { grid-area: left; min-width: 0; display: flex; flex-direction: column; gap: var(--space-6); }
  @container (max-width: 880px) {
    .dash { grid-template-columns: minmax(0, 1fr); grid-template-areas: "top" "left" "detail"; }
  }
  .back { color: var(--muted); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--space-2) var(--space-4); margin-bottom: var(--space-6); font-size: var(--text-sm); }
  .back:hover { border-color: var(--border-accent); color: var(--text); }
  .hero { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-5); margin-bottom: var(--space-7); }
  .hero .logo { width: 64px; height: 64px; object-fit: contain; flex: none; }
  .herotext { flex: 1 1 auto; min-width: 0; }
  h1 { font-size: var(--text-xl); font-weight: var(--fw-semibold); margin: 0 0 var(--space-3); }
  .nameask { display: flex; gap: var(--space-3); margin: var(--space-4) 0; }
  .nameask input { flex: 1; max-width: 320px; }
  .hero p { font-size: var(--text-sm); margin: var(--space-3) 0 0; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--space-4); }

  /* Modern surface treatment shared by every card-like panel: a soft low-contrast border,
     a faint top inner-highlight and a gentle layered drop shadow for depth, plus a barely
     there top-down sheen. Tuned understated for the near-black CEC theme — no neon. */
  .tile, .card, .detail {
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0) 55%),
      var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--edge-hi), var(--shadow-2);
  }
  .tile { padding: var(--space-4) var(--space-5); min-width: 0; min-height: 84px; display: flex; flex-direction: column; justify-content: center; }
  .tile .num { font-size: var(--text-2xl); font-weight: var(--fw-semibold); font-family: var(--mono); font-variant-numeric: tabular-nums; line-height: 1.1; }
  .tile .lbl { font-size: var(--text-xs); margin-top: var(--space-1); }
  .tile.split { display: flex; flex-direction: column; gap: var(--space-2); justify-content: center; }
  .prov { display: flex; align-items: center; gap: var(--space-3); font-family: var(--mono); font-size: var(--text-md); font-variant-numeric: tabular-nums; }
  .card { padding: var(--space-5); min-width: 0; }
  .card h3, .detail h3 { margin: 0 0 var(--space-4); font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: var(--ls-label); color: var(--dim); }
  /* GitHub-style heatmap as a horizontally-scrollable "rolling buffer": fixed-size tiles, only the
     weeks that fit the card are visible, and you scroll back/forth through the ~year. The month
     labels row shares the column geometry and scrolls with the grid inside .calscroll. */
  /* Header row so the ‹ › month pager sits opposite the card title. */
  .cardhd { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-4); }
  .cardhd h3 { margin: 0; }
  .calnav { display: flex; gap: 4px; flex: none; }
  .calbtn { display: grid; place-items: center; width: 22px; height: 22px; border-radius: var(--r-sm); border: 1px solid var(--border);
    color: var(--muted); font-size: 0.95rem; line-height: 1; }
  .calbtn:hover { border-color: var(--border-accent); color: var(--text); background: var(--surface-2); }
  /* Month-segmented heatmap as a per-month PAGINATED buffer: the scrollbar is hidden and the ‹ ›
     controls step one month at a time (it stays trackpad-scrollable too). */
  .calscroll { overflow-x: auto; overflow-y: hidden; scrollbar-width: none; scroll-behavior: smooth; }
  .calscroll::-webkit-scrollbar { display: none; }
  .calmonthsrow { display: flex; align-items: flex-start; gap: 14px; width: max-content; }
  .month { display: flex; flex-direction: column; gap: 4px; }
  .mlabel { font-size: var(--text-2xs); font-weight: var(--fw-medium); letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--dim); }
  .mgrid { display: grid; grid-auto-flow: column; gap: 3px; }
  /* Every tile carries a faint inset hairline so the matrix reads cleanly even where the
     fill is near the card colour (zero-activity days). */
  .cell { border-radius: var(--r-xs); padding: 0; border: 0; box-shadow: inset 0 0 0 1px var(--border); }
  .cell.pad { box-shadow: none; }
  .cell:not(.pad) { cursor: pointer; }
  .cell:not(.pad):hover { box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.85); }
  /* Inset accent ring for the pinned day — stays within the cell bounds (no scale/overlap
     into neighbouring cells or rows). The :hover pairing keeps the ring on when hovered. */
  .cell.selected, .cell.selected:hover { box-shadow: inset 0 0 0 2px var(--accent); }
  .legend { display: flex; align-items: center; gap: 4px; font-size: var(--text-2xs); margin-top: var(--space-4); }
  .legend .k { width: 12px; height: 12px; border-radius: var(--r-xs); display: inline-block; box-shadow: inset 0 0 0 1px var(--border); }
  .projs { display: flex; flex-direction: column; gap: var(--space-4); }
  .ptop { display: flex; justify-content: space-between; font-size: var(--text-sm); margin-bottom: var(--space-1); }
  .pname { font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pmeta { font-size: var(--text-xs); font-family: var(--mono); font-variant-numeric: tabular-nums; flex: none; }
  .pbar { height: 6px; background: var(--surface-3); border-radius: var(--r-pill); overflow: hidden; }
  .pfill { height: 100%; border-radius: var(--r-pill); background: linear-gradient(90deg, var(--cyan), var(--accent));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25); }
  .empty2 { font-size: var(--text-sm); padding: var(--space-3) 0; }

  /* Day-detail panel — stretches to the full height of the calendar/projects stack and
     centres its content vertically so it reads as a deliberate pair, not a floating card. */
  .detail { grid-area: detail; align-self: stretch; display: flex; flex-direction: column; padding: var(--space-5); }
  .dbody { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .dhead { font-size: var(--text-md); font-weight: var(--fw-semibold); margin-bottom: var(--space-4); line-height: 1.35; }
  .dstats { display: flex; gap: var(--space-4); margin-bottom: var(--space-5); }
  .dstat { flex: 1; background: var(--surface-2); border: 1px solid var(--border-subtle); border-radius: var(--r-lg); padding: var(--space-4); box-shadow: var(--edge-hi); }
  .dstat .num { font-size: var(--text-xl); font-weight: var(--fw-semibold); font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .dstat .lbl { font-size: var(--text-xs); margin-top: var(--space-1); }
  .dbreak-h { font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: var(--ls-label); margin-bottom: var(--space-2); }
  .dbreak { display: flex; flex-direction: column; }
  .drow { display: flex; justify-content: space-between; gap: var(--space-4); font-size: var(--text-sm); padding: var(--space-2) 0; border-top: 1px solid var(--border-subtle); }
  .drow:first-child { border-top: none; }
  .dn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dv { font-family: var(--mono); font-size: var(--text-xs); font-variant-numeric: tabular-nums; flex: none; color: var(--muted); }

  .tip { position: fixed; z-index: 60; pointer-events: none; background: var(--surface-2); border: 1px solid var(--border-strong);
    border-radius: var(--r-lg); padding: var(--space-3) var(--space-4); box-shadow: var(--shadow-3), var(--edge-hi); min-width: 150px; max-width: 240px; }
  .tiphead { font-size: var(--text-xs); font-weight: var(--fw-medium); margin-bottom: var(--space-2); font-variant-numeric: tabular-nums; }
  .tiprow { display: flex; justify-content: space-between; gap: var(--space-4); font-size: var(--text-xs); }
  .tn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tv { font-family: var(--mono); font-variant-numeric: tabular-nums; flex: none; }

  @media (prefers-reduced-motion: no-preference) {
    .tile, .card, .detail { transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
    .tile:hover { transform: translateY(-2px); border-color: var(--border-strong);
      box-shadow: var(--edge-hi), var(--shadow-3); }
    .cell { transition: box-shadow var(--dur) var(--ease), background var(--dur-slow) var(--ease); }
    .pfill { transition: width var(--dur-slow) var(--ease); }
    .tip { animation: pop-in var(--dur-fast) var(--ease); }

    /* Matrix-decode entrance: the stat tiles, both left cards and the detail panel stay hidden
       while the heading scrambles (no .revealed on .dash), then stagger up once JS resolves the
       heading and adds .revealed. animation-fill-mode:backwards holds each element's hidden 0%
       state through its delay so nothing flashes visible before its turn. Under reduce-motion
       this whole @media block is inert, so everything is simply shown at once. */
    .dash:not(.revealed) .tile,
    .dash:not(.revealed) .card,
    .dash:not(.revealed) .detail { opacity: 0; }
    .dash.revealed .tile,
    .dash.revealed .card,
    .dash.revealed .detail { animation: reveal-up 340ms var(--ease) backwards; }
    .dash.revealed .tiles .tile:nth-child(1) { animation-delay: 0ms; }
    .dash.revealed .tiles .tile:nth-child(2) { animation-delay: 40ms; }
    .dash.revealed .tiles .tile:nth-child(3) { animation-delay: 80ms; }
    .dash.revealed .tiles .tile:nth-child(4) { animation-delay: 120ms; }
    .dash.revealed .tiles .tile:nth-child(5) { animation-delay: 160ms; }
    .dash.revealed .left .card:nth-child(1) { animation-delay: 210ms; }
    .dash.revealed .left .card:nth-child(2) { animation-delay: 260ms; }
    .dash.revealed .detail { animation-delay: 320ms; }
  }
  @keyframes reveal-up {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
