import type Database from 'better-sqlite3'
import type { TaskBoardEvent } from './taskBoard.js'

/** Complete, task-only replay. Neither a transcript prefix nor its tail is authoritative task state.
 * Filter inside SQLite, including individual Claude blocks, BEFORE hydrating any blob. A message can
 * contain a tiny TaskCreate beside a multi-megabyte tool result; that result is not board input.
 * The existing session index avoids scanning unrelated chats. During legacy index backfill use the
 * original table, not an incomplete index. No new boot-time index/migration or duplicate task writes.
 */
export function readTaskBoardEvents(
  db: Database.Database,
  sessionId: string,
  decode: (payload: string, seq: number) => unknown,
): TaskBoardEvent[] {
  return db.transaction(() => {
    const complete = db.prepare(`SELECT scanned_through >= (SELECT COALESCE(MAX(seq), 0) FROM events)
      FROM journal_session_index_state WHERE singleton = 1`).pluck().get() === 1
    const source = complete
      ? `journal_session_event_index AS si JOIN events AS e ON e.seq = si.seq`
      : 'events AS e'
    const session = complete ? 'si.session' : 'e.session'
    // This CTE is deliberately NOT materialized: unrelated transcript payloads never form a temp table.
    const rows = db.prepare(`
      WITH scoped AS NOT MATERIALIZED (
        SELECT e.seq, e.ts, e.kind, e.payload FROM ${source}
        WHERE ${session} = @session
          AND e.kind IN ('manager/task-assigned', 'codex/turn/plan/updated', 'claude/assistant', 'claude/user')
      ), calls AS MATERIALIZED (
        SELECT e.seq, e.ts, e.kind, b.key AS ordinal, b.value AS block,
          json_extract(b.value, '$.id') AS tool_id
        FROM scoped AS e, json_each(CASE WHEN json_valid(e.payload)
          THEN e.payload ELSE '{}' END, '$.message.content') AS b
        WHERE e.kind = 'claude/assistant' AND b.type = 'object'
          AND json_extract(b.value, '$.type') = 'tool_use'
          AND json_extract(b.value, '$.name') IN ('TaskCreate', 'TaskUpdate', 'TodoWrite', 'update_plan')
      )
      SELECT seq, ts, kind, 0 AS ordinal, payload FROM scoped
      WHERE kind IN ('manager/task-assigned', 'codex/turn/plan/updated')
      UNION ALL
      SELECT seq, ts, kind, ordinal,
        json_object('message', json_object('content', json_array(json(block)))) AS payload FROM calls
      UNION ALL
      SELECT e.seq, e.ts, e.kind, b.key AS ordinal,
        json_object('message', json_object('content', json_array(json(b.value)))) AS payload
      FROM scoped AS e, json_each(CASE WHEN json_valid(e.payload)
        THEN e.payload ELSE '{}' END, '$.message.content') AS b
      WHERE e.kind = 'claude/user' AND b.type = 'object'
        AND json_extract(b.value, '$.type') = 'tool_result'
        AND json_extract(b.value, '$.tool_use_id') IN (SELECT tool_id FROM calls WHERE tool_id IS NOT NULL)
      ORDER BY seq, ordinal
    `).iterate({ session: sessionId }) as Iterable<{ seq: number; ts: string; kind: string; payload: string }>
    const events: TaskBoardEvent[] = []
    for (const row of rows) events.push({ ts: row.ts, kind: row.kind, payload: decode(row.payload, row.seq) })
    return events
  })()
}
