import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { redactedJson } from './redact.js'
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

/**
 * A tiny rollback-compatible replacement for a transient event that happened to carry the current worker
 * cursor. New hubs read `worker_cursors`; an older binary still runs the historical reset-aware MAX(wseq)
 * query, so condensation must leave one compact event-row anchor too. These markers are durable cursor
 * metadata, not transcript, and are deliberately outside the two-kind condensation allowlist.
 */
export const WSEQ_CHECKPOINT_KIND = 'session/wseq-checkpoint'

export const JOURNAL_CONDENSE_GRACE_MS = 60 * 60 * 1000
export const JOURNAL_CONDENSE_INTERVAL_MS = 5 * 60 * 1000
export const JOURNAL_CONDENSE_MAX_COMMAND_DELTAS = 5_000
export const JOURNAL_CONDENSE_MAX_DIFF_SNAPSHOTS = 25

export type JournalCondenseOptions = {
  nowMs?: number
  graceMs?: number
  maxCommandOutputDeltas?: number
  maxDiffSnapshots?: number
}

export type JournalCondenseResult = {
  commandOutputDeltasDeleted: number
  diffSnapshotsDeleted: number
  cursorCheckpointsWritten: number
}

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
    // `MAX(wseq)` was originally derived from the event rows themselves. That made otherwise-safe
    // condensation capable of moving the durable re-attach cursor BACKWARDS: delete the row carrying the
    // maximum and a restarted hub asks the worker to replay it, duplicating already-journaled output.
    //
    // Keep the high-water mark in a separate durable table, maintained by DATABASE triggers rather than by
    // appendWorker convention. The trigger matters during a blue-green flip: once the green creates it, an
    // older blue sharing this DB also advances the cursor even though its JavaScript knows nothing about the
    // table. A reset marker atomically rebases the row to zero. Condensation never deletes this table.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_cursors (
        session TEXT PRIMARY KEY,
        wseq INTEGER NOT NULL,
        event_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal_migrations (
        name TEXT PRIMARY KEY
      );

      CREATE TRIGGER IF NOT EXISTS events_worker_cursor_advance
      AFTER INSERT ON events
      WHEN NEW.session IS NOT NULL AND NEW.wseq IS NOT NULL
      BEGIN
        INSERT INTO worker_cursors (session, wseq, event_seq)
        VALUES (NEW.session, NEW.wseq, NEW.seq)
        ON CONFLICT(session) DO UPDATE SET
          wseq = excluded.wseq,
          event_seq = excluded.event_seq
        WHERE excluded.wseq >= worker_cursors.wseq;
      END;

      CREATE TRIGGER IF NOT EXISTS events_worker_cursor_reset
      AFTER INSERT ON events
      WHEN NEW.session IS NOT NULL AND NEW.kind = '${WSEQ_RESET_KIND}'
      BEGIN
        INSERT INTO worker_cursors (session, wseq, event_seq)
        VALUES (NEW.session, 0, NEW.seq)
        ON CONFLICT(session) DO UPDATE SET
          wseq = 0,
          event_seq = excluded.event_seq;
      END;
    `)
    // Additive migration for journals written before worker_cursors existed. Create the INSERT triggers
    // first, then backfill with INSERT/UPSERT: if the briefly-concurrent blue writes while green migrates,
    // its trigger-created row wins when newer and the backfill can only raise (never lower) that high-water.
    // The latest reset bounds the window exactly as the old query did.
    const backfillWorkerCursors = this.db.transaction(() => {
      const done = this.db
        .prepare("SELECT 1 FROM journal_migrations WHERE name = 'worker-cursors-v1'")
        .get() as unknown
      if (done) return
      this.db.exec(`
        INSERT INTO worker_cursors (session, wseq, event_seq)
        SELECT session, wseq, seq
        FROM (
          WITH latest_reset AS (
            SELECT session, MAX(seq) AS reset_seq
            FROM events
            WHERE session IS NOT NULL AND kind = '${WSEQ_RESET_KIND}'
            GROUP BY session
          )
          SELECT
            e.session,
            e.wseq,
            e.seq,
            ROW_NUMBER() OVER (
              PARTITION BY e.session
              ORDER BY e.wseq DESC, e.seq DESC
            ) AS rank
          FROM events AS e
          LEFT JOIN latest_reset AS reset ON reset.session = e.session
          WHERE e.session IS NOT NULL
            AND e.wseq IS NOT NULL
            AND e.seq > COALESCE(reset.reset_seq, 0)
        )
        WHERE rank = 1
        ON CONFLICT(session) DO UPDATE SET
          wseq = excluded.wseq,
          event_seq = excluded.event_seq
        WHERE excluded.wseq > worker_cursors.wseq;

        INSERT OR IGNORE INTO worker_cursors (session, wseq, event_seq)
        SELECT session, 0, MAX(seq)
        FROM events
        WHERE session IS NOT NULL AND kind = '${WSEQ_RESET_KIND}'
        GROUP BY session;

        INSERT INTO journal_migrations (name) VALUES ('worker-cursors-v1');
      `)
    })
    backfillWorkerCursors.immediate()
    this.insertStmt = this.db.prepare('INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)')
    this.insertWorkerStmt = this.db.prepare('INSERT INTO events (ts, session, kind, payload, wseq) VALUES (?, ?, ?, ?, ?)')
    // This lookup is independent of condensable rows. The reset-aware legacy event query remains valid too
    // because the sweep writes WSEQ_CHECKPOINT_KIND before removing its current event-row anchor.
    this.lastWseqStmt = this.db.prepare('SELECT wseq AS m FROM worker_cursors WHERE session = ?')
    this.sinceStmt = this.db.prepare(
      'SELECT seq, ts, session, kind, payload FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?'
    )
  }

  append(sessionId: string | null, kind: string, payload: unknown): HubEvent {
    const ts = new Date().toISOString()
    const clean = redactedJson(payload)
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
    const clean = redactedJson(payload)
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
    const row = this.lastWseqStmt.get(sessionId) as { m: number | null } | undefined
    return row?.m ?? 0
  }

  /**
   * Condense the two measured Codex firehoses after their authoritative terminal records are old enough.
   *
   * `commandExecution/outputDelta` is deleted only when the same session/thread/turn/item has an old
   * commandExecution `item/completed`, whose `aggregatedOutput` is the final replacement. Cumulative
   * `turn/diff/updated` snapshots wait for `turn/completed`; the newest snapshot remains because the
   * terminal event does NOT contain the diff. Invalid JSON and incomplete correlations fail closed.
   *
   * The selected deletes are capped. better-sqlite3 is synchronous, and this method is also useful from
   * tests/manual maintenance; an unbounded 300k-row DELETE would trade turn-completion latency for a random
   * multi-second hub stall. Production invokes it in a one-shot child process as a second defense, keeping
   * JSON scans off the hub event loop and bounding the SQLite writer-lock/WAL burst.
   *
   * This intentionally does NOT VACUUM. SQLite will reuse the freed pages, stopping this firehose from
   * growing the file, but shrinking an existing DB is a separate operator maintenance action: full VACUUM
   * takes an exclusive rewrite plus roughly one database of free disk, while changing an existing DB to
   * auto_vacuum=INCREMENTAL itself requires that same one-time full VACUUM.
   */
  condenseCompletedCodex(options: JournalCondenseOptions = {}): JournalCondenseResult {
    const nowMs = options.nowMs ?? Date.now()
    const graceMs = options.graceMs ?? JOURNAL_CONDENSE_GRACE_MS
    const maxCommandOutputDeltas = options.maxCommandOutputDeltas ?? JOURNAL_CONDENSE_MAX_COMMAND_DELTAS
    const maxDiffSnapshots = options.maxDiffSnapshots ?? JOURNAL_CONDENSE_MAX_DIFF_SNAPSHOTS
    for (const [name, value] of [
      ['nowMs', nowMs],
      ['graceMs', graceMs],
      ['maxCommandOutputDeltas', maxCommandOutputDeltas],
      ['maxDiffSnapshots', maxDiffSnapshots],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`)
    }
    const commandLimit = Math.floor(maxCommandOutputDeltas)
    const diffLimit = Math.floor(maxDiffSnapshots)
    const now = new Date(nowMs).toISOString()
    const cutoff = new Date(nowMs - graceMs).toISOString()

    // Built lazily by the maintenance child, after the hub is healthy. Creating an index over the operator's
    // existing 375k-row journal at boot would turn a recoverability feature into a new deterministic boot
    // dependency. The partial indexes cover only the four maintenance kinds; ordinary durable events pay no
    // index write cost.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_condense_command_completed
        ON events (ts, seq) WHERE kind = 'codex/item/completed';
      CREATE INDEX IF NOT EXISTS idx_events_condense_turn_completed
        ON events (ts, seq) WHERE kind = 'codex/turn/completed';
      CREATE INDEX IF NOT EXISTS idx_events_condense_command_delta
        ON events (seq) WHERE kind = 'codex/item/commandExecution/outputDelta';
      CREATE INDEX IF NOT EXISTS idx_events_condense_diff
        ON events (seq) WHERE kind = 'codex/turn/diff/updated';

      CREATE TEMP TABLE IF NOT EXISTS journal_condense_commands (
        session TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (session, thread_id, turn_id, item_id)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS journal_condense_turns (
        session TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        PRIMARY KEY (session, thread_id, turn_id)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS journal_condense_diff_keep (
        seq INTEGER PRIMARY KEY
      );
      CREATE TEMP TABLE IF NOT EXISTS journal_condense_delete (
        seq INTEGER PRIMARY KEY
      );
    `)

    // Candidate discovery writes TEMP only and reads the main DB. Keep it outside the main write transaction
    // so the expensive JSON validation/extraction does not hold SQLite's single WAL writer lock against live
    // worker events. Event rows are append-only, so a selected seq remains safe to re-check/delete moments
    // later; a concurrent cursor advance/reset is re-read inside the write transaction below.
    const selectCandidates = (): void => {
      this.db.exec(`
        DELETE FROM journal_condense_commands;
        DELETE FROM journal_condense_turns;
        DELETE FROM journal_condense_diff_keep;
        DELETE FROM journal_condense_delete;
      `)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_commands (session, thread_id, turn_id, item_id)
           SELECT session, thread_id, turn_id, item_id
           FROM (
             SELECT
               session,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END AS thread_id,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.turnId') END AS turn_id,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.item.id') END AS item_id,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.item.type') END AS item_type,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.item.aggregatedOutput') END AS final_output
             FROM events
             WHERE kind = 'codex/item/completed' AND ts <= ? AND session IS NOT NULL
           )
           WHERE typeof(thread_id) = 'text'
             AND typeof(turn_id) = 'text'
             AND typeof(item_id) = 'text'
             AND item_type = 'commandExecution'
             AND typeof(final_output) = 'text'`
        )
        .run(cutoff)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_turns (session, thread_id, turn_id)
           SELECT session, thread_id, turn_id
           FROM (
             SELECT
               session,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END AS thread_id,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.turn.id') END AS turn_id
             FROM events
             WHERE kind = 'codex/turn/completed' AND ts <= ? AND session IS NOT NULL
           )
           WHERE typeof(thread_id) = 'text' AND typeof(turn_id) = 'text'`
        )
        .run(cutoff)

      // The final diff is itself authoritative: turn/completed carries status/items but no patch. Compute the
      // newest valid snapshot across the whole matched turn (not merely before cutoff), then exclude it.
      this.db.exec(`
        INSERT OR IGNORE INTO journal_condense_diff_keep (seq)
        SELECT MAX(candidate.seq)
        FROM (
          SELECT
            seq,
            session,
            CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END AS thread_id,
            CASE WHEN json_valid(payload) THEN json_extract(payload, '$.turnId') END AS turn_id
          FROM events
          WHERE kind = 'codex/turn/diff/updated' AND session IS NOT NULL
        ) AS candidate
        JOIN journal_condense_turns AS terminal
          ON terminal.session = candidate.session
         AND terminal.thread_id = candidate.thread_id
         AND terminal.turn_id = candidate.turn_id
        WHERE typeof(candidate.thread_id) = 'text' AND typeof(candidate.turn_id) = 'text'
        GROUP BY candidate.session, candidate.thread_id, candidate.turn_id;
      `)

      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_delete (seq)
           SELECT candidate.seq
           FROM (
             SELECT
               seq,
               ts,
               session,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END AS thread_id,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.turnId') END AS turn_id,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.itemId') END AS item_id
             FROM events
             WHERE kind = 'codex/item/commandExecution/outputDelta' AND session IS NOT NULL
           ) AS candidate
           JOIN journal_condense_commands AS terminal
             ON terminal.session = candidate.session
            AND terminal.thread_id = candidate.thread_id
            AND terminal.turn_id = candidate.turn_id
            AND terminal.item_id = candidate.item_id
           WHERE candidate.ts <= ?
             AND typeof(candidate.thread_id) = 'text'
             AND typeof(candidate.turn_id) = 'text'
             AND typeof(candidate.item_id) = 'text'
           ORDER BY candidate.seq
           LIMIT ?`
        )
        .run(cutoff, commandLimit)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_delete (seq)
           SELECT candidate.seq
           FROM (
             SELECT
               seq,
               ts,
               session,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END AS thread_id,
               CASE WHEN json_valid(payload) THEN json_extract(payload, '$.turnId') END AS turn_id
             FROM events
             WHERE kind = 'codex/turn/diff/updated' AND session IS NOT NULL
           ) AS candidate
           JOIN journal_condense_turns AS terminal
             ON terminal.session = candidate.session
            AND terminal.thread_id = candidate.thread_id
            AND terminal.turn_id = candidate.turn_id
           LEFT JOIN journal_condense_diff_keep AS keep ON keep.seq = candidate.seq
           WHERE candidate.ts <= ?
             AND keep.seq IS NULL
             AND typeof(candidate.thread_id) = 'text'
             AND typeof(candidate.turn_id) = 'text'
           ORDER BY candidate.seq
           LIMIT ?`
        )
        .run(cutoff, diffLimit)
    }
    selectCandidates()

    const applyDeletes = this.db.transaction((): JournalCondenseResult => {
      // worker_cursors makes the new reader independent of event retention. A rollback can still launch the
      // old MAX(wseq)-from-events reader, though, so if a selected transient row is the current anchor, first
      // replace it with a tiny checkpoint carrying the same wseq. The advance trigger atomically points the
      // table at this new row; both old and new binaries then retain the exact cursor across the DELETE.
      //
      // This internal marker is inserted by the maintenance child and intentionally is not EventEmitter-
      // emitted to live panes. It has no UI state; replay/polling may see and ignore it like any unknown kind.
      const cursorCheckpointsWritten = this.db
        .prepare(
          `INSERT INTO events (ts, session, kind, payload, wseq)
           SELECT ?, cursor.session, ?, ?, cursor.wseq
           FROM worker_cursors AS cursor
           JOIN journal_condense_delete AS selected ON selected.seq = cursor.event_seq
           JOIN events AS existing ON existing.seq = selected.seq`
        )
        .run(
          now,
          WSEQ_CHECKPOINT_KIND,
          JSON.stringify({ reason: 'journal condensation replaced a transient wseq anchor' })
        ).changes
      const commandOutputDeltasDeleted = this.db
        .prepare(
          `DELETE FROM events
           WHERE kind = 'codex/item/commandExecution/outputDelta'
             AND seq IN (SELECT seq FROM journal_condense_delete)`
        )
        .run().changes
      const diffSnapshotsDeleted = this.db
        .prepare(
          `DELETE FROM events
           WHERE kind = 'codex/turn/diff/updated'
             AND seq IN (SELECT seq FROM journal_condense_delete)`
        )
        .run().changes
      return { commandOutputDeltasDeleted, diffSnapshotsDeleted, cursorCheckpointsWritten }
    })
    return applyDeletes.immediate()
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
      // NEVER let one malformed row take the hub down. A redaction bug once wrote a payload containing an
      // invalid escape; because this parse was unguarded, every WebSocket replay that crossed that row
      // threw and the app crash-looped on startup until the row was repaired by hand. The write side is
      // fixed now, but a durable store outlives the bug that wrote into it: a row we cannot read is a gap
      // to surface, not a reason to stop serving the other three hundred thousand.
      payload: parsePayload(r.payload, r.seq),
    }))
  }

  /** The most recent event (kind + ts) for a session, or undefined if it has none. Read-only; used by the
   *  peek_agent tool to summarize a teammate's latest activity without interrupting them. */
  /**
   * The origin of the session's most recent turn — who caused it — or undefined if it has never run one.
   *
   * Turn provenance decides whether the hub may auto-approve a tool call (an operator's own turn may; a
   * teammate's bus message must not). It used to live only in hub memory, which meant a hub restart
   * ERASED it: a turn that survived the restart lost the fact that the operator started it, and its very
   * next tool call raised an approval nobody was expecting — a Full Access chat silently blocked, mid-work.
   *
   * Reading it back from the journal makes provenance survive exactly as long as the turn does.
   */
  lastTurnOrigin(sessionId: string): 'operator' | 'bus' | undefined {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE session = ? AND kind = 'session/turn-origin' ORDER BY seq DESC LIMIT 1")
      .get(sessionId) as { payload: string } | undefined
    if (!row) return undefined
    try {
      const origin = (JSON.parse(row.payload) as { origin?: unknown }).origin
      return origin === 'operator' || origin === 'bus' ? origin : undefined
    } catch {
      return undefined
    }
  }

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

/**
 * Parse a stored payload, degrading to a visible marker rather than throwing.
 *
 * Keeps replay TOTAL for stored rows: the client receives this event and advances to its real seq, while
 * the operator sees that something was unreadable instead of the hub silently skipping it or dying.
 * Sequence values need not be contiguous after intentional journal condensation; cursors are `seq > ?`.
 */
function parsePayload(raw: string, seq: number): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch (err) {
    return { __unreadable: true, seq, reason: err instanceof Error ? err.message : String(err) }
  }
}
