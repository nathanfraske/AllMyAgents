/**
 * Standalone journal-replication and restore entry point.
 *
 * This intentionally has no dependency on a running hub. The restore path is most valuable when hub.db is
 * gone or the hub cannot boot, and transfer interruption tests need a process that can be killed between
 * durable chunk watermarks. Production packaging can expose the same commands through hubctl/desktop later;
 * keeping the mechanics here prevents that future UI from becoming part of the recovery dependency chain.
 */
import Database from 'better-sqlite3'
import {
  configureJournalReplication,
  createJournalSnapshot,
  ensureReplicationNodeIdentity,
  readJournalReplicationStatus,
  recordReplicaVerification,
  reserveReplicationPruneGate,
  restoreJournalSnapshot,
  transferJournalSnapshot,
  verifyJournalSnapshot,
} from './journalReplication.js'

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

function number(value: string | undefined, name: string): number {
  const parsed = Number(required(value, name))
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
  return parsed
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'node-id': {
      output({ nodeId: ensureReplicationNodeIdentity(required(args[0], 'data directory')) })
      return
    }
    case 'snapshot': {
      const snapshot = await createJournalSnapshot({
        sourceDataDir: required(args[0], 'source data directory'),
        ...(args[1] ? { chunkBytes: number(args[1], 'chunk bytes') } : {}),
      })
      output(snapshot)
      return
    }
    case 'transfer': {
      const result = await transferJournalSnapshot({
        sourceGenerationDir: required(args[0], 'source generation directory'),
        targetDataDir: required(args[1], 'target data directory'),
        ...(args[2] ? { chunkDelayMs: number(args[2], 'chunk delay') } : {}),
        onChunk: (nextChunk) => output({ type: 'chunk-durable', nextChunk }),
      })
      output({ type: 'transfer-complete', ...result })
      return
    }
    case 'verify': {
      output({ manifest: verifyJournalSnapshot(required(args[0], 'generation directory')) })
      return
    }
    case 'configure': {
      const assignedPeerIds = JSON.parse(required(args[2], 'assigned peer JSON')) as unknown
      if (!Array.isArray(assignedPeerIds) || !assignedPeerIds.every((value) => typeof value === 'string')) {
        throw new Error('assigned peer JSON must be an array of strings')
      }
      configureJournalReplication({
        sourceJournalPath: required(args[0], 'source journal path'),
        requiredReplicas: number(args[1], 'required replicas'),
        assignedPeerIds,
      })
      output({ configured: true })
      return
    }
    case 'ack': {
      recordReplicaVerification({
        sourceJournalPath: required(args[0], 'source journal path'),
        replicaDataDir: required(args[1], 'replica data directory'),
        generationId: required(args[2], 'generation id'),
      })
      output({ acknowledged: true })
      return
    }
    case 'protect': {
      const db = new Database(required(args[0], 'source journal path'), { fileMustExist: true })
      try {
        output({ gate: reserveReplicationPruneGate(db) })
      } finally {
        db.close()
      }
      return
    }
    case 'status': {
      output(readJournalReplicationStatus(required(args[0], 'source journal path')))
      return
    }
    case 'restore': {
      output({
        manifest: restoreJournalSnapshot({
          replicaGenerationDir: required(args[0], 'replica generation directory'),
          destinationDataDir: required(args[1], 'destination data directory'),
        }),
      })
      return
    }
    default:
      throw new Error(
        'usage: journalReplicationCli <node-id|snapshot|transfer|verify|configure|ack|protect|status|restore> ...'
      )
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
