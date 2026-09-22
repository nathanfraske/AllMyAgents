import type Database from 'better-sqlite3'

interface SessionEventRow {
  seq: number
  ts: string
  session: string | null
  kind: string
  payload: string
}

/**
 * A LIMIT bounds returned rows, not the work needed to find them. Reading an idle session directly
 * from `events` scanned the whole journal on the hub thread; a fleet status repeated that per agent.
 * Reuse the existing session/sequence projection, without a new boot-time index or transcript cache.
 *
 * Check its frontier and read in ONE snapshot: maintenance/backfill cannot change completeness between
 * the two statements. During legacy backfill fall back to the exact table rather than silently dropping
 * unindexed events (particularly turn authority). Hydration happens after this short read transaction.
 */
export function readSessionEventRows(
  db: Database.Database,
  sessionId: string,
  options: { afterSeq?: number; limit: number; descending?: boolean; kind?: string },
): SessionEventRow[] {
  return db.transaction(() => {
    const complete = db.prepare(`SELECT scanned_through >= (SELECT COALESCE(MAX(seq), 0) FROM events)
      FROM journal_session_index_state WHERE singleton = 1`).pluck().get() === 1
    const source = complete
      ? 'journal_session_event_index AS si JOIN events AS e ON e.seq = si.seq'
      : 'events AS e'
    const session = complete ? 'si.session' : 'e.session'
    const seq = complete ? 'si.seq' : 'e.seq'
    const kind = options.kind === undefined ? '' : 'AND e.kind = @kind'
    return db.prepare(`SELECT e.seq, e.ts, e.session, e.kind, e.payload FROM ${source}
      WHERE ${session} = @session AND ${seq} > @after ${kind}
      ORDER BY ${seq} ${options.descending ? 'DESC' : 'ASC'} LIMIT @limit`)
      .all({ session: sessionId, after: options.afterSeq ?? 0, limit: options.limit,
        ...(options.kind === undefined ? {} : { kind: options.kind }) }) as SessionEventRow[]
  })()
}
