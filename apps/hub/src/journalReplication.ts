import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { SCHEMA_VERSION } from './restartHandshake.js'

export const JOURNAL_REPLICATION_DISK_POLICY = 'grow-until-replicated' as const
export const JOURNAL_REPLICATION_DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024

const REPLICATION_FORMAT = 1 as const
const REPLICATION_ROOT = 'journal-replication'
const NODE_IDENTITY_FILE = 'node.json'
const SNAPSHOT_FILE = 'snapshot.db'
const MANIFEST_FILE = 'manifest.json'
const VERIFIED_FILE = 'verified.json'
const TRANSFER_STATE_FILE = 'transfer-state.json'
const PARTIAL_FILE = 'snapshot.db.partial'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export type JournalSnapshotManifest = {
  format: 1
  sourceJournalId: string
  generationId: string
  createdAt: string
  maxSeq: number
  rowCount: number
  schemaVersion: number
  databaseBytes: number
  databaseSha256: string
  chunkBytes: number
  chunks: Array<{ index: number; offset: number; length: number; sha256: string }>
}

export type JournalSnapshot = {
  generationDir: string
  manifest: JournalSnapshotManifest
}

export type SnapshotTransferResult = {
  complete: boolean
  generationDir: string
  chunksWritten: number
  chunksReused: number
  nextChunk: number
  manifest: JournalSnapshotManifest
}

export type ReplicationPruneGate = {
  enabled: boolean
  coverageSatisfied: boolean
  maxPrunableSeq: number
  requiredReplicas: number
  verifiedReplicas: number
  supportingGenerationIds: string[]
  diskPressurePolicy: typeof JOURNAL_REPLICATION_DISK_POLICY
}

type SnapshotInspection = {
  sourceJournalId: string
  maxSeq: number
  rowCount: number
  schemaVersion: number
}

type TransferState = {
  format: 1
  manifestSha256: string
  nextChunk: number
}

type VerifiedMarker = {
  format: 1
  manifestSha256: string
  databaseSha256: string
  verifiedAt: string
  nodeId?: string
}

const REPLICATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS journal_replication_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    journal_id TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS journal_replication_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    required_replicas INTEGER NOT NULL CHECK (required_replicas > 0),
    disk_pressure_policy TEXT NOT NULL CHECK (disk_pressure_policy = 'grow-until-replicated'),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_replication_assignments (
    peer_node_id TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS journal_replication_generations (
    generation_id TEXT PRIMARY KEY,
    max_seq INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    database_bytes INTEGER NOT NULL,
    database_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    protected INTEGER NOT NULL DEFAULT 0,
    protected_replicas INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS journal_replication_acks (
    generation_id TEXT NOT NULL,
    peer_node_id TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    PRIMARY KEY (generation_id, peer_node_id)
  );
`

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error(`${label} is not a safe identifier`)
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`)
}

function sha256Buffer(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function readExactly(file: string, offset: number, length: number): Buffer {
  const out = Buffer.allocUnsafe(length)
  const fd = fs.openSync(file, 'r')
  try {
    let read = 0
    while (read < length) {
      const n = fs.readSync(fd, out, read, length - read, offset + read)
      if (n === 0) {
        throw new Error(`snapshot is truncated at byte ${offset + read}; expected ${length - read} more byte(s)`)
      }
      read += n
    }
  } finally {
    fs.closeSync(fd)
  }
  return out
}

function fsyncFile(file: string): void {
  // Windows rejects FlushFileBuffers for a read-only handle even though POSIX accepts fsync on one.
  const fd = fs.openSync(file, 'r+')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  const fd = fs.openSync(temporary, 'wx')
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(temporary, file)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* preserve the atomic-write failure */
    }
    throw error
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`cannot read ${file}: ${errorText(error)}`)
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function manifestDigest(manifest: JournalSnapshotManifest): string {
  return sha256Buffer(JSON.stringify(manifest))
}

function parseManifest(generationDir: string): JournalSnapshotManifest {
  const raw = object(readJson(path.join(generationDir, MANIFEST_FILE)))
  if (!raw || raw.format !== REPLICATION_FORMAT) throw new Error('unsupported or malformed snapshot manifest')
  const manifest = raw as unknown as JournalSnapshotManifest
  assertSafeId(manifest.sourceJournalId, 'source journal id')
  assertSafeId(manifest.generationId, 'snapshot generation id')
  assertNonNegativeInteger(manifest.maxSeq, 'snapshot maxSeq')
  assertNonNegativeInteger(manifest.rowCount, 'snapshot rowCount')
  assertNonNegativeInteger(manifest.schemaVersion, 'snapshot schemaVersion')
  assertNonNegativeInteger(manifest.databaseBytes, 'snapshot databaseBytes')
  assertPositiveInteger(manifest.chunkBytes, 'snapshot chunkBytes')
  if (!SHA256_PATTERN.test(manifest.databaseSha256)) throw new Error('snapshot database hash is malformed')
  if (!Array.isArray(manifest.chunks)) throw new Error('snapshot chunk list is malformed')
  let expectedOffset = 0
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    const chunk = manifest.chunks[index]
    if (!chunk || chunk.index !== index || chunk.offset !== expectedOffset) {
      throw new Error(`snapshot chunk ${index} is out of order`)
    }
    assertPositiveInteger(chunk.length, `snapshot chunk ${index} length`)
    if (chunk.length > manifest.chunkBytes) throw new Error(`snapshot chunk ${index} exceeds chunkBytes`)
    if (!SHA256_PATTERN.test(chunk.sha256)) throw new Error(`snapshot chunk ${index} hash is malformed`)
    expectedOffset += chunk.length
  }
  if (expectedOffset !== manifest.databaseBytes) {
    throw new Error(`snapshot chunks cover ${expectedOffset} bytes, expected ${manifest.databaseBytes}`)
  }
  if (manifest.databaseBytes > 0 && manifest.chunks.length === 0) throw new Error('snapshot has no chunks')
  if (Number.isNaN(Date.parse(manifest.createdAt))) throw new Error('snapshot createdAt is malformed')
  return manifest
}

function parseVerified(generationDir: string): VerifiedMarker {
  const raw = object(readJson(path.join(generationDir, VERIFIED_FILE)))
  if (
    !raw ||
    raw.format !== REPLICATION_FORMAT ||
    typeof raw.manifestSha256 !== 'string' ||
    typeof raw.databaseSha256 !== 'string' ||
    typeof raw.verifiedAt !== 'string'
  ) {
    throw new Error('snapshot verification marker is malformed')
  }
  if (!SHA256_PATTERN.test(raw.manifestSha256) || !SHA256_PATTERN.test(raw.databaseSha256)) {
    throw new Error('snapshot verification marker contains a malformed hash')
  }
  if (raw.nodeId !== undefined && typeof raw.nodeId !== 'string') {
    throw new Error('snapshot verification marker node id is malformed')
  }
  return raw as VerifiedMarker
}

function inspectSnapshot(file: string, maxSchemaVersion: number): SnapshotInspection {
  assertNonNegativeInteger(maxSchemaVersion, 'maximum schema version')
  let db: Database.Database | undefined
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    db.pragma('query_only = ON')
    const schemaVersion = Number(db.pragma('user_version', { simple: true }))
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
      throw new Error(`snapshot has invalid schema version ${schemaVersion}`)
    }
    if (schemaVersion > maxSchemaVersion) {
      throw new Error(`snapshot schema v${schemaVersion} is newer than supported v${maxSchemaVersion}`)
    }
    const findings = (db.pragma('integrity_check') as Array<Record<string, unknown>>).flatMap((row) =>
      Object.values(row).map(String)
    )
    if (findings.length !== 1 || findings[0]?.toLowerCase() !== 'ok') {
      throw new Error(`snapshot failed SQLite integrity_check: ${findings.join('; ') || 'no result'}`)
    }
    const identity = db
      .prepare('SELECT journal_id FROM journal_replication_identity WHERE singleton = 1')
      .get() as { journal_id: string } | undefined
    if (!identity) throw new Error('snapshot is missing its durable journal identity')
    assertSafeId(identity.journal_id, 'snapshot journal id')
    const invalidPayload = db
      .prepare('SELECT seq FROM events WHERE json_valid(payload) = 0 ORDER BY seq LIMIT 1')
      .get() as { seq: number } | undefined
    if (invalidPayload) {
      // A malformed payload once made replay crash-loop. The reader now degrades it visibly, but a replica
      // must not certify those bytes as a known-good restore and spread the poison to every healthy node.
      throw new Error(`snapshot contains unreadable JSON payload at event seq ${invalidPayload.seq}`)
    }
    const row = db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq, COUNT(*) AS rowCount FROM events')
      .get() as { maxSeq: number; rowCount: number }
    return {
      sourceJournalId: identity.journal_id,
      maxSeq: Number(row.maxSeq),
      rowCount: Number(row.rowCount),
      schemaVersion,
    }
  } catch (error) {
    throw new Error(`snapshot is not a valid journal: ${errorText(error)}`)
  } finally {
    db?.close()
  }
}

function verifySnapshotBytes(
  generationDir: string,
  manifest: JournalSnapshotManifest,
  maxSchemaVersion: number
): void {
  const snapshotFile = path.join(generationDir, SNAPSHOT_FILE)
  let stat: fs.Stats
  try {
    stat = fs.statSync(snapshotFile)
  } catch (error) {
    throw new Error(`snapshot database is missing: ${errorText(error)}`)
  }
  if (!stat.isFile() || stat.size !== manifest.databaseBytes) {
    throw new Error(`snapshot database size is ${stat.size}; expected ${manifest.databaseBytes} (truncated or corrupt)`)
  }
  const databaseSha256 = sha256File(snapshotFile)
  if (databaseSha256 !== manifest.databaseSha256) {
    throw new Error(`snapshot database hash mismatch: expected ${manifest.databaseSha256}, got ${databaseSha256}`)
  }
  // The whole-file digest already covers every byte; re-reading every chunk here would double verification
  // I/O on a measured 390 MB journal. Per-chunk hashes are checked while transferring and resuming, where
  // they identify the exact bad unit. Whole hash + SQLite integrity + logical payload validation is stronger
  // and cheaper for a completed immutable artifact.
  const inspection = inspectSnapshot(snapshotFile, maxSchemaVersion)
  if (
    inspection.sourceJournalId !== manifest.sourceJournalId ||
    inspection.maxSeq !== manifest.maxSeq ||
    inspection.rowCount !== manifest.rowCount ||
    inspection.schemaVersion !== manifest.schemaVersion
  ) {
    throw new Error('snapshot journal metadata does not match its manifest')
  }
}

function initializeReplicationSchema(db: Database.Database): string {
  db.exec(REPLICATION_SCHEMA)
  db.prepare(
    'INSERT OR IGNORE INTO journal_replication_identity (singleton, journal_id) VALUES (1, ?)'
  ).run(crypto.randomUUID())
  const identity = db
    .prepare('SELECT journal_id FROM journal_replication_identity WHERE singleton = 1')
    .get() as { journal_id: string } | undefined
  if (!identity) throw new Error('could not establish a durable journal replication identity')
  assertSafeId(identity.journal_id, 'journal id')
  return identity.journal_id
}

function openSource(journalPath: string): Database.Database {
  const db = new Database(journalPath, { fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  return db
}

function registerGeneration(
  db: Database.Database,
  manifest: JournalSnapshotManifest
): void {
  db.prepare(
    `INSERT INTO journal_replication_generations (
       generation_id, max_seq, row_count, schema_version, database_bytes, database_sha256, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(generation_id) DO UPDATE SET
       max_seq = excluded.max_seq,
       row_count = excluded.row_count,
       schema_version = excluded.schema_version,
       database_bytes = excluded.database_bytes,
       database_sha256 = excluded.database_sha256,
       created_at = excluded.created_at`
  ).run(
    manifest.generationId,
    manifest.maxSeq,
    manifest.rowCount,
    manifest.schemaVersion,
    manifest.databaseBytes,
    manifest.databaseSha256,
    manifest.createdAt
  )
}

export function ensureReplicationNodeIdentity(dataDir: string): string {
  const root = path.join(path.resolve(dataDir), REPLICATION_ROOT)
  const identityFile = path.join(root, NODE_IDENTITY_FILE)
  fs.mkdirSync(root, { recursive: true })
  if (!fs.existsSync(identityFile)) {
    const value = { format: REPLICATION_FORMAT, nodeId: crypto.randomUUID(), createdAt: new Date().toISOString() }
    let fd: number | undefined
    try {
      fd = fs.openSync(identityFile, 'wx')
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      fs.fsyncSync(fd)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      // Two incoming transfers may discover a new peer simultaneously. Exactly one durable identity wins;
      // the loser reads it below instead of inventing a second assignment identity.
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  const raw = object(readJson(identityFile))
  if (!raw || raw.format !== REPLICATION_FORMAT || typeof raw.nodeId !== 'string') {
    // Never silently mint a second identity after a partial/corrupt write. Assignments are keyed by this id;
    // changing it would make a healthy replica look like an unrelated machine and could strand protected data.
    throw new Error(`replication node identity is malformed: ${identityFile}`)
  }
  assertSafeId(raw.nodeId, 'replication node id')
  return raw.nodeId
}

export function replicaGenerationDirectory(
  dataDir: string,
  sourceJournalId: string,
  generationId: string
): string {
  assertSafeId(sourceJournalId, 'source journal id')
  assertSafeId(generationId, 'snapshot generation id')
  return path.join(path.resolve(dataDir), REPLICATION_ROOT, 'replicas', sourceJournalId, generationId)
}

export async function createJournalSnapshot(options: {
  sourceDataDir: string
  journalPath?: string
  chunkBytes?: number
  maxSchemaVersion?: number
}): Promise<JournalSnapshot> {
  const sourceDataDir = path.resolve(options.sourceDataDir)
  const journalPath = path.resolve(options.journalPath ?? path.join(sourceDataDir, 'hub.db'))
  const chunkBytes = options.chunkBytes ?? JOURNAL_REPLICATION_DEFAULT_CHUNK_BYTES
  const maxSchemaVersion = options.maxSchemaVersion ?? SCHEMA_VERSION
  assertPositiveInteger(chunkBytes, 'chunkBytes')
  assertNonNegativeInteger(maxSchemaVersion, 'maximum schema version')

  const outgoingRoot = path.join(sourceDataDir, REPLICATION_ROOT, 'outgoing')
  const stagingDir = path.join(outgoingRoot, `.staging-${process.pid}-${crypto.randomUUID()}`)
  fs.mkdirSync(stagingDir, { recursive: true })
  const stagingSnapshot = path.join(stagingDir, SNAPSHOT_FILE)
  let db: Database.Database | undefined
  try {
    db = openSource(journalPath)
    const sourceJournalId = initializeReplicationSchema(db)
    // better-sqlite3's online backup API takes one consistent SQLite snapshot while writers continue in WAL
    // mode. Copying hub.db itself would omit committed WAL pages and can create a backup that never existed.
    await db.backup(stagingSnapshot)
    const inspection = inspectSnapshot(stagingSnapshot, maxSchemaVersion)
    if (inspection.sourceJournalId !== sourceJournalId) throw new Error('online backup changed journal identity')
    const databaseBytes = fs.statSync(stagingSnapshot).size
    const databaseSha256 = sha256File(stagingSnapshot)
    const chunks: JournalSnapshotManifest['chunks'] = []
    for (let offset = 0, index = 0; offset < databaseBytes; offset += chunkBytes, index += 1) {
      const length = Math.min(chunkBytes, databaseBytes - offset)
      chunks.push({ index, offset, length, sha256: sha256Buffer(readExactly(stagingSnapshot, offset, length)) })
    }
    const generationId = `g-${inspection.maxSeq}-${databaseSha256.slice(0, 24)}`
    const manifest: JournalSnapshotManifest = {
      format: REPLICATION_FORMAT,
      sourceJournalId,
      generationId,
      createdAt: new Date().toISOString(),
      maxSeq: inspection.maxSeq,
      rowCount: inspection.rowCount,
      schemaVersion: inspection.schemaVersion,
      databaseBytes,
      databaseSha256,
      chunkBytes,
      chunks,
    }
    writeJsonAtomic(path.join(stagingDir, MANIFEST_FILE), manifest)
    writeJsonAtomic(path.join(stagingDir, VERIFIED_FILE), {
      format: REPLICATION_FORMAT,
      manifestSha256: manifestDigest(manifest),
      databaseSha256,
      verifiedAt: new Date().toISOString(),
    } satisfies VerifiedMarker)

    const generationDir = path.join(outgoingRoot, generationId)
    fs.mkdirSync(outgoingRoot, { recursive: true })
    let registeredManifest = manifest
    if (fs.existsSync(generationDir)) {
      const existing = verifyJournalSnapshot(generationDir, maxSchemaVersion)
      if (
        existing.sourceJournalId !== manifest.sourceJournalId ||
        existing.generationId !== manifest.generationId ||
        existing.maxSeq !== manifest.maxSeq ||
        existing.rowCount !== manifest.rowCount ||
        existing.schemaVersion !== manifest.schemaVersion ||
        existing.databaseBytes !== manifest.databaseBytes ||
        existing.databaseSha256 !== manifest.databaseSha256
      ) {
        throw new Error(`snapshot generation collision at ${generationDir}`)
      }
      // Re-taking a snapshot without intervening writes can produce the identical SQLite bytes. Reuse its
      // immutable first manifest; createdAt/chunk sizing are artifact metadata, not a reason to fail or store
      // a duplicate full database.
      registeredManifest = existing
      fs.rmSync(stagingDir, { recursive: true, force: true })
    } else {
      fs.renameSync(stagingDir, generationDir)
    }
    registerGeneration(db, registeredManifest)
    return { generationDir, manifest: registeredManifest }
  } catch (error) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true })
    } catch {
      /* preserve the snapshot failure */
    }
    throw error
  } finally {
    db?.close()
  }
}

function readTransferState(generationDir: string, digest: string): TransferState {
  const stateFile = path.join(generationDir, TRANSFER_STATE_FILE)
  if (!fs.existsSync(stateFile)) {
    const state: TransferState = { format: REPLICATION_FORMAT, manifestSha256: digest, nextChunk: 0 }
    writeJsonAtomic(stateFile, state)
    return state
  }
  const raw = object(readJson(stateFile))
  if (
    !raw ||
    raw.format !== REPLICATION_FORMAT ||
    raw.manifestSha256 !== digest ||
    !Number.isSafeInteger(raw.nextChunk) ||
    Number(raw.nextChunk) < 0
  ) {
    throw new Error('snapshot transfer state is malformed or belongs to a different manifest')
  }
  return raw as TransferState
}

function writeTransferState(generationDir: string, state: TransferState): void {
  writeJsonAtomic(path.join(generationDir, TRANSFER_STATE_FILE), state)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function transferJournalSnapshot(options: {
  sourceGenerationDir: string
  targetDataDir: string
  maxChunks?: number
  chunkDelayMs?: number
  onChunk?: (nextChunk: number) => void
}): Promise<SnapshotTransferResult> {
  const maxChunks = options.maxChunks ?? Number.MAX_SAFE_INTEGER
  const chunkDelayMs = options.chunkDelayMs ?? 0
  assertNonNegativeInteger(maxChunks, 'maxChunks')
  assertNonNegativeInteger(chunkDelayMs, 'chunkDelayMs')
  const manifest = verifyJournalSnapshot(path.resolve(options.sourceGenerationDir), SCHEMA_VERSION)
  const digest = manifestDigest(manifest)
  const nodeId = ensureReplicationNodeIdentity(options.targetDataDir)
  const generationDir = replicaGenerationDirectory(
    options.targetDataDir,
    manifest.sourceJournalId,
    manifest.generationId
  )
  fs.mkdirSync(generationDir, { recursive: true })
  const targetManifestFile = path.join(generationDir, MANIFEST_FILE)
  if (fs.existsSync(targetManifestFile)) {
    const existing = parseManifest(generationDir)
    if (manifestDigest(existing) !== digest) throw new Error('target generation contains a different manifest')
  } else {
    writeJsonAtomic(targetManifestFile, manifest)
  }

  const finalFile = path.join(generationDir, SNAPSHOT_FILE)
  if (fs.existsSync(finalFile)) {
    if (fs.existsSync(path.join(generationDir, VERIFIED_FILE))) {
      verifyJournalSnapshot(generationDir, SCHEMA_VERSION)
    } else {
      // A kill can land after the complete file rename but before VERIFIED is written. Re-validate the exact
      // immutable bytes and finish certification; do not force an operator to delete a perfectly good copy.
      verifySnapshotBytes(generationDir, manifest, SCHEMA_VERSION)
      writeJsonAtomic(path.join(generationDir, VERIFIED_FILE), {
        format: REPLICATION_FORMAT,
        manifestSha256: digest,
        databaseSha256: manifest.databaseSha256,
        verifiedAt: new Date().toISOString(),
        nodeId,
      } satisfies VerifiedMarker)
    }
    return {
      complete: true,
      generationDir,
      chunksWritten: 0,
      chunksReused: manifest.chunks.length,
      nextChunk: manifest.chunks.length,
      manifest,
    }
  }

  const state = readTransferState(generationDir, digest)
  if (state.nextChunk > manifest.chunks.length) throw new Error('snapshot transfer watermark exceeds chunk count')
  const expectedOffset =
    state.nextChunk === manifest.chunks.length ? manifest.databaseBytes : manifest.chunks[state.nextChunk]!.offset
  const partialFile = path.join(generationDir, PARTIAL_FILE)
  if (!fs.existsSync(partialFile)) {
    if (state.nextChunk !== 0) throw new Error('snapshot partial file is missing below its durable watermark')
    const fd = fs.openSync(partialFile, 'wx')
    fs.closeSync(fd)
  }
  const partialSize = fs.statSync(partialFile).size
  if (partialSize < expectedOffset) {
    throw new Error(`snapshot partial file is truncated below durable watermark ${state.nextChunk}`)
  }
  if (partialSize > expectedOffset) {
    // A kill can land after fsync(data) but before the atomic watermark write. The unacknowledged tail is
    // deliberately discarded and requested again; bytes at or below the durable watermark are never guessed.
    fs.truncateSync(partialFile, expectedOffset)
  }
  for (let index = 0; index < state.nextChunk; index += 1) {
    const chunk = manifest.chunks[index]!
    if (sha256Buffer(readExactly(partialFile, chunk.offset, chunk.length)) !== chunk.sha256) {
      throw new Error(`snapshot partial chunk ${index} is corrupt below its durable watermark`)
    }
  }

  const sourceFile = path.join(path.resolve(options.sourceGenerationDir), SNAPSHOT_FILE)
  const partialFd = fs.openSync(partialFile, 'r+')
  let chunksWritten = 0
  try {
    while (state.nextChunk < manifest.chunks.length && chunksWritten < maxChunks) {
      const chunk = manifest.chunks[state.nextChunk]!
      const bytes = readExactly(sourceFile, chunk.offset, chunk.length)
      if (sha256Buffer(bytes) !== chunk.sha256) throw new Error(`source snapshot chunk ${chunk.index} is corrupt`)
      let written = 0
      while (written < bytes.length) {
        written += fs.writeSync(partialFd, bytes, written, bytes.length - written, chunk.offset + written)
      }
      fs.fsyncSync(partialFd)
      state.nextChunk += 1
      writeTransferState(generationDir, state)
      chunksWritten += 1
      options.onChunk?.(state.nextChunk)
      if (chunkDelayMs > 0) await delay(chunkDelayMs)
    }
  } finally {
    fs.closeSync(partialFd)
  }
  const chunksReused = state.nextChunk - chunksWritten
  if (state.nextChunk < manifest.chunks.length) {
    return { complete: false, generationDir, chunksWritten, chunksReused, nextChunk: state.nextChunk, manifest }
  }

  if (fs.statSync(partialFile).size !== manifest.databaseBytes) {
    throw new Error('completed snapshot partial has the wrong size')
  }
  if (sha256File(partialFile) !== manifest.databaseSha256) {
    throw new Error('completed snapshot partial has the wrong database hash')
  }
  inspectSnapshot(partialFile, SCHEMA_VERSION)
  fs.renameSync(partialFile, finalFile)
  writeJsonAtomic(path.join(generationDir, VERIFIED_FILE), {
    format: REPLICATION_FORMAT,
    manifestSha256: digest,
    databaseSha256: manifest.databaseSha256,
    verifiedAt: new Date().toISOString(),
    nodeId,
  } satisfies VerifiedMarker)
  verifyJournalSnapshot(generationDir, SCHEMA_VERSION)
  return {
    complete: true,
    generationDir,
    chunksWritten,
    chunksReused,
    nextChunk: state.nextChunk,
    manifest,
  }
}

export function verifyJournalSnapshot(
  generationDir: string,
  maxSchemaVersion = SCHEMA_VERSION
): JournalSnapshotManifest {
  const resolved = path.resolve(generationDir)
  const manifest = parseManifest(resolved)
  const verified = parseVerified(resolved)
  if (verified.manifestSha256 !== manifestDigest(manifest)) {
    throw new Error('snapshot verification marker does not match its manifest')
  }
  if (verified.databaseSha256 !== manifest.databaseSha256) {
    throw new Error('snapshot verification marker does not match its database')
  }
  verifySnapshotBytes(resolved, manifest, maxSchemaVersion)
  return manifest
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  )
}

function computePruneGate(db: Database.Database, reserve: boolean): ReplicationPruneGate {
  if (!tableExists(db, 'journal_replication_policy')) {
    return {
      enabled: false,
      coverageSatisfied: true,
      maxPrunableSeq: Number.MAX_SAFE_INTEGER,
      requiredReplicas: 0,
      verifiedReplicas: 0,
      supportingGenerationIds: [],
      diskPressurePolicy: JOURNAL_REPLICATION_DISK_POLICY,
    }
  }
  const policy = db
    .prepare(
      'SELECT required_replicas AS requiredReplicas, disk_pressure_policy AS diskPressurePolicy FROM journal_replication_policy WHERE singleton = 1'
    )
    .get() as { requiredReplicas: number; diskPressurePolicy: string } | undefined
  if (!policy) {
    return {
      enabled: false,
      coverageSatisfied: true,
      maxPrunableSeq: Number.MAX_SAFE_INTEGER,
      requiredReplicas: 0,
      verifiedReplicas: 0,
      supportingGenerationIds: [],
      diskPressurePolicy: JOURNAL_REPLICATION_DISK_POLICY,
    }
  }
  if (policy.diskPressurePolicy !== JOURNAL_REPLICATION_DISK_POLICY) {
    throw new Error(`unknown journal replication disk policy: ${policy.diskPressurePolicy}`)
  }
  assertPositiveInteger(policy.requiredReplicas, 'required replica count')
  const rows = db
    .prepare(
      `SELECT ack.peer_node_id AS peerNodeId, generation.generation_id AS generationId,
              generation.max_seq AS maxSeq
       FROM journal_replication_acks AS ack
       JOIN journal_replication_generations AS generation
         ON generation.generation_id = ack.generation_id
       JOIN journal_replication_assignments AS assignment
         ON assignment.peer_node_id = ack.peer_node_id
       ORDER BY ack.peer_node_id, generation.max_seq DESC, generation.created_at DESC`
    )
    .all() as Array<{ peerNodeId: string; generationId: string; maxSeq: number }>
  const bestByPeer = new Map<string, { peerNodeId: string; generationId: string; maxSeq: number }>()
  for (const row of rows) {
    if (!bestByPeer.has(row.peerNodeId)) bestByPeer.set(row.peerNodeId, row)
  }
  const verified = [...bestByPeer.values()].sort(
    (a, b) => b.maxSeq - a.maxSeq || a.peerNodeId.localeCompare(b.peerNodeId)
  )
  const coverageSatisfied = verified.length >= policy.requiredReplicas
  const supporting = coverageSatisfied ? verified.slice(0, policy.requiredReplicas) : []
  const maxPrunableSeq = coverageSatisfied ? supporting.at(-1)!.maxSeq : 0
  const supportingGenerationIds = [...new Set(supporting.map((row) => row.generationId))].sort()
  if (reserve && supportingGenerationIds.length > 0) {
    const protect = db.prepare(
      `UPDATE journal_replication_generations
       SET protected = 1,
           protected_replicas = MAX(protected_replicas, ?)
       WHERE generation_id = ?`
    )
    const transaction = db.transaction(() => {
      for (const generationId of supportingGenerationIds) {
        protect.run(policy.requiredReplicas, generationId)
      }
    })
    // Commit this reservation BEFORE maintenance deletes a row. If the process dies between the two, it
    // merely retains an extra generation; the unsafe reverse ordering could orphan the only pre-prune copy.
    transaction.immediate()
  }
  return {
    enabled: true,
    coverageSatisfied,
    maxPrunableSeq,
    requiredReplicas: policy.requiredReplicas,
    verifiedReplicas: verified.length,
    supportingGenerationIds,
    diskPressurePolicy: JOURNAL_REPLICATION_DISK_POLICY,
  }
}

export function configureJournalReplication(options: {
  sourceJournalPath: string
  requiredReplicas: number
  assignedPeerIds: string[]
}): void {
  assertPositiveInteger(options.requiredReplicas, 'required replica count')
  const assignedPeerIds = [...new Set(options.assignedPeerIds)]
  if (assignedPeerIds.length !== options.assignedPeerIds.length) throw new Error('replica assignments contain duplicates')
  if (assignedPeerIds.length < options.requiredReplicas) {
    throw new Error(
      `replication factor ${options.requiredReplicas} requires at least ${options.requiredReplicas} assigned peers`
    )
  }
  for (const peerId of assignedPeerIds) assertSafeId(peerId, 'assigned peer id')
  const sourceJournalPath = path.resolve(options.sourceJournalPath)
  const sourceNodeId = ensureReplicationNodeIdentity(path.dirname(sourceJournalPath))
  if (assignedPeerIds.includes(sourceNodeId)) {
    throw new Error('the source node cannot count its own local snapshot as a peer replica')
  }
  const db = openSource(sourceJournalPath)
  try {
    initializeReplicationSchema(db)
    const previous = new Set(
      (
        db.prepare('SELECT peer_node_id AS peerNodeId FROM journal_replication_assignments').all() as Array<{
          peerNodeId: string
        }>
      ).map((row) => row.peerNodeId)
    )
    const removing = [...previous].some((peerId) => !assignedPeerIds.includes(peerId))
    if (removing) {
      const protectedGenerations = db
        .prepare(
          `SELECT generation_id AS generationId, protected_replicas AS protectedReplicas
           FROM journal_replication_generations
           WHERE protected = 1`
        )
        .all() as Array<{ generationId: string; protectedReplicas: number }>
      const placeholders = assignedPeerIds.map(() => '?').join(', ')
      for (const generation of protectedGenerations) {
        const row =
          assignedPeerIds.length === 0
            ? { count: 0 }
            : (db
                .prepare(
                  `SELECT COUNT(*) AS count
                   FROM journal_replication_acks
                   WHERE generation_id = ? AND peer_node_id IN (${placeholders})`
                )
                .get(generation.generationId, ...assignedPeerIds) as { count: number })
        if (row.count < generation.protectedReplicas) {
          throw new Error(
            `refusing assignment change: protected generation ${generation.generationId} has ` +
              `${row.count}/${generation.protectedReplicas} verified handoff copies in the proposed assignment`
          )
        }
      }
    }
    const apply = db.transaction(() => {
      db.prepare('DELETE FROM journal_replication_assignments').run()
      const insert = db.prepare(
        'INSERT INTO journal_replication_assignments (peer_node_id) VALUES (?)'
      )
      for (const peerId of assignedPeerIds) insert.run(peerId)
      db.prepare(
        `INSERT INTO journal_replication_policy (
           singleton, required_replicas, disk_pressure_policy, updated_at
         ) VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           required_replicas = excluded.required_replicas,
           disk_pressure_policy = excluded.disk_pressure_policy,
           updated_at = excluded.updated_at`
      ).run(options.requiredReplicas, JOURNAL_REPLICATION_DISK_POLICY, new Date().toISOString())
    })
    apply.immediate()
  } finally {
    db.close()
  }
}

export function recordReplicaVerification(options: {
  sourceJournalPath: string
  replicaDataDir: string
  generationId: string
  maxSchemaVersion?: number
}): void {
  assertSafeId(options.generationId, 'snapshot generation id')
  const sourceJournalPath = path.resolve(options.sourceJournalPath)
  const sourceNodeId = ensureReplicationNodeIdentity(path.dirname(sourceJournalPath))
  const db = openSource(sourceJournalPath)
  try {
    const sourceJournalId = initializeReplicationSchema(db)
    const peerNodeId = ensureReplicationNodeIdentity(options.replicaDataDir)
    if (peerNodeId === sourceNodeId) throw new Error('the source node cannot acknowledge its own local snapshot')
    const assigned = db
      .prepare('SELECT 1 FROM journal_replication_assignments WHERE peer_node_id = ?')
      .get(peerNodeId)
    if (!assigned) throw new Error(`peer ${peerNodeId} is not assigned to hold this journal`)
    const generation = db
      .prepare(
        `SELECT max_seq AS maxSeq, row_count AS rowCount, schema_version AS schemaVersion,
                database_bytes AS databaseBytes, database_sha256 AS databaseSha256
         FROM journal_replication_generations WHERE generation_id = ?`
      )
      .get(options.generationId) as
      | {
          maxSeq: number
          rowCount: number
          schemaVersion: number
          databaseBytes: number
          databaseSha256: string
        }
      | undefined
    if (!generation) throw new Error(`source does not know snapshot generation ${options.generationId}`)
    const generationDir = replicaGenerationDirectory(
      options.replicaDataDir,
      sourceJournalId,
      options.generationId
    )
    const manifest = verifyJournalSnapshot(generationDir, options.maxSchemaVersion ?? SCHEMA_VERSION)
    const marker = parseVerified(generationDir)
    if (marker.nodeId !== peerNodeId) {
      throw new Error(
        `replica verification marker belongs to node ${marker.nodeId ?? '(none)'}, expected ${peerNodeId}`
      )
    }
    if (
      manifest.sourceJournalId !== sourceJournalId ||
      manifest.generationId !== options.generationId ||
      manifest.maxSeq !== generation.maxSeq ||
      manifest.rowCount !== generation.rowCount ||
      manifest.schemaVersion !== generation.schemaVersion ||
      manifest.databaseBytes !== generation.databaseBytes ||
      manifest.databaseSha256 !== generation.databaseSha256
    ) {
      throw new Error('replica verification does not match the source generation record')
    }
    db.prepare(
      `INSERT INTO journal_replication_acks (generation_id, peer_node_id, verified_at)
       VALUES (?, ?, ?)
       ON CONFLICT(generation_id, peer_node_id) DO UPDATE SET verified_at = excluded.verified_at`
    ).run(options.generationId, peerNodeId, new Date().toISOString())
  } finally {
    db.close()
  }
}

export function reserveReplicationPruneGate(db: Database.Database): ReplicationPruneGate {
  return computePruneGate(db, true)
}

export function readJournalReplicationStatus(sourceJournalPath: string): ReplicationPruneGate & {
  sourceJournalId?: string
  assignedPeerIds: string[]
  protectedGenerationIds: string[]
} {
  const db = new Database(path.resolve(sourceJournalPath), { readonly: true, fileMustExist: true })
  try {
    if (!tableExists(db, 'journal_replication_identity')) {
      return {
        ...computePruneGate(db, false),
        assignedPeerIds: [],
        protectedGenerationIds: [],
      }
    }
    const identity = db
      .prepare('SELECT journal_id AS journalId FROM journal_replication_identity WHERE singleton = 1')
      .get() as { journalId: string } | undefined
    const assignedPeerIds = (
      db
        .prepare('SELECT peer_node_id AS peerNodeId FROM journal_replication_assignments ORDER BY peer_node_id')
        .all() as Array<{ peerNodeId: string }>
    ).map((row) => row.peerNodeId)
    const protectedGenerationIds = (
      db
        .prepare(
          'SELECT generation_id AS generationId FROM journal_replication_generations WHERE protected = 1 ORDER BY generation_id'
        )
        .all() as Array<{ generationId: string }>
    ).map((row) => row.generationId)
    return {
      ...computePruneGate(db, false),
      sourceJournalId: identity?.journalId,
      assignedPeerIds,
      protectedGenerationIds,
    }
  } finally {
    db.close()
  }
}

export function chooseReplicaAssignments(
  sourceJournalId: string,
  candidatePeerIds: string[],
  replicationFactor: number
): string[] {
  assertSafeId(sourceJournalId, 'source journal id')
  assertNonNegativeInteger(replicationFactor, 'replication factor')
  const peers = [...new Set(candidatePeerIds)]
  if (peers.length !== candidatePeerIds.length) throw new Error('candidate peer list contains duplicates')
  if (replicationFactor > peers.length) throw new Error('replication factor exceeds candidate peer count')
  for (const peer of peers) assertSafeId(peer, 'candidate peer id')
  // Rendezvous hashing changes only the assignments whose relative score is displaced by a join/leave. It is
  // deterministic across machines and needs no central allocator; the protected-generation handoff check is
  // still the authority that decides whether the planned removal is safe to commit.
  return peers
    .map((peer) => ({ peer, score: crypto.createHash('sha256').update(`${sourceJournalId}\0${peer}`).digest() }))
    .sort((a, b) => Buffer.compare(b.score, a.score) || a.peer.localeCompare(b.peer))
    .slice(0, replicationFactor)
    .map(({ peer }) => peer)
}

export function restoreJournalSnapshot(options: {
  replicaGenerationDir: string
  destinationDataDir: string
  maxSchemaVersion?: number
}): JournalSnapshotManifest {
  const manifest = verifyJournalSnapshot(
    path.resolve(options.replicaGenerationDir),
    options.maxSchemaVersion ?? SCHEMA_VERSION
  )
  const destinationDataDir = path.resolve(options.destinationDataDir)
  const destination = path.join(destinationDataDir, 'hub.db')
  if (fs.existsSync(destination) || fs.existsSync(`${destination}-wal`) || fs.existsSync(`${destination}-shm`)) {
    throw new Error(`refusing to overwrite an existing journal at ${destination}`)
  }
  fs.mkdirSync(destinationDataDir, { recursive: true })
  const temporary = path.join(
    destinationDataDir,
    `.hub.db.restore-${process.pid}-${crypto.randomUUID()}.partial`
  )
  try {
    fs.copyFileSync(path.join(path.resolve(options.replicaGenerationDir), SNAPSHOT_FILE), temporary)
    fsyncFile(temporary)
    if (fs.statSync(temporary).size !== manifest.databaseBytes || sha256File(temporary) !== manifest.databaseSha256) {
      throw new Error('scratch restore copy is truncated or corrupt')
    }
    const inspection = inspectSnapshot(temporary, options.maxSchemaVersion ?? SCHEMA_VERSION)
    if (
      inspection.sourceJournalId !== manifest.sourceJournalId ||
      inspection.maxSeq !== manifest.maxSeq ||
      inspection.rowCount !== manifest.rowCount
    ) {
      throw new Error('scratch restore journal does not match its verified manifest')
    }
    fs.renameSync(temporary, destination)
    try {
      writeJsonAtomic(path.join(destinationDataDir, REPLICATION_ROOT, 'restore-receipt.json'), {
        format: REPLICATION_FORMAT,
        sourceJournalId: manifest.sourceJournalId,
        generationId: manifest.generationId,
        databaseSha256: manifest.databaseSha256,
        restoredAt: new Date().toISOString(),
      })
    } catch {
      // The verified hub.db is already atomically installed. A diagnostic receipt failing (most plausibly
      // because the disk filled on its final few hundred bytes) must not turn a successful restore into an
      // unretryable "failure" whose next attempt then refuses to overwrite the restored database.
    }
    return manifest
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* preserve the restore verification failure */
    }
    throw error
  }
}
