import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { redact } from './redact.js'
import type { HubEvent } from './types.js'

export class Journal extends EventEmitter {
  readonly db: Database.Database
  private readonly insertStmt: Database.Statement
  private readonly sinceStmt: Database.Statement

  constructor(file: string) {
    super()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL)'
    )
    this.insertStmt = this.db.prepare('INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)')
    this.sinceStmt = this.db.prepare(
      'SELECT seq, ts, session, kind, payload FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?'
    )
  }

  append(sessionId: string | null, kind: string, payload: unknown): HubEvent {
    const ts = new Date().toISOString()
    const clean = redact(JSON.stringify(payload ?? null))
    const info = this.insertStmt.run(ts, sessionId, kind, clean)
    const event: HubEvent = {
      seq: Number(info.lastInsertRowid),
      ts,
      sessionId,
      kind,
      payload: JSON.parse(clean) as unknown,
    }
    this.emit('event', event)
    return event
  }

  since(seq: number, limit = 2000): HubEvent[] {
    const rows = this.sinceStmt.all(seq, limit) as Array<{
      seq: number
      ts: string
      session: string | null
      kind: string
      payload: string
    }>
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      sessionId: r.session,
      kind: r.kind,
      payload: JSON.parse(r.payload) as unknown,
    }))
  }
}
