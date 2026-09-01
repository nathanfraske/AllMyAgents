import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { planCompletedTurnHistory, type JournalHistoryRow } from './journalHistory.js'
import {
  reserveReplicationPruneGate,
  type ReplicationPruneGate,
} from './journalReplication.js'
import {
  JOURNAL_BLOB_INLINE_LIMIT_BYTES,
  JOURNAL_BLOB_KEY,
  JournalBlobStore,
} from './journalBlobStore.js'
import { sanitizeJournalPayload } from './journalPayload.js'
import { redactedJson } from './redact.js'
import type { ApprovalStatus, HubEvent } from './types.js'

export interface ResolvedQuestion {
  sessionId: string
  status: 'answered' | 'cancelled' | 'aborted' | 'interrupted'
  correlationDigest: string
  questionDigest: string
  reason?: 'hub-restarted' | 'worker-restarted' | 'interrupted_by_restart'
}

export interface DurableQuestion {
  id: string
  sessionId: string
  correlationDigest: string
  questionDigest: string
  ownerEpoch: string
  status: 'pending' | ResolvedQuestion['status']
  reason?: ResolvedQuestion['reason']
}

export interface RegisterQuestionResult {
  created: boolean
  state: DurableQuestion
}

export interface ResolveQuestionResult {
  written: boolean
  state: ResolvedQuestion
}

export interface RestartInterruptedTurn {
  restartGeneration: string
  sessionId: string
  questionCount: number
  /** Owner-process receipt only; never persisted or journaled. */
  questionIds: readonly string[]
}

export interface RestartContinuityExcerpt {
  sourceSeq: number
  questionCount: number
  events: Array<{ seq: number; kind: string; payload: unknown }>
}

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
export const JOURNAL_CONDENSE_MAX_AGENT_MESSAGE_DELTAS = 5_000
export const JOURNAL_CONDENSE_MAX_DIFF_SNAPSHOTS = 5_000
export const JOURNAL_CONDENSE_MAX_ITEM_STARTED = 5_000
export const JOURNAL_CONDENSE_MAX_DELETE_ROWS = 3_500
export const JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES = 8 * 1024 * 1024
/** Resident SQLite target. Exact oversized transcript bytes live in the lossless content-addressed store. */
export const JOURNAL_SQLITE_TARGET_BYTES = 2 * 1024 * 1024 * 1024
/** At 4 KiB pages this reclaims at most 64 MiB per ordinary maintenance cycle. */
export const JOURNAL_STORAGE_MAX_INCREMENTAL_VACUUM_PAGES = 16_384
export const JOURNAL_REPLAY_PROTOCOL_VERSION = 1 as const
export const JOURNAL_HISTORY_PAGE_MAX_ROWS = 80
export const JOURNAL_HISTORY_PAGE_MAX_BYTES = 512 * 1024
// A UI page seeds one viewport; it is not a transcript dump. The wider constants above remain the hard
// API/test ceiling, while normal panes use the smaller working set and page older history losslessly.
export const JOURNAL_HISTORY_VIEW_ROWS = 40
export const JOURNAL_HISTORY_VIEW_BYTES = 256 * 1024

// A history page is a transcript projection, not a second copy of the raw worker protocol. Codex
// streams one journal row for almost every text/output fragment, so selecting the latest 80 raw rows
// can return nothing but deltas from a single tool call and strand every completed operator/assistant
// message behind hundreds of "load older" requests. Every kind below is independently meaningful to
// journalHistoryReducer; terminal Codex items already carry the complete message/tool payload, making
// their preceding deltas redundant for recovery. Keep this list beside the storage query so the DB can
// use the per-session sequence index and skip transient rows before applying the row/byte page bounds.
const JOURNAL_HISTORY_EVENT_KINDS = [
  'session/input',
  'bus/sent',
  'bus/delivered',
  'question/recovery-unknown',
  'question/restart-interrupted',
  'session/error',
  'session/mode',
  'session/worktree-created',
  'memory/recalled',
  'claude/assistant',
  'claude/user',
  'claude/system',
  'claude/result',
  'codex/thread/compacted',
  'codex/turn/completed',
  'codex/item/completed',
  'codex/subagent/item/completed',
] as const
const JOURNAL_HISTORY_EVENT_KIND_SET = new Set<string>(JOURNAL_HISTORY_EVENT_KINDS)
const JOURNAL_HISTORY_EVENT_KINDS_SQL = JOURNAL_HISTORY_EVENT_KINDS
  .map((kind) => `'${kind.replaceAll("'", "''")}'`)
  .join(', ')
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
  /** Immutable inclusive event frontier proven covered by the deletion-authorizing snapshot. */
  deleteThroughSeq?: number
  maxCommandOutputDeltas?: number
  maxAgentMessageDeltas?: number
  maxDiffSnapshots?: number
  maxItemStarted?: number
  maxTransientPayloadBytes?: number
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
  agentMessageDeltasDeleted: number
  diffSnapshotsDeleted: number
  itemStartedDeleted: number
  transientPayloadBytesDeleted: number
  oversizedTransientRowsRetained: number
  writerLockMs: number
  cursorCheckpointsWritten: number
  historyTurnsRolledUp: number
  historyTurnsDeferred: number
  historyTurnsExpired: number
  historyRowsDeleted: number
  historyPayloadBytesSelected: number
  historyPayloadBytesWritten: number
  replication: ReplicationPruneGate
}

export interface ReplayCheckpoint {
  version: typeof JOURNAL_REPLAY_PROTOCOL_VERSION
  generation: number
  cursor: number
  resetFloorSeq: number
}

export interface SessionHistoryPage {
  events: HubEvent[]
  olderCursor: number | null
  hasOlder: boolean
  encodedBytes: number
  checkpointGeneration: number
}

export interface JournalBlobMigrationResult {
  rowsScanned: number
  rowsRewritten: number
  sourceBytesScanned: number
  sqliteBytesReleased: number
  bytesExternalized: number
  scannedThrough: number
  target: number
  complete: boolean
}

export interface JournalStorageEnforcementResult {
  targetBytes: number
  bytesBefore: number
  bytesAfter: number
  freelistPagesBefore: number
  freelistPagesAfter: number
  action: 'none' | 'incremental-vacuum' | 'full-vacuum'
  withinTarget: boolean
}

export interface BoundedReplayPage {
  checkpoint: ReplayCheckpoint
  events: HubEvent[]
  lastSeq: number
  hasMore: boolean
  encodedBytes: number
  tooLarge?: {
    seq: number
    encodedBytes: number
  }
}

export type JournalCompactionPhase =
  | 'started'
  | 'progress'
  | 'completed'
  | 'deferred'
  | 'failed'
  | 'unobservable'

export interface JournalCompactionStatus {
  operationId: string
  phase: JournalCompactionPhase
  startedAt: string
  updatedAt: string
  rowsDeleted: number
  payloadBytesDeleted: number
  detail: string
}

export class SessionHistoryIndexingError extends Error {
  constructor(
    readonly scannedThrough: number,
    readonly target: number
  ) {
    super(`journal history index is building (${scannedThrough}/${target})`)
    this.name = 'SessionHistoryIndexingError'
  }
}

export class TransientHistoryIndexingError extends Error {
  constructor(
    readonly scannedThrough: number,
    readonly target: number
  ) {
    super(`journal transient maintenance index is building (${scannedThrough}/${target})`)
    this.name = 'TransientHistoryIndexingError'
  }
}

export class ReplayGenerationChangedError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number
  ) {
    super(`journal replay generation changed (${expected} -> ${actual})`)
    this.name = 'ReplayGenerationChangedError'
  }
}

/** SQLite writer contention is expected while the live hub and maintenance child share the WAL. */
export function isTransientSqliteContention(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  if (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_')) return true
  if (code === 'SQLITE_LOCKED' || code.startsWith('SQLITE_LOCKED_')) return true
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:database|database table|schema) is locked\b/i.test(message)
}

export class Journal extends EventEmitter {
  readonly db: Database.Database
  private readonly payloadBlobs: JournalBlobStore | undefined
  private readonly atomicEventBuffers: HubEvent[][] = []
  private transientMaintenanceIndexesReady = false
  private readonly insertStmt: Database.Statement
  private readonly insertWorkerStmt: Database.Statement
  private readonly lastWseqStmt: Database.Statement
  private readonly sinceStmt: Database.Statement
  private readonly currentBusNoticeStmt: Database.Statement
  // Lazily built the first time a re-issued approval is reconciled (worker mode only — the in-process
  // executor never supplies a stable id, so this never runs flag-off, keeping the constructor byte-identical).
  private resolvedApprovalStmt: Database.Statement | undefined
  private questionRecoveryUnknownStmt: Database.Statement | undefined

  constructor(file: string, options: { busyTimeoutMs?: number } = {}) {
    super()
    const requestedBusyTimeoutMs = options.busyTimeoutMs ?? 5_000
    if (!Number.isSafeInteger(requestedBusyTimeoutMs) || requestedBusyTimeoutMs < 0 || requestedBusyTimeoutMs > 60_000) {
      throw new Error('journal busy timeout must be a whole number from 0 to 60000 milliseconds')
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.payloadBlobs = file === ':memory:'
      ? undefined
      : new JournalBlobStore(path.join(path.dirname(path.resolve(file)), 'journal-blobs'))
    this.db = new Database(file)
    const freshDatabase = Number(
      this.db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'").pluck().get(),
    ) === 0
    // New journals can reclaim bounded maintenance deletes incrementally. Existing journals retain their
    // mode until the one-time operator VACUUM that physically removes legacy inline payload pages; that
    // VACUUM may then opt them into the same steady-state policy without a second full rewrite.
    if (freshDatabase) this.db.pragma('auto_vacuum = INCREMENTAL')
    this.db.pragma('journal_mode = WAL')
    // Two hub processes briefly share this DB during a blue-green restart (docs/agent-detachment-impl.md
    // §4.3). WAL allows many readers + one writer, but with NO busy_timeout a concurrent writer throws
    // SQLITE_BUSY immediately. Ordinary connections wait 5s; isolated maintenance may opt into a longer,
    // still-bounded wait without stalling the hub's event loop.
    this.db.pragma(`busy_timeout = ${requestedBusyTimeoutMs}`)
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
    // Interactive question bodies are needed only while the matching SDK callback is live and therefore
    // stay only in the bounded owner process memory. This table stores summary metadata (never prompt,
    // description, preview, or answer bytes). Its primary key is the cross-process blue/green CAS.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS question_lifecycles (
        id TEXT PRIMARY KEY,
        session TEXT NOT NULL,
        correlation_digest TEXT NOT NULL,
        tool_use_id_length INTEGER NOT NULL,
        request_id_length INTEGER NOT NULL,
        question_digest TEXT NOT NULL,
        owner_epoch TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled', 'aborted', 'interrupted')),
        terminal_reason TEXT,
        input_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_question_lifecycles_pending
        ON question_lifecycles(status, session);
      CREATE TABLE IF NOT EXISTS question_restart_interruptions (
        restart_generation TEXT NOT NULL,
        session TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('planned', 'crash')),
        boundary TEXT NOT NULL CHECK (boundary IN ('pending', 'completed', 'unknown')),
        question_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (restart_generation, session)
      );
      CREATE INDEX IF NOT EXISTS idx_question_restart_interruptions_pending
        ON question_restart_interruptions(boundary, session);
    `)
    // The immediately preceding Ask candidate allowed only `aborted`. A test/live candidate DB can survive
    // into this build even though older public releases had no table at all. Widen the CHECK transactionally
    // instead of relying on CREATE TABLE IF NOT EXISTS, which never updates an existing constraint.
    const questionLifecycleSql = (
      this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'question_lifecycles'")
        .get() as { sql?: string } | undefined
    )?.sql
    if (questionLifecycleSql && !questionLifecycleSql.includes("'interrupted'")) {
      try {
        this.db.exec(`
          BEGIN IMMEDIATE;
          DROP INDEX IF EXISTS idx_question_lifecycles_pending;
          ALTER TABLE question_lifecycles RENAME TO question_lifecycles_before_interrupted;
          CREATE TABLE question_lifecycles (
            id TEXT PRIMARY KEY,
            session TEXT NOT NULL,
            correlation_digest TEXT NOT NULL,
            tool_use_id_length INTEGER NOT NULL,
            request_id_length INTEGER NOT NULL,
            question_digest TEXT NOT NULL,
            owner_epoch TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled', 'aborted', 'interrupted')),
            terminal_reason TEXT,
            input_bytes INTEGER NOT NULL,
            created_at TEXT NOT NULL
          );
          INSERT INTO question_lifecycles
            (id, session, correlation_digest, tool_use_id_length, request_id_length,
             question_digest, owner_epoch, status, terminal_reason, input_bytes, created_at)
          SELECT id, session, correlation_digest, tool_use_id_length, request_id_length,
                 question_digest, owner_epoch, status, terminal_reason, input_bytes, created_at
          FROM question_lifecycles_before_interrupted;
          DROP TABLE question_lifecycles_before_interrupted;
          CREATE INDEX idx_question_lifecycles_pending
            ON question_lifecycles(status, session);
          COMMIT;
        `)
      } catch (error) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* transaction may already have rolled back */
        }
        const racedSql = (
          this.db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'question_lifecycles'"
            )
            .get() as { sql?: string } | undefined
        )?.sql
        if (!racedSql?.includes("'interrupted'")) throw error
      }
    }
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
      CREATE TABLE IF NOT EXISTS journal_replay_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        reset_floor_seq INTEGER NOT NULL DEFAULT 0 CHECK (reset_floor_seq >= 0),
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO journal_replay_state
        (singleton, generation, reset_floor_seq, updated_at)
      VALUES (1, 1, 0, '1970-01-01T00:00:00.000Z');
      CREATE TABLE IF NOT EXISTS journal_session_event_index (
        session TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (session, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS journal_session_index_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        scanned_through INTEGER NOT NULL CHECK (scanned_through >= 0)
      );
      INSERT OR IGNORE INTO journal_session_index_state (singleton, scanned_through) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS journal_session_history_event_index (
        session TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (session, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS journal_session_history_index_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        scanned_through INTEGER NOT NULL CHECK (scanned_through >= 0)
      );
      INSERT OR IGNORE INTO journal_session_history_index_state (singleton, scanned_through)
      VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS journal_transient_event_index (
        seq INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        ts TEXT NOT NULL,
        session TEXT,
        payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
        thread_id TEXT,
        turn_id TEXT,
        item_id TEXT,
        item_type TEXT,
        canonical_terminal INTEGER NOT NULL DEFAULT 0 CHECK (canonical_terminal IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS idx_journal_transient_kind_seq
        ON journal_transient_event_index(kind, seq);
      CREATE TABLE IF NOT EXISTS journal_transient_index_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        scanned_through INTEGER NOT NULL CHECK (scanned_through >= 0)
      );
      INSERT OR IGNORE INTO journal_transient_index_state (singleton, scanned_through)
      VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS journal_migrations (
        name TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS journal_blob_migration_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        scanned_through INTEGER NOT NULL CHECK (scanned_through >= 0),
        bytes_externalized INTEGER NOT NULL DEFAULT 0 CHECK (bytes_externalized >= 0),
        rows_rewritten INTEGER NOT NULL DEFAULT 0 CHECK (rows_rewritten >= 0),
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO journal_blob_migration_state
        (singleton, scanned_through, bytes_externalized, rows_rewritten, updated_at)
      VALUES (1, 0, 0, 0, '1970-01-01T00:00:00.000Z');
      CREATE TABLE IF NOT EXISTS journal_compaction_runs (
        operation_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL CHECK (
          phase IN ('started', 'progress', 'completed', 'deferred', 'failed', 'unobservable')
        ),
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        rows_deleted INTEGER NOT NULL CHECK (rows_deleted >= 0),
        payload_bytes_deleted INTEGER NOT NULL CHECK (payload_bytes_deleted >= 0),
        detail TEXT NOT NULL CHECK (length(detail) <= 512)
      );
      CREATE INDEX IF NOT EXISTS idx_journal_compaction_runs_updated
        ON journal_compaction_runs(updated_at DESC, operation_id DESC);

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

      CREATE TRIGGER IF NOT EXISTS events_session_index_insert
      AFTER INSERT ON events
      WHEN NEW.session IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO journal_session_event_index (session, seq) VALUES (NEW.session, NEW.seq);
      END;

      CREATE TRIGGER IF NOT EXISTS events_session_index_delete
      AFTER DELETE ON events
      WHEN OLD.session IS NOT NULL
      BEGIN
        DELETE FROM journal_session_event_index WHERE session = OLD.session AND seq = OLD.seq;
      END;

      CREATE TRIGGER IF NOT EXISTS events_session_index_frontier
      AFTER INSERT ON events
      BEGIN
        UPDATE journal_session_index_state
        SET scanned_through = NEW.seq
        WHERE singleton = 1
          AND scanned_through >= COALESCE(
            (SELECT MAX(seq) FROM events WHERE seq < NEW.seq),
            0
          );
      END;

      CREATE TRIGGER IF NOT EXISTS events_session_history_index_insert
      AFTER INSERT ON events
      WHEN NEW.session IS NOT NULL
        AND (
          NEW.kind IN (${JOURNAL_HISTORY_EVENT_KINDS_SQL})
          OR (
            NEW.kind = 'codex/item/started'
            AND json_valid(NEW.payload)
            AND json_extract(NEW.payload, '$.item.type') = 'contextCompaction'
          )
        )
      BEGIN
        INSERT OR IGNORE INTO journal_session_history_event_index (session, seq)
        VALUES (NEW.session, NEW.seq);
      END;

      CREATE TRIGGER IF NOT EXISTS events_session_history_index_delete
      AFTER DELETE ON events
      WHEN OLD.session IS NOT NULL
      BEGIN
        DELETE FROM journal_session_history_event_index WHERE session = OLD.session AND seq = OLD.seq;
      END;

      CREATE TRIGGER IF NOT EXISTS events_session_history_index_frontier
      AFTER INSERT ON events
      BEGIN
        UPDATE journal_session_history_index_state
        SET scanned_through = NEW.seq
        WHERE singleton = 1
          AND scanned_through >= COALESCE(
            (SELECT MAX(seq) FROM events WHERE seq < NEW.seq),
            0
          );
      END;

      CREATE TRIGGER IF NOT EXISTS events_transient_index_insert
      AFTER INSERT ON events
      WHEN NEW.kind IN (
        'claude/result',
        'codex/item/started',
        'codex/item/completed',
        'codex/turn/completed',
        'codex/item/commandExecution/outputDelta',
        'codex/item/agentMessage/delta',
        'codex/turn/diff/updated'
      )
      BEGIN
        INSERT OR REPLACE INTO journal_transient_event_index
          (
            seq,
            kind,
            ts,
            session,
            payload_bytes,
            thread_id,
            turn_id,
            item_id,
            item_type,
            canonical_terminal
          )
        VALUES (
          NEW.seq,
          NEW.kind,
          NEW.ts,
          NEW.session,
          length(CAST(NEW.payload AS BLOB)),
          CASE WHEN json_valid(NEW.payload) THEN json_extract(NEW.payload, '$.threadId') END,
          CASE
            WHEN json_valid(NEW.payload) AND NEW.kind = 'codex/turn/completed'
              THEN json_extract(NEW.payload, '$.turn.id')
            WHEN json_valid(NEW.payload)
              THEN json_extract(NEW.payload, '$.turnId')
          END,
          CASE WHEN json_valid(NEW.payload) THEN
            COALESCE(
              json_extract(NEW.payload, '$.item.id'),
              json_extract(NEW.payload, '$.itemId')
            )
          END,
          CASE WHEN json_valid(NEW.payload) THEN json_extract(NEW.payload, '$.item.type') END,
          CASE
            WHEN NEW.kind = 'codex/item/completed'
              AND json_valid(NEW.payload)
              AND (
                (
                  json_extract(NEW.payload, '$.item.type') = 'commandExecution'
                  AND (
                    typeof(json_extract(NEW.payload, '$.item.aggregatedOutput')) = 'text'
                    OR json_type(
                      NEW.payload,
                      '$.item.aggregatedOutput.${JOURNAL_BLOB_KEY}.sha256'
                    ) = 'text'
                  )
                )
                OR (
                  json_extract(NEW.payload, '$.item.type') = 'agentMessage'
                  AND (
                    typeof(json_extract(NEW.payload, '$.item.text')) = 'text'
                    OR json_type(
                      NEW.payload,
                      '$.item.text.${JOURNAL_BLOB_KEY}.sha256'
                    ) = 'text'
                  )
                )
              )
            THEN 1
            ELSE 0
          END
        );
      END;

      CREATE TRIGGER IF NOT EXISTS events_transient_index_delete
      AFTER DELETE ON events
      BEGIN
        DELETE FROM journal_transient_event_index WHERE seq = OLD.seq;
      END;

      CREATE TRIGGER IF NOT EXISTS events_transient_index_frontier
      AFTER INSERT ON events
      BEGIN
        UPDATE journal_transient_index_state
        SET scanned_through = NEW.seq
        WHERE singleton = 1
          AND scanned_through >= COALESCE(
            (SELECT MAX(seq) FROM events WHERE seq < NEW.seq),
            0
          );
      END;
    `)
    const compactionLifecycleSql = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'journal_compaction_runs'")
      .pluck()
      .get()
    if (typeof compactionLifecycleSql === 'string' && !compactionLifecycleSql.includes("'deferred'")) {
      const widenCompactionLifecycle = this.db.transaction(() => {
        const currentSql = this.db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'journal_compaction_runs'")
          .pluck()
          .get()
        if (typeof currentSql === 'string' && currentSql.includes("'deferred'")) return
        this.db.exec(`
          DROP INDEX IF EXISTS idx_journal_compaction_runs_updated;
          ALTER TABLE journal_compaction_runs RENAME TO journal_compaction_runs_before_deferred;
          CREATE TABLE journal_compaction_runs (
            operation_id TEXT PRIMARY KEY,
            phase TEXT NOT NULL CHECK (
              phase IN ('started', 'progress', 'completed', 'deferred', 'failed', 'unobservable')
            ),
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            rows_deleted INTEGER NOT NULL CHECK (rows_deleted >= 0),
            payload_bytes_deleted INTEGER NOT NULL CHECK (payload_bytes_deleted >= 0),
            detail TEXT NOT NULL CHECK (length(detail) <= 512)
          );
          INSERT INTO journal_compaction_runs
            (operation_id, phase, started_at, updated_at, rows_deleted, payload_bytes_deleted, detail)
          SELECT operation_id, phase, started_at, updated_at, rows_deleted, payload_bytes_deleted, detail
          FROM journal_compaction_runs_before_deferred;
          DROP TABLE journal_compaction_runs_before_deferred;
          CREATE INDEX idx_journal_compaction_runs_updated
            ON journal_compaction_runs(updated_at DESC, operation_id DESC);
        `)
      })
      widenCompactionLifecycle.immediate()
    }
    const hasResetFloor =
      (this.db
        .prepare(
          "SELECT 1 FROM pragma_table_info('journal_replay_state') WHERE name = 'reset_floor_seq'"
        )
        .get() as unknown) != null
    if (!hasResetFloor) {
      try {
        this.db.exec(
          'ALTER TABLE journal_replay_state ADD COLUMN reset_floor_seq INTEGER NOT NULL DEFAULT 0 CHECK (reset_floor_seq >= 0)'
        )
      } catch (error) {
        const raced =
          (this.db
            .prepare(
              "SELECT 1 FROM pragma_table_info('journal_replay_state') WHERE name = 'reset_floor_seq'"
            )
            .get() as unknown) != null
        if (!raced) throw error
      }
    }
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
    // The transient projection predates `codex/item/started`. Merely widening the trigger would index
    // future rows but strand every existing start row behind a frontier already marked complete. Rewind
    // only the projection cursor (never the journal itself) once; the post-ready maintenance child then
    // replays the table in its existing bounded batches, INSERT OR IGNORE-ing old projection members and
    // adding the newly eligible kind without putting a full events scan back on startup.
    const widenTransientProjection = this.db.transaction(() => {
      const done = this.db
        .prepare("SELECT 1 FROM journal_migrations WHERE name = 'transient-item-started-v1'")
        .get() as unknown
      if (done) return
      this.db.exec(`
        UPDATE journal_transient_index_state SET scanned_through = 0 WHERE singleton = 1;
        INSERT INTO journal_migrations (name) VALUES ('transient-item-started-v1');
      `)
    })
    widenTransientProjection.immediate()
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
    const clean = JSON.parse(redactedJson(sanitizeJournalPayload(payload))) as unknown
    const stored = JSON.stringify(this.payloadBlobs?.encode(clean).stored ?? clean)
    const info = this.insertStmt.run(ts, sessionId, kind, stored)
    const event: HubEvent = {
      seq: Number(info.lastInsertRowid),
      ts,
      sessionId,
      kind,
      payload: clean,
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
    const clean = JSON.parse(redactedJson(sanitizeJournalPayload(payload))) as unknown
    const stored = JSON.stringify(this.payloadBlobs?.encode(clean).stored ?? clean)
    const info = this.insertWorkerStmt.run(ts, sessionId, kind, stored, wseq)
    const event: HubEvent = { seq: Number(info.lastInsertRowid), ts, sessionId, kind, payload: clean }
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

  recordCompactionLifecycle(
    operationId: string,
    phase: JournalCompactionPhase,
    values: {
      rowsDeleted?: number
      payloadBytesDeleted?: number
      detail: string
      now?: string
    }
  ): JournalCompactionStatus {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      throw new Error('journal compaction operation id is invalid')
    }
    if (!['started', 'progress', 'completed', 'deferred', 'failed', 'unobservable'].includes(phase)) {
      throw new Error('journal compaction phase is invalid')
    }
    const rowsDeleted = values.rowsDeleted ?? 0
    const payloadBytesDeleted = values.payloadBytesDeleted ?? 0
    if (
      !Number.isSafeInteger(rowsDeleted) ||
      rowsDeleted < 0 ||
      !Number.isSafeInteger(payloadBytesDeleted) ||
      payloadBytesDeleted < 0
    ) {
      throw new Error('journal compaction counters are invalid')
    }
    const detail = values.detail.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512)
    const now = values.now ?? new Date().toISOString()
    if (Number.isNaN(Date.parse(now)) || new Date(now).toISOString() !== now) {
      throw new Error('journal compaction timestamp is invalid')
    }
    const status = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT
             operation_id AS operationId,
             phase,
             started_at AS startedAt,
             updated_at AS updatedAt,
             rows_deleted AS rowsDeleted,
             payload_bytes_deleted AS payloadBytesDeleted,
             detail
           FROM journal_compaction_runs
           WHERE operation_id = ?`
        )
        .get(operationId) as JournalCompactionStatus | undefined
      if (!existing && phase !== 'started') {
        throw new Error('journal compaction lifecycle has no started boundary')
      }
      if (existing) {
        const terminal = ['completed', 'deferred', 'failed', 'unobservable'].includes(existing.phase)
        if (terminal) {
          if (
            existing.phase === phase &&
            existing.rowsDeleted === rowsDeleted &&
            existing.payloadBytesDeleted === payloadBytesDeleted &&
            existing.detail === detail
          ) {
            return existing
          }
          throw new Error('journal compaction lifecycle is already terminal')
        }
        if (phase === 'started') return existing
      }
      const startedAt = existing?.startedAt ?? now
      const result: JournalCompactionStatus = {
        operationId,
        phase,
        startedAt,
        updatedAt: now,
        rowsDeleted,
        payloadBytesDeleted,
        detail,
      }
      this.db
        .prepare(
          `INSERT INTO journal_compaction_runs
             (operation_id, phase, started_at, updated_at, rows_deleted, payload_bytes_deleted, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(operation_id) DO UPDATE SET
             phase = excluded.phase,
             updated_at = excluded.updated_at,
             rows_deleted = excluded.rows_deleted,
             payload_bytes_deleted = excluded.payload_bytes_deleted,
             detail = excluded.detail`
        )
        .run(
          operationId,
          phase,
          startedAt,
          now,
          rowsDeleted,
          payloadBytesDeleted,
          detail
        )
      this.append(null, `journal/compaction-${phase}`, result)
      if (phase === 'completed' || phase === 'deferred' || phase === 'failed' || phase === 'unobservable') {
        this.db
          .prepare(
            `DELETE FROM journal_compaction_runs
             WHERE operation_id IN (
               SELECT operation_id
               FROM journal_compaction_runs
               ORDER BY updated_at DESC, operation_id DESC
               LIMIT -1 OFFSET 32
             )`
          )
          .run()
      }
      return result
    }).immediate()
    return status
  }

  latestCompactionLifecycle(): JournalCompactionStatus | null {
    const row = this.db
      .prepare(
        `SELECT
           operation_id AS operationId,
           phase,
           started_at AS startedAt,
           updated_at AS updatedAt,
           rows_deleted AS rowsDeleted,
           payload_bytes_deleted AS payloadBytesDeleted,
           detail
         FROM journal_compaction_runs
         ORDER BY updated_at DESC, operation_id DESC
         LIMIT 1`
      )
      .get() as JournalCompactionStatus | undefined
    return row ?? null
  }

  /**
   * The small authority used by a cold client instead of replaying from zero. `generation` changes in the
   * same transaction as every destructive rewrite; `cursor` is the exact event high-water in this SQLite
   * snapshot. Callers that also need materialized state use {@link readReplaySnapshot} so those values and
   * the watermark cannot straddle a concurrent append.
   */
  replayCheckpoint(): ReplayCheckpoint {
    const state = this.db
      .prepare(
        'SELECT generation, reset_floor_seq AS resetFloorSeq FROM journal_replay_state WHERE singleton = 1'
      )
      .get() as { generation?: unknown; resetFloorSeq?: unknown } | undefined
    const generation = state?.generation
    const resetFloorSeq = state?.resetFloorSeq
    const cursor = this.db.prepare('SELECT COALESCE(MAX(seq), 0) FROM events').pluck().get()
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      typeof resetFloorSeq !== 'number' ||
      !Number.isSafeInteger(resetFloorSeq) ||
      resetFloorSeq < 0 ||
      typeof cursor !== 'number' ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    ) {
      throw new Error('journal replay checkpoint is invalid')
    }
    return {
      version: JOURNAL_REPLAY_PROTOCOL_VERSION,
      generation,
      cursor,
      resetFloorSeq,
    }
  }

  /**
   * Establish one SQLite read snapshot before evaluating current-state repositories that share this
   * connection. The callback must remain synchronous: an await would retain a read transaction across an
   * arbitrary event-loop turn and could pin the WAL.
   */
  readReplaySnapshot<T>(read: (checkpoint: ReplayCheckpoint) => T): T {
    const ownsSnapshot = !this.db.inTransaction
    if (ownsSnapshot) this.db.exec('BEGIN DEFERRED')
    try {
      const checkpoint = this.replayCheckpoint()
      const value = read(checkpoint)
      if (value instanceof Promise) throw new Error('replay snapshot callback must be synchronous')
      return value
    } finally {
      if (ownsSnapshot && this.db.inTransaction) this.db.exec('COMMIT')
    }
  }

  /**
   * Latest bounded journal rows for one hub-native chat. The result is returned oldest-to-newest so a
   * side-effect-free transcript reducer can consume it directly; `olderCursor` is exclusive on the next
   * request. A single row larger than the page budget is explicit rather than an infinite retry loop.
   */
  async sessionHistoryPage(
    sessionId: string,
    options: {
      beforeSeq?: number
      maxRows?: number
      maxBytes?: number
      expectedGeneration?: number
    } = {}
  ): Promise<SessionHistoryPage> {
    if (!sessionId || sessionId.length > 256) throw new Error('invalid session id')
    const maxRows = options.maxRows ?? JOURNAL_HISTORY_PAGE_MAX_ROWS
    const maxBytes = options.maxBytes ?? JOURNAL_HISTORY_PAGE_MAX_BYTES
    for (const [name, value, maximum] of [
      ['maxRows', maxRows, JOURNAL_HISTORY_PAGE_MAX_ROWS],
      ['maxBytes', maxBytes, JOURNAL_HISTORY_PAGE_MAX_BYTES],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(`${name} is outside the supported history-page bound`)
      }
    }
    const snapshot = this.readReplaySnapshot((checkpoint) => {
      if (
        options.expectedGeneration !== undefined &&
        options.expectedGeneration !== checkpoint.generation
      ) {
        throw new ReplayGenerationChangedError(options.expectedGeneration, checkpoint.generation)
      }
      const indexedThrough = this.db
        .prepare('SELECT scanned_through FROM journal_session_history_index_state WHERE singleton = 1')
        .pluck()
        .get()
      if (
        typeof indexedThrough !== 'number' ||
        !Number.isSafeInteger(indexedThrough) ||
        indexedThrough < checkpoint.cursor
      ) {
        throw new SessionHistoryIndexingError(
          typeof indexedThrough === 'number' && Number.isSafeInteger(indexedThrough)
            ? indexedThrough
            : 0,
          checkpoint.cursor
        )
      }
      const beforeSeq = options.beforeSeq ?? checkpoint.cursor + 1
      if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1) {
        throw new Error('beforeSeq is outside the supported history-page bound')
      }
      const rows = this.db
        .prepare(
          `SELECT
             event.seq,
             event.ts,
             event.session,
             event.kind,
             CASE
               WHEN length(CAST(event.payload AS BLOB)) <= ? THEN event.payload
               ELSE NULL
             END AS payload,
             length(CAST(event.payload AS BLOB)) AS payload_bytes
           FROM journal_session_history_event_index AS session_event
           JOIN events AS event ON event.seq = session_event.seq
           WHERE session_event.session = ?
             AND session_event.seq < ?
           ORDER BY session_event.seq DESC
           LIMIT ?`
        )
        .all(
          maxBytes,
          sessionId,
          beforeSeq,
          maxRows + 1
        ) as Array<{
        seq: number
        ts: string
        session: string
        kind: string
        payload: string | null
        payload_bytes: number
      }>
      return { checkpoint, rows }
    })

    type HistoryRow = (typeof snapshot.rows)[number]
    type PlannedHistoryEvent = {
      row: HistoryRow
      stored?: unknown
      event?: HubEvent
      estimatedBytes: number
    }
    const oversizedEvent = (row: HistoryRow, originalPayloadBytes: number): HubEvent => ({
      seq: row.seq,
      ts: row.ts,
      sessionId: row.session,
      kind: 'journal/history-event-oversized',
      payload: {
        originalKind: row.kind,
        originalPayloadBytes,
        message:
          'One large retained event was kept out of this bounded view; the surrounding conversation loaded normally.',
      },
    })

    // Plan from the immutable content-addressed references first. The previous path hydrated every row
    // synchronously and only then discovered that most of those bytes could not fit in the 512 KiB page.
    // Releasing the SQLite snapshot before asynchronous file I/O also prevents a slow disk from pinning WAL.
    const planned: PlannedHistoryEvent[] = []
    let estimatedPageBytes = 0
    let hasOlder = snapshot.rows.length > maxRows
    for (const row of snapshot.rows.slice(0, maxRows)) {
      const envelopeWithoutPayload =
        Buffer.byteLength(
          JSON.stringify({
            seq: row.seq,
            ts: row.ts,
            sessionId: row.session,
            kind: row.kind,
            payload: null,
          }),
        ) - Buffer.byteLength('null')
      let candidate: PlannedHistoryEvent
      if (row.payload === null) {
        const event = oversizedEvent(row, row.payload_bytes)
        candidate = { row, event, estimatedBytes: Buffer.byteLength(JSON.stringify(event)) }
      } else {
        const stored = parseStoredPayload(row.payload, row.seq)
        const payloadEstimate = this.payloadBlobs
          ? this.payloadBlobs.estimateDecodedJsonBytes(stored)
          : Buffer.byteLength(JSON.stringify(stored))
        const estimatedBytes = envelopeWithoutPayload + payloadEstimate
        if (estimatedBytes > maxBytes) {
          const event = oversizedEvent(row, Math.max(row.payload_bytes, payloadEstimate))
          candidate = { row, event, estimatedBytes: Buffer.byteLength(JSON.stringify(event)) }
        } else {
          candidate = { row, stored, estimatedBytes }
        }
      }
      if (estimatedPageBytes + candidate.estimatedBytes > maxBytes) {
        hasOlder = true
        break
      }
      planned.push(candidate)
      estimatedPageBytes += candidate.estimatedBytes
    }

    const stored = planned.filter((candidate) => candidate.stored !== undefined)
    const hydrated = this.payloadBlobs
      ? await this.payloadBlobs.decodeManyAsync(stored.map((candidate) => candidate.stored))
      : stored.map((candidate) => candidate.stored)
    let hydratedIndex = 0
    const selected: HubEvent[] = []
    let encodedBytes = 0
    for (const candidate of planned) {
      let event = candidate.event
      if (!event) {
        event = {
          seq: candidate.row.seq,
          ts: candidate.row.ts,
          sessionId: candidate.row.session,
          kind: candidate.row.kind,
          payload: hydrated[hydratedIndex],
        }
        hydratedIndex += 1
      }
      let bytes = Buffer.byteLength(JSON.stringify(event))
      if (bytes > maxBytes) {
        event = oversizedEvent(candidate.row, bytes)
        bytes = Buffer.byteLength(JSON.stringify(event))
      }
      if (encodedBytes + bytes > maxBytes) {
        hasOlder = true
        break
      }
      selected.push(event)
      encodedBytes += bytes
    }
    selected.reverse()
    return {
      events: selected,
      olderCursor: hasOlder ? (selected[0]?.seq ?? null) : null,
      hasOlder,
      encodedBytes,
      checkpointGeneration: snapshot.checkpoint.generation,
    }
  }

  /**
   * Crash-resumable post-ready projection used by bounded per-session history. It advances in small writer
   * transactions instead of creating a giant `(session,seq)` index synchronously while a 981 MB journal is
   * booting. INSERT/DELETE triggers keep already-projected and newly appended rows exact.
   */
  backfillSessionEventIndex(maxRows = 5_000): {
    rowsIndexed: number
    scannedThrough: number
    target: number
    complete: boolean
  } {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 50_000) {
      throw new Error('session history index batch is outside the supported bound')
    }
    return this.db.transaction(() => {
      const scanned = this.db
        .prepare('SELECT scanned_through FROM journal_session_index_state WHERE singleton = 1')
        .pluck()
        .get()
      if (typeof scanned !== 'number' || !Number.isSafeInteger(scanned) || scanned < 0) {
        throw new Error('journal session history index state is invalid')
      }
      const target = this.db.prepare('SELECT COALESCE(MAX(seq), 0) FROM events').pluck().get()
      if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0) {
        throw new Error('journal session history index target is invalid')
      }
      const rows = this.db
        .prepare(
          `SELECT seq, session
           FROM events
           WHERE seq > ?
           ORDER BY seq
           LIMIT ?`
        )
        .all(scanned, maxRows) as Array<{ seq: number; session: string | null }>
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO journal_session_event_index (session, seq) VALUES (?, ?)'
      )
      let rowsIndexed = 0
      for (const row of rows) {
        if (row.session !== null) rowsIndexed += insert.run(row.session, row.seq).changes
      }
      const scannedThrough = Math.max(scanned, rows.at(-1)?.seq ?? target)
      this.db
        .prepare(
          'UPDATE journal_session_index_state SET scanned_through = ? WHERE singleton = 1'
        )
        .run(scannedThrough)
      return {
        rowsIndexed,
        scannedThrough,
        target,
        complete: scannedThrough >= target,
      }
    }).immediate()
  }

  /**
   * Crash-resumable transcript-only projection. The general session index is intentionally retained for
   * lifecycle and recovery queries, but a chat viewport must not walk through hundreds of thousands of
   * streaming deltas to find forty renderable events. Existing journals are scanned in bounded post-ready
   * batches; triggers keep a completed frontier exact without putting migration work back on boot.
   */
  backfillSessionHistoryEventIndex(maxRows = 5_000): {
    rowsIndexed: number
    scannedThrough: number
    target: number
    complete: boolean
  } {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 50_000) {
      throw new Error('session transcript index batch is outside the supported bound')
    }
    return this.db.transaction(() => {
      const scanned = this.db
        .prepare('SELECT scanned_through FROM journal_session_history_index_state WHERE singleton = 1')
        .pluck()
        .get()
      if (typeof scanned !== 'number' || !Number.isSafeInteger(scanned) || scanned < 0) {
        throw new Error('journal session transcript index state is invalid')
      }
      const target = this.db.prepare('SELECT COALESCE(MAX(seq), 0) FROM events').pluck().get()
      if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0) {
        throw new Error('journal session transcript index target is invalid')
      }
      const rows = this.db
        .prepare(
          `SELECT
             seq,
             session,
             kind,
             CASE
               WHEN kind = 'codex/item/started' AND json_valid(payload)
               THEN json_extract(payload, '$.item.type')
               ELSE NULL
             END AS item_type
           FROM events
           WHERE seq > ?
           ORDER BY seq
           LIMIT ?`
        )
        .all(scanned, maxRows) as Array<{
        seq: number
        session: string | null
        kind: string
        item_type: string | null
      }>
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO journal_session_history_event_index (session, seq) VALUES (?, ?)'
      )
      let rowsIndexed = 0
      for (const row of rows) {
        if (
          row.session !== null &&
          (JOURNAL_HISTORY_EVENT_KIND_SET.has(row.kind) ||
            (row.kind === 'codex/item/started' && row.item_type === 'contextCompaction'))
        ) {
          rowsIndexed += insert.run(row.session, row.seq).changes
        }
      }
      const scannedThrough = Math.max(scanned, rows.at(-1)?.seq ?? target)
      this.db
        .prepare(
          'UPDATE journal_session_history_index_state SET scanned_through = ? WHERE singleton = 1'
        )
        .run(scannedThrough)
      return {
        rowsIndexed,
        scannedThrough,
        target,
        complete: scannedThrough >= target,
      }
    }).immediate()
  }

  /**
   * Crash-resumable post-ready projection for the bounded maintenance kinds. The projection and
   * its small `(kind,seq)` index start empty, so an upgraded 981 MB journal never pays a synchronous
   * full-table index build during boot or its first maintenance pass. Database triggers cover new rows
   * while bounded batches advance the durable frontier across existing rows.
   */
  backfillTransientEventIndex(maxRows = 5_000): {
    rowsIndexed: number
    scannedThrough: number
    target: number
    complete: boolean
  } {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 50_000) {
      throw new Error('transient maintenance index batch is outside the supported bound')
    }
    return this.db.transaction(() => {
      const scanned = this.db
        .prepare('SELECT scanned_through FROM journal_transient_index_state WHERE singleton = 1')
        .pluck()
        .get()
      if (typeof scanned !== 'number' || !Number.isSafeInteger(scanned) || scanned < 0) {
        throw new Error('journal transient maintenance index state is invalid')
      }
      const target = this.db.prepare('SELECT COALESCE(MAX(seq), 0) FROM events').pluck().get()
      if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0) {
        throw new Error('journal transient maintenance index target is invalid')
      }
      const rows = this.db
        .prepare(
          `SELECT
             seq,
             kind,
             ts,
             session,
             length(CAST(payload AS BLOB)) AS payload_bytes,
             CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END AS thread_id,
             CASE
               WHEN json_valid(payload) AND kind = 'codex/turn/completed'
                 THEN json_extract(payload, '$.turn.id')
               WHEN json_valid(payload)
                 THEN json_extract(payload, '$.turnId')
             END AS turn_id,
             CASE WHEN json_valid(payload) THEN
               COALESCE(json_extract(payload, '$.item.id'), json_extract(payload, '$.itemId'))
             END AS item_id,
             CASE WHEN json_valid(payload) THEN json_extract(payload, '$.item.type') END AS item_type,
             CASE
               WHEN kind = 'codex/item/completed'
                 AND json_valid(payload)
                 AND (
                   (
                     json_extract(payload, '$.item.type') = 'commandExecution'
                     AND (
                       typeof(json_extract(payload, '$.item.aggregatedOutput')) = 'text'
                       OR json_type(
                         payload,
                         '$.item.aggregatedOutput.${JOURNAL_BLOB_KEY}.sha256'
                       ) = 'text'
                     )
                   )
                   OR (
                     json_extract(payload, '$.item.type') = 'agentMessage'
                     AND (
                       typeof(json_extract(payload, '$.item.text')) = 'text'
                       OR json_type(
                         payload,
                         '$.item.text.${JOURNAL_BLOB_KEY}.sha256'
                       ) = 'text'
                     )
                   )
                 )
               THEN 1
               ELSE 0
             END AS canonical_terminal
           FROM events
           WHERE seq > ?
           ORDER BY seq
           LIMIT ?`
        )
        .all(scanned, maxRows) as Array<{
        seq: number
        kind: string
        ts: string
        session: string | null
        payload_bytes: number
        thread_id: string | null
        turn_id: string | null
        item_id: string | null
        item_type: string | null
        canonical_terminal: number
      }>
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO journal_transient_event_index
           (
             seq,
             kind,
             ts,
             session,
             payload_bytes,
             thread_id,
             turn_id,
             item_id,
             item_type,
             canonical_terminal
           )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ? IN (
           'claude/result',
           'codex/item/started',
           'codex/item/completed',
           'codex/turn/completed',
           'codex/item/commandExecution/outputDelta',
           'codex/item/agentMessage/delta',
           'codex/turn/diff/updated'
         )`
      )
      let rowsIndexed = 0
      for (const row of rows) {
        rowsIndexed += insert
          .run(
            row.seq,
            row.kind,
            row.ts,
            row.session,
            row.payload_bytes,
            row.thread_id,
            row.turn_id,
            row.item_id,
            row.item_type,
            row.canonical_terminal,
            row.kind
          )
          .changes
      }
      const scannedThrough = Math.max(scanned, rows.at(-1)?.seq ?? target)
      this.db
        .prepare(
          'UPDATE journal_transient_index_state SET scanned_through = ? WHERE singleton = 1'
        )
        .run(scannedThrough)
      return {
        rowsIndexed,
        scannedThrough,
        target,
        complete: scannedThrough >= target,
      }
    }).immediate()
  }

  /**
   * Read a replay page without decoding a row until its stored JSON bytes fit both the frame and remaining
   * page budgets. This is the authority used by the WebSocket catch-up path; `since()` remains a convenient
   * diagnostic API but is deliberately not used for bounded transport.
   */
  boundedReplayPage(
    afterSeq: number,
    throughSeq: number,
    options: {
      maxRows: number
      maxBytes: number
      maxFrameBytes: number
      eventFilter?: (event: { seq: number; sessionId: string | null; kind: string }) => boolean
    }
  ): BoundedReplayPage {
    for (const [name, value, maximum] of [
      ['afterSeq', afterSeq, Number.MAX_SAFE_INTEGER],
      ['throughSeq', throughSeq, Number.MAX_SAFE_INTEGER],
      ['maxRows', options.maxRows, 5_000],
      ['maxBytes', options.maxBytes, 2 * 1024 * 1024],
      ['maxFrameBytes', options.maxFrameBytes, 512 * 1024],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < (name.startsWith('max') ? 1 : 0) || value > maximum) {
        throw new Error(`${name} is outside the supported bounded replay range`)
      }
    }
    if (throughSeq < afterSeq) throw new Error('bounded replay high-water precedes its cursor')
    return this.readReplaySnapshot((checkpoint) => {
      const rawPayloadLimit = Math.min(options.maxFrameBytes, options.maxBytes)
      const rows = this.db
        .prepare(
          `SELECT
             seq,
             ts,
             session,
             kind,
             CASE
               WHEN length(CAST(payload AS BLOB)) <= ? THEN payload
               ELSE NULL
             END AS payload,
             length(CAST(payload AS BLOB)) AS payload_bytes
           FROM events
           WHERE seq > ? AND seq <= ?
           ORDER BY seq ASC
           LIMIT ?`
        )
        .all(rawPayloadLimit, afterSeq, throughSeq, options.maxRows + 1) as Array<{
        seq: number
        ts: string
        session: string | null
        kind: string
        payload: string | null
        payload_bytes: number
      }>
      const events: HubEvent[] = []
      let encodedBytes = 0
      let lastSeq = afterSeq
      for (const row of rows.slice(0, options.maxRows)) {
        if (options.eventFilter && !options.eventFilter({ seq: row.seq, sessionId: row.session, kind: row.kind })) {
          // A filtered fleet stream still advances its durable cursor. Otherwise one noisy, unrelated
          // agent would be scanned forever even though none of its transcript bytes are transmitted.
          lastSeq = row.seq
          continue
        }
        const envelopeWithoutPayload =
          Buffer.byteLength(
            JSON.stringify({
              seq: row.seq,
              ts: row.ts,
              sessionId: row.session,
              kind: row.kind,
              payload: null,
            })
          ) -
          Buffer.byteLength('null')
        if (row.payload === null) {
          return {
            checkpoint,
            events,
            lastSeq,
            hasMore: true,
            encodedBytes,
            tooLarge: { seq: row.seq, encodedBytes: envelopeWithoutPayload + row.payload_bytes },
          }
        }
        const storedPayload = parseStoredPayload(row.payload, row.seq)
        // Externalized rows are tiny SQLite pointers whose decoded strings may be megabytes. Budgeting
        // the pointer bytes made a reconnect synchronously read and hash thousands of cold blob files on
        // the hub thread before discovering the frames could not fit. Metadata is enough to reject or
        // stop planning first; only the bounded working set below is hydrated.
        const estimatedPayloadBytes = this.payloadBlobs
          ? this.payloadBlobs.estimateDecodedJsonBytes(storedPayload)
          : Buffer.byteLength(JSON.stringify(storedPayload))
        const estimatedEnvelopeBytes = envelopeWithoutPayload + estimatedPayloadBytes
        if (estimatedEnvelopeBytes > options.maxFrameBytes) {
          return {
            checkpoint,
            events,
            lastSeq,
            hasMore: true,
            encodedBytes,
            tooLarge: { seq: row.seq, encodedBytes: estimatedEnvelopeBytes },
          }
        }
        if (encodedBytes + estimatedEnvelopeBytes > options.maxBytes) break
        const event: HubEvent = {
          seq: row.seq,
          ts: row.ts,
          sessionId: row.session,
          kind: row.kind,
          payload: this.payloadBlobs?.decode(storedPayload) ?? storedPayload,
        }
        const bytes = Buffer.byteLength(JSON.stringify(event))
        if (bytes > options.maxFrameBytes) {
          return {
            checkpoint,
            events,
            lastSeq,
            hasMore: true,
            encodedBytes,
            tooLarge: { seq: row.seq, encodedBytes: bytes },
          }
        }
        if (encodedBytes + bytes > options.maxBytes) break
        events.push(event)
        encodedBytes += bytes
        lastSeq = row.seq
      }
      return {
        checkpoint,
        events,
        lastSeq,
        hasMore: lastSeq < throughSeq,
        encodedBytes,
      }
    })
  }

  private advanceReplayGeneration(now: string, changedThroughSeq: number): void {
    if (
      !Number.isSafeInteger(changedThroughSeq) ||
      changedThroughSeq < 0
    ) {
      throw new Error('journal replay reset floor is invalid')
    }
    const changed = this.db
      .prepare(
        `UPDATE journal_replay_state
         SET generation = generation + 1,
             reset_floor_seq = MAX(reset_floor_seq, ?),
             updated_at = ?
         WHERE singleton = 1 AND generation < 9007199254740991`
      )
      .run(changedThroughSeq, now)
    if (changed.changes !== 1) throw new Error('journal replay generation cannot advance safely')
  }

  /**
   * Highest event that is currently a safe superseded-stream deletion candidate.
   *
   * Maintenance freezes this frontier after its bounded projection catches up, then verifies snapshot
   * coverage through exactly this value. Lifecycle/progress rows written after that point cannot move the
   * authorization goalpost, and a later candidate remains untouched until a later verified operation.
   */
  condensationCandidateFrontier(
    options: Pick<
      JournalCondenseOptions,
      'nowMs' | 'graceMs' | 'maxTransientPayloadBytes'
    > & { maxSeq?: number } = {}
  ): number {
    // These indexes are deliberately lazy. Production calls this method only from the post-ready
    // maintenance child; building them in Journal's constructor would put a one-time 700k-row index
    // migration back on the hub's port-bind critical path. Without the correlation keys, SQLite can only
    // use idx_journal_transient_kind_seq for each EXISTS/MAX probe. On the operator's measured journal that
    // meant scanning ~82k terminal rows for each of ~700k transient rows: every maintenance child exhausted
    // its 4m50s observation window without selecting one deletion, the journal grew indefinitely, and the
    // mandatory boot integrity pass eventually took more than forty seconds by itself.
    this.ensureTransientMaintenanceIndexes()
    const nowMs = options.nowMs ?? Date.now()
    const graceMs = options.graceMs ?? JOURNAL_CONDENSE_GRACE_MS
    const maxTransientPayloadBytes =
      options.maxTransientPayloadBytes ?? JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES
    const maxSeq = options.maxSeq ?? Number.MAX_SAFE_INTEGER
    for (const [name, value] of [
      ['nowMs', nowMs],
      ['graceMs', graceMs],
      ['maxTransientPayloadBytes', maxTransientPayloadBytes],
      ['maxSeq', maxSeq],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a finite non-negative number`)
      }
    }
    if (!Number.isSafeInteger(maxSeq)) throw new Error('maxSeq must be a safe integer')
    const indexedThrough = this.db
      .prepare('SELECT scanned_through FROM journal_transient_index_state WHERE singleton = 1')
      .pluck()
      .get()
    const target = this.db.prepare('SELECT COALESCE(MAX(seq), 0) FROM events').pluck().get()
    if (
      typeof indexedThrough !== 'number' ||
      !Number.isSafeInteger(indexedThrough) ||
      typeof target !== 'number' ||
      !Number.isSafeInteger(target)
    ) {
      throw new Error('journal transient maintenance projection state is invalid')
    }
    if (indexedThrough < target) throw new TransientHistoryIndexingError(indexedThrough, target)
    const cutoff = new Date(nowMs - graceMs).toISOString()
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(candidate.seq), 0) AS frontier
         FROM journal_transient_event_index AS candidate
         WHERE candidate.ts <= ?
           AND candidate.seq <= ?
           AND candidate.payload_bytes <= ?
           AND (
             (
               candidate.kind = 'codex/item/started'
               AND candidate.session IS NOT NULL
               AND candidate.thread_id IS NOT NULL
               AND candidate.turn_id IS NOT NULL
               AND candidate.item_id IS NOT NULL
               AND EXISTS (
                 SELECT 1
                 FROM journal_transient_event_index AS terminal
                 WHERE terminal.kind = 'codex/item/completed'
                   AND terminal.ts <= ?
                   AND terminal.session = candidate.session
                   AND terminal.thread_id = candidate.thread_id
                   AND terminal.turn_id = candidate.turn_id
                   AND terminal.item_id = candidate.item_id
               )
             )
             OR (
               candidate.kind = 'codex/item/commandExecution/outputDelta'
               AND candidate.session IS NOT NULL
               AND candidate.thread_id IS NOT NULL
               AND candidate.turn_id IS NOT NULL
               AND candidate.item_id IS NOT NULL
               AND EXISTS (
                 SELECT 1
                 FROM journal_transient_event_index AS terminal
                 WHERE terminal.kind = 'codex/item/completed'
                   AND terminal.ts <= ?
                   AND terminal.session = candidate.session
                   AND terminal.thread_id = candidate.thread_id
                   AND terminal.turn_id = candidate.turn_id
                   AND terminal.item_id = candidate.item_id
                   AND terminal.item_type = 'commandExecution'
                   AND terminal.canonical_terminal = 1
               )
             )
             OR (
               candidate.kind = 'codex/item/agentMessage/delta'
               AND candidate.session IS NOT NULL
               AND candidate.thread_id IS NOT NULL
               AND candidate.turn_id IS NOT NULL
               AND candidate.item_id IS NOT NULL
               AND EXISTS (
                 SELECT 1
                 FROM journal_transient_event_index AS terminal
                 WHERE terminal.kind = 'codex/item/completed'
                   AND terminal.ts <= ?
                   AND terminal.session = candidate.session
                   AND terminal.thread_id = candidate.thread_id
                   AND terminal.turn_id = candidate.turn_id
                   AND terminal.item_id = candidate.item_id
                   AND terminal.item_type = 'agentMessage'
                   AND terminal.canonical_terminal = 1
               )
             )
             OR (
               candidate.kind = 'codex/turn/diff/updated'
               AND candidate.session IS NOT NULL
               AND candidate.thread_id IS NOT NULL
               AND candidate.turn_id IS NOT NULL
               AND candidate.seq < (
                 SELECT MAX(newer.seq)
                 FROM journal_transient_event_index AS newer
                 WHERE newer.kind = 'codex/turn/diff/updated'
                   AND newer.session = candidate.session
                   AND newer.thread_id = candidate.thread_id
                   AND newer.turn_id = candidate.turn_id
               )
             )
           )`
      )
      .get(
        cutoff,
        maxSeq,
        Math.floor(maxTransientPayloadBytes),
        cutoff,
        cutoff,
        cutoff
      ) as { frontier: unknown }
    if (
      typeof row.frontier !== 'number' ||
      !Number.isSafeInteger(row.frontier) ||
      row.frontier < 0
    ) {
      throw new Error('journal condensation candidate frontier is invalid')
    }
    return row.frontier
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
   * This delete transaction intentionally does NOT VACUUM. The same ordinary post-ready maintenance sequence
   * enforces the configured resident-SQLite ceiling: incremental databases release a bounded page
   * batch, while an oversized legacy database is crash-atomically converted once its payload projection is
   * current. Physical reclaim therefore never lengthens the delete writer-lock boundary or the boot path.
   */
  condenseCompletedCodex(options: JournalCondenseOptions = {}): JournalCondenseResult {
    this.ensureTransientMaintenanceIndexes()
    const nowMs = options.nowMs ?? Date.now()
    const graceMs = options.graceMs ?? JOURNAL_CONDENSE_GRACE_MS
    const deleteThroughSeq = options.deleteThroughSeq ?? Number.MAX_SAFE_INTEGER
    const maxCommandOutputDeltas = options.maxCommandOutputDeltas ?? JOURNAL_CONDENSE_MAX_COMMAND_DELTAS
    const maxAgentMessageDeltas =
      options.maxAgentMessageDeltas ?? JOURNAL_CONDENSE_MAX_AGENT_MESSAGE_DELTAS
    const maxDiffSnapshots = options.maxDiffSnapshots ?? JOURNAL_CONDENSE_MAX_DIFF_SNAPSHOTS
    const maxItemStarted = options.maxItemStarted ?? JOURNAL_CONDENSE_MAX_ITEM_STARTED
    const maxTransientPayloadBytes =
      options.maxTransientPayloadBytes ?? JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES
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
      ['deleteThroughSeq', deleteThroughSeq],
      ['maxCommandOutputDeltas', maxCommandOutputDeltas],
      ['maxAgentMessageDeltas', maxAgentMessageDeltas],
      ['maxDiffSnapshots', maxDiffSnapshots],
      ['maxItemStarted', maxItemStarted],
      ['maxTransientPayloadBytes', maxTransientPayloadBytes],
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
    if (!Number.isSafeInteger(deleteThroughSeq)) {
      throw new Error('deleteThroughSeq must be a safe integer')
    }
    const commandLimit = Math.floor(maxCommandOutputDeltas)
    const messageLimit = Math.floor(maxAgentMessageDeltas)
    const diffLimit = Math.floor(maxDiffSnapshots)
    const startedLimit = Math.floor(maxItemStarted)
    const transientByteLimit = Math.floor(maxTransientPayloadBytes)
    const now = new Date(nowMs).toISOString()
    const cutoff = new Date(nowMs - graceMs).toISOString()
    // Replication is opt-in for existing journals. Once configured, however, it is a hard deletion gate:
    // reserve the exact verified generations BEFORE selecting anything destructive, then constrain every
    // DELETE/UPDATE path by the kth replica's durable snapshot seq. An offline fleet therefore grows past
    // its last verified watermark; it never quietly trades the only archive copy for free disk.
    const replication = reserveReplicationPruneGate(this.db)
    const maxPrunableSeq = Math.min(replication.maxPrunableSeq, deleteThroughSeq)
    const transientIndexedThrough = this.db
      .prepare('SELECT scanned_through FROM journal_transient_index_state WHERE singleton = 1')
      .pluck()
      .get()
    const transientTarget = this.db.prepare('SELECT COALESCE(MAX(seq), 0) FROM events').pluck().get()
    if (
      typeof transientIndexedThrough !== 'number' ||
      !Number.isSafeInteger(transientIndexedThrough) ||
      typeof transientTarget !== 'number' ||
      !Number.isSafeInteger(transientTarget)
    ) {
      throw new Error('journal transient maintenance projection state is invalid')
    }
    if (transientIndexedThrough < transientTarget) {
      throw new TransientHistoryIndexingError(transientIndexedThrough, transientTarget)
    }

    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS journal_condense_commands (
        session TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (session, thread_id, turn_id, item_id)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS journal_condense_messages (
        session TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (session, thread_id, turn_id, item_id)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS journal_condense_completed_items (
        session TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (session, thread_id, turn_id, item_id)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS journal_condense_diff_keep (
        seq INTEGER PRIMARY KEY
      );
      CREATE TEMP TABLE IF NOT EXISTS journal_condense_delete (
        seq INTEGER PRIMARY KEY,
        payload_bytes INTEGER NOT NULL
      );
    `)

    // Candidate discovery writes TEMP only and reads the main DB. Keep it outside the main write transaction
    // so the expensive JSON validation/extraction does not hold SQLite's single WAL writer lock against live
    // worker events. The live hub only appends; the single maintenance child owns old-row rewrites, and a
    // concurrent cursor advance/reset is re-read inside the write transaction below.
    const selectCandidates = (): void => {
      this.db.exec(`
        DELETE FROM journal_condense_commands;
        DELETE FROM journal_condense_messages;
        DELETE FROM journal_condense_completed_items;
        DELETE FROM journal_condense_diff_keep;
        DELETE FROM journal_condense_delete;
      `)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_commands (session, thread_id, turn_id, item_id)
           SELECT session, thread_id, turn_id, item_id
           FROM journal_transient_event_index
           WHERE kind = 'codex/item/completed'
             AND ts <= ?
             AND session IS NOT NULL
             AND thread_id IS NOT NULL
             AND turn_id IS NOT NULL
             AND item_id IS NOT NULL
             AND item_type = 'commandExecution'
             AND canonical_terminal = 1`
        )
        .run(cutoff)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_messages (session, thread_id, turn_id, item_id)
           SELECT session, thread_id, turn_id, item_id
           FROM journal_transient_event_index
           WHERE kind = 'codex/item/completed'
             AND ts <= ?
             AND session IS NOT NULL
             AND thread_id IS NOT NULL
             AND turn_id IS NOT NULL
             AND item_id IS NOT NULL
             AND item_type = 'agentMessage'
             AND canonical_terminal = 1`
        )
        .run(cutoff)
      // App-server defines turn/diff/updated as the WHOLE current cumulative patch, not a delta. Keep the
      // newest well-correlated snapshot for every turn even if its terminal went missing during a provider
      // crash; older snapshots are superseded by that row without making any claim about the turn outcome.
      // Invalid/missing identities never enter this table and therefore fail closed.
      this.db.exec(`
        INSERT OR IGNORE INTO journal_condense_diff_keep (seq)
        SELECT MAX(seq)
        FROM journal_transient_event_index
        WHERE kind = 'codex/turn/diff/updated'
          AND session IS NOT NULL
          AND thread_id IS NOT NULL
          AND turn_id IS NOT NULL
        GROUP BY session, thread_id, turn_id;
      `)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_completed_items (session, thread_id, turn_id, item_id)
           SELECT session, thread_id, turn_id, item_id
           FROM journal_transient_event_index
           WHERE kind = 'codex/item/completed'
             AND ts <= ?
             AND session IS NOT NULL
             AND thread_id IS NOT NULL
             AND turn_id IS NOT NULL
             AND item_id IS NOT NULL`
        )
        .run(cutoff)

      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_delete (seq, payload_bytes)
           SELECT candidate.seq, candidate.payload_bytes
           FROM journal_transient_event_index AS candidate
           JOIN journal_condense_completed_items AS terminal
             ON terminal.session = candidate.session
            AND terminal.thread_id = candidate.thread_id
            AND terminal.turn_id = candidate.turn_id
            AND terminal.item_id = candidate.item_id
           WHERE candidate.ts <= ?
             AND candidate.seq <= ?
             AND candidate.kind = 'codex/item/started'
             AND candidate.session IS NOT NULL
             AND candidate.thread_id IS NOT NULL
             AND candidate.turn_id IS NOT NULL
             AND candidate.item_id IS NOT NULL
           ORDER BY candidate.seq
           LIMIT ?`
        )
        .run(cutoff, maxPrunableSeq, startedLimit)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_delete (seq, payload_bytes)
           SELECT candidate.seq, candidate.payload_bytes
           FROM journal_transient_event_index AS candidate
           JOIN journal_condense_commands AS terminal
             ON terminal.session = candidate.session
            AND terminal.thread_id = candidate.thread_id
            AND terminal.turn_id = candidate.turn_id
            AND terminal.item_id = candidate.item_id
           WHERE candidate.ts <= ?
             AND candidate.seq <= ?
             AND candidate.kind = 'codex/item/commandExecution/outputDelta'
             AND candidate.session IS NOT NULL
             AND candidate.thread_id IS NOT NULL
             AND candidate.turn_id IS NOT NULL
             AND candidate.item_id IS NOT NULL
           ORDER BY candidate.seq
           LIMIT ?`
        )
        .run(cutoff, maxPrunableSeq, commandLimit)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_delete (seq, payload_bytes)
           SELECT candidate.seq, candidate.payload_bytes
           FROM journal_transient_event_index AS candidate
           JOIN journal_condense_messages AS terminal
             ON terminal.session = candidate.session
            AND terminal.thread_id = candidate.thread_id
            AND terminal.turn_id = candidate.turn_id
            AND terminal.item_id = candidate.item_id
           WHERE candidate.ts <= ?
             AND candidate.seq <= ?
             AND candidate.kind = 'codex/item/agentMessage/delta'
             AND candidate.session IS NOT NULL
             AND candidate.thread_id IS NOT NULL
             AND candidate.turn_id IS NOT NULL
             AND candidate.item_id IS NOT NULL
           ORDER BY candidate.seq
           LIMIT ?`
        )
        .run(cutoff, maxPrunableSeq, messageLimit)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_condense_delete (seq, payload_bytes)
           SELECT candidate.seq, candidate.payload_bytes
           FROM journal_transient_event_index AS candidate
           LEFT JOIN journal_condense_diff_keep AS keep ON keep.seq = candidate.seq
           WHERE candidate.ts <= ?
             AND candidate.seq <= ?
             AND keep.seq IS NULL
             AND candidate.kind = 'codex/turn/diff/updated'
             AND candidate.session IS NOT NULL
             AND candidate.thread_id IS NOT NULL
             AND candidate.turn_id IS NOT NULL
           ORDER BY candidate.seq
           LIMIT ?`
        )
        .run(cutoff, maxPrunableSeq, diffLimit)
      // The row limits bound statement work; this single cumulative budget additionally bounds WAL/write
      // amplification when retained cumulative diffs are hundreds of KiB each. Candidate discovery remains
      // read-only and the committed DELETE batch can never exceed this selected payload total.
      //
      // An individually oversized row is retained and reported, but it cannot starve every later bounded
      // candidate. Removing it before the running sum lets maintenance continue making safe progress.
      this.db
        .prepare('DELETE FROM journal_condense_delete WHERE payload_bytes > ?')
        .run(transientByteLimit)
      this.db
        .prepare(
          `DELETE FROM journal_condense_delete
           WHERE seq IN (
             SELECT seq
             FROM journal_condense_delete
             ORDER BY seq
             LIMIT -1 OFFSET ?
           )`
        )
        .run(JOURNAL_CONDENSE_MAX_DELETE_ROWS)
      this.db
        .prepare(
          `DELETE FROM journal_condense_delete
           WHERE seq IN (
             SELECT seq
             FROM (
               SELECT
                 seq,
                 SUM(payload_bytes) OVER (ORDER BY seq) AS cumulative_bytes
               FROM journal_condense_delete
             )
             WHERE cumulative_bytes > ?
           )`
        )
        .run(transientByteLimit)
    }
    selectCandidates()

    // This diagnostic walks the bounded transient projection, but on a multi-million-row journal it can
    // still take seconds. It is deliberately outside the write transaction: holding SQLite's single writer
    // lock during a read-only count made the live hub's next synchronous append wait in native code, freezing
    // HTTP/WebSocket handling even though maintenance itself runs in a child process.
    const oversizedTransientRowsRetained = this.db
      .prepare(
        `SELECT COUNT(*)
         FROM journal_transient_event_index
         WHERE seq <= ?
           AND kind IN (
             'codex/item/commandExecution/outputDelta',
             'codex/item/agentMessage/delta',
             'codex/turn/diff/updated',
             'codex/item/started'
           )
           AND payload_bytes > ?`
      )
      .pluck()
      .get(maxPrunableSeq, transientByteLimit)
    if (
      typeof oversizedTransientRowsRetained !== 'number' ||
      !Number.isSafeInteger(oversizedTransientRowsRetained) ||
      oversizedTransientRowsRetained < 0
    ) {
      throw new Error('journal condensation oversized-row count is invalid')
    }

    const applyDeletes = this.db.transaction(
      (): Pick<
        JournalCondenseResult,
        | 'commandOutputDeltasDeleted'
        | 'agentMessageDeltasDeleted'
        | 'diffSnapshotsDeleted'
        | 'itemStartedDeleted'
        | 'transientPayloadBytesDeleted'
        | 'oversizedTransientRowsRetained'
        | 'cursorCheckpointsWritten'
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
        const transientPayloadBytesDeleted = this.db
          .prepare('SELECT COALESCE(SUM(payload_bytes), 0) FROM journal_condense_delete')
          .pluck()
          .get()
        if (
          typeof transientPayloadBytesDeleted !== 'number' ||
          !Number.isSafeInteger(transientPayloadBytesDeleted) ||
          transientPayloadBytesDeleted < 0 ||
          transientPayloadBytesDeleted > transientByteLimit
        ) {
          throw new Error('journal condensation selected an invalid payload-byte batch')
        }
        // Count the already-bounded selection through its compact projection, then delete by the events
        // INTEGER PRIMARY KEY in one statement. Four kind-filtered DELETEs previously made SQLite revisit
        // the payload-heavy events table four times while holding the writer lock. On the operator's 1.7 GB
        // journal that blocked the hub for longer than the renderer's eight-second history deadline.
        const selectedKinds = this.db
          .prepare(
            `SELECT candidate.kind, COUNT(*) AS count
             FROM journal_condense_delete AS selected
             JOIN journal_transient_event_index AS candidate ON candidate.seq = selected.seq
             GROUP BY candidate.kind`
          )
          .all() as Array<{ kind: string; count: number }>
        const selectedCount = (kind: string): number =>
          selectedKinds.find((row) => row.kind === kind)?.count ?? 0
        const commandOutputDeltasDeleted = selectedCount(
          'codex/item/commandExecution/outputDelta'
        )
        const agentMessageDeltasDeleted = selectedCount('codex/item/agentMessage/delta')
        const diffSnapshotsDeleted = selectedCount('codex/turn/diff/updated')
        const itemStartedDeleted = selectedCount('codex/item/started')
        const expectedDeletes =
          commandOutputDeltasDeleted +
          agentMessageDeltasDeleted +
          diffSnapshotsDeleted +
          itemStartedDeleted
        const deleted = this.db
          .prepare(
            `DELETE FROM events
             WHERE seq IN (SELECT seq FROM journal_condense_delete)`
          )
          .run().changes
        if (deleted !== expectedDeletes) {
          throw new Error(
            `journal condensation deleted ${deleted} rows from a ${expectedDeletes}-row selection`
          )
        }
        if (
          commandOutputDeltasDeleted > 0 ||
          agentMessageDeltasDeleted > 0 ||
          diffSnapshotsDeleted > 0 ||
          itemStartedDeleted > 0
        ) {
          const changedThroughSeq = this.db
            .prepare('SELECT COALESCE(MAX(seq), 0) FROM journal_condense_delete')
            .pluck()
            .get()
          if (
            typeof changedThroughSeq !== 'number' ||
            !Number.isSafeInteger(changedThroughSeq) ||
            changedThroughSeq < 1
          ) {
            throw new Error('journal condensation changed rows without a reset floor')
          }
          this.advanceReplayGeneration(now, changedThroughSeq)
        }
        return {
          commandOutputDeltasDeleted,
          agentMessageDeltasDeleted,
          diffSnapshotsDeleted,
          itemStartedDeleted,
          transientPayloadBytesDeleted,
          oversizedTransientRowsRetained,
          cursorCheckpointsWritten,
        }
      }
    )
    const writerStarted = process.hrtime.bigint()
    const transient = applyDeletes.immediate()
    const writerLockMs = Number(process.hrtime.bigint() - writerStarted) / 1_000_000
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
      writerLockMs,
      cursorCheckpointsWritten: transient.cursorCheckpointsWritten + history.cursorCheckpointsWritten,
      replication,
    }
  }

  /**
   * Build selector-only indexes outside ordinary hub startup.
   *
   * They live on the bounded transient projection rather than the payload-heavy events table. The partial
   * terminal index contains only canonical completed items; the diff index contains only cumulative patch
   * snapshots. New Journal instances still issue IF NOT EXISTS once per maintenance operation, while the
   * in-object flag avoids repeating schema preparation for every bounded delete batch.
   */
  private ensureTransientMaintenanceIndexes(): void {
    if (this.transientMaintenanceIndexesReady) return
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_journal_transient_terminal_correlation
        ON journal_transient_event_index (
          session,
          thread_id,
          turn_id,
          item_id,
          item_type,
          ts
        )
        WHERE kind = 'codex/item/completed' AND canonical_terminal = 1;
      CREATE INDEX IF NOT EXISTS idx_journal_transient_completed_item_correlation
        ON journal_transient_event_index (
          session,
          thread_id,
          turn_id,
          item_id,
          ts
        )
        WHERE kind = 'codex/item/completed';
      CREATE INDEX IF NOT EXISTS idx_journal_transient_diff_correlation
        ON journal_transient_event_index (
          session,
          thread_id,
          turn_id,
          seq
        )
        WHERE kind = 'codex/turn/diff/updated';
    `)
    this.transientMaintenanceIndexesReady = true
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
    | 'commandOutputDeltasDeleted'
    | 'agentMessageDeltasDeleted'
    | 'diffSnapshotsDeleted'
    | 'itemStartedDeleted'
    | 'transientPayloadBytesDeleted'
    | 'oversizedTransientRowsRetained'
    | 'writerLockMs'
    | 'replication'
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
      CREATE TEMP TABLE IF NOT EXISTS journal_history_delete (
        seq INTEGER PRIMARY KEY
      );
    `)

    const terminals = this.db
      .prepare(
        `SELECT candidate.seq, candidate.ts, candidate.session, candidate.kind
         FROM journal_transient_event_index AS candidate
         LEFT JOIN journal_turn_rollups AS done ON done.terminal_seq = candidate.seq
         WHERE candidate.session IS NOT NULL
           AND candidate.kind IN ('claude/result', 'codex/turn/completed')
           AND candidate.ts <= ?
           AND candidate.seq <= ?
           AND done.terminal_seq IS NULL
         ORDER BY candidate.seq
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
       FROM journal_transient_event_index
       WHERE session = ? AND seq < ? AND kind IN ('claude/result', 'codex/turn/completed')`
    )
    const turnRowsStmt = this.db.prepare(
      `SELECT event.seq, event.ts, event.session, event.kind, event.payload, event.wseq
       FROM journal_session_event_index AS session_event
       JOIN events AS event ON event.seq = session_event.seq
       WHERE session_event.session = ? AND session_event.seq > ? AND session_event.seq <= ?
       ORDER BY session_event.seq`
    )
    const turnSizeStmt = this.db.prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(length(CAST(event.payload AS BLOB))), 0) AS bytes
       FROM journal_session_event_index AS session_event
       JOIN events AS event ON event.seq = session_event.seq
       WHERE session_event.session = ? AND session_event.seq > ? AND session_event.seq <= ?`
    )
    const currentStateRowsStmt = this.db.prepare(
      `SELECT MAX(event.seq) AS seq
       FROM journal_session_event_index AS session_event
       JOIN events AS event ON event.seq = session_event.seq
       WHERE session_event.session = ?
         AND event.kind IN ('codex/thread/tokenUsage/updated', 'session/tokens')
       GROUP BY event.kind`
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

  /**
   * Durable terminal result for one vendor-correlated AskUserQuestion invocation. Unlike legacy approval
   * recovery, the id is derived from the SDK's per-invocation toolUseID + requestId rather than payload,
   * so replay cannot turn one answer into a standing answer for a later byte-identical question.
   */
  resolvedQuestion(id: string): ResolvedQuestion | undefined {
    const lifecycle = this.questionLifecycle(id)
    if (lifecycle && lifecycle.status !== 'pending') {
      return {
        sessionId: lifecycle.sessionId,
        status: lifecycle.status,
        correlationDigest: lifecycle.correlationDigest,
        questionDigest: lifecycle.questionDigest,
        ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
      }
    }
    return undefined
  }

  /** Whether this exact invocation already received the one operator-visible lost-reply notice. */
  questionRecoveryUnknownNoted(id: string): boolean {
    if (!this.questionRecoveryUnknownStmt) {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_events_question_recovery_unknown ON events(json_extract(payload, '$.id')) WHERE kind = 'question/recovery-unknown'"
      )
      this.questionRecoveryUnknownStmt = this.db.prepare(
        "SELECT 1 AS present FROM events WHERE kind = 'question/recovery-unknown' AND json_extract(payload, '$.id') = ? LIMIT 1"
      )
    }
    return this.questionRecoveryUnknownStmt.get(id) !== undefined
  }

  /** Return one materialized question summary; active bodies never enter this database. */
  questionLifecycle(id: string): DurableQuestion | undefined {
    const row = this.db
      .prepare(
        `SELECT id, session, correlation_digest, question_digest, owner_epoch, status,
                terminal_reason
         FROM question_lifecycles WHERE id = ?`
      )
      .get(id) as
      | {
          id: string
          session: string
          correlation_digest: string
          question_digest: string
          owner_epoch: string
          status: DurableQuestion['status']
          terminal_reason: ResolvedQuestion['reason'] | null
        }
      | undefined
    if (!row) return undefined
    return {
      id: row.id,
      sessionId: row.session,
      correlationDigest: row.correlation_digest,
      questionDigest: row.question_digest,
      ownerEpoch: row.owner_epoch,
      status: row.status,
      ...(row.terminal_reason ? { reason: row.terminal_reason } : {}),
    }
  }

  /**
   * Atomically register bounded lifecycle metadata. A failed append rolls back the row; a post-commit
   * subscriber failure is contained by atomic(), so callers never retain a phantom.
   */
  registerQuestion(
    question: {
      id: string
      sessionId: string
      correlationDigest: string
      toolUseIdLength: number
      requestIdLength: number
      questionDigest: string
      ownerEpoch: string
      inputBytes: number
      createdAt: string
      questionCount: number
    },
    limits: { global: number; perSession: number }
  ): RegisterQuestionResult {
    return this.atomic(() => {
      const existing = this.questionLifecycle(question.id)
      if (existing) return { created: false, state: existing }
      const global = (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM question_lifecycles WHERE status = 'pending'")
          .get() as { n: number }
      ).n
      if (global >= limits.global) throw new Error('too many pending questions in this hub')
      const session = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM question_lifecycles WHERE status = 'pending' AND session = ?"
          )
          .get(question.sessionId) as { n: number }
      ).n
      if (session >= limits.perSession) {
        throw new Error('too many pending questions for this session')
      }
      this.db
        .prepare(
          `INSERT INTO question_lifecycles
             (id, session, correlation_digest, tool_use_id_length, request_id_length,
              question_digest, owner_epoch, status, terminal_reason, input_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`
        )
        .run(
          question.id,
          question.sessionId,
          question.correlationDigest,
          question.toolUseIdLength,
          question.requestIdLength,
          question.questionDigest,
          question.ownerEpoch,
          question.inputBytes,
          question.createdAt
        )
      // Full prompts/descriptions/previews are intentionally absent from the append-only replay stream.
      this.append(question.sessionId, 'question/requested', {
        id: question.id,
        correlationDigest: question.correlationDigest,
        toolUseIdLength: question.toolUseIdLength,
        requestIdLength: question.requestIdLength,
        questionDigest: question.questionDigest,
        questionCount: question.questionCount,
        inputBytes: question.inputBytes,
      })
      return {
        created: true,
        state: this.questionLifecycle(question.id)!,
      }
    })
  }

  /** CAS pending -> terminal and its audit row in one SQLite transaction. */
  resolveQuestion(
    id: string,
    expected: {
      sessionId: string
      correlationDigest: string
      questionDigest: string
    },
    status: ResolvedQuestion['status'],
    reason?: ResolvedQuestion['reason']
  ): ResolveQuestionResult {
    return this.atomic(() => {
      const before = this.questionLifecycle(id)
      if (!before) throw new Error('question lifecycle is missing')
      if (
        before.sessionId !== expected.sessionId ||
        before.correlationDigest !== expected.correlationDigest ||
        before.questionDigest !== expected.questionDigest
      ) {
        throw new Error('durable question correlation conflicts with the current request')
      }
      if (before.status !== 'pending') {
        return {
          written: false,
          state: {
            sessionId: before.sessionId,
            status: before.status,
            correlationDigest: before.correlationDigest,
            questionDigest: before.questionDigest,
            ...(before.reason ? { reason: before.reason } : {}),
          },
        }
      }
      const changed = this.db
        .prepare(
          `UPDATE question_lifecycles
           SET status = ?, terminal_reason = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(status, reason ?? null, id)
      if (changed.changes !== 1) {
        const raced = this.questionLifecycle(id)
        if (!raced || raced.status === 'pending') throw new Error('question terminal CAS failed')
        return {
          written: false,
          state: {
            sessionId: raced.sessionId,
            status: raced.status,
            correlationDigest: raced.correlationDigest,
            questionDigest: raced.questionDigest,
            ...(raced.reason ? { reason: raced.reason } : {}),
          },
        }
      }
      this.append(expected.sessionId, 'question/resolved', {
        id,
        status,
        correlationDigest: expected.correlationDigest,
        questionDigest: expected.questionDigest,
        ...(reason ? { reason } : {}),
      })
      return {
        written: true,
        state: {
          sessionId: expected.sessionId,
          status,
          correlationDigest: expected.correlationDigest,
          questionDigest: expected.questionDigest,
          ...(reason ? { reason } : {}),
        },
      }
    })
  }

  /**
   * Planned blue drain: atomically close every callback owned by this process and retain only a body-free
   * marker saying its containing turn still needs an observed terminal boundary.
   */
  terminalizeOwnedQuestionsForRestart(
    ownerEpoch: string,
    restartGeneration: string
  ): RestartInterruptedTurn[] {
    return this.atomic(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM question_lifecycles
           WHERE status = 'pending' AND owner_epoch = ? ORDER BY created_at, id`
        )
        .all(ownerEpoch) as Array<{ id: string }>
      const questionIds = new Map<string, string[]>()
      for (const { id } of rows) {
        const state = this.questionLifecycle(id)
        if (!state || state.status !== 'pending') continue
        const result = this.resolveQuestion(
          id,
          {
            sessionId: state.sessionId,
            correlationDigest: state.correlationDigest,
            questionDigest: state.questionDigest,
          },
          'interrupted',
          'interrupted_by_restart'
        )
        if (!result.written) continue
        const ids = questionIds.get(state.sessionId) ?? []
        ids.push(id)
        questionIds.set(state.sessionId, ids)
      }
      const interrupted = [...questionIds].map(([sessionId, ids]) => ({
        restartGeneration,
        sessionId,
        questionCount: ids.length,
        questionIds: ids,
      }))
      for (const turn of interrupted) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO question_restart_interruptions
               (restart_generation, session, phase, boundary, question_count, created_at)
             VALUES (?, ?, 'planned', 'pending', ?, ?)`
          )
          .run(
            restartGeneration,
            turn.sessionId,
            turn.questionCount,
            new Date().toISOString()
          )
      }
      return interrupted
    })
  }

  /**
   * Record the observed same-turn boundary before blue releases its listener. A timeout is deliberately
   * "unknown", not a fabricated cancellation or a fresh provider turn. The CAS makes notification
   * idempotent across duplicate supervisor messages.
   */
  completeQuestionRestartInterruptions(
    interrupted: readonly RestartInterruptedTurn[],
    completedSessionIds: ReadonlySet<string>
  ): number {
    return this.atomic(() => {
      let written = 0
      for (const turn of interrupted) {
        const boundary = completedSessionIds.has(turn.sessionId) ? 'completed' : 'unknown'
        const changed = this.db
          .prepare(
            `UPDATE question_restart_interruptions
             SET boundary = ?
             WHERE restart_generation = ? AND session = ? AND boundary = 'pending'`
          )
          .run(boundary, turn.restartGeneration, turn.sessionId)
        if (changed.changes !== 1) continue
        this.append(turn.sessionId, 'question/restart-interrupted', {
          reason: 'interrupted_by_restart',
          phase: this.db
            .prepare(
              `SELECT phase FROM question_restart_interruptions
               WHERE restart_generation = ? AND session = ?`
            )
            .pluck()
            .get(turn.restartGeneration, turn.sessionId),
          turnBoundary: boundary,
          questionCount: turn.questionCount,
        })
        written += 1
      }
      return written
    })
  }

  /**
   * Return one not-yet-injected, bounded conversation excerpt after an interrupted interactive question.
   * This is the durable fallback for the rare case where the vendor resume identity/process is unavailable.
   * Only conversational rows are selected; tool output and command streams never enter the capsule.
   */
  restartContinuityExcerpt(sessionId: string, limit = 120): RestartContinuityExcerpt | undefined {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('restart continuity limit is outside the supported bound')
    }
    const interrupted = this.db.prepare(
      `SELECT source.seq, source.payload
       FROM journal_session_event_index AS source_index
       JOIN events AS source ON source.seq = source_index.seq
       WHERE source_index.session = ? AND source.kind = 'question/restart-interrupted'
         AND NOT EXISTS (
           SELECT 1
           FROM journal_session_event_index AS injected_index
           JOIN events AS injected ON injected.seq = injected_index.seq
           WHERE injected_index.session = source_index.session
             AND injected.kind = 'session/restart-continuity-injected'
             AND CAST(json_extract(injected.payload, '$.sourceSeq') AS INTEGER) = source.seq
         )
       ORDER BY source_index.seq DESC LIMIT 1`
    ).get(sessionId) as { seq: number; payload: string } | undefined
    if (!interrupted) return undefined
    const rows = this.db.prepare(
      `SELECT seq, kind, payload FROM (
         SELECT event.seq, event.kind, event.payload
         FROM journal_session_event_index AS session_event
         JOIN events AS event ON event.seq = session_event.seq
         WHERE session_event.session = ? AND session_event.seq < ? AND event.kind IN (
           'session/input', 'claude/assistant', 'claude/result',
           'codex/item/completed', 'codex/subagent/item/completed'
         )
         ORDER BY session_event.seq DESC LIMIT ?
       ) ORDER BY seq ASC`
    ).all(sessionId, interrupted.seq, limit) as Array<{ seq: number; kind: string; payload: string }>
    let questionCount = 1
    try {
      const payload = JSON.parse(interrupted.payload) as { questionCount?: unknown }
      if (typeof payload.questionCount === 'number' && Number.isSafeInteger(payload.questionCount)) {
        questionCount = payload.questionCount
      }
    } catch {
      // The journal guarantees JSON, but a missing count must not suppress continuity recovery.
    }
    return {
      sourceSeq: interrupted.seq,
      questionCount,
      events: rows.map((row) => ({
        ...row,
        payload: parsePayload(row.payload, row.seq, this.payloadBlobs),
      })),
    }
  }

  /** Foreign-owner rows have no callback in this process; close and surface them before promotion. */
  terminalizeForeignQuestions(ownerEpoch: string): number {
    return this.atomic(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM question_lifecycles
           WHERE status = 'pending' AND owner_epoch <> ? ORDER BY created_at, id`
        )
        .all(ownerEpoch) as Array<{ id: string }>
      let count = 0
      const counts = new Map<string, Map<string, number>>()
      for (const { id } of rows) {
        const state = this.questionLifecycle(id)
        if (!state || state.status !== 'pending') continue
        const result = this.resolveQuestion(
          id,
          {
            sessionId: state.sessionId,
            correlationDigest: state.correlationDigest,
            questionDigest: state.questionDigest,
          },
          'interrupted',
          'interrupted_by_restart'
        )
        if (!result.written) continue
        let sessions = counts.get(state.ownerEpoch)
        if (!sessions) {
          sessions = new Map()
          counts.set(state.ownerEpoch, sessions)
        }
        sessions.set(state.sessionId, (sessions.get(state.sessionId) ?? 0) + 1)
        count += 1
      }
      for (const [sourceOwnerEpoch, sessions] of counts) {
        for (const [sessionId, questionCount] of sessions) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO question_restart_interruptions
                 (restart_generation, session, phase, boundary, question_count, created_at)
               VALUES (?, ?, 'crash', 'pending', ?, ?)`
            )
            .run(
              `crash:${sourceOwnerEpoch}`,
              sessionId,
              questionCount,
              new Date().toISOString()
            )
        }
      }

      // A hard kill can happen after planned terminalization but before blue records whether the same turn
      // finished. The public successor may surface that ambiguity exactly once, but must never retry it.
      const pending = this.db
        .prepare(
          `SELECT restart_generation AS restartGeneration, session AS sessionId,
                  question_count AS questionCount
           FROM question_restart_interruptions
           WHERE boundary = 'pending'
           ORDER BY created_at, restart_generation, session`
        )
        .all() as Array<{
        restartGeneration: string
        sessionId: string
        questionCount: number
      }>
      const pendingTurns: RestartInterruptedTurn[] = pending.map((turn) => ({
        ...turn,
        questionIds: [],
      }))
      this.completeQuestionRestartInterruptions(pendingTurns, new Set())
      return count
    })
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
      payload: parsePayload(r.payload, r.seq, this.payloadBlobs),
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

  lastEventForSession(sessionId: string): { seq: number; kind: string; ts: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT event.seq, event.kind, event.ts
         FROM journal_session_event_index AS session_event
         JOIN events AS event ON event.seq = session_event.seq
         WHERE session_event.session = ?
         ORDER BY session_event.seq DESC
         LIMIT 1`
      )
      .get(sessionId) as { seq: number; kind: string; ts: string } | undefined
    return row ?? undefined
  }

  /**
   * Losslessly externalize large strings from legacy event rows in bounded, crash-resumable batches.
   *
   * Blob publication happens before each compare-and-swap row rewrite. The durable cursor advances in
   * the same SQLite transaction as the rewrite, so a kill either retries an already-published immutable
   * blob or resumes after a fully committed pointer. No transcript bytes are truncated or summarized.
   */
  externalizeLegacyPayloads(
    maxRows = 64,
    maxSourceBytes = 16 * 1024 * 1024,
  ): JournalBlobMigrationResult {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1_000) {
      throw new Error('journal blob migration row batch is outside the supported bound')
    }
    if (
      !Number.isSafeInteger(maxSourceBytes) ||
      maxSourceBytes < JOURNAL_BLOB_INLINE_LIMIT_BYTES ||
      maxSourceBytes > 256 * 1024 * 1024
    ) {
      throw new Error('journal blob migration byte batch is outside the supported bound')
    }
    const state = this.db.prepare(
      `SELECT scanned_through AS scannedThrough
       FROM journal_blob_migration_state WHERE singleton = 1`,
    ).get() as { scannedThrough: number }
    const target = Number(
      this.db.prepare('SELECT COALESCE(MAX(seq), 0) FROM events').pluck().get(),
    )
    if (!this.payloadBlobs || state.scannedThrough >= target) {
      return {
        rowsScanned: 0,
        rowsRewritten: 0,
        sourceBytesScanned: 0,
        sqliteBytesReleased: 0,
        bytesExternalized: 0,
        scannedThrough: Math.max(state.scannedThrough, target),
        target,
        complete: true,
      }
    }
    const candidates = this.db.prepare(
      `SELECT seq, payload, length(CAST(payload AS BLOB)) AS payloadBytes
       FROM events
       WHERE seq > ? AND length(CAST(payload AS BLOB)) >= ?
       ORDER BY seq
       LIMIT ?`,
    ).all(state.scannedThrough, JOURNAL_BLOB_INLINE_LIMIT_BYTES, maxRows) as Array<{
      seq: number
      payload: string
      payloadBytes: number
    }>
    let rowsScanned = 0
    let rowsRewritten = 0
    let sourceBytesScanned = 0
    let sqliteBytesReleased = 0
    let bytesExternalized = 0
    let scannedThrough = state.scannedThrough
    for (const row of candidates) {
      if (rowsScanned > 0 && sourceBytesScanned + row.payloadBytes > maxSourceBytes) break
      const parsed = JSON.parse(row.payload) as unknown
      const encoded = this.payloadBlobs.encode(parsed)
      const stored = JSON.stringify(encoded.stored)
      let rewritten = 0
      if (stored !== row.payload && Buffer.byteLength(stored) < row.payloadBytes) {
        rewritten = this.db.transaction(() => {
          const changed = this.db.prepare(
            'UPDATE events SET payload = ? WHERE seq = ? AND payload = ?',
          ).run(stored, row.seq, row.payload).changes
          if (changed > 0) {
            this.db.prepare(
              `UPDATE journal_transient_event_index
               SET payload_bytes = length(CAST(? AS BLOB)),
                   canonical_terminal = CASE
                     WHEN kind = 'codex/item/completed' AND (
                       json_type(?, '$.item.aggregatedOutput') = 'text'
                       OR json_type(?, '$.item.aggregatedOutput.${JOURNAL_BLOB_KEY}.sha256') = 'text'
                       OR json_type(?, '$.item.text') = 'text'
                       OR json_type(?, '$.item.text.${JOURNAL_BLOB_KEY}.sha256') = 'text'
                     ) THEN 1 ELSE canonical_terminal END
               WHERE seq = ?`,
            ).run(stored, stored, stored, stored, stored, row.seq)
          }
          this.db.prepare(
            `UPDATE journal_blob_migration_state
             SET scanned_through = MAX(scanned_through, ?),
                 bytes_externalized = bytes_externalized + ?,
                 rows_rewritten = rows_rewritten + ?,
                 updated_at = ?
             WHERE singleton = 1`,
          ).run(row.seq, encoded.bytesExternalized, changed, new Date().toISOString())
          return changed
        }).immediate()
      } else {
        this.db.prepare(
          `UPDATE journal_blob_migration_state
           SET scanned_through = MAX(scanned_through, ?), updated_at = ?
           WHERE singleton = 1`,
        ).run(row.seq, new Date().toISOString())
      }
      rowsScanned += 1
      rowsRewritten += rewritten
      sourceBytesScanned += row.payloadBytes
      bytesExternalized += rewritten > 0 ? encoded.bytesExternalized : 0
      sqliteBytesReleased += rewritten > 0 ? row.payloadBytes - Buffer.byteLength(stored) : 0
      scannedThrough = row.seq
    }
    const exhaustedCandidates = rowsScanned === candidates.length && candidates.length < maxRows
    if (candidates.length === 0 || exhaustedCandidates) {
      scannedThrough = target
      this.db.prepare(
        `UPDATE journal_blob_migration_state
         SET scanned_through = MAX(scanned_through, ?), updated_at = ? WHERE singleton = 1`,
      ).run(target, new Date().toISOString())
    }
    return {
      rowsScanned,
      rowsRewritten,
      sourceBytesScanned,
      sqliteBytesReleased,
      bytesExternalized,
      scannedThrough,
      target,
      complete: scannedThrough >= target,
    }
  }

  reclaimFreelistPages(maxPages = 2_048): { supported: boolean; before: number; after: number } {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 16_384) {
      throw new Error('journal incremental vacuum page batch is outside the supported bound')
    }
    const mode = Number(this.db.pragma('auto_vacuum', { simple: true }))
    const before = Number(this.db.pragma('freelist_count', { simple: true }))
    if (mode !== 2 || before <= 0) return { supported: mode === 2, before, after: before }
    this.db.pragma(`incremental_vacuum(${Math.min(before, maxPages)})`)
    const after = Number(this.db.pragma('freelist_count', { simple: true }))
    return { supported: true, before, after }
  }

  /**
   * Enforce the same explicit resident-SQLite ceiling on every maintenance cycle.
   *
   * There is deliberately no migration flag or operator-only cleanup command. A compliant root does
   * nothing. An oversized legacy root first externalizes exact large strings through the ordinary bounded
   * cursor, then this path performs SQLite's crash-atomic conversion to incremental auto-vacuum. Later
   * cycles reclaim only a bounded page batch. If retained live state itself exceeds the target, the result
   * says so honestly; this method never destroys the only copy of transcript data to manufacture success.
   */
  enforceStorageCeiling(
    targetBytes = JOURNAL_SQLITE_TARGET_BYTES,
    maxIncrementalPages = JOURNAL_STORAGE_MAX_INCREMENTAL_VACUUM_PAGES,
  ): JournalStorageEnforcementResult {
    if (!Number.isSafeInteger(targetBytes) || targetBytes < 1024 * 1024) {
      throw new Error('journal SQLite target must be a safe integer of at least 1 MiB')
    }
    if (
      !Number.isSafeInteger(maxIncrementalPages) ||
      maxIncrementalPages < 1 ||
      maxIncrementalPages > JOURNAL_STORAGE_MAX_INCREMENTAL_VACUUM_PAGES
    ) {
      throw new Error('journal storage reclaim page batch is outside the supported bound')
    }
    const cursor = Number(this.db.prepare(
      'SELECT scanned_through FROM journal_blob_migration_state WHERE singleton = 1',
    ).pluck().get())
    const pendingOversizedSeq = this.db.prepare(
      `SELECT seq
       FROM events
       WHERE seq > ? AND length(CAST(payload AS BLOB)) >= ?
       ORDER BY seq
       LIMIT 1`,
    ).pluck().get(cursor, JOURNAL_BLOB_INLINE_LIMIT_BYTES)
    if (
      !Number.isSafeInteger(cursor) ||
      (pendingOversizedSeq !== undefined &&
        (!Number.isSafeInteger(pendingOversizedSeq) || Number(pendingOversizedSeq) <= cursor))
    ) {
      throw new Error('journal payload projection state is invalid')
    }
    if (pendingOversizedSeq !== undefined) {
      throw new Error(
        `journal storage enforcement found an oversized payload at ${String(pendingOversizedSeq)} ` +
        `after projection cursor ${cursor}`,
      )
    }
    const bytesBefore = this.databasePageBytes()
    const freelistPagesBefore = Number(this.db.pragma('freelist_count', { simple: true }))
    let action: JournalStorageEnforcementResult['action'] = 'none'
    if (bytesBefore > targetBytes && freelistPagesBefore > 0) {
      const mode = Number(this.db.pragma('auto_vacuum', { simple: true }))
      if (mode === 2) {
        this.db.pragma(
          `incremental_vacuum(${Math.min(freelistPagesBefore, maxIncrementalPages)})`,
        )
        action = 'incremental-vacuum'
      } else {
        // This is not a one-off upgrade branch: it is the regular response whenever an oversized root
        // predates incremental auto-vacuum. VACUUM is crash-atomic, runs post-ready in the maintenance
        // child, and remains under that child's size-aware no-progress deadline.
        this.db.pragma('auto_vacuum = INCREMENTAL')
        this.db.exec('VACUUM')
        action = 'full-vacuum'
      }
      const findings = (this.db.pragma('quick_check') as Array<Record<string, unknown>>)
        .flatMap((row) => Object.values(row).map(String))
      if (findings.length !== 1 || findings[0]?.toLowerCase() !== 'ok') {
        throw new Error(`journal storage enforcement quick_check failed: ${findings.slice(0, 3).join('; ')}`)
      }
    }
    const bytesAfter = this.databasePageBytes()
    const freelistPagesAfter = Number(this.db.pragma('freelist_count', { simple: true }))
    return {
      targetBytes,
      bytesBefore,
      bytesAfter,
      freelistPagesBefore,
      freelistPagesAfter,
      action,
      withinTarget: bytesAfter <= targetBytes,
    }
  }

  private databasePageBytes(): number {
    const pageCount = Number(this.db.pragma('page_count', { simple: true }))
    const pageSize = Number(this.db.pragma('page_size', { simple: true }))
    if (!Number.isSafeInteger(pageCount) || !Number.isSafeInteger(pageSize)) return 0
    return pageCount * pageSize
  }

  /** Latest exact event of one kind for a session, using the bounded per-session side index. */
  latestEventForSessionKind(sessionId: string, kind: string): HubEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT event.seq, event.ts, event.session, event.kind, event.payload
         FROM journal_session_event_index AS session_event
         JOIN events AS event ON event.seq = session_event.seq
         WHERE session_event.session = ? AND event.kind = ?
         ORDER BY session_event.seq DESC
         LIMIT 1`
      )
      .get(sessionId, kind) as {
        seq: number
        ts: string
        session: string | null
        kind: string
        payload: string
      } | undefined
    return row
      ? {
          seq: row.seq,
          ts: row.ts,
          sessionId: row.session,
          kind: row.kind,
          payload: parsePayload(row.payload, row.seq, this.payloadBlobs),
        }
      : undefined
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
      payload: parsePayload(row.payload, row.seq, this.payloadBlobs),
    }))
  }

  /**
   * Latest bounded context-occupancy projection for one session. The session/sequence side index keeps
   * this proportional to that chat, not the full journal. Prefer request-scoped rows; old releases did
   * not label scope, so fall back to their latest token row and let the caller apply a conservative
   * interpretation. Condensation deliberately retains the newest `session/tokens` state row.
   */
  latestSessionTokenUsage(sessionId: string): { ts: string; payload: unknown } | undefined {
    const select = (requestScoped: boolean): { ts: string; payload: string } | undefined =>
      this.db
        .prepare(
          `SELECT event.ts, event.payload
           FROM journal_session_event_index AS session_event
           JOIN events AS event ON event.seq = session_event.seq
           WHERE session_event.session = ?
             AND event.kind = 'session/tokens'
             ${requestScoped
               ? `AND json_valid(event.payload)
                  AND (
                    json_extract(event.payload, '$.scope') = 'request'
                    OR json_type(event.payload, '$.contextUsed') IN ('integer', 'real')
                  )`
               : ''}
           ORDER BY session_event.seq DESC
           LIMIT 1`
        )
        .get(sessionId) as { ts: string; payload: string } | undefined
    const row = select(true) ?? select(false)
    if (!row) return undefined
    try {
      return { ts: row.ts, payload: parsePayload(row.payload, 0, this.payloadBlobs) }
    } catch {
      return undefined
    }
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
      payload: parsePayload(row.payload, row.seq, this.payloadBlobs),
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
function parsePayload(raw: string, seq: number, blobs?: JournalBlobStore): unknown {
  const parsed = parseStoredPayload(raw, seq)
  return blobs?.decode(parsed) ?? parsed
}

function parseStoredPayload(raw: string, seq: number): unknown {
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
