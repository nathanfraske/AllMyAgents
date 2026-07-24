import type Database from 'better-sqlite3'
import type { SessionRecord } from './types.js'

export class SessionStore {
  private readonly upsertStmt: Database.Statement
  private readonly allStmt: Database.Statement

  constructor(db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL, updated TEXT NOT NULL)'
    )
    this.upsertStmt = db.prepare(
      'INSERT INTO sessions (id, record, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record, updated = excluded.updated'
    )
    this.allStmt = db.prepare('SELECT record FROM sessions ORDER BY updated ASC')
  }

  upsert(record: SessionRecord): void {
    this.upsertStmt.run(record.id, JSON.stringify(record), new Date().toISOString())
  }

  all(): SessionRecord[] {
    const rows = this.allStmt.all() as Array<{ record: string }>
    return rows.map((r) => JSON.parse(r.record) as SessionRecord)
  }
}
