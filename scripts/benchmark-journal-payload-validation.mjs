// From apps/hub: node --import tsx ../../scripts/benchmark-journal-payload-validation.mjs [GiB, default 2]
// Synthetic data only. Never opens or modifies the operator journal.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { validateJournalPayloadBatch } from '../apps/hub/src/journalPayloadValidation.ts'
const require = createRequire(new URL('../apps/hub/package.json', import.meta.url))
const Database = require('better-sqlite3')
const gib = Number(process.argv[2] ?? 2)
if (!Number.isFinite(gib) || gib < 0.01 || gib > 4) throw new Error('fixture size must be 0.01–4 GiB')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-json-validation-bench-'))
const file = path.join(directory, 'fixture.db')
const payload = JSON.stringify({ text: 'x'.repeat(32 * 1024) })
const rows = Math.ceil(gib * 1024 ** 3 / Buffer.byteLength(payload))
let db
try {
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL') // generated benchmark data, not product durability configuration
  db.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO events(payload) VALUES (?)')
  const batchInsert = db.transaction((n) => { for (let i=0; i<n; i++) insert.run(payload) })
  for (let i=0; i<rows; i+=250) batchInsert(Math.min(250, rows-i))
  db.pragma('wal_checkpoint(TRUNCATE)')
  console.log(JSON.stringify({ phase: 'prepared', rows, databaseBytes: fs.statSync(file).size }))
  db.close()
  db = new Database(file)
  const before = performance.now()
  const invalid = db.prepare('SELECT seq FROM events WHERE json_valid(payload)=0 ORDER BY seq LIMIT 1').get()
  if (invalid) throw new Error('invalid generated fixture')
  const previousFullScanMs = performance.now()-before
  const start = performance.now()
  let batches=0, rowsScanned=0, maxBatchMs=0
  while (true) {
    const batchStart=performance.now()
    const batch=validateJournalPayloadBatch(db)
    maxBatchMs=Math.max(maxBatchMs, performance.now()-batchStart)
    batches++; rowsScanned+=batch.rowsScanned
    if (batch.complete) break
    await new Promise(resolve=>setImmediate(resolve))
    if (performance.now()-start > 120_000) throw new Error('validation exceeded fixture deadline')
  }
  const initialValidationMs=performance.now()-start
  const steadyStart=performance.now()
  const steady=validateJournalPayloadBatch(db)
  const steadyMs=performance.now()-steadyStart
  if (steady.rowsScanned!==0 || !steady.complete || rowsScanned!==rows) throw new Error('validation cursor did not converge')
  db.prepare('INSERT INTO events(payload) VALUES (?)').run('{"new":"event"}')
  const next=validateJournalPayloadBatch(db)
  if (next.rowsScanned!==1 || !next.complete) throw new Error('delta validation did not isolate the new row')
  console.log(JSON.stringify({ previousFullScanMs, initialValidationMs, batches, rowsScanned, maxBatchMs,
    steadyRowsScanned: steady.rowsScanned, steadyMs, nextCycleRowsScanned: next.rowsScanned,
    caveat: 'OS cache was not purged; this compares work shape on generated data, not cold-device UI latency.' }))
} finally {
  if (db?.open) db.close()
  // Exact task-owned directory only; never derived from operator data or a supplied path.
  if (path.dirname(directory)!==os.tmpdir() || !path.basename(directory).startsWith('ama-json-validation-bench-')) {
    throw new Error('refusing unexpected benchmark cleanup target')
  }
  fs.rmSync(directory, { recursive: true })
}
