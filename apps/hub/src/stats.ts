import type Database from 'better-sqlite3'
import type { ProjectStore } from './projects.js'

export interface DayStat {
  date: string // YYYY-MM-DD (UTC)
  turns: number
  /** Sum of Claude SDK result estimates; not a provider bill or subscription-plan charge. */
  apiEquivalentCostUsd: number
  projects: Record<string, { turns: number; apiEquivalentCostUsd: number }>
}

export interface StatsResult {
  days: DayStat[]
  totalTurns: number
  /** Sum over the same visible day window as `days`. */
  totalApiEquivalentCostUsd: number
  totalSessions: number
}

// Aggregate per-day activity (completed turns), spend, and per-project breakdown from the
// event journal. A "turn" = a claude/result or codex/turn/completed; cost comes from Claude
// results (Codex is subscription, no per-turn cost).
// ~53 weeks so the dashboard heatmap fills its card width with small GitHub-style cells (rather
// than a handful of oversized tiles). Empty days render as zero-activity cells and fill in over time.
export function computeStats(
  db: Database.Database,
  projects: ProjectStore,
  dayCount = 371,
  nowMs = Date.now(),
): StatsResult {
  const projName = new Map<string, string>()
  for (const p of projects.list()) projName.set(p.id, p.name)

  const sessRows = db.prepare('SELECT id, record FROM sessions').all() as Array<{ id: string; record: string }>
  const sessionProject = new Map<string, string>()
  let liveSessionCount = 0
  for (const r of sessRows) {
    let projectId: string | undefined
    let retired = false
    try {
      const record = JSON.parse(r.record) as { projectId?: string; managerRetiredAt?: string }
      projectId = record.projectId
      retired = Boolean(record.managerRetiredAt)
    } catch {
      /* ignore */
    }
    if (!retired) liveSessionCount++
    sessionProject.set(r.id, projectId ? (projName.get(projectId) ?? 'Unknown project') : 'Unfiled')
  }

  // `days` is a rolling calendar window. Keep the summary tiles on precisely that same window;
  // previously they scanned the entire journal while being labelled "past yr", so the tiles and
  // visible calendar silently diverged as soon as the journal became older than one year.
  const safeDayCount = Math.max(1, Math.floor(dayCount))
  const firstDay = new Date(nowMs - (safeDayCount - 1) * 86_400_000).toISOString().slice(0, 10)
  const turnRows = db
    .prepare(
      "SELECT ts, session, kind, payload FROM events WHERE kind IN ('claude/result','codex/turn/completed') AND ts >= ?",
    )
    .all(`${firstDay}T00:00:00.000Z`) as Array<{ ts: string; session: string | null; kind: string; payload: string }>

  const dayMap = new Map<string, DayStat>()
  let totalTurns = 0
  let totalApiEquivalentCostUsd = 0
  for (const row of turnRows) {
    const date = row.ts.slice(0, 10)
    let cost = 0
    if (row.kind === 'claude/result') {
      try {
        cost = (JSON.parse(row.payload) as { total_cost_usd?: number }).total_cost_usd ?? 0
      } catch {
        /* ignore */
      }
    }
    const proj = (row.session && sessionProject.get(row.session)) || 'Unfiled'
    let d = dayMap.get(date)
    if (!d) {
      d = { date, turns: 0, apiEquivalentCostUsd: 0, projects: {} }
      dayMap.set(date, d)
    }
    d.turns++
    d.apiEquivalentCostUsd += cost
    const pd = d.projects[proj] ?? { turns: 0, apiEquivalentCostUsd: 0 }
    pd.turns++
    pd.apiEquivalentCostUsd += cost
    d.projects[proj] = pd
    totalTurns++
    totalApiEquivalentCostUsd += cost
  }

  const days: DayStat[] = []
  for (let i = safeDayCount - 1; i >= 0; i--) {
    const key = new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10)
    days.push(dayMap.get(key) ?? { date: key, turns: 0, apiEquivalentCostUsd: 0, projects: {} })
  }

  return { days, totalTurns, totalApiEquivalentCostUsd, totalSessions: liveSessionCount }
}
