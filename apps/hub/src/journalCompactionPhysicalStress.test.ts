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

const RUN = process.env.AMA_RUN_PHYSICAL_COMPACTION_STRESS === '1'
const NOW = Date.parse('2026-07-30T12:00:00.000Z')
const OLD = '2026-07-30T10:00:00.000Z'

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

describe('manual physical journal compaction stress', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-compaction-physical-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it.runIf(RUN)(
    'compacts 200k deltas plus 2,222 real 250KiB diffs with bounded concurrent writer latency',
    async () => {
      const file = path.join(tmp, 'physical-555mb.db')
      const journal = new Journal(file)
      try {
        const diffPayload = JSON.stringify({
          threadId: 'thread',
          turnId: 'diff-turn',
          diff: 'd'.repeat(250_000),
        })
        journal.db
          .prepare(
            `WITH RECURSIVE n(value) AS (
               VALUES(1)
               UNION ALL SELECT value + 1 FROM n WHERE value < 202779
             )
             INSERT INTO events (ts, session, kind, payload)
             SELECT ?, 'stress', 'codex/item/agentMessage/delta',
               '{"threadId":"thread","turnId":"turn","itemId":"answer","delta":"x"}'
             FROM n`
          )
          .run(OLD)
        journal.db
          .prepare(
            `INSERT INTO events (ts, session, kind, payload)
             VALUES (?, 'stress', 'codex/item/completed',
               '{"threadId":"thread","turnId":"turn","item":{"id":"answer","type":"agentMessage","text":"canonical"}}')`
          )
          .run(OLD)
        journal.db
          .prepare(
            `WITH RECURSIVE n(value) AS (
               VALUES(1)
               UNION ALL SELECT value + 1 FROM n WHERE value < 2222
             )
             INSERT INTO events (ts, session, kind, payload)
             SELECT ?, 'stress', 'codex/turn/diff/updated', ? FROM n`
          )
          .run(OLD, diffPayload)

        // Reuse the physical incident-shaped corpus for the transport evidence too. The baseline reads
        // only its small durable checkpoint; the 205k historical payload bodies never cross into JS.
        const baselineStarted = performance.now()
        const baseline = journal.readReplaySnapshot((checkpoint) => ({
          version: checkpoint.version,
          generation: checkpoint.generation,
          highWaterSeq: checkpoint.cursor,
          resetFloorSeq: checkpoint.resetFloorSeq,
          sessions: [],
          projects: [],
          journalCompaction: journal.latestCompactionLifecycle(),
        }))
        const baselineElapsedMs = performance.now() - baselineStarted
        const baselineBytes = Buffer.byteLength(JSON.stringify(baseline))
        const coldTail = journal.boundedReplayPage(
          baseline.highWaterSeq,
          baseline.highWaterSeq,
          { maxRows: 5_000, maxBytes: 2 * 1024 * 1024, maxFrameBytes: 512 * 1024 }
        )
        journal.append(null, 'test/reconnect', { value: 1 })
        journal.append(null, 'test/reconnect', { value: 2 })
        const reconnectCheckpoint = journal.replayCheckpoint()
        const reconnectTail = journal.boundedReplayPage(
          baseline.highWaterSeq,
          reconnectCheckpoint.cursor,
          { maxRows: 5_000, maxBytes: 2 * 1024 * 1024, maxFrameBytes: 512 * 1024 }
        )
        expect(coldTail.events).toEqual([])
        expect(coldTail.hasMore).toBe(false)
        expect(reconnectTail.events).toHaveLength(2)
        expect(reconnectTail.hasMore).toBe(false)

        while (!journal.backfillTransientEventIndex(5_000).complete) {
          // The production child yields between these bounded batches. This isolated stress has no UI loop.
        }
        journal.db.pragma('wal_checkpoint(TRUNCATE)')
        const dbBytesBefore = fileBytes(file)
        const walBytesBefore = fileBytes(`${file}-wal`)

        const require = createRequire(import.meta.url)
        const worker = new Worker(
          `
          const { parentPort, workerData } = require('node:worker_threads')
          const { performance } = require('node:perf_hooks')
          const Database = require(workerData.betterSqlite3)
          const db = new Database(workerData.file)
          db.pragma('busy_timeout = 5000')
          const insert = db.prepare(
            "INSERT INTO events (ts, session, kind, payload) VALUES (?, NULL, 'test/stress-writer', '{}')"
          )
          parentPort.on('message', (id) => {
            const started = performance.now()
            insert.run(new Date().toISOString())
            parentPort.postMessage({ id, elapsed: performance.now() - started })
          })
        `,
          {
            eval: true,
            workerData: { betterSqlite3: require.resolve('better-sqlite3'), file },
          }
        )
        const appendOnce = (id: number): Promise<number> =>
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

        const started = performance.now()
        const appendLatencies: number[] = []
        let batches = 0
        let rowsDeleted = 0
        let bytesDeleted = 0
        let maxWalBytes = 0
        try {
          for (; batches < 180; batches += 1) {
            const append = appendOnce(batches)
            journal.backfillTransientEventIndex(5_000)
            let result
            try {
              result = journal.condenseCompletedCodex({
                nowMs: NOW,
                graceMs: 60 * 60 * 1000,
                maxCommandOutputDeltas: 5_000,
                maxAgentMessageDeltas: 5_000,
                maxDiffSnapshots: 5_000,
                maxTransientPayloadBytes: JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES,
              })
            } catch (error) {
              appendLatencies.push(await append)
              if (error instanceof TransientHistoryIndexingError) {
                batches -= 1
                continue
              }
              throw error
            }
            appendLatencies.push(await append)
            const deleted =
              result.commandOutputDeltasDeleted +
              result.agentMessageDeltasDeleted +
              result.diffSnapshotsDeleted +
              result.itemStartedDeleted
            rowsDeleted += deleted
            bytesDeleted += result.transientPayloadBytesDeleted
            maxWalBytes = Math.max(maxWalBytes, fileBytes(`${file}-wal`))
            expect(result.transientPayloadBytesDeleted).toBeLessThanOrEqual(
              JOURNAL_CONDENSE_MAX_TRANSIENT_BYTES
            )
            if (deleted === 0) break
          }
        } finally {
          await worker.terminate()
        }

        const retained = journal.db
          .prepare(
            `SELECT COUNT(*) AS rows, COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes
             FROM events
             WHERE kind IN ('codex/item/agentMessage/delta', 'codex/turn/diff/updated')`
          )
          .get() as { rows: number; bytes: number }
        const sorted = [...appendLatencies].sort((left, right) => left - right)
        const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
        const maxAppendMs = sorted.at(-1) ?? 0
        const wallMs = performance.now() - started
        journal.db.pragma('wal_checkpoint(TRUNCATE)')
        const evidence = {
          baselineElapsedMs,
          baselineBytes,
          coldTailRows: coldTail.events.length,
          coldTailBytes: coldTail.encodedBytes,
          reconnectTailRows: reconnectTail.events.length,
          reconnectTailBytes: reconnectTail.encodedBytes,
          resetCount: 0,
          wallMs,
          batches,
          rowsDeleted,
          bytesDeleted,
          retainedRows: retained.rows,
          retainedBytes: retained.bytes,
          appendP95Ms: p95,
          appendMaxMs: maxAppendMs,
          dbBytesBefore,
          dbBytesAfter: fileBytes(file),
          walBytesBefore,
          maxWalBytes,
          walBytesAfter: fileBytes(`${file}-wal`),
        }
        console.log(`[physical-compaction-evidence] ${JSON.stringify(evidence)}`)

        expect(baselineElapsedMs).toBeLessThan(1_000)
        expect(baselineBytes).toBeLessThan(512 * 1024)
        expect(reconnectTail.encodedBytes).toBeLessThan(2 * 1024 * 1024)
        expect(wallMs).toBeLessThan(15 * 60 * 1_000)
        expect(batches).toBeLessThan(180)
        expect(rowsDeleted).toBeGreaterThan(200_000)
        expect(bytesDeleted).toBeGreaterThan(555_000_000)
        expect(retained.rows).toBeLessThan(5_000)
        expect(retained.bytes).toBeLessThan(16 * 1024 * 1024)
        expect(p95).toBeLessThan(100)
        expect(maxAppendMs).toBeLessThan(1_000)
      } finally {
        journal.db.close()
      }
    },
    20 * 60 * 1_000
  )
})
