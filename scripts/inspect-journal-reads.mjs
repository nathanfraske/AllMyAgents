// Read-only diagnostics. No Journal constructor (which migrates), checkpoint, vacuum or payload output.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { statSync } from 'node:fs'

if (process.argv[2] !== '--read-only-child') {
  if (!process.argv[2]) throw new Error('Usage: node scripts/inspect-journal-reads.mjs <existing hub.db>')
  const file = path.resolve(process.argv[2])
  if (!statSync(file).isFile()) throw new Error('An existing database file is required')
  const worker = fork(fileURLToPath(import.meta.url), ['--read-only-child', file], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const deadline = setTimeout(() => {
    console.error('Read-only inspection exceeded 45 seconds; terminating diagnostics only.')
    process.exitCode = 1
    worker.kill('SIGKILL')
  }, 45_000)
  worker.on('message', value => console.log(JSON.stringify(value)))
  worker.stderr.on('data', bytes => process.stderr.write(bytes))
  worker.on('error', error => { console.error(error); process.exitCode = 1 })
  worker.on('exit', code => { clearTimeout(deadline); if (code !== 0) process.exitCode = 1 })
} else {
  const require = createRequire(new URL('../apps/hub/package.json', import.meta.url))
  const Database = require('better-sqlite3')
  const db = new Database(process.argv[3], { readonly: true, fileMustExist: true, timeout: 1_000 })
  const timed = (label, read) => {
    const start = performance.now()
    const value = read()
    process.send({ label, elapsedMs: +(performance.now() - start).toFixed(2), value })
    return value
  }
  try {
    timed('allocation', () => Object.fromEntries(['page_size', 'page_count', 'freelist_count', 'auto_vacuum', 'journal_size_limit']
      .map(key => [key, db.pragma(key, { simple: true })])))
    timed('projections', () => ['journal_session_history_index_state', 'journal_session_index_state', 'journal_blob_migration_state']
      .map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table} LIMIT 1`).all() })))
    timed('maintenance', () => db.prepare('SELECT phase, updated_at, rows_deleted, payload_bytes_deleted, detail FROM journal_compaction_runs ORDER BY updated_at DESC LIMIT 3').all())
    timed('recent-sample-20000-not-whole-database', () => db.prepare(`SELECT kind, COUNT(*) AS rows,
      SUM(length(CAST(payload AS BLOB))) AS bytes FROM (SELECT kind, payload FROM events ORDER BY seq DESC LIMIT 20000)
      GROUP BY kind ORDER BY bytes DESC LIMIT 10`).all())
    const sessions = db.prepare('SELECT DISTINCT session FROM (SELECT session FROM events ORDER BY seq DESC LIMIT 3000) WHERE session IS NOT NULL LIMIT 8').all()
    for (const [index, { session }] of sessions.entries()) {
      const query = `SELECT e.seq, e.kind, length(CAST(e.payload AS BLOB)) AS bytes,
          CASE WHEN length(CAST(e.payload AS BLOB)) <= 262144 THEN e.payload ELSE NULL END AS payload
        FROM journal_session_history_event_index AS i JOIN events AS e ON e.seq = i.seq
        WHERE i.session = ? AND i.seq < ? ORDER BY i.seq DESC LIMIT 41`
      if (index === 0) timed('history-query-plan', () => db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(session, Number.MAX_SAFE_INTEGER))
      timed(`recent-session-${index + 1}-history-page`, () => {
        const rows = db.prepare(query).all(session, Number.MAX_SAFE_INTEGER)
        return { rows: rows.length, storedBytes: rows.reduce((n, row) => n + row.bytes, 0) }
      })
    }
  } finally { db.close() }
}
