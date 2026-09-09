import type Database from 'better-sqlite3'

const initialized = new WeakSet<Database.Database>()

/** Resumable content validation, not a second transcript or deletion authority. A full-table JSON
 * scan every five minutes reread gigabytes even when cleanup was waiting for the same snapshot.
 * Inserts/rewrites behind the cursor invalidate it in the writer's transaction, including writes
 * from older hub processes. Actual deletion still requires independently verified recovery coverage.
 */
export function validateJournalPayloadBatch(db: Database.Database, maxRows = 500): {
  scannedThrough: number; rowsScanned: number; complete: boolean
} {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 5_000) {
    throw new Error('journal payload validation batch must be between 1 and 5000 rows')
  }
  if (!initialized.has(db)) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS journal_payload_validation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      scanned_through INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO journal_payload_validation VALUES (1, 0);
    CREATE TRIGGER IF NOT EXISTS journal_payload_validation_insert AFTER INSERT ON events
    WHEN NEW.seq <= (SELECT scanned_through FROM journal_payload_validation WHERE singleton = 1)
    BEGIN
      UPDATE journal_payload_validation SET scanned_through = MAX(0, NEW.seq - 1) WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS journal_payload_validation_update AFTER UPDATE OF payload, seq ON events
    WHEN (NEW.payload IS NOT OLD.payload OR NEW.seq != OLD.seq)
      AND NEW.seq <= (SELECT scanned_through FROM journal_payload_validation WHERE singleton = 1)
    BEGIN
      UPDATE journal_payload_validation SET scanned_through = MAX(0, NEW.seq - 1) WHERE singleton = 1;
    END;
    `)
    initialized.add(db)
  }
  // The read and cursor advance share a transaction: a concurrent rewrite cannot be overwritten by
  // a stale validator. WAL readers remain available; yield between bounded batches to the hub writer.
  return db.transaction(() => {
    let cursor = Number(db.prepare('SELECT scanned_through FROM journal_payload_validation WHERE singleton=1').pluck().get())
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('invalid journal payload validation cursor')
    const rows = db.prepare(`
      SELECT seq, json_valid(payload) AS valid FROM events WHERE seq > ? ORDER BY seq LIMIT ?
    `).all(cursor, maxRows) as Array<{ seq: number; valid: number }>
    for (const row of rows) {
      if (!row.valid) throw new Error(`journal contains invalid JSON in event sequence ${row.seq}; maintenance refused to mutate it`)
      cursor = row.seq
    }
    if (rows.length) db.prepare('UPDATE journal_payload_validation SET scanned_through=? WHERE singleton=1').run(cursor)
    return { scannedThrough: cursor, rowsScanned: rows.length, complete: rows.length < maxRows }
  }).immediate()
}
