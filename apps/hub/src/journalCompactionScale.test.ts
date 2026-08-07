import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { afterAll, describe, expect, it } from 'vitest'
import {
  JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES,
  Journal,
  TransientHistoryIndexingError,
} from './journal.js'

const NOW = Date.parse('2026-07-30T12:00:00.000Z')
const OLD = '2026-07-30T10:00:00.000Z'

describe('measured journal compaction scale', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-compaction-scale-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it(
    'indexes terminal correlations before selecting the incident-sized maintenance frontier',
    () => {
      const journal = new Journal(path.join(tmp, 'frontier-correlation.db'))
      try {
        // The live failure had ~700k transient candidates and ~82k completed items. With only the old
        // (kind, seq) index, every correlated terminal lookup walked most completed items and the selector
        // never returned inside the maintenance child's 4m50s lifetime. Keep the fixture materially smaller
        // for CI while preserving the pathological many-candidates x many-terminals query shape.
        journal.db.exec(`
          BEGIN IMMEDIATE;
          WITH RECURSIVE n(value) AS (
            VALUES(1)
            UNION ALL SELECT value + 1 FROM n WHERE value < 100000
          )
          INSERT INTO journal_transient_event_index (
            seq, kind, ts, session, payload_bytes, thread_id, turn_id, item_id,
            item_type, canonical_terminal
          )
          SELECT
            value,
            'codex/item/commandExecution/outputDelta',
            '${OLD}',
            'scale',
            1,
            'thread',
            'turn-' || ((value - 1) % 25000),
            'item-' || ((value - 1) % 25000),
            NULL,
            0
          FROM n;
          WITH RECURSIVE n(value) AS (
            VALUES(1)
            UNION ALL SELECT value + 1 FROM n WHERE value < 25000
          )
          INSERT INTO journal_transient_event_index (
            seq, kind, ts, session, payload_bytes, thread_id, turn_id, item_id,
            item_type, canonical_terminal
          )
          SELECT
            100000 + value,
            'codex/item/completed',
            '${OLD}',
            'scale',
            1,
            'thread',
            'turn-' || (value - 1),
            'item-' || (value - 1),
            'commandExecution',
            1
          FROM n;
          COMMIT;
        `)

        const started = performance.now()
        const frontier = journal.condensationCandidateFrontier({
          nowMs: NOW,
          graceMs: 60 * 60 * 1000,
          maxTransientPayloadBytes: JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES,
        })
        const elapsedMs = performance.now() - started

        expect(frontier).toBe(100_000)
        // The missing-index plan does not complete inside the 30-second test lifetime. Leave ample room
        // for contended hosted runners while still proving the correlated lookup is indexed.
        expect(elapsedMs).toBeLessThan(15_000)
        const indexes = new Set(
          (
            journal.db
              .prepare(
                `SELECT name FROM sqlite_master
                 WHERE type = 'index' AND tbl_name = 'journal_transient_event_index'`
              )
              .all() as Array<{ name: string }>
          ).map((row) => row.name)
        )
        expect(indexes).toContain('idx_journal_transient_terminal_correlation')
        expect(indexes).toContain('idx_journal_transient_diff_correlation')
      } finally {
        journal.db.close()
      }
    },
    30_000
  )

  it(
    'converges the logical 205k-row / 555MB-equivalent selector accounting in bounded batches',
    () => {
      const journal = new Journal(path.join(tmp, 'scale.db'))
      try {
        // 202,779 superseded agent-message deltas plus 2,222 cumulative 250KB diff snapshots models
        // the measured 205,001 redundant rows / 555MB diff trend. The event payloads stay small so this
        // deterministic CI gate does not itself consume 555MB; the durable projection carries the exact
        // measured payload byte weight used by the production selector and transaction cap.
        journal.db.exec(`
          BEGIN IMMEDIATE;
          WITH RECURSIVE n(value) AS (
            VALUES(1)
            UNION ALL
            SELECT value + 1 FROM n WHERE value < 202779
          )
          INSERT INTO events (ts, session, kind, payload)
          SELECT
            '${OLD}',
            'scale',
            'codex/item/agentMessage/delta',
            '{"threadId":"thread","turnId":"turn","itemId":"answer","delta":"x"}'
          FROM n;
          INSERT INTO events (ts, session, kind, payload)
          VALUES (
            '${OLD}',
            'scale',
            'codex/item/completed',
            '{"threadId":"thread","turnId":"turn","item":{"id":"answer","type":"agentMessage","text":"canonical"}}'
          );
          WITH RECURSIVE n(value) AS (
            VALUES(1)
            UNION ALL
            SELECT value + 1 FROM n WHERE value < 2222
          )
          INSERT INTO events (ts, session, kind, payload)
          SELECT
            '${OLD}',
            'scale',
            'codex/turn/diff/updated',
            '{"threadId":"thread","turnId":"diff-turn","diff":"cumulative"}'
          FROM n;
          UPDATE journal_transient_event_index
          SET payload_bytes = 250000
          WHERE kind = 'codex/turn/diff/updated';
          COMMIT;
        `)

        let deletedRows = 0
        let representedBytes = 0
        for (let batch = 0; batch < 160; batch += 1) {
          const result = journal.condenseCompletedCodex({
            nowMs: NOW,
            graceMs: 60 * 60 * 1000,
            maxCommandOutputDeltas: 5_000,
            maxAgentMessageDeltas: 5_000,
            maxDiffSnapshots: 5_000,
            maxTransientPayloadBytes: JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES,
          })
          const deleted =
            result.commandOutputDeltasDeleted +
            result.agentMessageDeltasDeleted +
            result.diffSnapshotsDeleted +
            result.itemStartedDeleted
          deletedRows += deleted
          representedBytes += result.transientPayloadBytesDeleted
          expect(result.transientPayloadBytesDeleted).toBeLessThanOrEqual(
            JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES
          )
          if (deleted === 0) break
        }

        const retained = journal.db
          .prepare(
            `SELECT COUNT(*) AS rows, COALESCE(SUM(payload_bytes), 0) AS bytes
             FROM journal_transient_event_index
             WHERE kind IN (
               'codex/item/agentMessage/delta',
               'codex/turn/diff/updated'
             )`
          )
          .get() as { rows: number; bytes: number }
        expect(deletedRows).toBeGreaterThan(200_000)
        expect(representedBytes).toBeGreaterThan(555_000_000)
        expect(retained.rows).toBeLessThan(5_000)
        expect(retained.bytes).toBeLessThan(16 * 1024 * 1024)
      } finally {
        journal.db.close()
      }
    },
    120_000
  )

  it(
    'keeps concurrent appends bounded while deleting genuinely large payload rows',
    async () => {
      const file = path.join(tmp, 'physical-scale.db')
      const journal = new Journal(file)
      const largeDelta = 'x'.repeat(256 * 1024)
      const payload = JSON.stringify({
        threadId: 'thread',
        turnId: 'physical-turn',
        itemId: 'answer',
        delta: largeDelta,
      })
      const insert = journal.db.prepare(
        'INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)'
      )
      journal.db.transaction(() => {
        for (let index = 0; index < 128; index += 1) {
          insert.run(OLD, 'physical', 'codex/item/agentMessage/delta', payload)
        }
        insert.run(
          OLD,
          'physical',
          'codex/item/completed',
          JSON.stringify({
            threadId: 'thread',
            turnId: 'physical-turn',
            item: { id: 'answer', type: 'agentMessage', text: 'canonical' },
          })
        )
      }).immediate()
      expect(journal.backfillTransientEventIndex(5_000).complete).toBe(true)

      const require = createRequire(import.meta.url)
      const worker = new Worker(
        `
          const { parentPort, workerData } = require('node:worker_threads')
          const { performance } = require('node:perf_hooks')
          const Database = require(workerData.betterSqlite3)
          const db = new Database(workerData.file)
          db.pragma('busy_timeout = 5000')
          const insert = db.prepare(
            "INSERT INTO events (ts, session, kind, payload) VALUES (?, NULL, 'test/concurrent-append', '{}')"
          )
          parentPort.on('message', (id) => {
            const started = performance.now()
            insert.run(new Date().toISOString())
            parentPort.postMessage({ id, elapsed: performance.now() - started })
          })
        `,
        {
          eval: true,
          workerData: {
            betterSqlite3: require.resolve('better-sqlite3'),
            file,
          },
        }
      )
      const waitForAppend = (id: number): Promise<number> =>
        new Promise((resolve, reject) => {
          const onMessage = (message: { id: number; elapsed: number }): void => {
            if (message.id !== id) return
            worker.off('message', onMessage)
            worker.off('error', onError)
            resolve(message.elapsed)
          }
          const onError = (error: Error): void => {
            worker.off('message', onMessage)
            reject(error)
          }
          worker.on('message', onMessage)
          worker.once('error', onError)
          worker.postMessage(id)
        })

      const appendLatencies: number[] = []
      let physicallyDeleted = 0
      try {
        for (let batch = 0; batch < 12; batch += 1) {
          const append = waitForAppend(batch)
          let result: ReturnType<Journal['condenseCompletedCodex']>
          while (true) {
            journal.backfillTransientEventIndex(5_000)
            try {
              result = journal.condenseCompletedCodex({
                nowMs: NOW,
                graceMs: 60 * 60 * 1000,
                maxCommandOutputDeltas: 5_000,
                maxAgentMessageDeltas: 5_000,
                maxDiffSnapshots: 5_000,
                maxTransientPayloadBytes: JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES,
              })
              break
            } catch (error) {
              if (error instanceof TransientHistoryIndexingError) continue
              throw error
            }
          }
          appendLatencies.push(await append)
          physicallyDeleted += result.transientPayloadBytesDeleted
          expect(result.transientPayloadBytesDeleted).toBeLessThanOrEqual(
            JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES
          )
          if (result.agentMessageDeltasDeleted === 0) break
        }
        const sorted = [...appendLatencies].sort((left, right) => left - right)
        const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
        expect(physicallyDeleted).toBeGreaterThan(24 * 1024 * 1024)
        // This default CI gate runs beside the entire Vitest pool, so it detects a wedge rather than
        // claiming an isolated latency percentile. The opt-in 619MB physical stress is the authoritative
        // p95 <100ms measurement against the incident-shaped corpus.
        expect(p95).toBeLessThan(1_000)
      } finally {
        await worker.terminate()
        journal.db.close()
      }
    },
    120_000
  )
})
