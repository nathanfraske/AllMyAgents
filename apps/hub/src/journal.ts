import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { redact } from './redact.js'
import type { HubEvent } from './types.js'

export class Journal extends EventEmitter {
  readonly db: Database.Database
  private readonly insertStmt: Database.Statement
  private readonly insertWorkerStmt: Database.Statement
  private readonly lastWseqStmt: Database.Statement
  private readonly sinceStmt: Database.Statement

  constructor(file: string) {
    super()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    // Two hub processes briefly share this DB during a blue-green restart (docs/agent-detachment-impl.md
    // §4.3). WAL allows many readers + one writer, but with NO busy_timeout a concurrent writer throws
    // SQLITE_BUSY immediately. Wait up to 5s so the sub-second flip window never surfaces a spurious error.
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL)'
    )
    // Additive, back-compat: tag worker-relayed events with their per-session worker seq so a restarted
    // hub can derive the durable re-attach cursor MAX(wseq) (docs/agent-worker-impl.md §7.1). Old rows
    // are NULL. Guarded so re-running on an already-migrated DB is a no-op.
    const hasWseq = (this.db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'wseq'").get() as unknown) != null
    if (!hasWseq) {
      try {
        this.db.exec('ALTER TABLE events ADD COLUMN wseq INTEGER')
      } catch (e) {
        // Swallow a lost race on the FIRST migration (two processes both saw the column absent) — the
        // column exists either way. Any other ALTER failure is real and re-thrown.
        if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e
      }
    }
    this.insertStmt = this.db.prepare('INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)')
    this.insertWorkerStmt = this.db.prepare('INSERT INTO events (ts, session, kind, payload, wseq) VALUES (?, ?, ?, ?, ?)')
    this.lastWseqStmt = this.db.prepare('SELECT MAX(wseq) AS m FROM events WHERE session = ? AND wseq IS NOT NULL')
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

  /**
   * Append a WORKER-relayed event, tagging it with the source per-session `wseq` so a restarted hub can
   * derive the durable re-attach cursor via lastJournaledWseq (docs/agent-worker-impl.md §7.1). Same
   * redaction + emit path as append(), so the event reaches reconnected operator panes identically.
   */
  appendWorker(sessionId: string, kind: string, payload: unknown, wseq: number): HubEvent {
    const ts = new Date().toISOString()
    const clean = redact(JSON.stringify(payload ?? null))
    const info = this.insertWorkerStmt.run(ts, sessionId, kind, clean, wseq)
    const event: HubEvent = { seq: Number(info.lastInsertRowid), ts, sessionId, kind, payload: JSON.parse(clean) as unknown }
    this.emit('event', event)
    return event
  }

  /** Highest worker `wseq` durably journaled for a session (0 if none) — the exactly-once re-attach
   *  cursor handed to the worker's attach(since) at hub boot (docs/agent-worker-impl.md §7.1). */
  lastJournaledWseq(sessionId: string): number {
    const row = this.lastWseqStmt.get(sessionId) as { m: number | null } | undefined
    return row?.m ?? 0
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

  /**
   * Replay EVERY event with seq > `seq`, in ascending order, exactly once, paging through the DB
   * in bounded chunks (`pageSize`) so an arbitrarily large journal is never materialized as a
   * single result set. `since()` alone caps at `pageSize` rows — a lone call silently drops the
   * tail; this drains until a short page proves the end is reached (H1).
   *
   * This is a *synchronous* generator (better-sqlite3 reads are synchronous), so a caller can
   * drain it and attach a live listener in the same tick with no intervening `await`. That is what
   * lets the WS handler join replay→live with no gap and no duplicate: single-threaded JS means no
   * `append()` can interleave between the final page read and `on('event', …)`.
   */
  *replay(seq: number, pageSize = 2000): Generator<HubEvent> {
    let cursor = seq
    for (;;) {
      const batch = this.since(cursor, pageSize)
      for (const event of batch) yield event
      const last = batch[batch.length - 1]
      if (batch.length < pageSize || !last) return
      cursor = last.seq
    }
  }
}
