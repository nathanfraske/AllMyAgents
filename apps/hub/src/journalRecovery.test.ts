import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import { snapshotJournal } from './journalBackup.js'
import {
  JournalRecoveryLease,
  acceptKnownGoodJournal,
  bootstrapJournalRecovery,
  bootstrapJournalRecoveryInWorker,
  consumeRecoveryReceipts,
  dismissRecoveryNotice,
  ensureRecoveryEnrollment,
  inspectKnownGoodJournal,
  listRecoveryGenerations,
  listRecoveryNotices,
  publishRecoveryGeneration,
  recoveryPaths,
  validateRecoveryReceiptsBeforeWritableOpen,
  verifyNormalJournalLineage,
  verifyStrongRecoverySnapshotCoverage,
} from './journalRecovery.js'
import { SCHEMA_VERSION } from './restartHandshake.js'

const roots: string[] = []
const journals: Journal[] = []

function root(label = 'ama-recovery'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`))
  roots.push(dir)
  return dir
}

function open(dataDir: string): Journal {
  const journal = new Journal(path.join(dataDir, 'hub.db'))
  journals.push(journal)
  return journal
}

function payloadText(event: { payload: unknown }): unknown {
  return (event.payload as { text?: unknown } | null)?.text
}

async function strongSnapshot(dataDir: string, journal: Journal, now: Date): Promise<void> {
  const result = await snapshotJournal(journal.db, {
    dir: path.join(dataDir, 'backups'),
    recoveryDataDir: dataDir,
    recoveryKeep: 6,
    now: () => now,
  })
  if (!result.ok) throw new Error(`strong snapshot failed: ${result.error}`)
}

async function runHardCrashModule(source: string): Promise<void> {
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
  const child = spawn(
    process.execPath,
    ['--import', loader, '--input-type=module', '--eval', source],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  )
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => (stderr += chunk))
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  clearTimeout(timeout)
  if (code === 0 && signal === null) {
    throw new Error(`hard-crash fixture exited normally: ${stderr}`)
  }
}

afterEach(() => {
  for (const journal of journals.splice(0)) {
    if (journal.db.open) journal.db.close()
  }
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('owned journal corruption recovery', () => {
  it('accepts an explicitly confirmed known-good legacy journal and journals the operator decision', () => {
    const dataDir = root('ama-known-good')
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'healthy legacy history' })
    journal.db.close()
    const paths = recoveryPaths(dataDir)
    const lease = new JournalRecoveryLease(dataDir)
    lease.acquireShared()
    lease.release()
    fs.writeFileSync(paths.head, 'legacy metadata evidence')

    const inspection = inspectKnownGoodJournal({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      maxSchemaVersion: SCHEMA_VERSION,
    })
    expect(() =>
      acceptKnownGoodJournal({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
        confirmSha256: '0'.repeat(64),
        reason: 'Operator independently verified this legacy journal.',
      })
    ).toThrow(/confirmation mismatch/i)

    const accepted = acceptKnownGoodJournal({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      maxSchemaVersion: SCHEMA_VERSION,
      confirmSha256: inspection.sha256,
      reason: 'Operator independently verified this legacy journal.',
    })

    expect(accepted.operationId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(fs.readFileSync(path.join(accepted.archiveDirectory, 'head.json'), 'utf8')).toBe(
      'legacy metadata evidence'
    )
    expect(fs.existsSync(path.join(dataDir, 'journal-recovery-known-good-acceptance.json'))).toBe(
      false
    )
    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toBeUndefined()
    const acceptedJournal = open(dataDir)
    const audit = acceptedJournal.db
      .prepare(
        `SELECT payload FROM events
         WHERE kind = 'journal/operator-known-good-accepted'`
      )
      .get() as { payload?: string }
    expect(JSON.parse(audit.payload ?? '{}')).toMatchObject({
      operationId: accepted.operationId,
      sourceSha256: inspection.sha256,
      reason: 'Operator independently verified this legacy journal.',
    })
  })

  it('resumes a known-good acceptance after a mid-archive crash with complete evidence metadata', () => {
    const dataDir = root('ama-known-good-resume')
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'healthy legacy history' })
    journal.db.close()
    const paths = recoveryPaths(dataDir)
    const lease = new JournalRecoveryLease(dataDir)
    lease.acquireShared()
    lease.release()
    fs.writeFileSync(paths.head, 'legacy head evidence')
    fs.writeFileSync(path.join(paths.root, 'legacy-extra.json'), 'legacy extra evidence')

    const journalPath = path.join(dataDir, 'hub.db')
    const reason = 'Operator independently verified this interrupted legacy journal.'
    const inspection = inspectKnownGoodJournal({
      dataDir,
      journalPath,
      maxSchemaVersion: SCHEMA_VERSION,
    })
    let interrupted = false
    expect(() =>
      acceptKnownGoodJournal({
        dataDir,
        journalPath,
        maxSchemaVersion: SCHEMA_VERSION,
        confirmSha256: inspection.sha256,
        reason,
        failpoint: (edge) => {
          if (!interrupted && edge.startsWith('after-known-good-archive-')) {
            interrupted = true
            throw new Error('simulated mid-archive crash')
          }
        },
      })
    ).toThrow(/simulated mid-archive crash/)

    const accepted = acceptKnownGoodJournal({
      dataDir,
      journalPath,
      maxSchemaVersion: SCHEMA_VERSION,
      confirmSha256: inspection.sha256,
      reason,
    })
    const manifest = JSON.parse(
      fs.readFileSync(path.join(accepted.archiveDirectory, 'operator-acceptance.json'), 'utf8'),
    ) as { archivedEntries?: string[] }
    expect(manifest.archivedEntries).toEqual(['head.json', 'legacy-extra.json'])
    expect(fs.readFileSync(path.join(accepted.archiveDirectory, 'head.json'), 'utf8')).toBe(
      'legacy head evidence',
    )
    expect(
      fs.readFileSync(path.join(accepted.archiveDirectory, 'legacy-extra.json'), 'utf8'),
    ).toBe('legacy extra evidence')
  })

  it('allows a conclusive first install while the fresh recovery lease is held', () => {
    const dataDir = root('ama-first-install')
    const journalPath = path.join(dataDir, 'hub.db')
    const lease = new JournalRecoveryLease(dataDir)
    lease.acquireShared()
    try {
      expect(fs.existsSync(journalPath)).toBe(false)
      expect(fs.existsSync(recoveryPaths(dataDir).rootBinding)).toBe(false)
      expect(
        verifyNormalJournalLineage({
          dataDir,
          journalPath,
          maxSchemaVersion: SCHEMA_VERSION,
        })
      ).toBeUndefined()
      expect(
        validateRecoveryReceiptsBeforeWritableOpen({ dataDir, journalPath })
      ).toBeUndefined()
    } finally {
      lease.release()
    }
  })

  it('runs healthy independent classification in a source/tsx worker', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'healthy-worker-classification' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()

    const result = await bootstrapJournalRecoveryInWorker({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
      operationId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
    })

    expect(result.preflight.ok).toBe(true)
    expect(result.recovery).toBeUndefined()
  })

  it('keeps the caller responsive and the journal unchanged when recovery worker execution wedges', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'worker-timeout-is-offline' })
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    const before = fs.readFileSync(journalPath)
    let parentTimerRan = false
    const parentTimer = setTimeout(() => {
      parentTimerRan = true
    }, 0)

    try {
      await expect(
        bootstrapJournalRecoveryInWorker({
          dataDir,
          journalPath,
          schemaVersion: SCHEMA_VERSION,
          operationId: '33333333-3333-4333-8333-333333333333',
          attemptId: '44444444-4444-4444-8444-444444444444',
          // Worker startup necessarily crosses an event-loop boundary. A one-millisecond ceiling
          // deterministically exercises the parent watchdog without manufacturing a database lock;
          // SQLite reports a held recovery lease synchronously on macOS instead of waiting as it does
          // on Windows, which made the old lock-based wedge test platform-dependent.
          timeoutMs: 1,
        })
      ).rejects.toThrow(/absolute execution ceiling/i)
      expect(parentTimerRan).toBe(true)
      expect(fs.readFileSync(journalPath)).toEqual(before)
    } finally {
      clearTimeout(parentTimer)
    }
  })

  it('exports read-only strong-snapshot coverage for an exact compaction frontier', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'covered-one' })
    journal.append('s1', 'session/input', { text: 'covered-two' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))

    const coverage = verifyStrongRecoverySnapshotCoverage({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      maxSchemaVersion: SCHEMA_VERSION,
      deleteThroughSeq: '2',
    })

    expect(coverage).toMatchObject({
      generation: '1',
      snapshotMaxSeq: '2',
      snapshotEventHighWater: '2',
      deleteThroughSeq: '2',
    })
    expect(coverage.rootId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(coverage.journalId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(coverage.manifestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(() =>
      verifyStrongRecoverySnapshotCoverage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
        deleteThroughSeq: '3',
      })
    ).toThrow(/does not cover/i)
  })

  it('never falls back from an invalid newest strong generation or to a legacy flat backup', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'generation-one' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.append('s1', 'session/input', { text: 'generation-two' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:01:00.000Z'))
    const newest = fs
      .readdirSync(recoveryPaths(dataDir).generations)
      .filter((entry) => entry.startsWith('g-'))
      .sort()
      .at(-1)!
    fs.appendFileSync(
      path.join(recoveryPaths(dataDir).generations, newest, 'snapshot.db'),
      Buffer.from([0])
    )

    expect(() =>
      verifyStrongRecoverySnapshotCoverage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
        deleteThroughSeq: '1',
      })
    ).toThrow()

    const legacyDataDir = root('ama-legacy-flat-backup')
    const legacyJournal = open(legacyDataDir)
    legacyJournal.append('legacy', 'session/input', { text: 'legacy-only' })
    fs.mkdirSync(path.join(legacyDataDir, 'backups'), { recursive: true })
    fs.copyFileSync(
      path.join(legacyDataDir, 'hub.db'),
      path.join(legacyDataDir, 'backups', 'hub-legacy.db')
    )
    expect(() =>
      verifyStrongRecoverySnapshotCoverage({
        dataDir: legacyDataDir,
        journalPath: path.join(legacyDataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
        deleteThroughSeq: '1',
      })
    ).toThrow()
  })

  it.each([
    'after-enrollment-intent',
    'after-enrollment-identity',
    'after-enrollment-root-binding',
  ])('resumes the exact first-enrollment authority after %s', (crashEdge) => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: `enrollment-${crashEdge}` })

    expect(() =>
      ensureRecoveryEnrollment(journal.db, dataDir, {
        failpoint: (edge) => {
          if (edge === crashEdge) throw new Error(`enrollment crash at ${edge}`)
        },
      })
    ).toThrow(/enrollment crash/i)
    const paths = recoveryPaths(dataDir)
    const intent = JSON.parse(
      fs.readFileSync(paths.enrollmentIntent, 'utf8')
    ) as { rootId: string; journalId: string }

    const resumed = ensureRecoveryEnrollment(journal.db, dataDir)

    expect(resumed).toEqual({ rootId: intent.rootId, journalId: intent.journalId })
    expect(fs.existsSync(paths.enrollmentIntent)).toBe(false)
    expect(JSON.parse(fs.readFileSync(paths.rootBinding, 'utf8'))).toMatchObject({
      rootId: intent.rootId,
      activeJournalId: intent.journalId,
    })
  })

  it('accepts an exact reader finishing root-binding publication concurrently', () => {
    const dataDir = root()
    const journal = open(dataDir)
    const journalPath = path.join(dataDir, 'hub.db')
    journal.append('s1', 'session/input', { text: 'concurrent-root-binding-reader' })
    let readerFinishedPublication = false

    const enrolled = ensureRecoveryEnrollment(journal.db, dataDir, {
      failpoint: (edge) => {
        if (edge !== 'after-enrollment-root-binding-publication-link') return
        const bindingPath = recoveryPaths(dataDir).rootBinding
        const before = fs.lstatSync(bindingPath, { bigint: true })
        expect(before.nlink).toBe(2n)
        expect(
          verifyNormalJournalLineage({
            dataDir,
            journalPath,
            maxSchemaVersion: SCHEMA_VERSION,
          })
        ).toBeUndefined()
        const after = fs.lstatSync(bindingPath, { bigint: true })
        expect(after.dev).toBe(before.dev)
        expect(after.nlink).toBe(1n)
        readerFinishedPublication = true
      },
    })

    expect(readerFinishedPublication).toBe(true)
    expect(enrolled.rootId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(enrolled.journalId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(
      fs
        .readdirSync(recoveryPaths(dataDir).root)
        .filter((entry) => entry.startsWith('root.json.partial-'))
    ).toEqual([])
  })

  it('enrolls the shipped healthy backup path into an identity-bound strong generation', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'durable' })

    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))

    const generations = listRecoveryGenerations(dataDir, SCHEMA_VERSION)
    expect(generations).toHaveLength(1)
    expect(generations[0]!.manifest).toMatchObject({
      format: 1,
      generation: '1',
      eventCount: '1',
      maxSeq: '1',
    })
    const rootBinding = JSON.parse(
      fs.readFileSync(recoveryPaths(dataDir).rootBinding, 'utf8')
    ) as Record<string, unknown>
    expect(rootBinding).toMatchObject({
      format: 1,
      activeJournalId: generations[0]!.manifest.journalId,
      nextGeneration: '2',
    })
    expect(fs.readdirSync(path.join(dataDir, 'backups')).some((name) => name.endsWith('.db'))).toBe(true)
  })

  it(
    'keeps Windows directory durability barriers fixed-size across repeated publications',
    async () => {
      const dataDir = root()
      const journal = open(dataDir)
      for (let index = 0; index < 8; index++) {
        journal.append('s1', 'session/input', { text: `snapshot-${index}` })
        await strongSnapshot(
          dataDir,
          journal,
          new Date(`2026-07-29T00:0${index}:00.000Z`)
        )
      }
      const pending = [recoveryPaths(dataDir).root]
      const barriers: string[] = []
      while (pending.length > 0) {
        const directory = pending.pop()!
        for (const entry of fs.readdirSync(directory)) {
          const file = path.join(directory, entry)
          const stat = fs.lstatSync(file)
          if (stat.isDirectory()) pending.push(file)
          else if (entry === '.ama-directory-barrier') barriers.push(file)
        }
      }
      if (process.platform === 'win32') {
        expect(barriers.length).toBeGreaterThan(0)
        expect(barriers.every((file) => fs.statSync(file).size === 16)).toBe(true)
      }
    },
    15_000
  )

  it('never replaces a competitor generation target created at the publication boundary', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'no-replace-generation' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    const snapshot = path.join(dataDir, 'candidate.db')
    await journal.db.backup(snapshot)
    let competitor = ''

    expect(() =>
      publishRecoveryGeneration({
        dataDir,
        snapshotFile: snapshot,
        maxSchemaVersion: SCHEMA_VERSION,
        failpoint: (edge, target) => {
          if (edge !== 'before-generation-publish' || !target) return
          competitor = target
          fs.mkdirSync(target)
          fs.writeFileSync(path.join(target, 'competitor-evidence'), 'retain')
        },
      })
    ).toThrow(/exist/i)

    expect(fs.readFileSync(path.join(competitor, 'competitor-evidence'), 'utf8')).toBe('retain')
  })

  it('bounds recovery generations by bytes as well as count while retaining the newest', async () => {
    const dataDir = root('ama-recovery-byte-retention')
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'generation-one' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.append('s1', 'session/input', { text: 'generation-two' })
    const snapshot = path.join(dataDir, 'byte-budget-candidate.db')
    await journal.db.backup(snapshot)
    const bytes = fs.statSync(snapshot).size

    publishRecoveryGeneration({
      dataDir,
      snapshotFile: snapshot,
      maxSchemaVersion: SCHEMA_VERSION,
      keep: 6,
      maxRetainedBytes: bytes,
    })

    expect(listRecoveryGenerations(dataDir, SCHEMA_VERSION).map((item) => item.manifest.generation))
      .toEqual(['2'])
  })

  it('retains a partially published generation as evidence and publishes only a new ordinal', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'partial-generation' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    const snapshot = path.join(dataDir, 'candidate.db')
    await journal.db.backup(snapshot)

    expect(() =>
      publishRecoveryGeneration({
        dataDir,
        snapshotFile: snapshot,
        maxSchemaVersion: SCHEMA_VERSION,
        failpoint: (edge) => {
          if (edge === 'after-generation-member-snapshot.db') {
            throw new Error('generation publication crash')
          }
        },
      })
    ).toThrow(/generation publication crash/i)
    const afterCrash = fs
      .readdirSync(recoveryPaths(dataDir).generations)
      .filter((entry) => entry.startsWith('g-'))
    expect(afterCrash).toHaveLength(2)

    const published = publishRecoveryGeneration({
      dataDir,
      snapshotFile: snapshot,
      maxSchemaVersion: SCHEMA_VERSION,
    })

    expect(published.manifest.generation).toBe('3')
    expect(listRecoveryGenerations(dataDir, SCHEMA_VERSION).map((item) => item.manifest.generation))
      .toEqual(['3', '1'])
    expect(
      fs.readdirSync(recoveryPaths(dataDir).generations).filter((entry) => entry.startsWith('g-'))
    ).toHaveLength(3)
  })

  it('adopts a fully verified generation after a crash between publication and activation', async () => {
    const dataDir = root('ama-generation-activation')
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'generation-one' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.append('s1', 'session/input', { text: 'generation-two' })
    const snapshot = path.join(dataDir, 'activation-candidate.db')
    await journal.db.backup(snapshot)
    const paths = recoveryPaths(dataDir)

    expect(() =>
      publishRecoveryGeneration({
        dataDir,
        snapshotFile: snapshot,
        maxSchemaVersion: SCHEMA_VERSION,
        failpoint: (edge) => {
          if (edge === 'after-generation-publication-before-activation') {
            throw new Error('crash before root activation')
          }
        },
      })
    ).toThrow(/crash before root activation/i)
    expect(JSON.parse(fs.readFileSync(paths.rootBinding, 'utf8'))).toMatchObject({
      activeGeneration: '1',
      nextGeneration: '3',
    })

    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toMatchObject({ code: 'database-validation-unavailable' })
    const reconciled = bootstrapJournalRecovery({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })
    expect(reconciled.preflight.ok).toBe(true)
    expect(reconciled.recovery).toBeUndefined()
    reconciled.lease.release()
    expect(JSON.parse(fs.readFileSync(paths.rootBinding, 'utf8'))).toMatchObject({
      activeGeneration: '2',
      nextGeneration: '3',
    })
    expect(JSON.parse(fs.readFileSync(paths.head, 'utf8'))).toMatchObject({
      generation: '2',
      eventHighWater: '2',
    })
  })

  it('survives an actual process kill after generation publication and before activation', async () => {
    const dataDir = root('ama-generation-hard-crash')
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'generation-one' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.append('s1', 'session/input', { text: 'generation-two' })
    const snapshot = path.join(dataDir, 'hard-crash-candidate.db')
    await journal.db.backup(snapshot)
    const recoveryModule = pathToFileURL(
      path.join(import.meta.dirname, 'journalRecovery.ts')
    ).href

    await runHardCrashModule(`
      const { publishRecoveryGeneration } = await import(${JSON.stringify(recoveryModule)});
      publishRecoveryGeneration({
        dataDir: ${JSON.stringify(dataDir)},
        snapshotFile: ${JSON.stringify(snapshot)},
        maxSchemaVersion: ${SCHEMA_VERSION},
        failpoint: (edge) => {
          if (edge === 'after-generation-publication-before-activation') {
            process.kill(process.pid, 'SIGKILL');
            throw new Error('hard kill returned unexpectedly');
          }
        },
      });
    `)

    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toMatchObject({ code: 'database-validation-unavailable' })
    const reconciled = bootstrapJournalRecovery({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })
    expect(reconciled.preflight.ok).toBe(true)
    expect(reconciled.recovery).toBeUndefined()
    reconciled.lease.release()
    expect(JSON.parse(fs.readFileSync(recoveryPaths(dataDir).rootBinding, 'utf8'))).toMatchObject({
      activeGeneration: '2',
    })
  })

  it('never bypasses a completed rollback receipt while adopting an interrupted later publication', async () => {
    const dataDir = root('ama-generation-after-rollback')
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'generation-one' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.append('s1', 'session/input', { text: 'generation-two' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:01:00.000Z'))
    journal.db.close()

    const generations = listRecoveryGenerations(dataDir, SCHEMA_VERSION)
    fs.truncateSync(path.join(generations[0]!.directory, 'snapshot.db'), 17)
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(64 * 1024, 0x47))
    const recovered = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })
    expect(recovered.recovery).toMatchObject({ generation: '1', previousActiveGeneration: '2' })
    const receiptFile = recovered.recovery!.receiptFile
    const receiptBytes = fs.readFileSync(receiptFile)
    recovered.lease.release()

    const restored = open(dataDir)
    restored.append('s1', 'session/input', { text: 'generation-three' })
    const candidate = path.join(dataDir, 'post-rollback-candidate.db')
    await restored.db.backup(candidate)
    restored.db.close()
    expect(() =>
      publishRecoveryGeneration({
        dataDir,
        snapshotFile: candidate,
        maxSchemaVersion: SCHEMA_VERSION,
        failpoint: (edge) => {
          if (edge === 'after-generation-publication-before-activation') {
            throw new Error('crash after rollback publication')
          }
        },
      })
    ).toThrow(/crash after rollback publication/i)

    fs.unlinkSync(receiptFile)
    expect(
      verifyNormalJournalLineage({ dataDir, journalPath, maxSchemaVersion: SCHEMA_VERSION })
    ).toMatchObject({ code: 'database-validation-unavailable' })
    expect(JSON.parse(fs.readFileSync(recoveryPaths(dataDir).rootBinding, 'utf8'))).toMatchObject({
      activeGeneration: '1',
    })

    fs.writeFileSync(receiptFile, receiptBytes)
    const reconciled = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })
    expect(reconciled.preflight.ok).toBe(true)
    expect(reconciled.recovery).toBeUndefined()
    reconciled.lease.release()
    expect(JSON.parse(fs.readFileSync(recoveryPaths(dataDir).rootBinding, 'utf8'))).toMatchObject({
      activeGeneration: '3',
    })
  })

  it('discards incomplete unactivated generation and classifier staging debris on boot', async () => {
    const dataDir = root('ama-recovery-debris')
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'stable-generation' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    const snapshot = path.join(dataDir, 'partial-candidate.db')
    await journal.db.backup(snapshot)
    expect(() =>
      publishRecoveryGeneration({
        dataDir,
        snapshotFile: snapshot,
        maxSchemaVersion: SCHEMA_VERSION,
        failpoint: (edge) => {
          if (edge === 'after-generation-member-snapshot.db') {
            throw new Error('partial generation crash')
          }
        },
      })
    ).toThrow(/partial generation crash/i)
    const paths = recoveryPaths(dataDir)
    const classifier = path.join(
      paths.staging,
      '.classifier-55555555-5555-4555-8555-555555555555'
    )
    fs.mkdirSync(classifier)
    fs.writeFileSync(path.join(classifier, 'incomplete-copy'), 'derived debris')

    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toMatchObject({ code: 'database-validation-unavailable' })
    expect(fs.existsSync(classifier)).toBe(true)
    const reconciled = bootstrapJournalRecovery({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })
    expect(reconciled.preflight.ok).toBe(true)
    expect(reconciled.recovery).toBeUndefined()
    reconciled.lease.release()
    expect(fs.existsSync(classifier)).toBe(false)
    expect(
      fs.readdirSync(paths.generations).filter((entry) => entry.startsWith('g-'))
    ).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(paths.rootBinding, 'utf8'))).toMatchObject({
      activeGeneration: '1',
      nextGeneration: '3',
    })
  })

  it('restores only an owned verified generation and retains the exact damaged family as evidence', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'survives' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()

    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(256 * 1024, 0x6e))
    const damagedHash = fs.readFileSync(journalPath)

    const boot = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })

    expect(boot.preflight.ok).toBe(true)
    expect(boot.recovery).toMatchObject({
      cause: 'sqlite-corruption',
      generation: '1',
    })
    const restored = open(dataDir)
    expect(restored.since(0).some((event) => payloadText(event) === 'survives')).toBe(true)
    const quarantine = boot.recovery!.quarantineDir
    expect(fs.readFileSync(path.join(quarantine, 'hub.db'))).toEqual(damagedHash)
    expect(fs.existsSync(boot.recovery!.receiptFile)).toBe(true)
    boot.lease.release()
  })

  it('recovers a SQLite-valid journal whose event payload JSON is corrupt', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'logical-good' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.prepare('UPDATE events SET payload = ? WHERE seq = 1').run('logical-secret-bad-json')
    journal.db.close()

    const recovered = bootstrapJournalRecovery({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })

    expect(recovered.recovery).toMatchObject({ cause: 'sqlite-corruption', generation: '1' })
    const restored = open(dataDir)
    expect(restored.since(0).map(payloadText)).toContain('logical-good')
    const quarantined = new Database(
      path.join(recovered.recovery!.quarantineDir, 'hub.db'),
      { readonly: true, fileMustExist: true }
    )
    expect(
      (
        quarantined.prepare('SELECT payload FROM events WHERE seq = 1').get() as {
          payload: string
        }
      ).payload
    ).toBe('logical-secret-bad-json')
    quarantined.close()
    recovered.lease.release()
  })

  it('quarantines a genuine checksum-corrupt live WAL before restoring an owned generation', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'snapshot-safe' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.append('s1', 'session/input', { text: 'wal-tail' })
    const journalPath = path.join(dataDir, 'hub.db')
    const main = fs.readFileSync(journalPath)
    const wal = fs.readFileSync(`${journalPath}-wal`)
    const shm = fs.readFileSync(`${journalPath}-shm`)
    journal.db.close()
    wal[64] = wal[64]! ^ 0xff
    fs.writeFileSync(journalPath, main)
    fs.writeFileSync(`${journalPath}-wal`, wal)
    fs.writeFileSync(`${journalPath}-shm`, shm)

    const recovered = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })

    expect(recovered.recovery).toMatchObject({ cause: 'sqlite-corruption', generation: '1' })
    const restored = open(dataDir)
    expect(restored.since(0).map(payloadText)).toContain('snapshot-safe')
    expect(restored.since(0).map(payloadText)).not.toContain('wal-tail')
    expect(fs.readFileSync(path.join(recovered.recovery!.quarantineDir, 'hub.db-wal'))).toEqual(
      wal
    )
    expect(fs.readFileSync(path.join(recovered.recovery!.quarantineDir, 'hub.db-shm'))).toEqual(
      shm
    )
    recovered.lease.release()
  })

  it('independently rejects a corrupt newest generation and falls back by canonical BigInt ordinal', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'first' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.append('s1', 'session/input', { text: 'second' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:01:00.000Z'))
    journal.db.close()

    const generations = listRecoveryGenerations(dataDir, SCHEMA_VERSION)
    expect(generations.map((entry) => entry.manifest.generation)).toEqual(['2', '1'])
    fs.truncateSync(path.join(generations[0]!.directory, 'snapshot.db'), 17)
    fs.writeFileSync(path.join(dataDir, 'hub.db'), Buffer.alloc(64 * 1024, 0x45))

    const crashedLease = new JournalRecoveryLease(dataDir)
    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        schemaVersion: SCHEMA_VERSION,
        lease: crashedLease,
        failpoint: (edge) => {
          if (edge === 'after-recovery-head-transition') {
            throw new Error('recovery head transition crash')
          }
        },
      })
    ).toThrow(/recovery head transition crash/i)
    crashedLease.release()
    expect(
      JSON.parse(fs.readFileSync(recoveryPaths(dataDir).rootBinding, 'utf8'))
    ).toMatchObject({ activeGeneration: '1' })
    const incompleteTransition = verifyNormalJournalLineage({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      maxSchemaVersion: SCHEMA_VERSION,
    })
    expect(incompleteTransition).toMatchObject({ code: 'database-validation-unavailable' })
    expect(incompleteTransition).not.toHaveProperty('recoveryCause')
    const boot = bootstrapJournalRecovery({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })

    expect(boot.recovery?.generation).toBe('1')
    const restored = open(dataDir)
    expect(restored.since(0).map(payloadText)).toContain('first')
    expect(restored.since(0).map(payloadText)).not.toContain('second')
    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toBeUndefined()
    expect(boot.recovery?.previousActiveGeneration).toBe('2')
    expect(
      JSON.parse(fs.readFileSync(recoveryPaths(dataDir).rootBinding, 'utf8'))
    ).toMatchObject({
      activeGeneration: '1',
      recoveryTransition: {
        planId: boot.recovery?.planId,
        previousGeneration: '2',
        restoredGeneration: '1',
        receiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    })
    boot.lease.release()
  })

  it('self-heals a verified published generation whose activation pointer was not advanced', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'first' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.append('s1', 'session/input', { text: 'second' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:01:00.000Z'))
    journal.db.close()

    const bindingFile = recoveryPaths(dataDir).rootBinding
    const binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8')) as Record<string, unknown>
    binding.activeGeneration = '1'
    delete binding.recoveryTransition
    fs.writeFileSync(bindingFile, `${JSON.stringify(binding, null, 2)}\n`)

    const pending = verifyNormalJournalLineage({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      maxSchemaVersion: SCHEMA_VERSION,
    })
    expect(pending).toMatchObject({ code: 'database-validation-unavailable' })
    const reconciled = bootstrapJournalRecovery({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })
    expect(reconciled.preflight.ok).toBe(true)
    expect(reconciled.recovery).toBeUndefined()
    reconciled.lease.release()
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      activeGeneration: '2',
    })
  })

  it('fails closed on a malformed directory claiming the same canonical generation ordinal', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'owned' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const paths = recoveryPaths(dataDir)
    fs.mkdirSync(path.join(paths.generations, 'g-00000000000000000001-aaaaaaaaaaaaaaaaaaaaaaaa'))
    const journalPath = path.join(dataDir, 'hub.db')
    const damaged = Buffer.alloc(64 * 1024, 0x42)
    fs.writeFileSync(journalPath, damaged)

    expect(() =>
      bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    ).toThrow(/ambiguous recovery generation ordinal 1/i)
    expect(fs.readFileSync(journalPath)).toEqual(damaged)
  })

  it('requires every generation ordinal to be below the durable next-generation authority', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'authority' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    const bindingFile = recoveryPaths(dataDir).rootBinding
    const binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8')) as Record<string, unknown>

    fs.writeFileSync(bindingFile, `${JSON.stringify({ ...binding, nextGeneration: '1' }, null, 2)}\n`)
    expect(() => listRecoveryGenerations(dataDir, SCHEMA_VERSION)).toThrow(
      /not below reserved authority/i
    )

    fs.writeFileSync(bindingFile, `${JSON.stringify({ ...binding, nextGeneration: '3' }, null, 2)}\n`)
    expect(listRecoveryGenerations(dataDir, SCHEMA_VERSION)).toHaveLength(1)
  })

  it('keeps legacy flat backups ineligible and leaves corrupt bytes untouched when no strong generation exists', async () => {
    const dataDir = root()
    const journalPath = path.join(dataDir, 'hub.db')
    const damaged = Buffer.alloc(128 * 1024, 0x77)
    fs.writeFileSync(journalPath, damaged)
    fs.mkdirSync(path.join(dataDir, 'backups'))
    fs.writeFileSync(path.join(dataDir, 'backups', 'hub-legacy.db'), Buffer.from('looks-like-a-backup'))

    expect(() =>
      bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    ).toThrow(/no identity-bound verified recovery generation/i)
    expect(fs.readFileSync(journalPath)).toEqual(damaged)
    expect(fs.existsSync(recoveryPaths(dataDir).activePlan)).toBe(false)
  })

  it('admits the 64th retained incident and rejects the 65th before family mutation', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'quota-snapshot' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const paths = recoveryPaths(dataDir)
    for (let index = 0; index < 63; index += 1) {
      fs.mkdirSync(path.join(paths.quarantine, `archive-retained-${String(index).padStart(2, '0')}`))
    }
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x61))

    const recovered = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })
    expect(fs.readdirSync(paths.quarantine).filter((entry) => !entry.startsWith('.'))).toHaveLength(
      64
    )
    recovered.lease.release()

    const secondDamage = Buffer.alloc(96 * 1024, 0x62)
    fs.writeFileSync(journalPath, secondDamage)
    expect(() =>
      bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    ).toThrow(/no quota for another incident/i)
    expect(fs.readFileSync(journalPath)).toEqual(secondDamage)
    expect(fs.readdirSync(paths.quarantine).filter((entry) => !entry.startsWith('.'))).toHaveLength(
      64
    )
  })

  it('rejects prospective quarantine bytes before moving the live family', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'byte-quota-snapshot' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    const damage = Buffer.alloc(96 * 1024, 0x63)
    fs.writeFileSync(journalPath, damage)

    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        evidenceByteLimit: BigInt(damage.length - 1),
      })
    ).toThrow(/prospective recovery evidence exceeds/i)
    expect(fs.readFileSync(journalPath)).toEqual(damage)
    expect(fs.readdirSync(recoveryPaths(dataDir).quarantine)).toHaveLength(0)
  })

  it('rejects a 17th generation publication before creating staging or final paths', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'generation-quota' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    const paths = recoveryPaths(dataDir)
    const [published] = listRecoveryGenerations(dataDir, SCHEMA_VERSION)
    for (let index = 0; index < 15; index += 1) {
      fs.mkdirSync(path.join(paths.generations, `retained-${String(index).padStart(2, '0')}`))
    }
    const stagingBefore = fs.readdirSync(paths.staging)

    expect(() =>
      publishRecoveryGeneration({
        dataDir,
        snapshotFile: path.join(published!.directory, 'snapshot.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toThrow(/no quota for another publication/i)
    expect(fs.readdirSync(paths.staging)).toEqual(stagingBefore)
    expect(fs.readdirSync(paths.generations).filter((entry) => !entry.startsWith('.'))).toHaveLength(
      16
    )
  })

  it('rejects a recovery operation when staging cannot reserve classifier and restore slots', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'staging-quota' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const paths = recoveryPaths(dataDir)
    for (let index = 0; index < 16; index += 1) {
      fs.writeFileSync(path.join(paths.staging, `retained-${String(index).padStart(2, '0')}`), 'x')
    }
    const journalPath = path.join(dataDir, 'hub.db')
    const damage = Buffer.alloc(96 * 1024, 0x64)
    fs.writeFileSync(journalPath, damage)
    const stagingBefore = fs.readdirSync(paths.staging).sort()

    expect(() =>
      bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    ).toThrow(/staging has no quota/i)
    expect(fs.readFileSync(journalPath)).toEqual(damage)
    expect(fs.readdirSync(paths.staging).sort()).toEqual(stagingBefore)
  })

  it.each([
    'generation',
    'head',
    'receipt',
    'active-plan',
    'prior-journal-identity',
  ])('refuses to mint a missing root binding when %s history survives', async (history) => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: `history-${history}` })
    const lease = new JournalRecoveryLease(dataDir)
    lease.acquireShared()
    lease.release()
    const paths = recoveryPaths(dataDir)
    if (history === 'generation') {
      fs.mkdirSync(paths.generations)
      fs.writeFileSync(path.join(paths.generations, 'surviving-generation'), 'evidence')
    } else if (history === 'head') {
      fs.writeFileSync(paths.head, '{}\n')
    } else if (history === 'receipt') {
      fs.mkdirSync(paths.receipts)
      fs.writeFileSync(path.join(paths.receipts, 'surviving-receipt.json'), '{}\n')
    } else if (history === 'active-plan') {
      fs.writeFileSync(paths.activePlan, '{}\n')
    } else {
      journal.db.exec(`
        CREATE TABLE journal_recovery_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          journal_id TEXT NOT NULL UNIQUE
        );
        INSERT INTO journal_recovery_identity (singleton, journal_id)
        VALUES (1, '11111111-1111-4111-8111-111111111111');
      `)
    }

    const lineage = verifyNormalJournalLineage({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      maxSchemaVersion: SCHEMA_VERSION,
    })
    expect(lineage).toMatchObject({ code: 'database-validation-unavailable' })
    const snapshot = await snapshotJournal(journal.db, {
      dir: path.join(dataDir, 'backups'),
      recoveryDataDir: dataDir,
      recoveryKeep: 6,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    })
    expect(snapshot.ok).toBe(false)
    expect(fs.existsSync(paths.rootBinding)).toBe(false)
  })

  it('does not recover while another live shared owner exists', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'owned' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    fs.writeFileSync(path.join(dataDir, 'hub.db'), Buffer.alloc(128 * 1024, 0x31))

    const incumbent = new JournalRecoveryLease(dataDir)
    incumbent.acquireShared()
    const contender = new JournalRecoveryLease(dataDir)

    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        schemaVersion: SCHEMA_VERSION,
        lease: contender,
      })
    ).toThrow(/exclusive recovery ownership|live owner/i)
    incumbent.release()
    contender.release()
  })

  it('creates only a conclusively absent first-install data root before taking the shared lease', () => {
    const parent = root()
    const dataDir = path.join(parent, 'fresh-data-root')
    expect(fs.existsSync(dataDir)).toBe(false)
    const lease = new JournalRecoveryLease(dataDir)

    lease.acquireShared()

    expect(fs.lstatSync(dataDir).isDirectory()).toBe(true)
    expect(fs.lstatSync(recoveryPaths(dataDir).root).isDirectory()).toBe(true)
    lease.release()
  })

  it.each([
    ['missing guard row', undefined],
    ['wrong guard row', 2],
  ])('fails closed on a quick-check-clean ownership database with %s', (_label, format) => {
    const dataDir = root()
    const paths = recoveryPaths(dataDir)
    fs.mkdirSync(paths.root)
    const db = new Database(paths.leaseDb)
    db.pragma('journal_mode = DELETE')
    db.exec(
      'CREATE TABLE recovery_ownership_guard (singleton INTEGER PRIMARY KEY, format INTEGER NOT NULL)'
    )
    if (format !== undefined) {
      db.prepare(
        'INSERT INTO recovery_ownership_guard (singleton, format) VALUES (1, ?)'
      ).run(format)
    }
    db.close()
    const incident = Buffer.from('do not mutate journal bytes')
    fs.writeFileSync(path.join(dataDir, 'hub.db'), incident)
    const lease = new JournalRecoveryLease(dataDir)

    expect(() => lease.acquireShared()).toThrow(/guard is missing or malformed/i)
    expect(fs.readFileSync(path.join(dataDir, 'hub.db'))).toEqual(incident)
    lease.release()
  })

  it('rejects split-lock authority when ownership.db is replaced beneath an open shared owner', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'lease-path-aba' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    const before = fs.readFileSync(journalPath)
    const paths = recoveryPaths(dataDir)
    const incumbent = new JournalRecoveryLease(dataDir)
    incumbent.acquireShared()
    const displaced = `${paths.leaseDb}.displaced`

    try {
      fs.renameSync(paths.leaseDb, displaced)
      fs.copyFileSync(displaced, paths.leaseDb, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      // Some Windows SQLite builds deny rename while the shared handle is open. That OS-level
      // exclusion already prevents the split-lock construction this test is exercising.
      const errorCode = (error as NodeJS.ErrnoException).code
      expect(['EBUSY', 'EPERM', 'EACCES']).toContain(errorCode)
      incumbent.release()
      return
    }

    const contender = new JournalRecoveryLease(dataDir)
    expect(() => contender.acquireShared()).toThrow(/bound data-root identity|path identity/i)
    expect(() => incumbent.acquireExclusive()).toThrow(/path identity/i)
    expect(fs.readFileSync(journalPath)).toEqual(before)
    contender.release()
    incumbent.release()
  })

  it('resumes after a crash following quarantine without rolling damaged bytes back', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'resume-me' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    const damaged = Buffer.alloc(128 * 1024, 0x39)
    fs.writeFileSync(journalPath, damaged)

    const crashedLease = new JournalRecoveryLease(dataDir)
    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        lease: crashedLease,
        failpoint: (edge) => {
          if (edge === 'after-quarantine-hub.db') throw new Error('simulated power loss')
        },
      })
    ).toThrow(/simulated power loss/)
    // A real forced exit lets the OS invalidate the PID lease. Explicit release models that boundary
    // without spawning or touching any non-disposable process.
    crashedLease.release()
    expect(fs.existsSync(journalPath)).toBe(false)
    expect(fs.existsSync(recoveryPaths(dataDir).activePlan)).toBe(true)

    const resumed = bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    expect(resumed.preflight.ok).toBe(true)
    expect(fs.readFileSync(path.join(resumed.recovery!.quarantineDir, 'hub.db'))).toEqual(damaged)
    const restored = open(dataDir)
    expect(restored.since(0).some((event) => payloadText(event) === 'resume-me')).toBe(true)
    resumed.lease.release()
  })

  it('keeps a published recovery offline until its active plan and receipt finish', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'publish-crash' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x73))
    const crashedLease = new JournalRecoveryLease(dataDir)

    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        lease: crashedLease,
        failpoint: (edge) => {
          if (edge === 'after-publish') throw new Error('published recovery crash')
        },
      })
    ).toThrow(/published recovery crash/i)
    crashedLease.release()
    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath,
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toMatchObject({ code: 'database-validation-unavailable' })

    const resumed = bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    expect(fs.existsSync(recoveryPaths(dataDir).activePlan)).toBe(false)
    expect(
      validateRecoveryReceiptsBeforeWritableOpen({ dataDir, journalPath })
    ).toBeUndefined()
    resumed.lease.release()
  })

  it('removes interrupted classifier debris after its completed receipt is durable', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'classifier-cleanup' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x74))

    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        failpoint: (edge) => {
          if (edge === 'after-plan-publication-before-classifier-cleanup') {
            throw new Error('plan/classifier handoff crash')
          }
        },
      })
    ).toThrow(/plan\/classifier handoff crash/i)
    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        failpoint: (edge) => {
          if (edge === 'after-plan-complete-before-classifier-cleanup') {
            throw new Error('classifier cleanup crash')
          }
        },
      })
    ).toThrow(/classifier cleanup crash/i)
    expect(fs.existsSync(recoveryPaths(dataDir).activePlan)).toBe(false)
    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath,
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toMatchObject({ code: 'database-validation-unavailable' })
    const reconciled = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })
    expect(reconciled.preflight.ok).toBe(true)
    reconciled.lease.release()
    expect(
      fs.readdirSync(recoveryPaths(dataDir).staging).filter((entry) =>
        entry.startsWith('.classifier-')
      )
    ).toHaveLength(0)
  })

  it.each([
    'after-active-plan-link',
    'after-evidence-link',
    'after-receipt-link',
  ])('reconciles a crash-torn exclusive metadata publication at %s', async (crashEdge) => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: `metadata-${crashEdge}` })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x6d))
    const crashedLease = new JournalRecoveryLease(dataDir)

    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        lease: crashedLease,
        failpoint: (edge) => {
          if (edge === crashEdge) throw new Error(`metadata crash at ${edge}`)
        },
      })
    ).toThrow(/metadata crash/i)
    crashedLease.release()

    const resumed = bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    expect(resumed.preflight.ok).toBe(true)
    expect(resumed.recovery?.generation).toBe('1')
    const restored = open(dataDir)
    expect(restored.since(0).map(payloadText)).toContain(`metadata-${crashEdge}`)
    expect(
      fs.readdirSync(recoveryPaths(dataDir).root, { recursive: true }).some((entry) =>
        String(entry).includes('.partial-')
      )
    ).toBe(false)
    resumed.lease.release()
  })

  it('rejects an unknown active-plan phase without advancing or issuing a receipt', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'phase' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x61))
    const crashedLease = new JournalRecoveryLease(dataDir)
    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        lease: crashedLease,
        failpoint: (edge) => {
          if (edge === 'after-quarantine-hub.db') throw new Error('stop after quarantine')
        },
      })
    ).toThrow(/stop after quarantine/)
    crashedLease.release()
    const paths = recoveryPaths(dataDir)
    const raw = JSON.parse(fs.readFileSync(paths.activePlan, 'utf8')) as Record<string, unknown>
    raw.phase = 'invented-phase'
    fs.writeFileSync(paths.activePlan, `${JSON.stringify(raw, null, 2)}\n`)
    const quarantineBefore = fs.readFileSync(
      path.join(String(raw.quarantineDirectory), 'hub.db')
    )

    expect(() =>
      bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    ).toThrow(/active journal recovery plan is malformed/i)
    expect(fs.readFileSync(path.join(String(raw.quarantineDirectory), 'hub.db'))).toEqual(
      quarantineBefore
    )
    expect(fs.readdirSync(paths.receipts).filter((entry) => entry.endsWith('.json'))).toEqual([])
    expect(fs.existsSync(paths.activePlan)).toBe(true)
  })

  it('resumes an exact no-replace classifier publication left with its owned partial link', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'resume-classifier' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x41))
    const operationId = '33333333-3333-4333-8333-333333333333'
    const crashedLease = new JournalRecoveryLease(dataDir)

    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        operationId,
        lease: crashedLease,
        failpoint: (edge) => {
          if (edge === 'after-classifier-publish-hub.db-link') {
            throw new Error('simulated classifier publish crash')
          }
        },
      })
    ).toThrow(/simulated classifier publish crash/)
    crashedLease.release()

    const resumed = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
      operationId,
    })
    expect(resumed.recovery?.generation).toBe('1')
    resumed.lease.release()
  })

  it.each([
    'after-classifier-directory',
    'after-classifier-copy-hub.db',
    'after-classifier-fsync-hub.db',
    'after-classifier-publish-hub.db-link',
    'before-plan-publication',
  ])('reuses one durable classifier operation after %s without staging growth', async (crashEdge) => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: `classifier-${crashEdge}` })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x51))
    const crashedLease = new JournalRecoveryLease(dataDir)

    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        lease: crashedLease,
        failpoint: (edge) => {
          if (edge === crashEdge) throw new Error(`classifier crash at ${edge}`)
        },
      })
    ).toThrow(/classifier crash/i)
    crashedLease.release()
    expect(
      fs
        .readdirSync(recoveryPaths(dataDir).staging)
        .filter((entry) => entry.startsWith('.classifier-'))
    ).toHaveLength(1)

    const resumed = bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    expect(resumed.recovery?.generation).toBe('1')
    expect(
      fs
        .readdirSync(recoveryPaths(dataDir).staging)
        .filter((entry) => entry.startsWith('.classifier-'))
    ).toHaveLength(0)
    resumed.lease.release()
  })

  it('removes unpublished classifier and restore copies after an ordinary preparation failure', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'preparation-cleanup' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const paths = recoveryPaths(dataDir)
    const generation = listRecoveryGenerations(dataDir, SCHEMA_VERSION)[0]
    expect(generation).toBeDefined()
    fs.truncateSync(path.join(generation!.directory, 'snapshot.db'), 17)
    fs.writeFileSync(path.join(dataDir, 'hub.db'), Buffer.alloc(96 * 1024, 0x52))

    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        schemaVersion: SCHEMA_VERSION,
      })
    ).toThrow(/no identity-bound verified recovery generation/i)

    expect(fs.existsSync(paths.activePlan)).toBe(false)
    expect(
      fs.readdirSync(paths.staging).filter((entry) => entry !== '.ama-directory-barrier')
    ).toEqual([])
    expect(fs.existsSync(path.join(dataDir, 'hub.db-wal'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'hub.db-shm'))).toBe(false)
  })

  it('reverifies a cleaning-phase publication before issuing a durable receipt', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'cleaning' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x62))
    const crashedLease = new JournalRecoveryLease(dataDir)
    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        lease: crashedLease,
        failpoint: (edge) => {
          if (edge === 'after-cleaning-phase') throw new Error('stop in cleaning')
        },
      })
    ).toThrow(/stop in cleaning/)
    crashedLease.release()
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x63))
    const paths = recoveryPaths(dataDir)

    expect(() =>
      bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    ).toThrow(/re-verification|integrity|database/i)
    expect(fs.existsSync(paths.activePlan)).toBe(true)
    expect(fs.readdirSync(paths.receipts).filter((entry) => entry.endsWith('.json'))).toEqual([])
  })

  it('refuses a receipt when a quarantined family member disappears after publication', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'evidence' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x64))
    const crashedLease = new JournalRecoveryLease(dataDir)
    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        lease: crashedLease,
        failpoint: (edge) => {
          if (edge === 'after-publish-link') throw new Error('stop after publish')
        },
      })
    ).toThrow(/stop after publish/)
    crashedLease.release()
    const paths = recoveryPaths(dataDir)
    const plan = JSON.parse(fs.readFileSync(paths.activePlan, 'utf8')) as {
      quarantineDirectory: string
    }
    fs.unlinkSync(path.join(plan.quarantineDirectory, 'hub.db'))

    expect(() =>
      bootstrapJournalRecovery({ dataDir, journalPath, schemaVersion: SCHEMA_VERSION })
    ).toThrow(/quarantine evidence member/i)
    expect(fs.existsSync(paths.activePlan)).toBe(true)
    expect(fs.readdirSync(paths.receipts).filter((entry) => entry.endsWith('.json'))).toEqual([])
  })

  it('stops when an unclassified SQLite sidecar appears before publication', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'owned' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x46))

    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        failpoint: (edge) => {
          if (edge === 'after-quarantine-hub.db') {
            fs.writeFileSync(`${journalPath}-wal`, 'late sidecar')
          }
        },
      })
    ).toThrow(/family reappeared|closure changed/i)
    expect(fs.readFileSync(`${journalPath}-wal`, 'utf8')).toBe('late sidecar')
    expect(fs.existsSync(journalPath)).toBe(false)
  })

  it('detects a planned sidecar disappearance before mutating the first live family member', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'owned' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.append('s1', 'session/input', { text: 'wal-tail' })
    const journalPath = path.join(dataDir, 'hub.db')
    const wal = fs.readFileSync(`${journalPath}-wal`)
    const shm = fs.readFileSync(`${journalPath}-shm`)
    journal.db.close()
    const damaged = Buffer.alloc(96 * 1024, 0x52)
    wal[64] = wal[64]! ^ 0xff
    fs.writeFileSync(journalPath, damaged)
    fs.writeFileSync(`${journalPath}-wal`, wal)
    fs.writeFileSync(`${journalPath}-shm`, shm)

    expect(() =>
      bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
        failpoint: (edge) => {
          if (edge === 'after-classifier-publish-hub.db-wal-partial-unlink') {
            fs.unlinkSync(`${journalPath}-wal`)
          }
        },
      })
    ).toThrow(/exact set changed|before recovery mutation/i)
    expect(fs.readFileSync(journalPath)).toEqual(damaged)
  })

  it('reconciles an immutable receipt after a later journal rewind without duplicating a present notice', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'snapshot' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x48))
    const recovered = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })
    recovered.lease.release()
    const restored = open(dataDir)

    expect(consumeRecoveryReceipts(restored)).toBe(1)
    expect(consumeRecoveryReceipts(restored)).toBe(0)
    const [notice] = listRecoveryNotices(restored.db)
    expect(notice).toMatchObject({
      planId: recovered.recovery!.planId,
      snapshotEventHighWater: '1',
    })
    expect(dismissRecoveryNotice(restored.db, notice!.planId)).toBe(true)
    restored.db.prepare('DELETE FROM journal_recovery_notices WHERE plan_id = ?').run(notice!.planId)
    restored.db.prepare("DELETE FROM events WHERE kind = 'journal/recovered'").run()

    expect(consumeRecoveryReceipts(restored)).toBe(1)
    expect(listRecoveryNotices(restored.db)).toHaveLength(1)
    expect(
      restored.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'journal/recovered'").get()
    ).toMatchObject({ count: 1 })

    const replayed = listRecoveryNotices(restored.db)[0]!
    expect(dismissRecoveryNotice(restored.db, replayed.planId)).toBe(true)
    fs.unlinkSync(path.join(recovered.recovery!.quarantineDir, 'evidence.json'))
    expect(
      validateRecoveryReceiptsBeforeWritableOpen({ dataDir, journalPath })
    ).toMatchObject({ code: 'database-validation-unavailable' })
    expect(() => consumeRecoveryReceipts(restored)).toThrow(/evidence|ENOENT/i)
  })

  it('rejects a tampered unconsumed receipt before writable Journal construction', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'receipt-preflight' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x71))
    const recovered = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })
    recovered.lease.release()
    fs.writeFileSync(path.join(recovered.recovery!.quarantineDir, 'evidence.json'), '{}\n')

    expect(
      validateRecoveryReceiptsBeforeWritableOpen({ dataDir, journalPath })
    ).toMatchObject({ code: 'database-validation-unavailable' })
  })

  it.each([
    [
      'deleted family member after notice dismissal',
      (
        dataDir: string,
        recovered: NonNullable<ReturnType<typeof bootstrapJournalRecovery>['recovery']>
      ) => {
        const restored = open(dataDir)
        expect(consumeRecoveryReceipts(restored)).toBe(1)
        expect(dismissRecoveryNotice(restored.db, recovered.planId)).toBe(true)
        restored.db.close()
        const member = fs
          .readdirSync(recovered.quarantineDir)
          .find((entry) => entry.startsWith('hub.db'))
        expect(member).toBeDefined()
        fs.unlinkSync(path.join(recovered.quarantineDir, member!))
      },
    ],
    [
      'replaced family member',
      (
        _dataDir: string,
        recovered: NonNullable<ReturnType<typeof bootstrapJournalRecovery>['recovery']>
      ) => {
        const member = fs
          .readdirSync(recovered.quarantineDir)
          .find((entry) => entry.startsWith('hub.db'))
        expect(member).toBeDefined()
        const file = path.join(recovered.quarantineDir, member!)
        fs.unlinkSync(file)
        fs.writeFileSync(file, 'replacement')
      },
    ],
    [
      'duplicate archive incident',
      (
        dataDir: string,
        recovered: NonNullable<ReturnType<typeof bootstrapJournalRecovery>['recovery']>
      ) => {
        const paths = recoveryPaths(dataDir)
        fs.mkdirSync(path.join(paths.quarantine, `archive-${recovered.planId}`))
      },
    ],
  ])('fails closed on %s before writable open', async (_label, mutate) => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'continuous-evidence' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x73))
    const result = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })
    result.lease.release()
    const recovered = result.recovery!
    mutate(dataDir, recovered)

    expect(
      validateRecoveryReceiptsBeforeWritableOpen({ dataDir, journalPath })
    ).toMatchObject({ code: 'database-validation-unavailable' })
  })

  it.each(['receipt', 'notice'])(
    'fails closed when an orphan recovery %s is present before writable open',
    async (kind) => {
      const dataDir = root()
      const journal = open(dataDir)
      journal.append('s1', 'session/input', { text: 'orphan-evidence' })
      await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
      journal.db.close()
      const journalPath = path.join(dataDir, 'hub.db')
      fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x74))
      const result = bootstrapJournalRecovery({
        dataDir,
        journalPath,
        schemaVersion: SCHEMA_VERSION,
      })
      result.lease.release()
      const recovered = result.recovery!
      const orphanId = '99999999-9999-4999-8999-999999999999'
      if (kind === 'receipt') {
        fs.copyFileSync(
          recovered.receiptFile,
          path.join(recoveryPaths(dataDir).receipts, `${orphanId}.json`)
        )
      } else {
        const restored = open(dataDir)
        expect(consumeRecoveryReceipts(restored)).toBe(1)
        restored.db
          .prepare(
            `INSERT INTO journal_recovery_notices (
               plan_id, generation, snapshot_max_seq, snapshot_event_high_water,
               quarantine_dir, recorded_at, dismissed_at
             ) VALUES (?, '1', '0', '0', ?, '2026-07-29T00:00:00.000Z', NULL)`
          )
          .run(orphanId, path.join(recoveryPaths(dataDir).quarantine, orphanId))
        restored.db.close()
      }

      expect(
        validateRecoveryReceiptsBeforeWritableOpen({ dataDir, journalPath })
      ).toMatchObject({ code: 'database-validation-unavailable' })
    }
  )

  it('keeps a completed recovery offline when its root-bound receipt disappears', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'missing-receipt' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x72))
    const recovered = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })
    recovered.lease.release()
    fs.unlinkSync(recovered.recovery!.receiptFile)

    expect(
      validateRecoveryReceiptsBeforeWritableOpen({ dataDir, journalPath })
    ).toMatchObject({ code: 'database-validation-unavailable' })
  })

  it('never authorizes automatic overwrite of a foreign healthy journal', async () => {
    const dataDir = root()
    const foreignDir = root('ama-foreign-journal')
    const journal = open(dataDir)
    journal.append('owned', 'session/input', { text: 'owned-lineage' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const foreign = open(foreignDir)
    foreign.append('foreign', 'session/input', { text: 'foreign-lineage' })
    await strongSnapshot(foreignDir, foreign, new Date('2026-07-29T00:00:00.000Z'))
    foreign.db.close()
    fs.copyFileSync(path.join(foreignDir, 'hub.db'), path.join(dataDir, 'hub.db'))
    const foreignBytes = fs.readFileSync(path.join(dataDir, 'hub.db'))

    const classified = bootstrapJournalRecovery({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      schemaVersion: SCHEMA_VERSION,
    })

    expect(classified.preflight.ok).toBe(false)
    if (!classified.preflight.ok) {
      expect(classified.preflight.failure).toMatchObject({
        code: 'database-lineage-invalid',
      })
      expect(classified.preflight.failure).not.toHaveProperty('recoveryCause')
    }
    expect(classified.recovery).toBeUndefined()
    expect(fs.readFileSync(path.join(dataDir, 'hub.db'))).toEqual(foreignBytes)
    classified.lease.release()
  })

  it('uses AUTOINCREMENT high-water so ordinary row condensation does not look like rollback', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'one' })
    journal.append('s1', 'session/input', { text: 'two' })
    journal.append('s1', 'session/input', { text: 'three' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.prepare('DELETE FROM events WHERE seq < 3').run()

    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toBeUndefined()
  })

  it('uses the newest verified metadata when head.json is missing or stale', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'generation-one' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    const paths = recoveryPaths(dataDir)
    const staleHead = fs.readFileSync(paths.head)
    journal.append('s1', 'session/input', { text: 'generation-two' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:01:00.000Z'))

    fs.writeFileSync(paths.head, staleHead)
    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toBeUndefined()
    fs.unlinkSync(paths.head)
    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toBeUndefined()

    journal.db.close()
    const first = listRecoveryGenerations(dataDir, SCHEMA_VERSION).find(
      (generation) => generation.manifest.generation === '1'
    )!
    fs.copyFileSync(path.join(first.directory, 'snapshot.db'), path.join(dataDir, 'hub.db'))
    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toMatchObject({
      code: 'database-lineage-invalid',
      recoveryCause: 'lineage-rollback',
    })
  })

  it('rebuilds derived head.json when it points to no matching verified generation', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'head-integrity' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    const headFile = recoveryPaths(dataDir).head
    const head = JSON.parse(fs.readFileSync(headFile, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(headFile, `${JSON.stringify({ ...head, generation: '999' }, null, 2)}\n`)

    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(headFile, 'utf8'))).toMatchObject({ generation: '1' })
  })

  it('reclassifies cleanly after an actual process kill leaves unpublished classifier debris', async () => {
    const dataDir = root('ama-classifier-hard-crash')
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'owned-before-crash' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.close()
    const journalPath = path.join(dataDir, 'hub.db')
    fs.writeFileSync(journalPath, Buffer.alloc(96 * 1024, 0x47))
    const recoveryModule = pathToFileURL(
      path.join(import.meta.dirname, 'journalRecovery.ts')
    ).href

    await runHardCrashModule(`
      const { bootstrapJournalRecovery } = await import(${JSON.stringify(recoveryModule)});
      bootstrapJournalRecovery({
        dataDir: ${JSON.stringify(dataDir)},
        journalPath: ${JSON.stringify(journalPath)},
        schemaVersion: ${SCHEMA_VERSION},
        failpoint: (edge) => {
          if (edge === 'after-classifier-fsync-hub.db') {
            process.kill(process.pid, 'SIGKILL');
            throw new Error('hard kill returned unexpectedly');
          }
        },
      });
    `)
    expect(
      fs.readdirSync(recoveryPaths(dataDir).staging).filter((entry) =>
        entry.startsWith('.classifier-')
      )
    ).toHaveLength(1)

    const recovered = bootstrapJournalRecovery({
      dataDir,
      journalPath,
      schemaVersion: SCHEMA_VERSION,
    })
    expect(recovered.recovery?.generation).toBe('1')
    expect(
      fs.readdirSync(recoveryPaths(dataDir).staging).filter((entry) =>
        entry.startsWith('.classifier-')
      )
    ).toHaveLength(0)
    recovered.lease.release()
  })

  it('never publishes a newer ordinal with a regressed event high-water', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'one' })
    journal.append('s1', 'session/input', { text: 'two' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.exec(
      "DELETE FROM events WHERE seq > 1; UPDATE sqlite_sequence SET seq = 1 WHERE name = 'events'"
    )

    const rejected = await snapshotJournal(journal.db, {
      dir: path.join(dataDir, 'backups'),
      recoveryDataDir: dataDir,
      recoveryKeep: 6,
      now: () => new Date('2026-07-29T00:01:00.000Z'),
    })

    expect(rejected).toMatchObject({ ok: false })
    expect(
      listRecoveryGenerations(dataDir, SCHEMA_VERSION).map(
        (generation) => generation.manifest.generation
      )
    ).toEqual(['1'])
  })

  it('classifies same-journal AUTOINCREMENT regression as recoverable lineage rollback', async () => {
    const dataDir = root()
    const journal = open(dataDir)
    journal.append('s1', 'session/input', { text: 'one' })
    journal.append('s1', 'session/input', { text: 'two' })
    await strongSnapshot(dataDir, journal, new Date('2026-07-29T00:00:00.000Z'))
    journal.db.exec("DELETE FROM events WHERE seq > 1; UPDATE sqlite_sequence SET seq = 1 WHERE name = 'events'")

    expect(
      verifyNormalJournalLineage({
        dataDir,
        journalPath: path.join(dataDir, 'hub.db'),
        maxSchemaVersion: SCHEMA_VERSION,
      })
    ).toMatchObject({
      code: 'database-lineage-invalid',
      recoveryCause: 'lineage-rollback',
    })
  })
})
