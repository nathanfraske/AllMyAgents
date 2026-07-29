import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { planCompletedTurnHistory, type JournalHistoryRow } from './journalHistory.js'
import {
  reserveReplicationPruneGate,
  type ReplicationPruneGate,
} from './journalReplication.js'
import { sanitizeJournalPayload } from './journalPayload.js'
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
// These horizons describe a possible opt-in history policy, but both lossy batch limits stay ZERO until a
// future explicit operator control enables it. The distinction is load-bearing: the one-hour condensation
// above removes only SUPERSEDED rows (an intermediate diff, or a delta whose completed item durably contains
// the aggregate). History rollup removes rows that are the ONLY copy of exact command inputs/results,
// reasoning, and diffs. Silently starting that irreversible act merely because a chat turned 30 days old is
// indefensible without advance warning and a known-good recovery path.
export const JOURNAL_HISTORY_GRACE_MS = 30 * 24 * 60 * 60 * 1000
export const JOURNAL_HISTORY_RETENTION_MS = 5 * 365 * 24 * 60 * 60 * 1000
export const JOURNAL_HISTORY_MAX_TURNS = 0
export const JOURNAL_HISTORY_MAX_EXPIRED_TURNS = 0
export const JOURNAL_HISTORY_MAX_SOURCE_ROWS = 10_000
export const JOURNAL_HISTORY_MAX_SOURCE_BYTES = 128 * 1024 * 1024
export const JOURNAL_HISTORY_TOOL_TEXT_CHARS = 2_000
export const JOURNAL_HISTORY_ROLLUP_CHARS = 32_000

export type JournalCondenseOptions = {
  nowMs?: number
  graceMs?: number
  maxCommandOutputDeltas?: number
  maxDiffSnapshots?: number
  historyGraceMs?: number
  historyRetentionMs?: number
  maxHistoryTurns?: number
  maxExpiredHistoryTurns?: number
  maxHistorySourceRows?: number
  maxHistorySourceBytes?: number
  historyToolTextChars?: number
  historyRollupChars?: number
}

export type JournalCondenseResult = {
  commandOutputDeltasDeleted: number
  diffSnapshotsDeleted: number
  cursorCheckpointsWritten: number
  historyTurnsRolledUp: number
  historyTurnsDeferred: number
  historyTurnsExpired: number
  historyRowsDeleted: number
  historyPayloadBytesSelected: number
  historyPayloadBytesWritten: number
  replication: ReplicationPruneGate
}

export class Journal extends EventEmitter {
  readonly db: Database.Database
  private readonly atomicEventBuffers: HubEvent[][] = []
  private readonly insertStmt: Database.Statement
  private readonly insertWorkerStmt: Database.Statement
  private readonly lastWseqStmt: Database.Statement
  private readonly sinceStmt: Database.Statement
  private readonly currentBusNoticeStmt: Database.Statement
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
    // DURABILITY. Without this SQLite uses synchronous=NORMAL under WAL, which does not fsync the WAL on
    // every commit: a power cut or a hard kill mid-write can leave the WAL torn, and a torn WAL takes the
    // whole journal down with it.
    //
    // That is not hypothetical here. This journal is subjected to exactly those conditions as a matter of
    // routine: the supervisor kills hubs with `taskkill /T /F` on Windows and SIGTERM to a process group on
    // POSIX, blue-green restarts overlap two writers, and the operator's machine took three forced Windows
    // Update reboots in four minutes. Their journal was corrupted twice in two days and once had to be
    // restored from a backup, losing fourteen hours of history.
    //
    // FULL costs an fsync per commit. That is the correct trade for a store whose entire purpose is to be
    // the durable record of what every agent did — a fast journal that loses a day is worth nothing.
    this.db.pragma('synchronous = FULL')
    // Bound how much unflushed history the WAL can accumulate. It had grown to 15 MB, which is both a large
    // window of work to lose and a large surface to corrupt. Checkpointing more eagerly keeps the base file
    // close to current, so a damaged WAL costs minutes rather than hours.
    this.db.pragma('wal_autocheckpoint = 256')
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
    this.currentBusNoticeStmt = this.db.prepare(`
      SELECT kind
      FROM events
      WHERE session = ?
        AND kind IN ('session/turn-origin', 'bus/pending-notice-attempted')
      ORDER BY seq DESC
      LIMIT 1
    `)
  }

  append(sessionId: string | null, kind: string, payload: unknown): HubEvent {
    const ts = new Date().toISOString()
    const clean = redactedJson(sanitizeJournalPayload(payload))
    const info = this.insertStmt.run(ts, sessionId, kind, clean)
    const event: HubEvent = {
      seq: Number(info.lastInsertRowid),
      ts,
      sessionId,
      kind,
      payload: JSON.parse(clean) as unknown,
    }
    this.publish(event)
    return event
  }

  /**
   * Append a WORKER-relayed event, tagging it with the source per-session `wseq` so a restarted hub can
   * derive the durable re-attach cursor via lastJournaledWseq (docs/agent-worker-impl.md §7.1). Same
   * redaction + emit path as append(), so the event reaches reconnected operator panes identically.
   */
  appendWorker(sessionId: string, kind: string, payload: unknown, wseq: number): HubEvent {
    const ts = new Date().toISOString()
    const clean = redactedJson(sanitizeJournalPayload(payload))
    const info = this.insertWorkerStmt.run(ts, sessionId, kind, clean, wseq)
    const event: HubEvent = { seq: Number(info.lastInsertRowid), ts, sessionId, kind, payload: JSON.parse(clean) as unknown }
    this.publish(event)
    return event
  }

  /**
   * Commit materialized state and its audit rows as one SQLite decision. Events are emitted only after
   * COMMIT: a crash rolls back both tables, while a committed authority change can never exist without
   * its journal evidence. Nested callers fold their events into the outer transaction's buffer.
   */
  atomic<T>(fn: () => T): T {
    const events: HubEvent[] = []
    this.atomicEventBuffers.push(events)
    try {
      const value = this.db.transaction(fn).immediate()
      this.atomicEventBuffers.pop()
      const parent = this.atomicEventBuffers.at(-1)
      if (parent) parent.push(...events)
      else {
        for (const event of events) {
          try {
            this.emit('event', event)
          } catch (error) {
            // The durable decision already committed. A subscriber must not turn that into an apparent
            // rollback in the caller while the database contains the new state.
            console.warn(
              `[journal] event subscriber failed after atomic commit (${event.kind}): ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          }
        }
      }
      return value
    } catch (error) {
      this.atomicEventBuffers.pop()
      throw error
    }
  }

  private publish(event: HubEvent): void {
    const buffer = this.atomicEventBuffers.at(-1)
    if (buffer) buffer.push(event)
    else this.emit('event', event)
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
   * Condense the two measured Codex firehoses, then project old completed turns into bounded history.
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
   * This intentionally does NOT VACUUM. SQLite will reuse the pages freed by both stages, stopping retained
   * history from growing the file after its window reaches steady state, but shrinking an existing DB is a
   * separate operator maintenance action: full VACUUM takes an exclusive rewrite plus roughly one database
   * of free disk, while changing an existing DB to auto_vacuum=INCREMENTAL itself requires that same one-time
   * full VACUUM.
   */
  condenseCompletedCodex(options: JournalCondenseOptions = {}): JournalCondenseResult {
    const nowMs = options.nowMs ?? Date.now()
    const graceMs = options.graceMs ?? JOURNAL_CONDENSE_GRACE_MS
    const maxCommandOutputDeltas = options.maxCommandOutputDeltas ?? JOURNAL_CONDENSE_MAX_COMMAND_DELTAS
    const maxDiffSnapshots = options.maxDiffSnapshots ?? JOURNAL_CONDENSE_MAX_DIFF_SNAPSHOTS
    const historyGraceMs = options.historyGraceMs ?? JOURNAL_HISTORY_GRACE_MS
    const historyRetentionMs = options.historyRetentionMs ?? JOURNAL_HISTORY_RETENTION_MS
    const maxHistoryTurns = options.maxHistoryTurns ?? JOURNAL_HISTORY_MAX_TURNS
    const maxExpiredHistoryTurns = options.maxExpiredHistoryTurns ?? JOURNAL_HISTORY_MAX_EXPIRED_TURNS
    const maxHistorySourceRows = options.maxHistorySourceRows ?? JOURNAL_HISTORY_MAX_SOURCE_ROWS
    const maxHistorySourceBytes = options.maxHistorySourceBytes ?? JOURNAL_HISTORY_MAX_SOURCE_BYTES
    const historyToolTextChars = options.historyToolTextChars ?? JOURNAL_HISTORY_TOOL_TEXT_CHARS
    const historyRollupChars = options.historyRollupChars ?? JOURNAL_HISTORY_ROLLUP_CHARS
    for (const [name, value] of [
      ['nowMs', nowMs],
      ['graceMs', graceMs],
      ['maxCommandOutputDeltas', maxCommandOutputDeltas],
      ['maxDiffSnapshots', maxDiffSnapshots],
      ['historyGraceMs', historyGraceMs],
      ['historyRetentionMs', historyRetentionMs],
      ['maxHistoryTurns', maxHistoryTurns],
      ['maxExpiredHistoryTurns', maxExpiredHistoryTurns],
      ['maxHistorySourceRows', maxHistorySourceRows],
      ['maxHistorySourceBytes', maxHistorySourceBytes],
      ['historyToolTextChars', historyToolTextChars],
      ['historyRollupChars', historyRollupChars],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`)
    }
    const commandLimit = Math.floor(maxCommandOutputDeltas)
    const diffLimit = Math.floor(maxDiffSnapshots)
    const now = new Date(nowMs).toISOString()
    const cutoff = new Date(nowMs - graceMs).toISOString()
    // Replication is opt-in for existing journals. Once configured, however, it is a hard deletion gate:
    // reserve the exact verified generations BEFORE selecting anything destructive, then constrain every
    // DELETE/UPDATE path by the kth replica's durable snapshot seq. An offline fleet therefore grows past
    // its last verified watermark; it never quietly trades the only archive copy for free disk.
    const replication = reserveReplicationPruneGate(this.db)
    const maxPrunableSeq = replication.maxPrunableSeq

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
    // worker events. The live hub only appends; the single maintenance child owns old-row rewrites, and a
    // concurrent cursor advance/reset is re-read inside the write transaction below.
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
             AND candidate.seq <= ?
             AND typeof(candidate.thread_id) = 'text'
             AND typeof(candidate.turn_id) = 'text'
             AND typeof(candidate.item_id) = 'text'
           ORDER BY candidate.seq
           LIMIT ?`
        )
        .run(cutoff, maxPrunableSeq, commandLimit)
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
             AND candidate.seq <= ?
             AND keep.seq IS NULL
             AND typeof(candidate.thread_id) = 'text'
             AND typeof(candidate.turn_id) = 'text'
           ORDER BY candidate.seq
           LIMIT ?`
        )
        .run(cutoff, maxPrunableSeq, diffLimit)
    }
    selectCandidates()

    const applyDeletes = this.db.transaction(
      (): Pick<
        JournalCondenseResult,
        'commandOutputDeltasDeleted' | 'diffSnapshotsDeleted' | 'cursorCheckpointsWritten'
      > => {
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
      }
    )
    const transient = applyDeletes.immediate()
    const history = this.rollupCompletedHistory({
      nowMs,
      historyGraceMs,
      historyRetentionMs,
      maxHistoryTurns: Math.floor(maxHistoryTurns),
      maxExpiredHistoryTurns: Math.floor(maxExpiredHistoryTurns),
      maxHistorySourceRows: Math.floor(maxHistorySourceRows),
      maxHistorySourceBytes: Math.floor(maxHistorySourceBytes),
      historyToolTextChars: Math.floor(historyToolTextChars),
      historyRollupChars: Math.floor(historyRollupChars),
      maxPrunableSeq,
    })
    return {
      ...transient,
      ...history,
      cursorCheckpointsWritten: transient.cursorCheckpointsWritten + history.cursorCheckpointsWritten,
      replication,
    }
  }

  /**
   * Roll old, terminal-bounded turns into a durable transcript rather than retaining their protocol
   * machinery forever.
   *
   * This deliberately remains in `events`. Hub-native history is still reconstructed solely by
   * Journal.replay(), and a previous hub binary may be launched during rollback. Moving canonical history
   * into a new table today would make it invisible to both readers. Instead the rollup uses event shapes
   * every shipped client already understands: exact session/input + assistant prose remains in place, and
   * old tool/reasoning detail is represented by one `codex/item/completed` commandExecution card whose
   * command says "history rollup; no command executed".
   *
   * Candidate parsing happens before the write transaction. The transaction re-checks every updated
   * payload, writes any required rollback-compatible wseq checkpoint, deletes the selected rows, reuses one
   * deleted seq for the rollup, and records the terminal as done. A crash exposes either the old turn or the
   * complete rollup, never half of each.
   */
  private rollupCompletedHistory(options: {
    nowMs: number
    historyGraceMs: number
    historyRetentionMs: number
    maxHistoryTurns: number
    maxExpiredHistoryTurns: number
    maxHistorySourceRows: number
    maxHistorySourceBytes: number
    historyToolTextChars: number
    historyRollupChars: number
    maxPrunableSeq: number
  }): Omit<
    JournalCondenseResult,
    'commandOutputDeltasDeleted' | 'diffSnapshotsDeleted' | 'replication'
  > {
    const empty = {
      cursorCheckpointsWritten: 0,
      historyTurnsRolledUp: 0,
      historyTurnsDeferred: 0,
      historyTurnsExpired: 0,
      historyRowsDeleted: 0,
      historyPayloadBytesSelected: 0,
      historyPayloadBytesWritten: 0,
    }
    if (options.maxHistoryTurns === 0 && options.maxExpiredHistoryTurns === 0) return empty

    const cutoff = new Date(options.nowMs - options.historyGraceMs).toISOString()
    const now = new Date(options.nowMs).toISOString()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_turn_rollups (
        terminal_seq INTEGER PRIMARY KEY,
        session TEXT NOT NULL,
        terminal_ts TEXT NOT NULL,
        terminal_kind TEXT NOT NULL,
        rollup_seq INTEGER,
        rows_deleted INTEGER NOT NULL,
        payload_bytes_selected INTEGER NOT NULL,
        payload_bytes_written INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expired INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_journal_turn_rollups_expiry
        ON journal_turn_rollups (expired, terminal_ts, terminal_seq);
      CREATE TABLE IF NOT EXISTS journal_history_boundaries (
        session TEXT PRIMARY KEY,
        marker_seq INTEGER NOT NULL UNIQUE,
        first_ts TEXT NOT NULL,
        last_ts TEXT NOT NULL,
        turns INTEGER NOT NULL,
        rows_deleted INTEGER NOT NULL,
        payload_bytes_deleted INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_history_terminals
        ON events (ts, seq) WHERE kind IN ('claude/result', 'codex/turn/completed');
      CREATE INDEX IF NOT EXISTS idx_events_history_terminal_session
        ON events (session, seq) WHERE kind IN ('claude/result', 'codex/turn/completed');

      CREATE TEMP TABLE IF NOT EXISTS journal_history_delete (
        seq INTEGER PRIMARY KEY
      );
    `)

    const terminals = this.db
      .prepare(
        `SELECT event.seq, event.ts, event.session, event.kind
         FROM events AS event
         LEFT JOIN journal_turn_rollups AS done ON done.terminal_seq = event.seq
         WHERE event.session IS NOT NULL
           AND event.kind IN ('claude/result', 'codex/turn/completed')
           AND event.ts <= ?
           AND event.seq <= ?
           AND done.terminal_seq IS NULL
         ORDER BY event.seq
         LIMIT ?`
      )
      .all(cutoff, options.maxPrunableSeq, options.maxHistoryTurns) as Array<{
      seq: number
      ts: string
      session: string
      kind: string
    }>

    const result = { ...empty }
    const previousTerminalStmt = this.db.prepare(
      `SELECT MAX(seq) AS seq
       FROM events
       WHERE session = ? AND seq < ? AND kind IN ('claude/result', 'codex/turn/completed')`
    )
    const turnRowsStmt = this.db.prepare(
      `SELECT seq, ts, session, kind, payload, wseq
       FROM events
       WHERE session = ? AND seq > ? AND seq <= ?
       ORDER BY seq`
    )
    const turnSizeStmt = this.db.prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes
       FROM events
       WHERE session = ? AND seq > ? AND seq <= ?`
    )
    const currentStateRowsStmt = this.db.prepare(
      `SELECT MAX(seq) AS seq
       FROM events
       WHERE session = ? AND kind IN ('codex/thread/tokenUsage/updated', 'session/tokens')
       GROUP BY kind`
    )
    const clearDeleteStmt = this.db.prepare('DELETE FROM journal_history_delete')
    const selectDeleteStmt = this.db.prepare('INSERT OR IGNORE INTO journal_history_delete (seq) VALUES (?)')
    const updatePayloadStmt = this.db.prepare('UPDATE events SET payload = ? WHERE seq = ? AND payload = ?')
    const deleteRowsStmt = this.db.prepare(
      'DELETE FROM events WHERE seq IN (SELECT seq FROM journal_history_delete)'
    )
    const insertRollupStmt = this.db.prepare(
      'INSERT INTO events (seq, ts, session, kind, payload, wseq) VALUES (?, ?, ?, ?, ?, NULL)'
    )
    const recordRollupStmt = this.db.prepare(
      `INSERT INTO journal_turn_rollups (
         terminal_seq, session, terminal_ts, terminal_kind, rollup_seq, rows_deleted,
         payload_bytes_selected, payload_bytes_written, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const checkpointStmt = this.db.prepare(
      `INSERT INTO events (ts, session, kind, payload, wseq)
       SELECT ?, cursor.session, ?, ?, cursor.wseq
       FROM worker_cursors AS cursor
       JOIN journal_history_delete AS selected ON selected.seq = cursor.event_seq
       JOIN events AS existing ON existing.seq = selected.seq`
    )

    const applyPlan = this.db.transaction(
      (
        terminal: { seq: number; ts: string; session: string; kind: string },
        plan: ReturnType<typeof planCompletedTurnHistory>
      ) => {
        clearDeleteStmt.run()
        for (const seq of plan.deleteSeqs) selectDeleteStmt.run(seq)

        const cursorCheckpointsWritten = checkpointStmt.run(
          now,
          WSEQ_CHECKPOINT_KIND,
          JSON.stringify({ reason: 'journal history rollup replaced a current transient wseq anchor' })
        ).changes

        // An event payload is immutable outside maintenance. Checking the old bytes turns an unexpected
        // second writer/schema migration into a full transaction rollback rather than overwriting it.
        for (const update of plan.updates) {
          const changed = updatePayloadStmt.run(update.payload, update.seq, update.expectedPayload).changes
          if (changed !== 1) throw new Error(`journal history row ${update.seq} changed while planning rollup`)
        }

        const rowsDeleted = deleteRowsStmt.run().changes
        if (rowsDeleted !== plan.deleteSeqs.length) {
          throw new Error(
            `journal history rollup selected ${plan.deleteSeqs.length} row(s) but deleted ${rowsDeleted}`
          )
        }
        if (plan.rollup) {
          insertRollupStmt.run(
            plan.rollup.seq,
            plan.rollup.ts,
            terminal.session,
            'codex/item/completed',
            plan.rollup.payload
          )
        }
        recordRollupStmt.run(
          terminal.seq,
          terminal.session,
          terminal.ts,
          terminal.kind,
          plan.rollup?.seq ?? null,
          rowsDeleted,
          plan.payloadBytesSelected,
          plan.payloadBytesWritten,
          now
        )
        return { cursorCheckpointsWritten, rowsDeleted }
      }
    )

    for (const terminal of terminals) {
      const previous = previousTerminalStmt.get(terminal.session, terminal.seq) as { seq: number | null }
      const size = turnSizeStmt.get(terminal.session, previous.seq ?? 0, terminal.seq) as {
        rows: number
        bytes: number
      }
      // A machine can return after maintenance was absent for months. Do not let the first child turn one
      // enormous, delta-heavy turn into an unbounded synchronous parse + DELETE: the earlier capped
      // transient sweep chips away at it first, and a later interval rolls it once it fits this envelope.
      if (size.rows > options.maxHistorySourceRows || size.bytes > options.maxHistorySourceBytes) {
        result.historyTurnsDeferred += 1
        continue
      }
      const rows = turnRowsStmt.all(terminal.session, previous.seq ?? 0, terminal.seq) as JournalHistoryRow[]
      const protectedSeqs = new Set(
        (currentStateRowsStmt.all(terminal.session) as Array<{ seq: number }>).map((row) => row.seq)
      )
      const plan = planCompletedTurnHistory(rows, terminal.seq, terminal.kind, {
        maxToolTextChars: options.historyToolTextChars,
        maxRollupChars: options.historyRollupChars,
        protectedSeqs,
      })
      const applied = applyPlan.immediate(terminal, plan)
      result.historyTurnsRolledUp += 1
      result.historyRowsDeleted += applied.rowsDeleted
      result.cursorCheckpointsWritten += applied.cursorCheckpointsWritten
      result.historyPayloadBytesSelected += plan.payloadBytesSelected
      result.historyPayloadBytesWritten += plan.payloadBytesWritten
    }

    if (options.maxExpiredHistoryTurns === 0) return result

    // Exact prose has a multi-year horizon, not an infinite one. Once that horizon passes, consolidate
    // every expired turn for a session into ONE boundary card. The marker is deliberately another
    // commandExecution shape, because every shipped client renders it as a tool card without changing
    // session status or pretending the operator/assistant authored it. Its command and body both say that
    // no command ran and exact detail is unavailable.
    const expiryCutoff = new Date(options.nowMs - options.historyRetentionMs).toISOString()
    const expiryCandidates = this.db
      .prepare(
        `SELECT terminal_seq, session, terminal_ts, terminal_kind
         FROM journal_turn_rollups
         WHERE expired = 0 AND terminal_ts <= ? AND terminal_seq <= ?
         ORDER BY terminal_seq
         LIMIT ?`
      )
      .all(expiryCutoff, options.maxPrunableSeq, options.maxExpiredHistoryTurns) as Array<{
      terminal_seq: number
      session: string
      terminal_ts: string
      terminal_kind: string
    }>
    const expiryRowsStmt = this.db.prepare(
      `SELECT seq, ts, session, kind, payload, wseq
         FROM events
         WHERE session = ?
           AND seq > ?
           AND seq < ?
           AND json_valid(payload)
           AND kind IN (
             'session/input',
             'bus/sent',
             'bus/delivered',
             'memory/recalled',
             'practice/wrote',
             'practice/edited',
             'claude/assistant',
           'claude/user',
           'claude/system',
           'codex/item/completed',
           'codex/item/agentMessage/delta'
         )
       ORDER BY seq`
    )
    const getBoundaryStmt = this.db.prepare(
      `SELECT marker_seq, first_ts, last_ts, turns, rows_deleted, payload_bytes_deleted
       FROM journal_history_boundaries
       WHERE session = ?`
    )
    const getEventBySeqStmt = this.db.prepare(
      'SELECT seq, ts, session, kind, payload, wseq FROM events WHERE seq = ?'
    )
    const upsertBoundaryStmt = this.db.prepare(
      `INSERT INTO journal_history_boundaries (
         session, marker_seq, first_ts, last_ts, turns, rows_deleted,
         payload_bytes_deleted, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session) DO UPDATE SET
         marker_seq = excluded.marker_seq,
         first_ts = excluded.first_ts,
         last_ts = excluded.last_ts,
         turns = excluded.turns,
         rows_deleted = excluded.rows_deleted,
         payload_bytes_deleted = excluded.payload_bytes_deleted,
         updated_at = excluded.updated_at`
    )
    const markExpiredStmt = this.db.prepare(
      'UPDATE journal_turn_rollups SET expired = 1 WHERE terminal_seq = ? AND expired = 0'
    )

    const expireTurn = this.db.transaction(
      (
        candidate: {
          terminal_seq: number
          session: string
          terminal_ts: string
          terminal_kind: string
        },
        rows: JournalHistoryRow[]
      ) => {
        const existing = getBoundaryStmt.get(candidate.session) as
          | {
              marker_seq: number
              first_ts: string
              last_ts: string
              turns: number
              rows_deleted: number
              payload_bytes_deleted: number
            }
          | undefined
        const existingMarker = existing
          ? (getEventBySeqStmt.get(existing.marker_seq) as JournalHistoryRow | undefined)
          : undefined
        if (existing && !existingMarker) {
          // The metadata and visible marker are one invariant. Do not silently advance/degrade if a manual
          // DB repair removed only half; surface a maintenance error and leave the turn exact.
          throw new Error(
            `journal history boundary metadata for ${candidate.session} points to missing seq ${existing.marker_seq}`
          )
        }

        clearDeleteStmt.run()
        for (const row of rows) selectDeleteStmt.run(row.seq)
        if (existingMarker) selectDeleteStmt.run(existingMarker.seq)

        const markerSeq = rows[0]?.seq ?? existingMarker?.seq
        const currentRowsDeleted = rows.length
        const currentBytesDeleted = rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0)
        const firstTs = existing?.first_ts ?? rows[0]?.ts ?? candidate.terminal_ts
        const lastTs = candidate.terminal_ts
        const turns = (existing?.turns ?? 0) + 1
        const cumulativeRows = (existing?.rows_deleted ?? 0) + currentRowsDeleted
        const cumulativeBytes = (existing?.payload_bytes_deleted ?? 0) + currentBytesDeleted
        const boundaryPayload =
          markerSeq == null
            ? undefined
            : makeHistoryBoundaryPayload({
                session: candidate.session,
                firstTs,
                lastTs,
                turns,
                rowsDeleted: cumulativeRows,
                payloadBytesDeleted: cumulativeBytes,
              })

        const cursorCheckpointsWritten = checkpointStmt.run(
          now,
          WSEQ_CHECKPOINT_KIND,
          JSON.stringify({ reason: 'journal history retention replaced a current transcript wseq anchor' })
        ).changes
        const rowsDeleted = deleteRowsStmt.run().changes
        const expectedDeletes = rows.length + (existingMarker ? 1 : 0)
        if (rowsDeleted !== expectedDeletes) {
          throw new Error(
            `journal history expiry selected ${expectedDeletes} row(s) but deleted ${rowsDeleted}`
          )
        }
        if (markerSeq != null && boundaryPayload) {
          insertRollupStmt.run(
            markerSeq,
            rows[0]?.ts ?? existingMarker?.ts ?? candidate.terminal_ts,
            candidate.session,
            'codex/item/completed',
            boundaryPayload
          )
          upsertBoundaryStmt.run(
            candidate.session,
            markerSeq,
            firstTs,
            lastTs,
            turns,
            cumulativeRows,
            cumulativeBytes,
            now
          )
        }
        if (markExpiredStmt.run(candidate.terminal_seq).changes !== 1) {
          throw new Error(`journal history terminal ${candidate.terminal_seq} changed while expiring`)
        }
        return {
          cursorCheckpointsWritten,
          rowsDeleted,
          selectedBytes: currentBytesDeleted + (existingMarker ? Buffer.byteLength(existingMarker.payload) : 0),
          writtenBytes: boundaryPayload ? Buffer.byteLength(boundaryPayload) : 0,
        }
      }
    )

    for (const candidate of expiryCandidates) {
      const previous = previousTerminalStmt.get(candidate.session, candidate.terminal_seq) as {
        seq: number | null
      }
      const rows = expiryRowsStmt.all(
        candidate.session,
        previous.seq ?? 0,
        candidate.terminal_seq
      ) as JournalHistoryRow[]
      const applied = expireTurn.immediate(candidate, rows)
      result.historyTurnsExpired += 1
      result.historyRowsDeleted += applied.rowsDeleted
      result.cursorCheckpointsWritten += applied.cursorCheckpointsWritten
      result.historyPayloadBytesSelected += applied.selectedBytes
      result.historyPayloadBytesWritten += applied.writtenBytes
    }
    return result
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

  /**
   * Whether this turn has already attempted the deliberately-small "mail is waiting" steer.
   *
   * The latest turn-origin row is the boundary. Keeping this fence in the journal—not only a process-local
   * Set—preserves "at most once per turn" when the worker keeps the turn alive across a hub restart.
   */
  hasBusPendingNoticeInCurrentTurn(sessionId: string): boolean {
    const row = this.currentBusNoticeStmt.get(sessionId) as { kind: string } | undefined
    return row?.kind === 'bus/pending-notice-attempted'
  }

  lastEventForSession(sessionId: string): { kind: string; ts: string } | undefined {
    const row = this.db
      .prepare('SELECT kind, ts FROM events WHERE session = ? ORDER BY seq DESC LIMIT 1')
      .get(sessionId) as { kind: string; ts: string } | undefined
    return row ?? undefined
  }

  /**
   * Newest exact events for one session, scoped in SQL before payload materialization. Manager roster
   * composition uses this small reverse-chronological window to describe real tool/activity state without
   * reading a child's full transcript or trusting prose the child wrote about itself.
   */
  recentEventsForSession(sessionId: string, limit = 40): HubEvent[] {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)))
    const rows = this.db
      .prepare(
        'SELECT seq, ts, session, kind, payload FROM events WHERE session = ? ORDER BY seq DESC LIMIT ?'
      )
      .all(sessionId, bounded) as Array<{
        seq: number
        ts: string
        session: string | null
        kind: string
        payload: string
      }>
    return rows.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      sessionId: row.session,
      kind: row.kind,
      payload: parsePayload(row.payload, row.seq),
    }))
  }

  /**
   * Exact per-session event page for manager-owned worker inspection. Unlike `since()`, this is scoped in
   * SQL before materialization, so inspecting one child never reads or exposes unrelated transcripts.
   */
  eventsForSession(
    sessionId: string,
    afterSeq = 0,
    limit = 200
  ): { events: HubEvent[]; nextAfterSeq: number | null } {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)))
    const rows = this.db
      .prepare(
        'SELECT seq, ts, session, kind, payload FROM events WHERE session = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
      )
      .all(sessionId, Math.max(0, Math.floor(afterSeq)), bounded + 1) as Array<{
        seq: number
        ts: string
        session: string | null
        kind: string
        payload: string
      }>
    const hasMore = rows.length > bounded
    const page = hasMore ? rows.slice(0, bounded) : rows
    const events = page.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      sessionId: row.session,
      kind: row.kind,
      payload: parsePayload(row.payload, row.seq),
    }))
    return {
      events,
      nextAfterSeq: hasMore ? (events.at(-1)?.seq ?? null) : null,
    }
  }

  /**
   * Replay EVERY event with seq > `seq`, in ascending order, exactly once, paging through the DB
   * in bounded chunks (`pageSize`) so an arbitrarily large journal is never materialized as a
   * single result set. `since()` alone caps at `pageSize` rows — a lone call silently drops the
   * tail; this drains until a short page proves the end is reached (H1).
   *
   * The pages share one SQLite read transaction. That was not needed while the journal was append-only,
   * but history maintenance runs in ANOTHER process and can replace old rows between two page SELECTs.
   * Without a snapshot one reconnect could get a hybrid: raw tool call on page N, its result deleted before
   * page N+1, and only half the rollup. WAL lets the maintenance writer commit while this reader keeps its
   * pre-commit snapshot.
   *
   * This is a *synchronous* generator (better-sqlite3 reads are synchronous), so a caller can drain it and
   * attach a live listener in the same tick with no intervening `await`. That is what lets the WS handler
   * join replay→live with no gap and no duplicate: single-threaded JS means no local `append()` can
   * interleave between the final page read and `on('event', …)`.
   */
  *replay(seq: number, pageSize = 2000): Generator<HubEvent> {
    const ownsSnapshot = !this.db.inTransaction
    if (ownsSnapshot) this.db.exec('BEGIN DEFERRED')
    try {
      let cursor = seq
      for (;;) {
        const batch = this.since(cursor, pageSize)
        for (const event of batch) yield event
        const last = batch[batch.length - 1]
        if (batch.length < pageSize || !last) return
        cursor = last.seq
      }
    } finally {
      if (ownsSnapshot && this.db.inTransaction) this.db.exec('COMMIT')
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

function makeHistoryBoundaryPayload(input: {
  session: string
  firstTs: string
  lastTs: string
  turns: number
  rowsDeleted: number
  payloadBytesDeleted: number
}): string {
  const bytes = new Intl.NumberFormat('en-US').format(input.payloadBytesDeleted)
  const rows = new Intl.NumberFormat('en-US').format(input.rowsDeleted)
  const turns = new Intl.NumberFormat('en-US').format(input.turns)
  return JSON.stringify({
    threadId: 'allmyagents-history',
    turnId: `history-boundary:${input.session}`,
    item: {
      id: `history-boundary:${input.session}`,
      type: 'commandExecution',
      command: `AllMyAgents history boundary (${turns} completed turns; no command executed)`,
      aggregatedOutput:
        `AllMyAgents retained this visible boundary after the configured history horizon.\n` +
        `The exact transcript detail is no longer available for ${turns} completed turns from ` +
        `${input.firstTs} through ${input.lastTs}.\n` +
        `${rows} old transcript rows (${bytes} payload bytes) were consolidated. ` +
        `Session lifecycle, approval decisions, turn terminals, worker cursors, and reset markers remain durable.`,
      status: 'completed',
      exitCode: 0,
    },
    __allmyagentsHistoryBoundary: true,
  })
}
