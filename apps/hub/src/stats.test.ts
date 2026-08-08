import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectStore } from './projects.js'
import { computeStats } from './stats.js'

describe('dashboard stats', () => {
  let db: Database.Database | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  it('uses one rolling window for calendar days, turn total, and API-equivalent estimate', () => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE events (ts TEXT NOT NULL, session TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL);
    `)
    db.prepare('INSERT INTO sessions (id, record) VALUES (?, ?)').run('project-session', JSON.stringify({ projectId: 'p1' }))
    db.prepare('INSERT INTO sessions (id, record) VALUES (?, ?)').run('loose-session', '{}')
    db.prepare('INSERT INTO sessions (id, record) VALUES (?, ?)').run(
      'retired-session',
      JSON.stringify({ projectId: 'p1', managerRetiredAt: '2026-08-08T11:00:00.000Z' }),
    )
    const insert = db.prepare('INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)')
    insert.run('2026-08-08T10:00:00.000Z', 'project-session', 'claude/result', JSON.stringify({ total_cost_usd: 2.75 }))
    insert.run('2026-08-07T10:00:00.000Z', 'loose-session', 'codex/turn/completed', '{}')
    insert.run('2026-08-05T10:00:00.000Z', 'project-session', 'claude/result', JSON.stringify({ total_cost_usd: 999 }))

    const projects = { list: () => [{ id: 'p1', name: 'Project One' }] } as unknown as ProjectStore
    const result = computeStats(db, projects, 2, Date.parse('2026-08-08T12:00:00.000Z'))

    expect(result.totalSessions).toBe(2)
    expect(result.totalTurns).toBe(2)
    expect(result.totalApiEquivalentCostUsd).toBe(2.75)
    expect(result.days.map((day) => day.date)).toEqual(['2026-08-07', '2026-08-08'])
    expect(result.days[0]).toMatchObject({ turns: 1, apiEquivalentCostUsd: 0 })
    expect(result.days[1]?.projects['Project One']).toEqual({ turns: 1, apiEquivalentCostUsd: 2.75 })
  })
})
