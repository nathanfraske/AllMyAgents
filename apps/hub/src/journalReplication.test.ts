import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { Journal } from './journal.js'
import {
  chooseReplicaAssignments,
  configureJournalReplication,
  createJournalSnapshot,
  ensureReplicationNodeIdentity,
  readJournalReplicationStatus,
  recordReplicaVerification,
  replicaGenerationDirectory,
  reserveReplicationPruneGate,
  restoreJournalSnapshot,
  transferJournalSnapshot,
  verifyJournalSnapshot,
} from './journalReplication.js'
import { runHubPreflight } from './preflight.js'
import { SCHEMA_VERSION } from './restartHandshake.js'

const roots: string[] = []
const journals: Journal[] = []

function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-journal-replication-'))
  roots.push(dir)
  return dir
}

function open(dataDir: string): Journal {
  const journal = new Journal(path.join(dataDir, 'hub.db'))
  journals.push(journal)
  return journal
}

function close(...journals: Journal[]): void {
  for (const journal of journals) {
    if (journal.db.open) journal.db.close()
  }
}

afterEach(() => {
  close(...journals.splice(0))
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('journal snapshot replication', () => {
  test('copies a real source journal between isolated hub data directories without merging active journals', async () => {
    const sourceDir = root()
    const peerDir = root()
    const source = open(sourceDir)
    const peer = open(peerDir)
    source.append('source-session', 'session/input', { text: 'source-only' })
    peer.append('peer-session', 'session/input', { text: 'peer-only' })

    const snapshot = await createJournalSnapshot({ sourceDataDir: sourceDir, chunkBytes: 16 * 1024 })
    const transfer = await transferJournalSnapshot({
      sourceGenerationDir: snapshot.generationDir,
      targetDataDir: peerDir,
    })

    expect(transfer.complete).toBe(true)
    expect(peer.since(0).map((event) => event.payload)).toEqual([{ text: 'peer-only' }])
    const replica = new Journal(path.join(transfer.generationDir, 'snapshot.db'))
    journals.push(replica)
    expect(replica.since(0).map((event) => event.payload)).toEqual([{ text: 'source-only' }])
    expect(path.resolve(sourceDir)).not.toBe(path.resolve(peerDir))
    close(replica, source, peer)
  })

  test('resumes an interrupted chunk transfer at its durable watermark without duplicating bytes or rows', async () => {
    const sourceDir = root()
    const peerDir = root()
    const source = open(sourceDir)
    for (let i = 0; i < 64; i += 1) {
      source.append('source-session', 'session/input', { i, text: `row-${i}-${'x'.repeat(4096)}` })
    }
    const snapshot = await createJournalSnapshot({ sourceDataDir: sourceDir, chunkBytes: 16 * 1024 })

    const interrupted = await transferJournalSnapshot({
      sourceGenerationDir: snapshot.generationDir,
      targetDataDir: peerDir,
      maxChunks: 2,
    })
    expect(interrupted).toMatchObject({ complete: false, chunksWritten: 2, chunksReused: 0, nextChunk: 2 })

    const resumed = await transferJournalSnapshot({
      sourceGenerationDir: snapshot.generationDir,
      targetDataDir: peerDir,
    })
    expect(resumed.complete).toBe(true)
    expect(resumed.chunksReused).toBe(2)
    const verified = verifyJournalSnapshot(resumed.generationDir, SCHEMA_VERSION)
    expect(verified.databaseSha256).toBe(snapshot.manifest.databaseSha256)
    const replica = new Database(path.join(resumed.generationDir, 'snapshot.db'), {
      readonly: true,
      fileMustExist: true,
    })
    expect(replica.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 64 })
    expect(replica.prepare('SELECT COUNT(DISTINCT seq) AS n FROM events').get()).toEqual({ n: 64 })
    replica.close()
    close(source)
  })

  test('rejects truncated offers and post-transfer corruption before either can become a restore', async () => {
    const sourceDir = root()
    const peerDir = root()
    const scratchDir = root()
    const source = open(sourceDir)
    source.append('source-session', 'session/input', { text: 'must survive' })
    const snapshot = await createJournalSnapshot({ sourceDataDir: sourceDir, chunkBytes: 16 * 1024 })

    const truncatedOffer = path.join(root(), 'truncated-offer')
    fs.cpSync(snapshot.generationDir, truncatedOffer, { recursive: true })
    fs.truncateSync(path.join(truncatedOffer, 'snapshot.db'), Math.max(0, snapshot.manifest.databaseBytes - 17))
    await expect(
      transferJournalSnapshot({ sourceGenerationDir: truncatedOffer, targetDataDir: peerDir })
    ).rejects.toThrow(/truncat|size|hash|corrupt|integrity/i)

    const transfer = await transferJournalSnapshot({
      sourceGenerationDir: snapshot.generationDir,
      targetDataDir: peerDir,
    })
    fs.truncateSync(path.join(transfer.generationDir, 'snapshot.db'), snapshot.manifest.databaseBytes - 1)
    expect(() =>
      restoreJournalSnapshot({
        replicaGenerationDir: transfer.generationDir,
        destinationDataDir: scratchDir,
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toThrow(/truncat|size|hash|corrupt|integrity/i)
    expect(fs.existsSync(path.join(scratchDir, 'hub.db'))).toBe(false)
    close(source)
  })

  test('requires a verified handoff before removing the only assigned holder of a protected generation', async () => {
    const sourceDir = root()
    const peerBDir = root()
    const peerCDir = root()
    const source = open(sourceDir)
    source.append('source-session', 'session/input', { text: 'protected' })
    const sourceNode = ensureReplicationNodeIdentity(sourceDir)
    const peerB = ensureReplicationNodeIdentity(peerBDir)
    const peerC = ensureReplicationNodeIdentity(peerCDir)
    expect(() =>
      configureJournalReplication({
        sourceJournalPath: path.join(sourceDir, 'hub.db'),
        requiredReplicas: 1,
        assignedPeerIds: [sourceNode],
      })
    ).toThrow(/source node|own local/i)
    configureJournalReplication({
      sourceJournalPath: path.join(sourceDir, 'hub.db'),
      requiredReplicas: 1,
      assignedPeerIds: [peerB],
    })
    const snapshot = await createJournalSnapshot({ sourceDataDir: sourceDir, chunkBytes: 16 * 1024 })
    await transferJournalSnapshot({ sourceGenerationDir: snapshot.generationDir, targetDataDir: peerBDir })
    recordReplicaVerification({
      sourceJournalPath: path.join(sourceDir, 'hub.db'),
      replicaDataDir: peerBDir,
      generationId: snapshot.manifest.generationId,
    })
    expect(reserveReplicationPruneGate(source.db)).toMatchObject({
      coverageSatisfied: true,
      maxPrunableSeq: snapshot.manifest.maxSeq,
    })

    expect(() =>
      configureJournalReplication({
        sourceJournalPath: path.join(sourceDir, 'hub.db'),
        requiredReplicas: 1,
        assignedPeerIds: [peerC],
      })
    ).toThrow(/protected|handoff|verified/i)

    configureJournalReplication({
      sourceJournalPath: path.join(sourceDir, 'hub.db'),
      requiredReplicas: 1,
      assignedPeerIds: [peerB, peerC],
    })
    const peerBGeneration = replicaGenerationDirectory(
      peerBDir,
      snapshot.manifest.sourceJournalId,
      snapshot.manifest.generationId
    )
    await transferJournalSnapshot({ sourceGenerationDir: peerBGeneration, targetDataDir: peerCDir })
    recordReplicaVerification({
      sourceJournalPath: path.join(sourceDir, 'hub.db'),
      replicaDataDir: peerCDir,
      generationId: snapshot.manifest.generationId,
    })
    configureJournalReplication({
      sourceJournalPath: path.join(sourceDir, 'hub.db'),
      requiredReplicas: 1,
      assignedPeerIds: [peerC],
    })

    const status = readJournalReplicationStatus(path.join(sourceDir, 'hub.db'))
    expect(status.assignedPeerIds).toEqual([peerC])
    expect(status.protectedGenerationIds).toEqual([snapshot.manifest.generationId])
    expect(chooseReplicaAssignments(snapshot.manifest.sourceJournalId, [peerC, peerB], 1)).toHaveLength(1)
    close(source)
  })

  test('restores a deleted data directory from a peer into a complete bootable scratch journal', async () => {
    const sourceDir = root()
    const peerDir = root()
    const source = open(sourceDir)
    source.append('source-session', 'session/created', { id: 'source-session' })
    source.appendWorker('source-session', 'codex/item/agentMessage/delta', { text: 'durable' }, 7)
    const snapshot = await createJournalSnapshot({ sourceDataDir: sourceDir, chunkBytes: 16 * 1024 })
    const transfer = await transferJournalSnapshot({
      sourceGenerationDir: snapshot.generationDir,
      targetDataDir: peerDir,
    })
    close(source)

    fs.rmSync(sourceDir, { recursive: true, force: true })
    expect(fs.existsSync(sourceDir)).toBe(false)
    restoreJournalSnapshot({
      replicaGenerationDir: transfer.generationDir,
      destinationDataDir: sourceDir,
      maxSchemaVersion: SCHEMA_VERSION,
    })

    const preflight = runHubPreflight({
      dataDir: sourceDir,
      journalPath: path.join(sourceDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })
    expect(preflight.ok).toBe(true)
    const restored = open(sourceDir)
    expect(restored.since(0).map((event) => event.kind)).toEqual([
      'session/created',
      'codex/item/agentMessage/delta',
    ])
    expect(restored.lastJournaledWseq('source-session')).toBe(7)
    close(restored)
  })

  test('grows instead of pruning when assigned peers have no verified coverage, then prunes only through an ack', async () => {
    const sourceDir = root()
    const peerDir = root()
    const source = open(sourceDir)
    const old = '2020-01-01T00:00:00.000Z'
    source.db
      .prepare('INSERT INTO events (ts, session, kind, payload, wseq) VALUES (?, ?, ?, ?, NULL)')
      .run(
        old,
        's',
        'codex/item/commandExecution/outputDelta',
        JSON.stringify({ threadId: 'thread', turnId: 'turn', itemId: 'item', delta: 'raw' })
      )
    source.db
      .prepare('INSERT INTO events (ts, session, kind, payload, wseq) VALUES (?, ?, ?, ?, NULL)')
      .run(
        old,
        's',
        'codex/item/completed',
        JSON.stringify({
          threadId: 'thread',
          turnId: 'turn',
          item: { id: 'item', type: 'commandExecution', aggregatedOutput: 'raw' },
        })
      )
    const peerId = ensureReplicationNodeIdentity(peerDir)
    configureJournalReplication({
      sourceJournalPath: path.join(sourceDir, 'hub.db'),
      requiredReplicas: 1,
      assignedPeerIds: [peerId],
    })

    const blocked = source.condenseCompletedCodex({
      nowMs: Date.parse('2020-01-02T00:00:00.000Z'),
      graceMs: 0,
      maxDiffSnapshots: 0,
      maxHistoryTurns: 0,
      maxExpiredHistoryTurns: 0,
    })
    expect(blocked.commandOutputDeltasDeleted).toBe(0)
    expect(blocked.replication).toMatchObject({
      enabled: true,
      coverageSatisfied: false,
      diskPressurePolicy: 'grow-until-replicated',
    })

    const snapshot = await createJournalSnapshot({ sourceDataDir: sourceDir, chunkBytes: 16 * 1024 })
    await transferJournalSnapshot({ sourceGenerationDir: snapshot.generationDir, targetDataDir: peerDir })
    recordReplicaVerification({
      sourceJournalPath: path.join(sourceDir, 'hub.db'),
      replicaDataDir: peerDir,
      generationId: snapshot.manifest.generationId,
    })
    const pruned = source.condenseCompletedCodex({
      nowMs: Date.parse('2020-01-02T00:00:00.000Z'),
      graceMs: 0,
      maxDiffSnapshots: 0,
      maxHistoryTurns: 0,
      maxExpiredHistoryTurns: 0,
    })
    expect(pruned.commandOutputDeltasDeleted).toBe(1)
    expect(pruned.replication.maxPrunableSeq).toBe(snapshot.manifest.maxSeq)
    close(source)
  })
})
