import type Database from 'better-sqlite3'
import type { ProjectStore } from './projects.js'

export interface DayStat {
  date: string // YYYY-MM-DD (UTC)
  turns: number
  cost: number
  projects: Record<string, { turns: number; cost: number }>
}

export interface StatsResult {
  days: DayStat[]
  totalTurns: number
  totalCost: number
  totalSessions: number
}

// Aggregate per-day activity (completed turns), spend, and per-project breakdown from the
// event journal. A "turn" = a claude/result or codex/turn/completed; cost comes from Claude
// results (Codex is subscription, no per-turn cost).
export function computeStats(db: Database.Database, projects: ProjectStore, dayCount = 98): StatsResult {
  const projName = new Map<string, string>()
  for (const p of projects.list()) projName.set(p.id, p.name)

  const sessRows = db.prepare('SELECT id, record FROM sessions').all() as Array<{ id: string; record: string }>
  const sessionProject = new Map<string, string>()
  for (const r of sessRows) {
    let projectId: string | undefined
    try {
      projectId = (JSON.parse(r.record) as { projectId?: string }).projectId
    } catch {
      /* ignore */
    }
    sessionProject.set(r.id, projectId ? (projName.get(projectId) ?? 'Unknown project') : 'Unfiled')
  }

  const turnRows = db
    .prepare("SELECT ts, session, kind, payload FROM events WHERE kind IN ('claude/result','codex/turn/completed')")
    .all() as Array<{ ts: string; session: string | null; kind: string; payload: string }>

  const dayMap = new Map<string, DayStat>()
  let totalTurns = 0
  let totalCost = 0
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
      d = { date, turns: 0, cost: 0, projects: {} }
      dayMap.set(date, d)
    }
    d.turns++
    d.cost += cost
    const pd = d.projects[proj] ?? { turns: 0, cost: 0 }
    pd.turns++
    pd.cost += cost
    d.projects[proj] = pd
    totalTurns++
    totalCost += cost
  }

  const days: DayStat[] = []
  const now = Date.now()
  for (let i = dayCount - 1; i >= 0; i--) {
    const key = new Date(now - i * 86_400_000).toISOString().slice(0, 10)
    days.push(dayMap.get(key) ?? { date: key, turns: 0, cost: 0, projects: {} })
  }

  return { days, totalTurns, totalCost, totalSessions: sessRows.length }
}
