import type Database from 'better-sqlite3'
import type { SessionApiRecord } from './sessions.js'
import type { SessionRecord } from './types.js'

const MAX_SESSION_RECORD_BYTES = 256 * 1024

/**
 * Read the replay roster from the durable materialized session table inside the caller's SQLite snapshot.
 * Green may have booted before blue's final mutation; its memory can be stale, while the persisted record
 * is written before the corresponding journal event. Pairing this read with Journal.readReplaySnapshot
 * prevents a baseline watermark from skipping a committed session change.
 */
export function durableReplaySessions(
  db: Database.Database,
  pendingBusCounts: ReadonlyMap<string, number>
): SessionApiRecord[] {
  const rows = db
    .prepare(
      `SELECT
         CASE WHEN length(CAST(record AS BLOB)) <= ? THEN record ELSE NULL END AS record,
         length(CAST(record AS BLOB)) AS record_bytes
       FROM sessions
       ORDER BY updated ASC`
    )
    .all(MAX_SESSION_RECORD_BYTES) as Array<{
    record: string | null
    record_bytes: number
  }>
  return rows.map((row) => {
    if (row.record === null || row.record_bytes > MAX_SESSION_RECORD_BYTES) {
      throw new Error('durable replay session record exceeds its byte bound')
    }
    const record = JSON.parse(row.record) as SessionRecord
    if (!record || typeof record.id !== 'string' || record.id.length > 256) {
      throw new Error('durable replay session record is invalid')
    }
    return {
      ...record,
      unreadFromTeammates: pendingBusCounts.get(record.id) ?? 0,
    }
  })
}
