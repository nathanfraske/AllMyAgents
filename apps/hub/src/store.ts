import type Database from 'better-sqlite3'
import type { SessionRecord } from './types.js'

export class SessionStore {
  private readonly upsertStmt: Database.Statement
  private readonly allStmt: Database.Statement
  private readonly removeStmt: Database.Statement

  constructor(db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL, updated TEXT NOT NULL)'
    )
    this.upsertStmt = db.prepare(
      'INSERT INTO sessions (id, record, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record, updated = excluded.updated'
    )
    this.allStmt = db.prepare('SELECT record FROM sessions ORDER BY updated ASC')
    this.removeStmt = db.prepare('DELETE FROM sessions WHERE id = ?')
  }

  upsert(record: SessionRecord): void {
    this.upsertStmt.run(record.id, JSON.stringify(record), new Date().toISOString())
  }

  // Drop a session from the persisted snapshot so a hub restart won't restore it. This is the
  // materialized-view counterpart to the `session/deleted` journal tombstone: boot() rebuilds the
  // in-memory map from all() (see SessionManager.boot), so removing the row here is exactly
  // "remove the deleted id from the restored map." Idempotent — deleting an unknown id is a no-op.
  remove(id: string): void {
    this.removeStmt.run(id)
  }

  all(): SessionRecord[] {
    const rows = this.allStmt.all() as Array<{ record: string }>
    return rows.map((r) => JSON.parse(r.record) as SessionRecord)
  }
}
