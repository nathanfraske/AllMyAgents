import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { redact } from './redact.js'
import type { ApprovalStatus, HubEvent } from './types.js'

/**
 * The per-session marker a restarted hub journals when the worker has respawned and the session's worker
 * `wseq` will RESTART at 1 for the next worker era (docs/agent-worker-impl.md §7.1 — F1). The reset-aware
 * {@link Journal.lastJournaledWseq} counts only wseq rows journaled AFTER the latest such marker, so the
 * durable re-attach cursor rebases to 0 for the new era instead of returning the stale old-era `MAX(wseq)`
 * (which would seed a too-high cursor and silently DROP the fresh turn's live events). Append-only +
 * additive: a DB with no marker (old rows, the flag-off path) counts every row exactly as before.
 */
export const WSEQ_RESET_KIND = 'session/wseq-reset'

export class Journal extends EventEmitter {
  readonly db: Database.Database
  private readonly insertStmt: Database.Statement
  private readonly insertWorkerStmt: Database.Statement
  private readonly lastWseqStmt: Database.Statement
  private readonly sinceStmt: Database.Statement
  // Lazily built the first time a re-issued approval is reconciled (worker mode only — the in-process
  // executor never supplies a stable id, so this never runs flag-off, keeping the constructor byte-identical).
  private resolvedApprovalStmt: Database.Statement | undefined

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
    // RESET-AWARE (docs/agent-worker-impl.md §7.1 — F1): the durable re-attach cursor is the highest wseq
    // journaled for this session SINCE its latest WSEQ_RESET_KIND marker (COALESCE → 0 when there is none, so
    // an unmarked/legacy DB counts every row exactly as before). A worker respawn restarts the session's wseq
    // at 1; journaling a reset marker on the stale-sweep rebases this query so the old era's high wseq can no
    // longer contaminate the successor's cursor and drop the fresh turn's events.
    this.lastWseqStmt = this.db.prepare(
      `SELECT MAX(wseq) AS m FROM events
         WHERE session = ? AND wseq IS NOT NULL
           AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE session = ? AND kind = ?), 0)`
    )
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

  /** Highest worker `wseq` durably journaled for a session SINCE its latest {@link WSEQ_RESET_KIND} marker
   *  (0 if none) — the exactly-once re-attach cursor handed to the worker's attach(since) at hub boot
   *  (docs/agent-worker-impl.md §7.1). Reset-aware so a worker respawn (wseq restarts at 1) does not seed a
   *  stale, too-high cursor from the previous era's rows. */
  lastJournaledWseq(sessionId: string): number {
    const row = this.lastWseqStmt.get(sessionId, sessionId, WSEQ_RESET_KIND) as { m: number | null } | undefined
    return row?.m ?? 0
  }

  /**
   * The DURABLE resolution of an approval id — `'approved' | 'denied' | 'timeout'` — or `undefined` if the
   * id was never resolved (docs/agent-worker-impl.md §7.2). A hub restart empties {@link ApprovalService}'s
   * in-memory pending map, but the operator's decision is durable here (the `approval/resolved` row the dead
   * hub journaled). When the worker re-issues an outstanding `approvalRequest` on re-attach, a fresh hub reads
   * that decision from here and answers immediately instead of re-prompting — so an approval resolved BEFORE a
   * crash is honored EXACTLY ONCE, never re-offered. Reads the latest `approval/resolved` row for the id.
   *
   * The lookup statement + its supporting index are built LAZILY on first use so the constructor stays
   * byte-identical for the flag-off (in-process) path, which never supplies a stable id and so never reaches
   * this. The index is a partial expression index over just the (rare) `approval/resolved` rows, making the
   * id match a fast index seek rather than a backward scan of the whole journal even when no row matches (the
   * common first-time-approval case). Additive + guarded — an older hub rolled back onto the DB simply
   * ignores it.
   */
  resolvedApproval(id: string): ApprovalStatus | undefined {
    if (!this.resolvedApprovalStmt) {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_events_resolved_approval ON events(json_extract(payload, '$.id')) WHERE kind = 'approval/resolved'"
      )
      this.resolvedApprovalStmt = this.db.prepare(
        "SELECT payload FROM events WHERE kind = 'approval/resolved' AND json_extract(payload, '$.id') = ? ORDER BY seq DESC LIMIT 1"
      )
    }
    const row = this.resolvedApprovalStmt.get(id) as { payload: string } | undefined
    if (!row) return undefined
    const status = (JSON.parse(row.payload) as { status?: ApprovalStatus }).status
    // Only a terminal status counts as "resolved"; anything else (never expected on an approval/resolved row)
    // is treated as not-resolved so the caller re-prompts rather than silently swallowing the request.
    return status === 'approved' || status === 'denied' || status === 'timeout' ? status : undefined
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

  /** The most recent event (kind + ts) for a session, or undefined if it has none. Read-only; used by the
   *  peek_agent tool to summarize a teammate's latest activity without interrupting them. */
  lastEventForSession(sessionId: string): { kind: string; ts: string } | undefined {
    const row = this.db
      .prepare('SELECT kind, ts FROM events WHERE session = ? ORDER BY seq DESC LIMIT 1')
      .get(sessionId) as { kind: string; ts: string } | undefined
    return row ?? undefined
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
