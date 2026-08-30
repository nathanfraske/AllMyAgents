import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import {
  runHubPreflight,
  type HubPreflightResult,
  type PreflightFailure,
} from './preflight.js'

const FORMAT = 1 as const
const RECOVERY_ROOT = 'journal-recovery'
const GENERATIONS = 'generations'
const STAGING = 'staging'
const QUARANTINE = 'quarantine'
const RECEIPTS = 'receipts'
const LEASES = 'leases'
const ROOT_FILE = 'root.json'
const ENROLLMENT_INTENT_FILE = 'enrollment-intent.json'
const HEAD_FILE = 'head.json'
const ACTIVE_PLAN_FILE = 'active-plan.json'
const SNAPSHOT_FILE = 'snapshot.db'
const MANIFEST_FILE = 'manifest.json'
const VERIFIED_FILE = 'verified.json'
const EVIDENCE_FILE = 'evidence.json'
const SQLITE_FAMILY = ['hub.db', 'hub.db-wal', 'hub.db-shm', 'hub.db-journal'] as const
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n
const MAX_METADATA_BYTES = 256n * 1024n
const MAX_GENERATION_ENTRIES = 16
const MAX_STAGING_ENTRIES = 16
const MAX_INCIDENTS = 64
const MAX_QUARANTINE_BYTES = 1n << 40n
export const JOURNAL_RECOVERY_WORKER_ABSOLUTE_MS = 5 * 60_000

type JournalRecoveryWorkerRequest = {
  kind: 'journal-recovery-v1'
  attemptId: string
  operationId: string
  dataDir: string
  journalPath: string
  schemaVersion: number
}

export type JournalRecoveryWorkerResult = {
  preflight: HubPreflightResult
  recovery?: RecoveryReceipt
}

export type AutomaticRecoveryCause =
  | 'sqlite-corruption'
  | 'orphan-family'

type RootBinding = {
  format: 1
  rootId: string
  activeJournalId: string
  nextGeneration: string
  activeGeneration?: string
  recoveryTransition?: {
    planId: string
    previousGeneration: string
    previousManifestSha256: string
    restoredGeneration: string
    receiptSha256?: string
  }
  completedRecoveries?: Array<{ planId: string; receiptSha256: string }>
  ownershipDatabase: {
    dev: string
    ino: string
  }
}

type EnrollmentIntent = {
  format: 1
  rootId: string
  journalId: string
  ownershipDatabase: {
    dev: string
    ino: string
  }
  createdAt: string
}

export type RecoveryManifest = {
  format: 1
  rootId: string
  journalId: string
  generation: string
  createdAt: string
  schemaVersion: number
  databaseBytes: string
  databaseSha256: string
  eventCount: string
  maxSeq: string
  eventHighWater: string
}

type VerifiedMarker = {
  format: 1
  rootId: string
  journalId: string
  generation: string
  manifestSha256: string
  databaseSha256: string
  verifiedAt: string
}

type RecoveryHead = {
  format: 1
  rootId: string
  journalId: string
  generation: string
  eventHighWater: string
  manifestSha256: string
}

type FileFingerprint = {
  name: (typeof SQLITE_FAMILY)[number]
  dev: string
  ino: string
  size: string
  mtimeNs: string
  sha256: string
}

type DirectoryIdentity = {
  realPath: string
  dev: string
  ino: string
}

type RecoveryPlan = {
  format: 1
  id: string
  cause: AutomaticRecoveryCause
  rootId: string
  journalId: string
  generation: string
  priorActiveGeneration?: string
  priorActiveManifestSha256?: string
  generationDirectory: string
  stagingFile: string
  quarantineDirectory: string
  rootRealPath: string
  rootDev: string
  rootIno: string
  directories: {
    recoveryRoot: DirectoryIdentity
    generations: DirectoryIdentity
    staging: DirectoryIdentity
    quarantine: DirectoryIdentity
    receipts: DirectoryIdentity
  }
  incidentDirectory?: DirectoryIdentity
  family: FileFingerprint[]
  createdAt: string
  phase: 'prepared' | 'quarantining' | 'publishing' | 'verifying' | 'cleaning'
}

export type RecoveryReceipt = {
  format: 1
  planId: string
  cause: AutomaticRecoveryCause
  rootId: string
  journalId: string
  generation: string
  previousActiveGeneration?: string
  previousActiveManifestSha256?: string
  snapshotMaxSeq: string
  snapshotEventHighWater: string
  quarantineDir: string
  evidenceSha256: string
  receiptFile: string
  notification: 'pending' | 'consumed'
  completedAt: string
}

export type RecoveryGeneration = {
  directory: string
  manifest: RecoveryManifest
}

export class JournalRecoveryBootstrapError extends Error {
  readonly failure: PreflightFailure

  constructor(failure: PreflightFailure, cause: unknown) {
    super(`automatic journal recovery could not proceed: ${text(cause)}`, { cause })
    this.name = 'JournalRecoveryBootstrapError'
    this.failure = failure
  }
}

export type RecoveryPaths = {
  root: string
  rootBinding: string
  enrollmentIntent: string
  head: string
  generations: string
  staging: string
  quarantine: string
  receipts: string
  leases: string
  leaseDb: string
  activePlan: string
}

export function recoveryPaths(dataDir: string): RecoveryPaths {
  const root = path.join(path.resolve(dataDir), RECOVERY_ROOT)
  return {
    root,
    rootBinding: path.join(root, ROOT_FILE),
    enrollmentIntent: path.join(root, ENROLLMENT_INTENT_FILE),
    head: path.join(root, HEAD_FILE),
    generations: path.join(root, GENERATIONS),
    staging: path.join(root, STAGING),
    quarantine: path.join(root, QUARANTINE),
    receipts: path.join(root, RECEIPTS),
    leases: path.join(root, LEASES),
    leaseDb: path.join(root, 'ownership.db'),
    activePlan: path.join(root, ACTIVE_PLAN_FILE),
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function code(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function lstatState(
  file: string
): { state: 'missing' } | { state: 'present'; stat: fs.Stats } {
  try {
    return { state: 'present', stat: fs.lstatSync(file) }
  } catch (error) {
    if (code(error) === 'ENOENT') return { state: 'missing' }
    throw error
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function reconcileUnpublishedJsonPartial(file: string): boolean {
  if (lstatState(file).state === 'present') return false
  const parent = path.dirname(file)
  const prefix = `${path.basename(file)}.partial-`
  const candidates = fs.readdirSync(parent).filter((entry) => entry.startsWith(prefix))
  if (candidates.length === 0) return false
  if (candidates.length !== 1) {
    throw new Error(`ambiguous unpublished recovery metadata for ${file}`)
  }
  const candidate = candidates[0]!
  const expectedHash = candidate.slice(prefix.length)
  if (!SHA256.test(expectedHash)) {
    throw new Error(`unpublished recovery metadata has a malformed digest name: ${candidate}`)
  }
  const partial = path.join(parent, candidate)
  const stat = assertRegular(partial, true)
  if (stat.size > MAX_METADATA_BYTES) {
    throw new Error('unpublished recovery metadata exceeds the bounded metadata size')
  }
  const bytes = fs.readFileSync(partial)
  if (sha256(bytes) !== expectedHash) {
    throw new Error('unpublished recovery metadata digest does not match its owned name')
  }
  JSON.parse(bytes.toString('utf8'))
  fs.linkSync(partial, file)
  syncFile(file)
  syncDirectory(parent)
  fs.unlinkSync(partial)
  syncDirectory(parent)
  return true
}

function readJson(file: string): unknown {
  try {
    if (lstatState(file).state === 'missing') reconcileUnpublishedJsonPartial(file)
    let stat = fs.lstatSync(file, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('metadata path is not one regular non-symlink file')
    }
    if (stat.size > MAX_METADATA_BYTES) {
      throw new Error('metadata file exceeds the bounded recovery metadata size')
    }
    const bytes = fs.readFileSync(file)
    if (stat.nlink !== 1n) {
      const partial = `${file}.partial-${sha256(bytes)}`
      const partialStat = fs.lstatSync(partial, { bigint: true })
      if (
        stat.nlink !== 2n ||
        !partialStat.isFile() ||
        partialStat.isSymbolicLink() ||
        partialStat.dev !== stat.dev ||
        partialStat.ino !== stat.ino
      ) {
        throw new Error('metadata path has an ambiguous publication link')
      }
      fs.unlinkSync(partial)
      syncDirectory(path.dirname(file))
      stat = fs.lstatSync(file, { bigint: true })
      if (stat.nlink !== 1n) {
        throw new Error('metadata publication link reconciliation did not converge')
      }
    }
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new Error(`cannot read durable recovery metadata ${file}: ${text(error)}`)
  }
}

function sha256(value: Buffer | string): string {
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

function decimal(value: unknown, label: string, positive = false): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal string`)
  }
  const parsed = BigInt(value)
  if (parsed > MAX_SQLITE_INTEGER || (positive && parsed === 0n)) {
    throw new Error(`${label} is outside the supported SQLite integer range`)
  }
  return value
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return Number(value)
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 32 ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`)
  }
  return value
}

function syncFile(file: string): void {
  const fd = fs.openSync(file, 'r+')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Node cannot open a directory for FlushFileBuffers on Windows. A durable, same-directory barrier file
 * still sends a volume flush after each metadata mutation. POSIX uses the stronger directory fsync.
 */
function syncDirectory(directory: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(directory, 'r')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    return
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* preserve the durability error */
      }
    }
    if (process.platform !== 'win32' || code(error) !== 'EPERM') throw error
  }
  const barrier = path.join(directory, '.ama-directory-barrier')
  const barrierState = lstatState(barrier)
  if (barrierState.state === 'present') assertRegular(barrier, true)
  const barrierFd = fs.openSync(barrier, barrierState.state === 'missing' ? 'wx' : 'w')
  try {
    fs.writeSync(barrierFd, 'ama-dir-sync-v1\n', null, 'utf8')
    fs.fsyncSync(barrierFd)
  } finally {
    fs.closeSync(barrierFd)
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const parent = path.dirname(file)
  const parentState = lstatState(parent)
  if (
    parentState.state !== 'present' ||
    !parentState.stat.isDirectory() ||
    parentState.stat.isSymbolicLink()
  ) {
    throw new Error(`recovery metadata parent is not a real directory: ${parent}`)
  }
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
    syncDirectory(path.dirname(file))
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* preserve the publication error */
    }
    throw error
  }
}

function writeJsonExclusive(
  file: string,
  value: unknown,
  failpoint?: (edge: string) => void,
  edge = 'metadata'
): void {
  const parent = path.dirname(file)
  const parentState = lstatState(parent)
  if (
    parentState.state !== 'present' ||
    !parentState.stat.isDirectory() ||
    parentState.stat.isSymbolicLink()
  ) {
    throw new Error(`recovery metadata parent is not a real directory: ${parent}`)
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (BigInt(bytes.length) > MAX_METADATA_BYTES) {
    throw new Error('recovery metadata exceeds the bounded metadata size')
  }
  const partial = `${file}.partial-${sha256(bytes)}`
  const finalState = lstatState(file)
  if (finalState.state === 'present') {
    // A crash after the exclusive hard-link publication may leave the expected owned partial
    // attached to the already-durable final inode. readJson validates and finishes that handoff.
    readJson(file)
    const alreadyPublished = fs.readFileSync(file)
    if (alreadyPublished.equals(bytes)) return
    const exists = new Error(`recovery metadata target already exists: ${file}`) as NodeJS.ErrnoException
    exists.code = 'EEXIST'
    throw exists
  }
  const partialState = lstatState(partial)
  if (partialState.state === 'present') {
    if (
      !partialState.stat.isFile() ||
      partialState.stat.isSymbolicLink() ||
      !fs.readFileSync(partial).equals(bytes)
    ) {
      // This exact digest-qualified unpublished name is owned by this publication attempt. A
      // partial write cannot be authoritative and is safe to recreate before the final exists.
      fs.unlinkSync(partial)
      syncDirectory(parent)
    }
  }
  if (lstatState(partial).state === 'missing') {
    const fd = fs.openSync(partial, 'wx')
    try {
      fs.writeFileSync(fd, bytes)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    failpoint?.(`after-${edge}-partial-fsync`)
  }
  fs.linkSync(partial, file)
  const publishedIdentity = fs.lstatSync(file, { bigint: true })
  failpoint?.(`after-${edge}-link`)
  syncFile(file)
  syncDirectory(parent)
  try {
    fs.unlinkSync(partial)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    let finalStat: fs.BigIntStats | undefined
    try {
      finalStat = fs.lstatSync(file, { bigint: true })
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
    }
    const bytesMatch = finalStat !== undefined && fs.readFileSync(file).equals(bytes)
    // Node's Windows stat inode value can change when NTFS drops the other hard-link name, even
    // though the surviving path still has the exact bytes on the same volume. POSIX inode identity
    // remains stable and is enforced there.
    const identityMatches =
      finalStat !== undefined &&
      finalStat.dev === publishedIdentity.dev &&
      (process.platform === 'win32' || finalStat.ino === publishedIdentity.ino)
    if (
      finalStat === undefined ||
      !finalStat.isFile() ||
      finalStat.isSymbolicLink() ||
      !identityMatches ||
      finalStat.nlink !== 1n ||
      !bytesMatch
    ) {
      const observed = finalStat
        ? `dev=${finalStat.dev} ino=${finalStat.ino} links=${finalStat.nlink} bytesMatch=${bytesMatch}`
        : 'missing'
      throw new Error(
        `recovery metadata partial disappeared before its exact publication could be verified: ${file} (${observed}; expected volume=${publishedIdentity.dev} exact bytes and one link)`
      )
    }
    // Another exact reader observed the two-link publication, validated the shared inode, and
    // completed the partial cleanup first. That is already the durable state this writer wanted.
  }
  failpoint?.(`after-${edge}-partial-unlink`)
  syncDirectory(parent)
}

function publishPartialNoReplace(
  partial: string,
  target: string,
  directory: string,
  failpoint: ((edge: string) => void) | undefined,
  edge: string
): void {
  fs.linkSync(partial, target)
  failpoint?.(`after-${edge}-link`)
  syncFile(target)
  syncDirectory(directory)
  fs.unlinkSync(partial)
  failpoint?.(`after-${edge}-partial-unlink`)
  syncDirectory(directory)
}

function removeMatchingPublishedPartial(partial: string, target: string, directory: string): void {
  const partialState = lstatState(partial)
  if (partialState.state === 'missing') return
  const targetState = lstatState(target)
  if (
    targetState.state === 'missing' ||
    !partialState.stat.isFile() ||
    partialState.stat.isSymbolicLink() ||
    partialState.stat.dev !== targetState.stat.dev ||
    partialState.stat.ino !== targetState.stat.ino
  ) {
    throw new Error(`published recovery target has an ambiguous partial: ${target}`)
  }
  fs.unlinkSync(partial)
  syncDirectory(directory)
}

function assertRegular(file: string, requireSingleLink = false): fs.BigIntStats {
  const stat = fs.lstatSync(file, { bigint: true })
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (requireSingleLink && stat.nlink !== 1n)
  ) {
    throw new Error(`recovery path is not an eligible regular file: ${file}`)
  }
  return stat
}

function assertRootStable(dataDir: string, expectedRealPath?: string): string {
  const resolved = path.resolve(dataDir)
  const stat = fs.lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`data root is not a real directory: ${resolved}`)
  }
  const real = fs.realpathSync.native(resolved)
  if (expectedRealPath !== undefined && real !== expectedRealPath) {
    throw new Error(`data root changed during recovery: ${resolved}`)
  }
  return real
}

function ensureRealDirectory(parent: string, directory: string): void {
  const parentReal = fs.realpathSync.native(parent)
  const state = lstatState(directory)
  if (state.state === 'missing') {
    fs.mkdirSync(directory)
    syncDirectory(parent)
  } else if (!state.stat.isDirectory() || state.stat.isSymbolicLink()) {
    throw new Error(`recovery path is not a real directory: ${directory}`)
  }
  const directoryReal = fs.realpathSync.native(directory)
  const relative = path.relative(parentReal, directoryReal)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`recovery directory escaped its expected parent: ${directory}`)
  }
}

function ensureRecoveryRoot(dataDir: string): RecoveryPaths {
  const resolved = path.resolve(dataDir)
  if (lstatState(resolved).state === 'missing') {
    fs.mkdirSync(resolved, { recursive: true })
  }
  assertRootStable(resolved)
  const paths = recoveryPaths(resolved)
  ensureRealDirectory(resolved, paths.root)
  return paths
}

function ensureRecoveryOperationDirectories(dataDir: string): RecoveryPaths {
  const paths = ensureRecoveryRoot(dataDir)
  for (const directory of [
    paths.generations,
    paths.staging,
    paths.quarantine,
    paths.receipts,
  ]) {
    ensureRealDirectory(paths.root, directory)
  }
  return paths
}

function hasPriorRecoveryNamespaceHistory(paths: RecoveryPaths): boolean {
  for (const file of [paths.head, paths.activePlan]) {
    if (lstatState(file).state === 'present') return true
  }
  for (const [directory, maximum, label] of [
    [paths.generations, MAX_GENERATION_ENTRIES, 'recovery generations'],
    [paths.staging, MAX_STAGING_ENTRIES, 'recovery staging'],
    [paths.quarantine, MAX_INCIDENTS, 'recovery incidents'],
    [paths.receipts, MAX_INCIDENTS, 'recovery receipts'],
  ] as const) {
    const state = lstatState(directory)
    if (state.state === 'missing') continue
    if (!state.stat.isDirectory() || state.stat.isSymbolicLink()) {
      throw new Error(`${label} path is not a real directory`)
    }
    if (boundedEntries(directory, maximum, label).length > 0) return true
  }
  const allowedRootEntries = new Set([
    '.ama-directory-barrier',
    path.basename(paths.leaseDb),
    path.basename(paths.enrollmentIntent),
    path.basename(paths.generations),
    path.basename(paths.staging),
    path.basename(paths.quarantine),
    path.basename(paths.receipts),
    path.basename(paths.leases),
  ])
  for (const entry of fs.readdirSync(paths.root)) {
    if (!allowedRootEntries.has(entry)) return true
  }
  return false
}

function boundedEntries(directory: string, maximum: number, label: string): string[] {
  const rawEntries = fs.readdirSync(directory)
  if (rawEntries.includes('.ama-directory-barrier')) {
    assertRegular(path.join(directory, '.ama-directory-barrier'), true)
  }
  const entries = rawEntries.filter((entry) => entry !== '.ama-directory-barrier')
  if (entries.length > maximum) {
    throw new Error(`${label} exceeds its bounded entry quota (${entries.length}/${maximum})`)
  }
  return entries
}

function assertRecoveryEvidenceQuota(
  paths: RecoveryPaths,
  prospectiveFamily: FileFingerprint[] = [],
  byteLimit: bigint = MAX_QUARANTINE_BYTES,
  reserve: { generations?: number; staging?: number } = {}
): void {
  const generations = boundedEntries(
    paths.generations,
    MAX_GENERATION_ENTRIES,
    'recovery generations'
  )
  const staging = boundedEntries(paths.staging, MAX_STAGING_ENTRIES, 'recovery staging')
  if (generations.length + (reserve.generations ?? 0) > MAX_GENERATION_ENTRIES) {
    throw new Error('recovery generations have no quota for another publication')
  }
  if (staging.length + (reserve.staging ?? 0) > MAX_STAGING_ENTRIES) {
    throw new Error('recovery staging has no quota for another operation')
  }
  const receipts = boundedEntries(paths.receipts, MAX_INCIDENTS, 'recovery receipts')
  const incidents = boundedEntries(paths.quarantine, MAX_INCIDENTS, 'recovery incidents')
  if (
    prospectiveFamily.length > 0 &&
    (receipts.length >= MAX_INCIDENTS || incidents.length >= MAX_INCIDENTS)
  ) {
    throw new Error('retained recovery evidence has no quota for another incident')
  }
  let totalBytes = 0n
  for (const incident of incidents) {
    const directory = path.join(paths.quarantine, incident)
    const state = lstatState(directory)
    if (
      state.state !== 'present' ||
      !state.stat.isDirectory() ||
      state.stat.isSymbolicLink()
    ) {
      throw new Error(`recovery incident is not a real directory: ${incident}`)
    }
    for (const entry of boundedEntries(directory, SQLITE_FAMILY.length + 1, 'recovery incident files')) {
      const file = path.join(directory, entry)
      const stat = fs.lstatSync(file, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`recovery incident contains a non-regular entry: ${entry}`)
      }
      totalBytes += stat.size
      if (totalBytes > byteLimit) {
        throw new Error(
          'retained recovery evidence exceeds 1 TiB; keep the root offline and archive evidence explicitly'
        )
      }
    }
  }
  totalBytes += prospectiveFamily.reduce((sum, entry) => sum + BigInt(entry.size), 0n)
  if (prospectiveFamily.length > 0) totalBytes += MAX_METADATA_BYTES
  if (totalBytes > byteLimit) {
    throw new Error(
      'prospective recovery evidence exceeds its byte quota; live bytes remain untouched'
    )
  }
}

function rootIdentity(dataDir: string): { realPath: string; dev: string; ino: string } {
  const realPath = assertRootStable(dataDir)
  const stat = fs.lstatSync(path.resolve(dataDir), { bigint: true })
  return { realPath, dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function directoryIdentity(directory: string): DirectoryIdentity {
  const state = fs.lstatSync(directory, { bigint: true })
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(`recovery path is not a real directory: ${directory}`)
  }
  return {
    realPath: fs.realpathSync.native(directory),
    dev: state.dev.toString(),
    ino: state.ino.toString(),
  }
}

function assertDirectoryIdentity(directory: string, expected: DirectoryIdentity): void {
  const actual = directoryIdentity(directory)
  if (
    actual.realPath !== expected.realPath ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error(`recovery directory identity changed: ${directory}`)
  }
}

function parseRootBinding(file: string): RootBinding {
  const raw = object(readJson(file))
  const ownershipDatabase = object(raw?.ownershipDatabase)
  const recoveryTransition = object(raw?.recoveryTransition)
  if (
    !raw ||
    raw.format !== FORMAT ||
    typeof raw.rootId !== 'string' ||
    !SAFE_UUID.test(raw.rootId) ||
    typeof raw.activeJournalId !== 'string' ||
    !SAFE_UUID.test(raw.activeJournalId) ||
    !ownershipDatabase
  ) {
    throw new Error('recovery root binding is malformed')
  }
  decimal(raw.nextGeneration, 'next recovery generation', true)
  if (raw.activeGeneration !== undefined) {
    decimal(raw.activeGeneration, 'active recovery generation', true)
  }
  if (raw.recoveryTransition !== undefined) {
    if (
      !recoveryTransition ||
      typeof recoveryTransition.planId !== 'string' ||
      !SAFE_UUID.test(recoveryTransition.planId) ||
      typeof recoveryTransition.previousManifestSha256 !== 'string' ||
      !SHA256.test(recoveryTransition.previousManifestSha256)
    ) {
      throw new Error('recovery root transition is malformed')
    }
    decimal(recoveryTransition.previousGeneration, 'previous recovery generation', true)
    decimal(recoveryTransition.restoredGeneration, 'restored recovery generation', true)
    if (
      recoveryTransition.receiptSha256 !== undefined &&
      (typeof recoveryTransition.receiptSha256 !== 'string' ||
        !SHA256.test(recoveryTransition.receiptSha256))
    ) {
      throw new Error('recovery root transition receipt digest is malformed')
    }
  }
  if (raw.completedRecoveries !== undefined) {
    if (!Array.isArray(raw.completedRecoveries) || raw.completedRecoveries.length > MAX_INCIDENTS) {
      throw new Error('recovery root completed-receipt index is malformed')
    }
    const ids = new Set<string>()
    for (const item of raw.completedRecoveries) {
      const completed = object(item)
      if (
        !completed ||
        typeof completed.planId !== 'string' ||
        !SAFE_UUID.test(completed.planId) ||
        typeof completed.receiptSha256 !== 'string' ||
        !SHA256.test(completed.receiptSha256) ||
        ids.has(completed.planId)
      ) {
        throw new Error('recovery root completed-receipt entry is malformed')
      }
      ids.add(completed.planId)
    }
  }
  decimal(ownershipDatabase.dev, 'recovery ownership device', false)
  decimal(ownershipDatabase.ino, 'recovery ownership inode', false)
  return raw as RootBinding
}

function parseEnrollmentIntent(file: string): EnrollmentIntent {
  const raw = object(readJson(file))
  const ownershipDatabase = object(raw?.ownershipDatabase)
  if (
    !raw ||
    raw.format !== FORMAT ||
    typeof raw.rootId !== 'string' ||
    !SAFE_UUID.test(raw.rootId) ||
    typeof raw.journalId !== 'string' ||
    !SAFE_UUID.test(raw.journalId) ||
    !ownershipDatabase
  ) {
    throw new Error('recovery enrollment intent is malformed')
  }
  decimal(ownershipDatabase.dev, 'enrollment ownership device', false)
  decimal(ownershipDatabase.ino, 'enrollment ownership inode', false)
  timestamp(raw.createdAt, 'recovery enrollment creation time')
  return raw as EnrollmentIntent
}

function readJournalIdentity(db: Database.Database): string {
  const row = db
    .prepare('SELECT journal_id AS journalId FROM journal_recovery_identity WHERE singleton = 1')
    .get() as { journalId?: unknown } | undefined
  if (!row || typeof row.journalId !== 'string' || !SAFE_UUID.test(row.journalId)) {
    throw new Error('journal recovery identity is missing or malformed')
  }
  return row.journalId
}

/**
 * Called before the online backup begins so both the durable source and copied snapshot contain the
 * exact same journal identity. Creating the root binding alone does not make recovery eligible.
 */
export function ensureRecoveryEnrollment(
  db: Database.Database,
  dataDir: string,
  options: { failpoint?: (edge: string) => void } = {}
): { rootId: string; journalId: string } {
  assertRootStable(dataDir)
  const paths = ensureRecoveryRoot(dataDir)
  if (lstatState(paths.leaseDb).state === 'missing') {
    const enrollmentLease = new JournalRecoveryLease(dataDir)
    enrollmentLease.acquireShared()
    enrollmentLease.release()
  }
  const ownershipStat = assertRegular(paths.leaseDb, true)
  const ownershipDatabase = {
    dev: ownershipStat.dev.toString(),
    ino: ownershipStat.ino.toString(),
  }
  reconcileUnpublishedJsonPartial(paths.rootBinding)
  reconcileUnpublishedJsonPartial(paths.enrollmentIntent)
  const identityTableExisted =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table' AND name = 'journal_recovery_identity'`
        )
        .get() as { count?: unknown } | undefined
    )?.count === 1
  const bindingState = lstatState(paths.rootBinding)
  if (bindingState.state === 'missing') {
    let intent: EnrollmentIntent
    if (lstatState(paths.enrollmentIntent).state === 'present') {
      intent = parseEnrollmentIntent(paths.enrollmentIntent)
      if (
        intent.ownershipDatabase.dev !== ownershipDatabase.dev ||
        intent.ownershipDatabase.ino !== ownershipDatabase.ino
      ) {
        throw new Error('recovery enrollment intent belongs to a different ownership database')
      }
    } else {
      if (identityTableExisted || hasPriorRecoveryNamespaceHistory(paths)) {
        throw new Error(
          'recovery root binding is missing despite prior enrollment history; refusing to mint a new lineage'
        )
      }
      intent = {
        format: FORMAT,
        rootId: crypto.randomUUID(),
        journalId: crypto.randomUUID(),
        ownershipDatabase,
        createdAt: new Date().toISOString(),
      }
      writeJsonExclusive(paths.enrollmentIntent, intent)
      options.failpoint?.('after-enrollment-intent')
    }
    if (identityTableExisted) {
      if (readJournalIdentity(db) !== intent.journalId) {
        throw new Error('recovery enrollment intent conflicts with the journal identity')
      }
    } else {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE journal_recovery_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          journal_id TEXT NOT NULL UNIQUE
        );
        INSERT INTO journal_recovery_identity (singleton, journal_id)
        VALUES (1, '${intent.journalId}');
        COMMIT;
      `)
      options.failpoint?.('after-enrollment-identity')
    }
    writeJsonExclusive(
      paths.rootBinding,
      {
        format: FORMAT,
        rootId: intent.rootId,
        activeJournalId: intent.journalId,
        nextGeneration: '1',
        ownershipDatabase,
      } satisfies RootBinding,
      options.failpoint,
      'enrollment-root-binding-publication'
    )
    options.failpoint?.('after-enrollment-root-binding')
  } else if (!identityTableExisted) {
    throw new Error('recovery root binding exists but the journal identity table is missing')
  }
  const binding = parseRootBinding(paths.rootBinding)
  const journalId = readJournalIdentity(db)
  if (binding.activeJournalId !== journalId) {
    throw new Error('data-root recovery identity does not match the active journal')
  }
  if (
    binding.ownershipDatabase.dev !== ownershipDatabase.dev ||
    binding.ownershipDatabase.ino !== ownershipDatabase.ino
  ) {
    throw new Error('recovery ownership database does not match the bound data-root identity')
  }
  if (lstatState(paths.enrollmentIntent).state === 'present') {
    const intent = parseEnrollmentIntent(paths.enrollmentIntent)
    if (
      intent.rootId !== binding.rootId ||
      intent.journalId !== binding.activeJournalId ||
      intent.ownershipDatabase.dev !== binding.ownershipDatabase.dev ||
      intent.ownershipDatabase.ino !== binding.ownershipDatabase.ino
    ) {
      throw new Error('completed recovery enrollment conflicts with its durable intent')
    }
    fs.unlinkSync(paths.enrollmentIntent)
    syncDirectory(paths.root)
  }
  return { rootId: binding.rootId, journalId }
}

function reserveGeneration(dataDir: string, journalId: string): {
  binding: RootBinding
  generation: string
} {
  const paths = recoveryPaths(dataDir)
  const binding = parseRootBinding(paths.rootBinding)
  if (binding.activeJournalId !== journalId) {
    throw new Error('cannot reserve recovery generation for a different journal')
  }
  const generation = decimal(binding.nextGeneration, 'next recovery generation', true)
  const next = BigInt(generation) + 1n
  if (next > MAX_SQLITE_INTEGER) throw new Error('recovery generation authority is exhausted')
  writeJsonAtomic(paths.rootBinding, { ...binding, nextGeneration: next.toString() })
  return { binding, generation }
}

type SnapshotInspection = {
  journalId: string
  schemaVersion: number
  eventCount: string
  maxSeq: string
  eventHighWater: string
}

function inspectDatabase(file: string, maxSchemaVersion: number): SnapshotInspection {
  assertRegular(file)
  let db: Database.Database | undefined
  let closeError: unknown
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    db.pragma('query_only = ON')
    const schemaVersion = safeInteger(
      db.pragma('user_version', { simple: true }),
      'snapshot schema version'
    )
    if (schemaVersion > maxSchemaVersion) {
      throw new Error(
        `snapshot schema v${schemaVersion} is newer than supported v${maxSchemaVersion}`
      )
    }
    const integrity = (db.pragma('integrity_check') as Array<Record<string, unknown>>).flatMap(
      (row) => Object.values(row).map(String)
    )
    if (integrity.length !== 1 || integrity[0]?.toLowerCase() !== 'ok') {
      throw new Error(`snapshot failed integrity_check: ${integrity.join('; ') || 'no result'}`)
    }
    const journalId = readJournalIdentity(db)
    const invalidPayload = db
      .prepare('SELECT seq FROM events WHERE json_valid(payload) = 0 ORDER BY seq LIMIT 1')
      .get() as { seq?: unknown } | undefined
    if (invalidPayload) {
      throw new Error(`snapshot contains invalid event JSON at seq ${String(invalidPayload.seq)}`)
    }
    const counts = db
      .prepare(
        `SELECT CAST(COUNT(*) AS TEXT) AS eventCount,
                CAST(COALESCE(MAX(seq), 0) AS TEXT) AS maxSeq,
                CAST(COALESCE(
                  (SELECT seq FROM sqlite_sequence WHERE name = 'events'),
                  0
                ) AS TEXT) AS eventHighWater
         FROM events`
      )
      .get() as
      | { eventCount?: unknown; maxSeq?: unknown; eventHighWater?: unknown }
      | undefined
    const eventCount = decimal(counts?.eventCount, 'snapshot event count')
    const maxSeq = decimal(counts?.maxSeq, 'snapshot max sequence')
    const eventHighWater = decimal(counts?.eventHighWater, 'snapshot event high-water')
    if (BigInt(eventHighWater) < BigInt(maxSeq)) {
      throw new Error('snapshot event high-water is below an existing event sequence')
    }
    return {
      journalId,
      schemaVersion,
      eventCount,
      maxSeq,
      eventHighWater,
    }
  } finally {
    try {
      db?.close()
    } catch (error) {
      closeError = error
    }
    if (closeError) throw new Error(`snapshot close failed: ${text(closeError)}`)
  }
}

function removeOwnedInspectionSidecars(file: string, ownedDirectory: string): void {
  if (path.dirname(path.resolve(file)) !== path.resolve(ownedDirectory)) {
    throw new Error('inspection sidecar cleanup escaped its owned directory')
  }
  let removed = false
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${file}${suffix}`
    const state = lstatState(sidecar)
    if (state.state === 'missing') continue
    assertRegular(sidecar, true)
    fs.unlinkSync(sidecar)
    removed = true
  }
  if (removed) syncDirectory(ownedDirectory)
}

function parseManifest(directory: string): RecoveryManifest {
  const raw = object(readJson(path.join(directory, MANIFEST_FILE)))
  if (
    !raw ||
    raw.format !== FORMAT ||
    typeof raw.rootId !== 'string' ||
    !SAFE_UUID.test(raw.rootId) ||
    typeof raw.journalId !== 'string' ||
    !SAFE_UUID.test(raw.journalId) ||
    typeof raw.createdAt !== 'string' ||
    Number.isNaN(Date.parse(raw.createdAt)) ||
    typeof raw.databaseSha256 !== 'string' ||
    !SHA256.test(raw.databaseSha256)
  ) {
    throw new Error('recovery manifest is malformed')
  }
  decimal(raw.generation, 'recovery generation', true)
  decimal(raw.databaseBytes, 'recovery database bytes', true)
  decimal(raw.eventCount, 'recovery event count')
  decimal(raw.maxSeq, 'recovery max sequence')
  decimal(raw.eventHighWater, 'recovery event high-water')
  safeInteger(raw.schemaVersion, 'recovery schema version')
  const manifest = raw as RecoveryManifest
  const expectedName = generationDirectoryName(manifest.generation, manifest.databaseSha256)
  if (path.basename(directory) !== expectedName) {
    throw new Error('recovery generation directory is not canonical')
  }
  return manifest
}

function parseVerified(directory: string): VerifiedMarker {
  const raw = object(readJson(path.join(directory, VERIFIED_FILE)))
  if (
    !raw ||
    raw.format !== FORMAT ||
    typeof raw.rootId !== 'string' ||
    !SAFE_UUID.test(raw.rootId) ||
    typeof raw.journalId !== 'string' ||
    !SAFE_UUID.test(raw.journalId) ||
    typeof raw.manifestSha256 !== 'string' ||
    !SHA256.test(raw.manifestSha256) ||
    typeof raw.databaseSha256 !== 'string' ||
    !SHA256.test(raw.databaseSha256) ||
    typeof raw.verifiedAt !== 'string' ||
    Number.isNaN(Date.parse(raw.verifiedAt))
  ) {
    throw new Error('recovery verification marker is malformed')
  }
  decimal(raw.generation, 'verified recovery generation', true)
  return raw as VerifiedMarker
}

function parseHead(file: string): RecoveryHead {
  const raw = object(readJson(file))
  if (
    !raw ||
    raw.format !== FORMAT ||
    typeof raw.rootId !== 'string' ||
    !SAFE_UUID.test(raw.rootId) ||
    typeof raw.journalId !== 'string' ||
    !SAFE_UUID.test(raw.journalId) ||
    typeof raw.manifestSha256 !== 'string' ||
    !SHA256.test(raw.manifestSha256)
  ) {
    throw new Error('recovery head is malformed')
  }
  decimal(raw.generation, 'recovery head generation', true)
  decimal(raw.eventHighWater, 'recovery head event high-water')
  return raw as RecoveryHead
}

function generationDirectoryName(generation: string, databaseSha256: string): string {
  return `g-${generation.padStart(20, '0')}-${databaseSha256.slice(0, 24)}`
}

function verifyGeneration(
  directory: string,
  binding: RootBinding,
  maxSchemaVersion: number
): RecoveryGeneration {
  const directoryStat = fs.lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('recovery generation path is not a real directory')
  }
  const manifest = parseManifest(directory)
  const marker = parseVerified(directory)
  const manifestBytes = fs.readFileSync(path.join(directory, MANIFEST_FILE))
  if (
    manifest.rootId !== binding.rootId ||
    manifest.journalId !== binding.activeJournalId ||
    marker.rootId !== manifest.rootId ||
    marker.journalId !== manifest.journalId ||
    marker.generation !== manifest.generation ||
    marker.manifestSha256 !== sha256(manifestBytes) ||
    marker.databaseSha256 !== manifest.databaseSha256
  ) {
    throw new Error('recovery generation ownership or verification binding does not match')
  }
  const snapshot = path.join(directory, SNAPSHOT_FILE)
  const stat = assertRegular(snapshot)
  if (stat.size.toString() !== manifest.databaseBytes) {
    throw new Error('recovery snapshot byte length does not match manifest')
  }
  if (sha256File(snapshot) !== manifest.databaseSha256) {
    throw new Error('recovery snapshot hash does not match manifest')
  }
  const inspection = inspectDatabase(snapshot, maxSchemaVersion)
  if (
    inspection.journalId !== manifest.journalId ||
    inspection.schemaVersion !== manifest.schemaVersion ||
    inspection.eventCount !== manifest.eventCount ||
    inspection.maxSeq !== manifest.maxSeq ||
    inspection.eventHighWater !== manifest.eventHighWater
  ) {
    throw new Error('recovery snapshot logical contents do not match manifest')
  }
  return { directory, manifest }
}

function scanRecoveryCandidates(dataDir: string): Array<{
  directory: string
  manifest: RecoveryManifest
}> {
  const paths = recoveryPaths(dataDir)
  let entries: string[]
  try {
    entries = boundedEntries(
      paths.generations,
      MAX_GENERATION_ENTRIES,
      'recovery generations'
    )
  } catch (error) {
    if (code(error) === 'ENOENT') return []
    throw error
  }
  const candidates: Array<{ directory: string; manifest: RecoveryManifest }> = []
  const ordinals = new Set<string>()
  const namedOrdinals = new Set<string>()
  for (const entry of entries) {
    const match = /^g-([0-9]{20})-[0-9a-f]{24}$/.exec(entry)
    if (!match) continue
    const ordinal = BigInt(match[1]!).toString()
    if (namedOrdinals.has(ordinal)) {
      throw new Error(`ambiguous recovery generation ordinal ${ordinal}`)
    }
    namedOrdinals.add(ordinal)
  }
  for (const entry of entries) {
    const directory = path.join(paths.generations, entry)
    let manifest: RecoveryManifest
    try {
      manifest = parseManifest(directory)
    } catch {
      continue
    }
    if (ordinals.has(manifest.generation)) {
      throw new Error(`ambiguous recovery generation ordinal ${manifest.generation}`)
    }
    ordinals.add(manifest.generation)
    candidates.push({ directory, manifest })
  }
  candidates.sort((left, right) => {
    const a = BigInt(left.manifest.generation)
    const b = BigInt(right.manifest.generation)
    return a === b ? 0 : a > b ? -1 : 1
  })
  return candidates
}

export function listRecoveryGenerations(
  dataDir: string,
  maxSchemaVersion: number
): RecoveryGeneration[] {
  const binding = parseRootBinding(recoveryPaths(dataDir).rootBinding)
  const candidates = scanRecoveryCandidates(dataDir)
  for (const candidate of candidates) {
    if (BigInt(candidate.manifest.generation) >= BigInt(binding.nextGeneration)) {
      throw new Error(
        `recovery generation ${candidate.manifest.generation} is not below reserved authority ${binding.nextGeneration}`
      )
    }
  }
  const generations: RecoveryGeneration[] = []
  for (const candidate of candidates) {
    try {
      generations.push(verifyGeneration(candidate.directory, binding, maxSchemaVersion))
    } catch {
      // Explicit inspection API reports only independently valid generations.
    }
  }
  return generations
}

export type StrongRecoverySnapshotCoverage = {
  rootId: string
  journalId: string
  generation: string
  manifestSha256: string
  snapshotMaxSeq: string
  snapshotEventHighWater: string
  deleteThroughSeq: string
}

export type StrongRecoverySnapshotClaim = {
  rootId: string
  journalId: string
  generation: string
  snapshotMaxSeq: string
  snapshotEventHighWater: string
}

/**
 * Cheap, read-only upper-bound hint from the newest canonical recovery manifest. This is deliberately a
 * CLAIM, not deletion authority: maintenance may use it only to avoid hashing a multi-gigabyte generation
 * when no eligible row falls beneath the claimed frontier. Any actual delete still goes through
 * {@link verifyStrongRecoverySnapshotCoverage}, which verifies the snapshot bytes and logical contents.
 */
export function newestStrongRecoverySnapshotClaim(options: {
  dataDir: string
  journalPath: string
}): StrongRecoverySnapshotClaim {
  const dataDir = path.resolve(options.dataDir)
  const journalPath = path.resolve(options.journalPath)
  if (path.dirname(journalPath) !== dataDir || path.basename(journalPath) !== 'hub.db') {
    throw new Error('strong recovery claim requires the exact data-root hub.db path')
  }
  const binding = parseRootBinding(recoveryPaths(dataDir).rootBinding)
  const newest = scanRecoveryCandidates(dataDir)[0]
  if (!newest) throw new Error('no strong recovery generation covers compaction')
  if (BigInt(newest.manifest.generation) >= BigInt(binding.nextGeneration)) {
    throw new Error('newest recovery generation exceeds reserved generation authority')
  }
  if (
    newest.manifest.rootId !== binding.rootId ||
    newest.manifest.journalId !== binding.activeJournalId
  ) {
    throw new Error('newest recovery generation does not belong to the active journal')
  }
  return {
    rootId: binding.rootId,
    journalId: binding.activeJournalId,
    generation: newest.manifest.generation,
    snapshotMaxSeq: newest.manifest.maxSeq,
    snapshotEventHighWater: newest.manifest.eventHighWater,
  }
}

/**
 * Read-only compaction gate. Only the newest canonical strong generation may cover deletion; an
 * invalid newest generation fails closed instead of falling back. Legacy flat backups, filenames,
 * mtimes, and quick_check results are never consulted.
 */
export function verifyStrongRecoverySnapshotCoverage(options: {
  dataDir: string
  journalPath: string
  maxSchemaVersion: number
  deleteThroughSeq: string
}): StrongRecoverySnapshotCoverage {
  const dataDir = path.resolve(options.dataDir)
  const journalPath = path.resolve(options.journalPath)
  if (path.dirname(journalPath) !== dataDir || path.basename(journalPath) !== 'hub.db') {
    throw new Error('strong recovery coverage requires the exact data-root hub.db path')
  }
  decimal(options.deleteThroughSeq, 'prospective compaction delete frontier')
  const binding = parseRootBinding(recoveryPaths(dataDir).rootBinding)
  const candidates = scanRecoveryCandidates(dataDir)
  const newest = candidates[0]
  if (!newest) throw new Error('no strong recovery generation covers compaction')
  if (BigInt(newest.manifest.generation) >= BigInt(binding.nextGeneration)) {
    throw new Error('newest recovery generation exceeds reserved generation authority')
  }
  const generation = verifyGeneration(newest.directory, binding, options.maxSchemaVersion)
  const frontier = BigInt(options.deleteThroughSeq)
  if (
    BigInt(generation.manifest.maxSeq) < frontier ||
    BigInt(generation.manifest.eventHighWater) < frontier
  ) {
    throw new Error('newest strong recovery generation does not cover the delete frontier')
  }
  return {
    rootId: binding.rootId,
    journalId: binding.activeJournalId,
    generation: generation.manifest.generation,
    manifestSha256: sha256File(path.join(generation.directory, MANIFEST_FILE)),
    snapshotMaxSeq: generation.manifest.maxSeq,
    snapshotEventHighWater: generation.manifest.eventHighWater,
    deleteThroughSeq: options.deleteThroughSeq,
  }
}

function selectRecoveryGeneration(
  dataDir: string,
  maxSchemaVersion: number
): RecoveryGeneration | undefined {
  const binding = parseRootBinding(recoveryPaths(dataDir).rootBinding)
  const candidates = scanRecoveryCandidates(dataDir)
  for (const candidate of candidates) {
    if (BigInt(candidate.manifest.generation) >= BigInt(binding.nextGeneration)) {
      throw new Error(
        `recovery generation ${candidate.manifest.generation} is not below reserved authority ${binding.nextGeneration}`
      )
    }
  }
  for (const candidate of candidates) {
    try {
      return verifyGeneration(candidate.directory, binding, maxSchemaVersion)
    } catch {
      // Offline selection records no authority from the filename/manifest alone and falls back.
    }
  }
  return undefined
}

function publishedRecoveryHeads(dataDir: string, binding: RootBinding): RecoveryHead[] {
  const heads: RecoveryHead[] = []
  for (const candidate of scanRecoveryCandidates(dataDir)) {
    if (BigInt(candidate.manifest.generation) >= BigInt(binding.nextGeneration)) {
      throw new Error(
        `recovery generation ${candidate.manifest.generation} is not below reserved authority ${binding.nextGeneration}`
      )
    }
    try {
      const marker = parseVerified(candidate.directory)
      const manifestSha256 = sha256(
        fs.readFileSync(path.join(candidate.directory, MANIFEST_FILE))
      )
      if (
        candidate.manifest.rootId !== binding.rootId ||
        candidate.manifest.journalId !== binding.activeJournalId ||
        marker.rootId !== candidate.manifest.rootId ||
        marker.journalId !== candidate.manifest.journalId ||
        marker.generation !== candidate.manifest.generation ||
        marker.manifestSha256 !== manifestSha256 ||
        marker.databaseSha256 !== candidate.manifest.databaseSha256
      ) {
        continue
      }
      heads.push({
        format: FORMAT,
        rootId: candidate.manifest.rootId,
        journalId: candidate.manifest.journalId,
        generation: candidate.manifest.generation,
        eventHighWater: candidate.manifest.eventHighWater,
        manifestSha256,
      })
    } catch {
      // A partial/invalid generation is evidence, not lineage authority.
    }
  }
  return heads
}

function assertRecoveryTransitionReceipt(
  dataDir: string,
  binding: RootBinding,
  active: RecoveryHead
): NonNullable<RootBinding['recoveryTransition']> {
  const transition = binding.recoveryTransition
  if (
    !transition ||
    transition.restoredGeneration !== active.generation ||
    !transition.receiptSha256
  ) {
    throw new Error(
      'active recovery generation lacks an immutable completed recovery transition'
    )
  }
  const receiptFile = path.join(
    recoveryPaths(dataDir).receipts,
    `${transition.planId}.json`
  )
  assertRegular(receiptFile, true)
  const receipt = readReceipt(receiptFile)
  if (
    sha256File(receiptFile) !== transition.receiptSha256 ||
    receipt.planId !== transition.planId ||
    receipt.rootId !== binding.rootId ||
    receipt.journalId !== binding.activeJournalId ||
    receipt.generation !== active.generation ||
    receipt.previousActiveGeneration !== transition.previousGeneration ||
    receipt.previousActiveManifestSha256 !== transition.previousManifestSha256
  ) {
    throw new Error(
      'active recovery generation conflicts with its immutable recovery receipt'
    )
  }
  return transition
}

function assertCompletedRecoveryTransition(
  dataDir: string,
  binding: RootBinding,
  active: RecoveryHead,
  highest: RecoveryHead
): void {
  const transition = assertRecoveryTransitionReceipt(dataDir, binding, active)
  if (
    transition.previousGeneration !== highest.generation ||
    transition.previousManifestSha256 !== highest.manifestSha256
  ) {
    throw new Error(
      'lower active recovery generation conflicts with its completed recovery predecessor'
    )
  }
}

function controllingPublishedHead(
  dataDir: string,
  binding: RootBinding
): RecoveryHead | undefined {
  const heads = publishedRecoveryHeads(dataDir, binding)
  const highest = heads[0]
  if (binding.activeGeneration === undefined) return highest
  const active = heads.find((head) => head.generation === binding.activeGeneration)
  if (!active) {
    throw new Error(
      `active recovery generation ${binding.activeGeneration} is not a published verified generation`
    )
  }
  if (highest && BigInt(active.generation) < BigInt(highest.generation)) {
    assertCompletedRecoveryTransition(dataDir, binding, active, highest)
  }
  return active
}

/**
 * Classifier/generation copies in staging are derived, unpublished bytes. With no durable active plan
 * they own no authority and must not turn a later healthy boot into a different permanent refusal.
 * Delete only the exact names and path types this module creates; unknown evidence remains untouched.
 */
function reconcileInterruptedRecoveryStaging(
  paths: RecoveryPaths,
  mutate = false
): void {
  if (
    lstatState(paths.activePlan).state === 'present' ||
    lstatState(paths.staging).state === 'missing'
  ) {
    return
  }
  const stagingState = lstatState(paths.staging)
  if (
    stagingState.state !== 'present' ||
    !stagingState.stat.isDirectory() ||
    stagingState.stat.isSymbolicLink()
  ) {
    throw new Error('recovery staging is not a real directory')
  }
  let removed = false
  for (const entry of boundedEntries(paths.staging, MAX_STAGING_ENTRIES, 'recovery staging')) {
    const classifier = /^\.classifier-([0-9a-f-]{36})$/i.exec(entry)
    const generation = /^\.generation-(?:0|[1-9][0-9]*)-[0-9]+-([0-9a-f-]{36})$/i.exec(entry)
    const restore = /^([0-9a-f-]{36})\.db(?:\.partial)?$/i.exec(entry)
    if (!classifier && !generation && !restore) continue
    const operationId = (classifier ?? generation ?? restore)?.[1]
    if (!operationId || !SAFE_UUID.test(operationId)) continue
    if (!mutate) {
      throw new Error(
        'interrupted recovery staging requires exclusive supervisor reconciliation'
      )
    }
    const target = path.join(paths.staging, entry)
    const state = lstatState(target)
    if (state.state !== 'present') continue
    if (classifier || generation) {
      if (!state.stat.isDirectory() || state.stat.isSymbolicLink()) {
        throw new Error(`interrupted recovery staging path is not a real directory: ${entry}`)
      }
      fs.rmSync(target, { recursive: true, force: true })
    } else {
      assertRegular(target, true)
      fs.unlinkSync(target)
    }
    removed = true
  }
  if (removed) syncDirectory(paths.staging)
}

function headForGeneration(generation: RecoveryGeneration): RecoveryHead {
  return {
    format: FORMAT,
    rootId: generation.manifest.rootId,
    journalId: generation.manifest.journalId,
    generation: generation.manifest.generation,
    eventHighWater: generation.manifest.eventHighWater,
    manifestSha256: sha256File(path.join(generation.directory, MANIFEST_FILE)),
  }
}

function sameHead(left: RecoveryHead, right: RecoveryHead): boolean {
  return (
    left.rootId === right.rootId &&
    left.journalId === right.journalId &&
    left.generation === right.generation &&
    left.eventHighWater === right.eventHighWater &&
    left.manifestSha256 === right.manifestSha256
  )
}

/**
 * A generation directory is immutable evidence first and becomes controlling state only through the
 * atomic root.json pointer. A crash can necessarily land after the immutable directory is durable but
 * before that one-file activation. On boot, independently verify and adopt that candidate. Invalid
 * unactivated candidates are disposable failed publications; an active or completed-rollback member is
 * never deleted here. head.json is derived display/diagnostic metadata and is rebuilt from root.json.
 */
function reconcilePublishedGenerationActivation(
  dataDir: string,
  binding: RootBinding,
  maxSchemaVersion: number,
  mutate = false
): { binding: RootBinding; head?: RecoveryHead } {
  const paths = recoveryPaths(dataDir)
  const activeOrdinal = binding.activeGeneration === undefined
    ? undefined
    : BigInt(binding.activeGeneration)
  let removed = false
  const generationEntries = lstatState(paths.generations).state === 'missing'
    ? []
    : boundedEntries(
        paths.generations,
        MAX_GENERATION_ENTRIES,
        'recovery generations'
      )
  for (const entry of generationEntries) {
    const match = /^g-([0-9]{20})-[0-9a-f]{24}$/.exec(entry)
    if (!match) continue
    const ordinal = BigInt(match[1]!).toString()
    if (BigInt(ordinal) >= BigInt(binding.nextGeneration)) {
      throw new Error(
        `recovery generation ${ordinal} is not below reserved authority ${binding.nextGeneration}`
      )
    }
    if (activeOrdinal !== undefined && BigInt(ordinal) <= activeOrdinal) continue
    if (binding.recoveryTransition?.previousGeneration === ordinal) continue
    const directory = path.join(paths.generations, entry)
    try {
      verifyGeneration(directory, binding, maxSchemaVersion)
    } catch {
      if (!mutate) {
        throw new Error(
          `unactivated recovery generation ${ordinal} requires exclusive supervisor reconciliation`
        )
      }
      const state = lstatState(directory)
      if (
        state.state !== 'present' ||
        !state.stat.isDirectory() ||
        state.stat.isSymbolicLink()
      ) {
        throw new Error(`invalid unactivated recovery generation is not a real directory: ${entry}`)
      }
      fs.rmSync(directory, { recursive: true, force: true })
      removed = true
    }
  }
  if (removed) syncDirectory(paths.generations)

  let nextBinding = binding
  const heads = publishedRecoveryHeads(dataDir, nextBinding)
  const highest = heads[0]
  const active = nextBinding.activeGeneration === undefined
    ? undefined
    : heads.find((candidate) => candidate.generation === nextBinding.activeGeneration)
  if (nextBinding.activeGeneration !== undefined && !active) {
    throw new Error(
      `active recovery generation ${nextBinding.activeGeneration} is not a published verified generation`
    )
  }

  let adopt = nextBinding.activeGeneration === undefined ? highest : undefined
  if (
    active &&
    highest &&
    BigInt(active.generation) < BigInt(highest.generation)
  ) {
    const transition = nextBinding.recoveryTransition
    if (!transition) {
      adopt = highest
    } else {
      // A completed rollback intentionally leaves the active generation below the generation it
      // replaced. Validate that immutable decision against its named predecessor first. Only a still
      // newer verified generation can be an interrupted publication awaiting adoption; a missing or
      // damaged rollback receipt must remain an offline condition, never an excuse to reactivate the
      // generation the operator just recovered away from.
      assertRecoveryTransitionReceipt(dataDir, nextBinding, active)
      const priorOrdinal = BigInt(transition.previousGeneration)
      const highestOrdinal = BigInt(highest.generation)
      if (highestOrdinal === priorOrdinal) {
        assertCompletedRecoveryTransition(dataDir, nextBinding, active, highest)
      } else if (highestOrdinal > priorOrdinal) {
        adopt = highest
      }
    }
  }
  if (adopt) {
    if (!mutate) {
      throw new Error(
        `published recovery generation ${adopt.generation} requires exclusive activation reconciliation`
      )
    }
    const candidate = scanRecoveryCandidates(dataDir).find(
      (item) => item.manifest.generation === adopt!.generation
    )
    if (!candidate) throw new Error('published activation candidate disappeared')
    const verified = verifyGeneration(candidate.directory, nextBinding, maxSchemaVersion)
    const verifiedHead = headForGeneration(verified)
    if (!sameHead(verifiedHead, adopt)) {
      throw new Error('published activation candidate changed during verification')
    }
    nextBinding = {
      ...nextBinding,
      activeGeneration: verified.manifest.generation,
      recoveryTransition: undefined,
    }
    writeJsonAtomic(paths.rootBinding, nextBinding)
  }

  const controlling = controllingPublishedHead(dataDir, nextBinding)
  if (controlling) {
    let matches = false
    const state = lstatState(paths.head)
    if (state.state === 'present') {
      if (!state.stat.isFile() || state.stat.isSymbolicLink()) {
        throw new Error('recovery head is not a regular metadata file')
      }
      try {
        matches = sameHead(parseHead(paths.head), controlling)
      } catch {
        matches = false
      }
    }
    if (!matches) {
      // head.json is explicitly non-authoritative derived metadata. Rebuilding it does not activate a
      // generation or authorize recovery bytes, so it may be repaired during ordinary shared-owner
      // preflight. Every writer derives the same immutable head from root.json plus verified manifests.
      writeJsonAtomic(paths.head, controlling)
    }
  } else if (lstatState(paths.head).state === 'present') {
    // Likewise, an orphaned display/index head can be removed without changing lineage authority.
    assertRegular(paths.head, true)
    fs.unlinkSync(paths.head)
    syncDirectory(paths.root)
  }
  return { binding: nextBinding, head: controlling }
}

export function verifyNormalJournalLineage(options: {
  dataDir: string
  journalPath: string
  maxSchemaVersion: number
  openReadonly?: (file: string) => Database.Database
}): PreflightFailure | undefined {
  const paths = recoveryPaths(options.dataDir)
  try {
    const rootState = lstatState(paths.root)
    if (rootState.state === 'present') {
      if (!rootState.stat.isDirectory() || rootState.stat.isSymbolicLink()) {
        throw new Error('recovery namespace is not a real directory')
      }
      reconcileUnpublishedJsonPartial(paths.rootBinding)
      reconcileUnpublishedJsonPartial(paths.enrollmentIntent)
      reconcileUnpublishedJsonPartial(paths.activePlan)
      if (lstatState(paths.activePlan).state === 'present') {
        return {
          code: 'database-validation-unavailable',
          message: 'A journal recovery plan is still active and requires exclusive supervisor resume.',
          recovery:
            'Keep the hub offline. The supervisor must resume the exact durable recovery plan before any writable Journal opens.',
        }
      }
      if (
        path.resolve(options.journalPath) === path.join(path.resolve(options.dataDir), 'hub.db') &&
        lstatState(paths.staging).state === 'present'
      ) {
        reconcileInterruptedRecoveryStaging(paths)
      }
    }
    if (lstatState(paths.rootBinding).state === 'missing') {
      let priorIdentity = false
      let journalIdentity: string | undefined
      let identityDb: Database.Database | undefined
      try {
        const journalState = lstatState(options.journalPath)
        if (journalState.state === 'present') {
          identityDb =
            options.openReadonly?.(options.journalPath) ??
            new Database(options.journalPath, { readonly: true, fileMustExist: true })
          identityDb.pragma('query_only = ON')
          priorIdentity =
            (
              identityDb
                .prepare(
                  `SELECT COUNT(*) AS count
                   FROM sqlite_master
                   WHERE type = 'table' AND name = 'journal_recovery_identity'`
                )
                .get() as { count?: unknown } | undefined
            )?.count === 1
          if (priorIdentity) journalIdentity = readJournalIdentity(identityDb)
        }
      } finally {
        identityDb?.close()
      }
      const intent =
        rootState.state === 'present' &&
        lstatState(paths.enrollmentIntent).state === 'present'
          ? parseEnrollmentIntent(paths.enrollmentIntent)
          : undefined
      if (intent) {
        const ownership = assertRegular(paths.leaseDb, true)
        if (
          intent.ownershipDatabase.dev !== ownership.dev.toString() ||
          intent.ownershipDatabase.ino !== ownership.ino.toString() ||
          (journalIdentity !== undefined && journalIdentity !== intent.journalId)
        ) {
          throw new Error('incomplete recovery enrollment intent no longer matches its bound state')
        }
      }
      if (
        (priorIdentity && !intent) ||
        (rootState.state === 'present' && hasPriorRecoveryNamespaceHistory(paths))
      ) {
        throw new Error('root binding is missing despite prior recovery enrollment history')
      }
      return undefined
    }
  } catch (error) {
    return {
      code: 'database-validation-unavailable',
      message: `Recovery lineage metadata could not be conclusively verified: ${text(error)}`,
      recovery:
        'Keep the data root offline. Repair or independently verify the recovery metadata before restart.',
    }
  }
  let binding: RootBinding
  let head: RecoveryHead | undefined
  try {
    binding = parseRootBinding(paths.rootBinding)
    const reconciled = reconcilePublishedGenerationActivation(
      options.dataDir,
      binding,
      options.maxSchemaVersion
    )
    binding = reconciled.binding
    head = reconciled.head
  } catch (error) {
    return {
      code: 'database-validation-unavailable',
      message: `Recovery lineage metadata could not be conclusively verified: ${text(error)}`,
      recovery:
        'Keep the data root offline. Repair or independently verify the recovery metadata before restart.',
    }
  }
  let db: Database.Database | undefined
  let result: PreflightFailure | undefined
  try {
    db =
      options.openReadonly?.(options.journalPath) ??
      new Database(options.journalPath, { readonly: true, fileMustExist: true })
    db.pragma('query_only = ON')
    const journalId = readJournalIdentity(db)
    const current = db
      .prepare(
        `SELECT CAST(COUNT(*) AS TEXT) AS eventCount,
                CAST(COALESCE(MAX(seq), 0) AS TEXT) AS maxSeq,
                CAST(COALESCE(
                  (SELECT seq FROM sqlite_sequence WHERE name = 'events'),
                  0
                ) AS TEXT) AS eventHighWater
         FROM events`
      )
      .get() as
      | { eventCount?: unknown; maxSeq?: unknown; eventHighWater?: unknown }
      | undefined
    decimal(current?.eventCount, 'live event count')
    const maxSeq = decimal(current?.maxSeq, 'live max sequence')
    const eventHighWater = decimal(current?.eventHighWater, 'live event high-water')
    if (BigInt(eventHighWater) < BigInt(maxSeq)) {
      throw new Error('live event high-water is below an existing event sequence')
    }
    if (journalId !== binding.activeJournalId) {
      result = {
        code: 'database-lineage-invalid',
        message: 'The journal identity does not match this data root.',
        recovery:
          'The current journal is foreign to this root. Keep it offline for explicit operator reconciliation; automatic overwrite is forbidden.',
      }
    } else if (
      head !== undefined &&
      BigInt(eventHighWater) < BigInt(head.eventHighWater)
    ) {
      result = {
        code: 'database-lineage-invalid',
        message: `The journal regressed below owned event high-water generation ${head.generation}.`,
        recovery:
          'Keep the current SQLite family as evidence. The supervisor may restore only a verified generation from this exact root and journal lineage.',
        recoveryCause: 'lineage-rollback',
      }
    }
  } catch (error) {
    result = {
      code: 'database-validation-unavailable',
      message: `The journal recovery identity/high-water check was unavailable: ${text(error)}`,
      recovery:
        'Keep the data root offline. Resolve the SQLite or recovery-metadata error and restart AllMyAgents.',
    }
  }
  try {
    db?.close()
  } catch (error) {
    result = {
      code: 'database-validation-unavailable',
      message: `The journal recovery identity/high-water handle could not be closed: ${text(error)}`,
      recovery:
        'Keep the data root offline until the validating process exits and the OS releases the uncertain handle.',
    }
  }
  return result
}

export function publishRecoveryGeneration(options: {
  dataDir: string
  snapshotFile: string
  maxSchemaVersion: number
  keep?: number
  maxRetainedBytes?: number
  failpoint?: (edge: string, target?: string) => void
}): RecoveryGeneration {
  const dataDir = path.resolve(options.dataDir)
  const rootRealPath = assertRootStable(dataDir)
  const paths = ensureRecoveryOperationDirectories(dataDir)
  assertRecoveryEvidenceQuota(paths, [], MAX_QUARANTINE_BYTES, {
    generations: 1,
    staging: 1,
  })
  const inspection = inspectDatabase(options.snapshotFile, options.maxSchemaVersion)
  const priorBinding = parseRootBinding(paths.rootBinding)
  const priorHead = controllingPublishedHead(dataDir, priorBinding)
  if (
    priorHead &&
    BigInt(inspection.eventHighWater) < BigInt(priorHead.eventHighWater)
  ) {
    throw new Error(
      `recovery snapshot event high-water ${inspection.eventHighWater} regressed below published generation ${priorHead.generation} high-water ${priorHead.eventHighWater}`
    )
  }
  const reserved = reserveGeneration(dataDir, inspection.journalId)
  const generation = reserved.generation
  const stagingDirectory = path.join(
    paths.staging,
    `.generation-${generation}-${process.pid}-${crypto.randomUUID()}`
  )
  fs.mkdirSync(stagingDirectory, { recursive: true })
  const stagingSnapshot = path.join(stagingDirectory, SNAPSHOT_FILE)
  try {
    assertRootStable(dataDir, rootRealPath)
    // Keep the compatibility flat path and strong generation as two directory entries for ONE inode.
    // This preserves the historical operator-visible backup without doubling multi-gigabyte retention.
    fs.linkSync(options.snapshotFile, stagingSnapshot)
    syncFile(stagingSnapshot)
    const copied = inspectDatabase(stagingSnapshot, options.maxSchemaVersion)
    removeOwnedInspectionSidecars(stagingSnapshot, stagingDirectory)
    if (
      copied.journalId !== inspection.journalId ||
      copied.schemaVersion !== inspection.schemaVersion ||
      copied.eventCount !== inspection.eventCount ||
      copied.maxSeq !== inspection.maxSeq ||
      copied.eventHighWater !== inspection.eventHighWater
    ) {
      throw new Error('copied recovery snapshot changed logical identity')
    }
    const stat = assertRegular(stagingSnapshot)
    const databaseSha256 = sha256File(stagingSnapshot)
    const manifest: RecoveryManifest = {
      format: FORMAT,
      rootId: reserved.binding.rootId,
      journalId: inspection.journalId,
      generation,
      createdAt: new Date().toISOString(),
      schemaVersion: inspection.schemaVersion,
      databaseBytes: stat.size.toString(),
      databaseSha256,
      eventCount: inspection.eventCount,
      maxSeq: inspection.maxSeq,
      eventHighWater: inspection.eventHighWater,
    }
    const manifestFile = path.join(stagingDirectory, MANIFEST_FILE)
    writeJsonExclusive(manifestFile, manifest)
    writeJsonExclusive(path.join(stagingDirectory, VERIFIED_FILE), {
      format: FORMAT,
      rootId: manifest.rootId,
      journalId: manifest.journalId,
      generation,
      manifestSha256: sha256(fs.readFileSync(manifestFile)),
      databaseSha256,
      verifiedAt: new Date().toISOString(),
    } satisfies VerifiedMarker)
    const finalDirectory = path.join(
      paths.generations,
      generationDirectoryName(generation, databaseSha256)
    )
    assertRootStable(dataDir, rootRealPath)
    options.failpoint?.('before-generation-publish', finalDirectory)
    fs.mkdirSync(finalDirectory)
    options.failpoint?.('after-generation-directory', finalDirectory)
    for (const entry of [SNAPSHOT_FILE, MANIFEST_FILE, VERIFIED_FILE]) {
      const source = path.join(stagingDirectory, entry)
      const target = path.join(finalDirectory, entry)
      if (lstatState(target).state === 'present') {
        throw new Error(`recovery generation publication target already contains ${entry}`)
      }
      fs.renameSync(source, target)
      options.failpoint?.(`after-generation-member-${entry}`, finalDirectory)
    }
    syncDirectory(finalDirectory)
    const stagingBarrier = path.join(stagingDirectory, '.ama-directory-barrier')
    if (lstatState(stagingBarrier).state === 'present') {
      assertRegular(stagingBarrier, true)
      fs.unlinkSync(stagingBarrier)
    }
    const stagingRemainder = fs.readdirSync(stagingDirectory)
    if (stagingRemainder.length > 0) {
      throw new Error(
        `recovery generation staging retained unexpected entries: ${stagingRemainder.join(', ')}`
      )
    }
    fs.rmdirSync(stagingDirectory)
    syncDirectory(paths.staging)
    syncDirectory(paths.generations)
    const verified = verifyGeneration(
      finalDirectory,
      parseRootBinding(paths.rootBinding),
      options.maxSchemaVersion
    )
    removeOwnedInspectionSidecars(
      path.join(finalDirectory, SNAPSHOT_FILE),
      finalDirectory
    )
    options.failpoint?.('after-generation-publication-before-activation', finalDirectory)
    writeJsonAtomic(paths.rootBinding, {
      ...parseRootBinding(paths.rootBinding),
      activeGeneration: verified.manifest.generation,
      recoveryTransition: undefined,
    } satisfies RootBinding)
    writeJsonAtomic(paths.head, {
      format: FORMAT,
      rootId: verified.manifest.rootId,
      journalId: verified.manifest.journalId,
      generation: verified.manifest.generation,
      eventHighWater: verified.manifest.eventHighWater,
      manifestSha256: sha256(fs.readFileSync(path.join(finalDirectory, MANIFEST_FILE))),
    } satisfies RecoveryHead)
    rotateRecoveryGenerations(
      dataDir,
      options.keep ?? 6,
      options.maxSchemaVersion,
      options.maxRetainedBytes,
    )
    return verified
  } catch (error) {
    try {
      fs.rmSync(stagingDirectory, { recursive: true, force: true })
    } catch {
      /* preserve the generation failure */
    }
    throw error
  }
}

function rotateRecoveryGenerations(
  dataDir: string,
  keep: number,
  _maxSchemaVersion: number,
  maxRetainedBytes?: number,
): void {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('recovery retention must be positive')
  if (
    maxRetainedBytes !== undefined &&
    (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 0)
  ) {
    throw new Error('recovery byte retention must be a non-negative safe integer')
  }
  const paths = recoveryPaths(dataDir)
  const entries = fs.readdirSync(paths.generations)
  const generations = scanRecoveryCandidates(dataDir)
  if (entries.length > keep + 2 && entries.length > generations.length) {
    throw new Error(
      `recovery generation evidence exceeds bounded retention (${entries.length} entries, ${generations.length} canonical)`
    )
  }
  let retainedBytes = generations.reduce(
    (total, generation) => total + BigInt(generation.manifest.databaseBytes),
    0n,
  )
  const byteLimit = maxRetainedBytes === undefined
    ? undefined
    : BigInt(maxRetainedBytes)
  // Newest first. Always retain at least the newest independently verified generation, even when one
  // snapshot alone exceeds the byte target. Backup and recovery entries are hard links in the normal
  // path, so applying the same byte budget to both directories bounds UNIQUE snapshot data instead of
  // letting two count-only policies multiply a growing journal by twelve.
  while (
    generations.length > 1 &&
    (generations.length > keep || (byteLimit !== undefined && retainedBytes > byteLimit))
  ) {
    const generation = generations.at(-1)
    if (!generation) break
    try {
      fs.rmSync(generation.directory, { recursive: true })
      syncDirectory(path.dirname(generation.directory))
      generations.pop()
      retainedBytes -= BigInt(generation.manifest.databaseBytes)
    } catch (error) {
      // A bounded maintenance reader may still have a legacy WAL-mode snapshot's zero-byte sidecar
      // mapped on Windows. The newly published generation is already verified and authoritative; defer
      // oldest-first retention to the next snapshot instead of falsely degrading that publication.
      // Quotas still fail closed before a later publication can exceed the evidence bound.
      if (code(error) === 'EBUSY' || code(error) === 'EPERM') break
      throw error
    }
  }
}

/**
 * Post-ready, idempotent retention for upgrade cleanup. This examines only signed manifest metadata;
 * it deliberately does not hash or integrity-check each multi-gigabyte snapshot merely to remove an
 * older superseded generation. The newest published generation is always retained.
 */
export function pruneRecoveryGenerations(
  dataDir: string,
  keep = 2,
  maxRetainedBytes = 4 * 1024 * 1024 * 1024,
): void {
  const paths = recoveryPaths(dataDir)
  if (!fs.existsSync(paths.generations)) return
  rotateRecoveryGenerations(dataDir, keep, 0, maxRetainedBytes)
}

export class JournalRecoveryLease {
  private readonly paths: RecoveryPaths
  private db: Database.Database | undefined
  private openedIdentity: { dev: string; ino: string } | undefined
  private mode: 'none' | 'shared' | 'exclusive' = 'none'

  constructor(dataDir: string) {
    this.paths = recoveryPaths(dataDir)
  }

  private assertPathMapsToOpenedDatabase(): void {
    const opened = this.openedIdentity
    if (!opened) throw new Error('recovery ownership database is not open')
    const current = assertRegular(this.paths.leaseDb, true)
    if (current.dev.toString() !== opened.dev || current.ino.toString() !== opened.ino) {
      throw new Error('recovery ownership database path identity changed')
    }
    const bindingState = lstatState(this.paths.rootBinding)
    if (bindingState.state === 'present') {
      const binding = parseRootBinding(this.paths.rootBinding)
      if (
        binding.ownershipDatabase.dev !== opened.dev ||
        binding.ownershipDatabase.ino !== opened.ino
      ) {
        throw new Error('recovery ownership database differs from the bound data-root identity')
      }
    }
  }

  private open(): Database.Database {
    if (this.db) return this.db
    ensureRecoveryRoot(path.dirname(this.paths.root))
    const initializing = lstatState(this.paths.leaseDb).state === 'missing'
    if (!initializing) assertRegular(this.paths.leaseDb, true)
    const db = new Database(this.paths.leaseDb)
    try {
      const openedIdentity = assertRegular(this.paths.leaseDb, true)
      db.pragma('busy_timeout = 0')
      const journalMode = String(
        db.pragma(initializing ? 'journal_mode = DELETE' : 'journal_mode', { simple: true })
      ).toLowerCase()
      if (journalMode !== 'delete') {
        throw new Error(`recovery ownership database refused DELETE journal mode (${journalMode})`)
      }
      db.pragma('synchronous = FULL')
      if (initializing) {
        db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE recovery_ownership_guard (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            format INTEGER NOT NULL CHECK (format = 1)
          );
          INSERT INTO recovery_ownership_guard (singleton, format) VALUES (1, 1);
          COMMIT;
        `)
      }
      const findings = (db.pragma('quick_check') as Array<Record<string, unknown>>).flatMap((row) =>
        Object.values(row).map(String)
      )
      if (findings.length !== 1 || findings[0]?.toLowerCase() !== 'ok') {
        throw new Error(`recovery ownership database failed quick_check: ${findings.join('; ')}`)
      }
      const guard = db
        .prepare('SELECT singleton, format FROM recovery_ownership_guard')
        .all() as Array<{ singleton?: unknown; format?: unknown }>
      if (
        guard.length !== 1 ||
        guard[0]?.singleton !== 1 ||
        guard[0]?.format !== 1
      ) {
        throw new Error('recovery ownership database guard is missing or malformed')
      }
      const recheckedIdentity = assertRegular(this.paths.leaseDb, true)
      if (
        openedIdentity.dev !== recheckedIdentity.dev ||
        openedIdentity.ino !== recheckedIdentity.ino
      ) {
        throw new Error('recovery ownership database identity changed while open')
      }
      this.openedIdentity = {
        dev: openedIdentity.dev.toString(),
        ino: openedIdentity.ino.toString(),
      }
      this.assertPathMapsToOpenedDatabase()
    } catch (error) {
      this.openedIdentity = undefined
      try {
        db.close()
      } catch {
        /* preserve the validation failure */
      }
      throw error
    }
    this.db = db
    return db
  }

  private beginShared(db: Database.Database): void {
    this.assertPathMapsToOpenedDatabase()
    db.exec('BEGIN')
    try {
      const guard = db
        .prepare('SELECT singleton, format FROM recovery_ownership_guard')
        .all() as Array<{ singleton?: unknown; format?: unknown }>
      if (
        guard.length !== 1 ||
        guard[0]?.singleton !== 1 ||
        guard[0]?.format !== 1
      ) {
        throw new Error('recovery ownership database guard is missing or malformed')
      }
      this.assertPathMapsToOpenedDatabase()
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* preserve the lock failure */
      }
      throw error
    }
  }

  acquireShared(): void {
    if (this.mode === 'shared' || this.mode === 'exclusive') return
    const db = this.open()
    this.beginShared(db)
    this.mode = 'shared'
  }

  acquireExclusive(): void {
    if (this.mode !== 'shared') {
      if (this.mode === 'exclusive') return
      throw new Error('shared journal ownership must be acquired first')
    }
    const db = this.open()
    this.assertPathMapsToOpenedDatabase()
    db.exec('COMMIT')
    this.mode = 'none'
    try {
      db.exec('BEGIN EXCLUSIVE')
      const guard = db
        .prepare('SELECT singleton, format FROM recovery_ownership_guard')
        .all() as Array<{ singleton?: unknown; format?: unknown }>
      if (
        guard.length !== 1 ||
        guard[0]?.singleton !== 1 ||
        guard[0]?.format !== 1
      ) {
        throw new Error('recovery ownership database guard is missing or malformed')
      }
      this.assertPathMapsToOpenedDatabase()
      this.mode = 'exclusive'
    } catch (error) {
      try {
        this.beginShared(db)
        this.mode = 'shared'
      } catch {
        this.mode = 'none'
      }
      throw new Error(`exclusive recovery ownership is blocked or unavailable: ${text(error)}`)
    }
  }

  downgradeToShared(): void {
    if (this.mode !== 'exclusive') return
    const db = this.open()
    db.exec('COMMIT')
    this.mode = 'none'
    this.beginShared(db)
    this.mode = 'shared'
  }

  assertExclusiveAuthority(): void {
    if (this.mode !== 'exclusive') {
      throw new Error('exclusive recovery ownership is required before journal-family mutation')
    }
    this.assertPathMapsToOpenedDatabase()
  }

  release(): void {
    const db = this.db
    if (!db) return
    try {
      if (this.mode !== 'none') db.exec('ROLLBACK')
      this.mode = 'none'
    } finally {
      db.close()
      this.db = undefined
      this.openedIdentity = undefined
    }
  }
}

export type KnownGoodJournalInspection = {
  journalPath: string
  sha256: string
  schemaVersion: number
  eventCount: string
  maxSeq: string
  eventHighWater: string
}

type KnownGoodAcceptanceIntent = {
  format: typeof FORMAT
  operationId: string
  sourceSha256: string
  rootId: string
  journalId: string
  reason: string
  archiveDirectory: string
  createdAt: string
}

function knownGoodAcceptanceIntentFile(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'journal-recovery-known-good-acceptance.json')
}

function inspectKnownGoodCandidate(
  journalPath: string,
  maxSchemaVersion: number
): KnownGoodJournalInspection {
  assertRegular(journalPath)
  let db: Database.Database | undefined
  try {
    db = new Database(journalPath, { fileMustExist: true })
    db.pragma('busy_timeout = 0')
    // The operator command holds the recovery lease exclusively. Fold an otherwise healthy WAL into the
    // main file so the confirmation digest names the complete accepted family, not just one member.
    db.pragma('wal_checkpoint(TRUNCATE)')
    const schemaVersion = safeInteger(
      db.pragma('user_version', { simple: true }),
      'journal schema version'
    )
    if (schemaVersion > maxSchemaVersion) {
      throw new Error(
        `journal schema v${schemaVersion} is newer than supported v${maxSchemaVersion}`
      )
    }
    const integrity = (db.pragma('integrity_check') as Array<Record<string, unknown>>).flatMap(
      (row) => Object.values(row).map(String)
    )
    if (integrity.length !== 1 || integrity[0]?.toLowerCase() !== 'ok') {
      throw new Error(`journal failed integrity_check: ${integrity.join('; ') || 'no result'}`)
    }
    const invalidPayload = db
      .prepare('SELECT seq FROM events WHERE json_valid(payload) = 0 ORDER BY seq LIMIT 1')
      .get() as { seq?: unknown } | undefined
    if (invalidPayload) {
      throw new Error(`journal contains invalid event JSON at seq ${String(invalidPayload.seq)}`)
    }
    const counts = db
      .prepare(
        `SELECT CAST(COUNT(*) AS TEXT) AS eventCount,
                CAST(COALESCE(MAX(seq), 0) AS TEXT) AS maxSeq,
                CAST(COALESCE(
                  (SELECT seq FROM sqlite_sequence WHERE name = 'events'),
                  0
                ) AS TEXT) AS eventHighWater
         FROM events`
      )
      .get() as Record<string, unknown> | undefined
    const eventCount = decimal(counts?.eventCount, 'journal event count')
    const maxSeq = decimal(counts?.maxSeq, 'journal max sequence')
    const eventHighWater = decimal(counts?.eventHighWater, 'journal event high-water')
    if (BigInt(eventHighWater) < BigInt(maxSeq)) {
      throw new Error('journal event high-water is below an existing event sequence')
    }
    db.close()
    db = undefined
    return {
      journalPath,
      sha256: sha256File(journalPath),
      schemaVersion,
      eventCount,
      maxSeq,
      eventHighWater,
    }
  } finally {
    db?.close()
  }
}

/**
 * Read-only in logical content (SQLite may checkpoint a WAL) and deliberately available while the normal
 * hub is offline. The returned digest is the confirmation token required by acceptKnownGoodJournal.
 */
export function inspectKnownGoodJournal(options: {
  dataDir: string
  journalPath: string
  maxSchemaVersion: number
}): KnownGoodJournalInspection {
  const dataDir = path.resolve(options.dataDir)
  const journalPath = path.resolve(options.journalPath)
  if (path.dirname(journalPath) !== dataDir || path.basename(journalPath) !== 'hub.db') {
    throw new Error('known-good inspection requires the exact data-root hub.db path')
  }
  const lease = new JournalRecoveryLease(dataDir)
  lease.acquireShared()
  try {
    lease.acquireExclusive()
    lease.assertExclusiveAuthority()
    return inspectKnownGoodCandidate(journalPath, options.maxSchemaVersion)
  } finally {
    lease.release()
  }
}

function parseKnownGoodAcceptanceIntent(file: string, dataDir: string): KnownGoodAcceptanceIntent {
  const raw = object(readJson(file))
  if (
    !raw ||
    raw.format !== FORMAT ||
    typeof raw.operationId !== 'string' ||
    !SAFE_UUID.test(raw.operationId) ||
    typeof raw.sourceSha256 !== 'string' ||
    !SHA256.test(raw.sourceSha256) ||
    typeof raw.rootId !== 'string' ||
    !SAFE_UUID.test(raw.rootId) ||
    typeof raw.journalId !== 'string' ||
    !SAFE_UUID.test(raw.journalId) ||
    typeof raw.reason !== 'string' ||
    !raw.reason ||
    raw.reason.length > 512 ||
    typeof raw.archiveDirectory !== 'string' ||
    typeof raw.createdAt !== 'string'
  ) {
    throw new Error('known-good acceptance intent is malformed')
  }
  timestamp(raw.createdAt, 'known-good acceptance creation time')
  const archiveDirectory = path.resolve(raw.archiveDirectory)
  if (
    path.dirname(archiveDirectory) !== dataDir ||
    !path.basename(archiveDirectory).startsWith('journal-recovery-operator-archive-')
  ) {
    throw new Error('known-good acceptance archive escaped the data root')
  }
  return { ...(raw as KnownGoodAcceptanceIntent), archiveDirectory }
}

function knownGoodDatabaseAcceptanceApplied(
  journalPath: string,
  intent: KnownGoodAcceptanceIntent
): boolean {
  let db: Database.Database | undefined
  try {
    db = new Database(journalPath, { readonly: true, fileMustExist: true })
    const identityTable = (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'journal_recovery_identity'`
        )
        .get() as { count?: unknown }
    ).count
    if (identityTable !== 1 || readJournalIdentity(db) !== intent.journalId) return false
    const events = db
      .prepare(
        `SELECT payload FROM events
         WHERE kind = 'journal/operator-known-good-accepted'
         ORDER BY seq DESC LIMIT 16`
      )
      .all() as Array<{ payload?: unknown }>
    return events.some((row) => {
      try {
        return object(JSON.parse(String(row.payload)))?.operationId === intent.operationId
      } catch {
        return false
      }
    })
  } catch {
    return false
  } finally {
    db?.close()
  }
}

/**
 * Explicit operator override for a healthy journal that predates identity-bound recovery metadata.
 * Existing recovery metadata is moved to a sibling evidence archive, never deleted. The current journal
 * is fully integrity/payload checked, its exact digest must match the operator's confirmation, and the
 * acceptance decision is appended to the journal in the same transaction that installs its new identity.
 */
export function acceptKnownGoodJournal(options: {
  dataDir: string
  journalPath: string
  maxSchemaVersion: number
  confirmSha256: string
  reason: string
  /** Crash-boundary injection for durability tests. */
  failpoint?: (edge: string) => void
}): KnownGoodJournalInspection & { operationId: string; archiveDirectory: string } {
  const dataDir = path.resolve(options.dataDir)
  const journalPath = path.resolve(options.journalPath)
  if (path.dirname(journalPath) !== dataDir || path.basename(journalPath) !== 'hub.db') {
    throw new Error('known-good acceptance requires the exact data-root hub.db path')
  }
  const confirmSha256 = options.confirmSha256.trim().toLowerCase()
  if (!SHA256.test(confirmSha256)) throw new Error('known-good confirmation SHA-256 is malformed')
  const reason = options.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512)
  if (!reason) throw new Error('known-good acceptance requires an operator reason')

  const lease = new JournalRecoveryLease(dataDir)
  lease.acquireShared()
  try {
    lease.acquireExclusive()
    lease.assertExclusiveAuthority()
    const paths = ensureRecoveryRoot(dataDir)
    const intentFile = knownGoodAcceptanceIntentFile(dataDir)
    let intent: KnownGoodAcceptanceIntent
    let inspection = inspectKnownGoodCandidate(journalPath, options.maxSchemaVersion)
    let databaseApplied = false
    const priorIntentState = lstatState(intentFile)
    if (priorIntentState.state === 'present') {
      intent = parseKnownGoodAcceptanceIntent(intentFile, dataDir)
      if (intent.sourceSha256 !== confirmSha256 || intent.reason !== reason) {
        throw new Error(
          'unfinished known-good acceptance requires its original SHA-256 confirmation and reason'
        )
      }
      databaseApplied = knownGoodDatabaseAcceptanceApplied(journalPath, intent)
      if (!databaseApplied && inspection.sha256 !== confirmSha256) {
        throw new Error('journal changed after the known-good acceptance intent was recorded')
      }
    } else {
      if (inspection.sha256 !== confirmSha256) {
        throw new Error(
          `known-good confirmation mismatch: journal is ${inspection.sha256}, not ${confirmSha256}`
        )
      }
      const operationId = crypto.randomUUID()
      intent = {
        format: FORMAT,
        operationId,
        sourceSha256: inspection.sha256,
        rootId: crypto.randomUUID(),
        journalId: crypto.randomUUID(),
        reason,
        archiveDirectory: path.join(
          dataDir,
          `journal-recovery-operator-archive-${new Date().toISOString().replace(/[:.]/g, '-')}-${operationId}`
        ),
        createdAt: new Date().toISOString(),
      }
      writeJsonExclusive(intentFile, intent)
    }
    const { operationId, archiveDirectory } = intent
    if (databaseApplied && lstatState(paths.rootBinding).state === 'present') {
      const binding = parseRootBinding(paths.rootBinding)
      if (binding.rootId !== intent.rootId || binding.activeJournalId !== intent.journalId) {
        throw new Error('known-good acceptance root binding conflicts with its durable intent')
      }
      ensureRecoveryOperationDirectories(dataDir)
      fs.rmSync(intentFile)
      syncDirectory(dataDir)
      const accepted = inspectDatabase(journalPath, options.maxSchemaVersion)
      return {
        ...inspection,
        sha256: intent.sourceSha256,
        schemaVersion: accepted.schemaVersion,
        eventCount: accepted.eventCount,
        maxSeq: accepted.maxSeq,
        eventHighWater: accepted.eventHighWater,
        operationId,
        archiveDirectory,
      }
    }
    if (lstatState(archiveDirectory).state === 'missing') fs.mkdirSync(archiveDirectory)
    syncDirectory(dataDir)

    const preservedInPlace = new Set(['.ama-directory-barrier', path.basename(paths.leaseDb)])
    for (const entry of fs.readdirSync(paths.root)) {
      if (preservedInPlace.has(entry)) continue
      const source = path.join(paths.root, entry)
      const target = path.join(archiveDirectory, entry)
      if (lstatState(target).state === 'present') {
        throw new Error(`known-good recovery archive contains a conflicting live entry: ${target}`)
      }
      fs.renameSync(source, target)
      // A crash can land between any two evidence moves. Flush each completed boundary so resume can
      // trust the directories it actually observes, then rebuild the manifest from that durable archive
      // rather than from this process's incomplete in-memory list.
      syncDirectory(paths.root)
      syncDirectory(archiveDirectory)
      options.failpoint?.(`after-known-good-archive-${entry}`)
    }
    const archiveManifest = path.join(archiveDirectory, 'operator-acceptance.json')
    if (lstatState(archiveManifest).state === 'missing') {
      const archivedEntries = fs
        .readdirSync(archiveDirectory)
        .filter(
          (entry) =>
            entry !== path.basename(archiveManifest) &&
            entry !== '.ama-directory-barrier',
        )
        .sort()
      writeJsonExclusive(archiveManifest, { ...intent, archivedEntries })
    }
    syncDirectory(paths.root)
    syncDirectory(archiveDirectory)

    if (!knownGoodDatabaseAcceptanceApplied(journalPath, intent)) {
      let db: Database.Database | undefined
      try {
        db = new Database(journalPath, { fileMustExist: true })
        db.pragma('busy_timeout = 0')
        const transaction = db.transaction(() => {
          db!.exec(`
            DROP TABLE IF EXISTS journal_recovery_identity;
            CREATE TABLE journal_recovery_identity (
              singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
              journal_id TEXT NOT NULL UNIQUE
            );
          `)
          db!
            .prepare(
              'INSERT INTO journal_recovery_identity (singleton, journal_id) VALUES (1, ?)'
            )
            .run(intent.journalId)
          db!
            .prepare('INSERT INTO events (ts, session, kind, payload) VALUES (?, NULL, ?, ?)')
            .run(
              new Date().toISOString(),
              'journal/operator-known-good-accepted',
              JSON.stringify({
                operationId,
                sourceSha256: intent.sourceSha256,
                reason,
                archiveDirectory,
              })
            )
        })
        transaction()
      } finally {
        db?.close()
      }
    }

    const ownership = assertRegular(paths.leaseDb, true)
    const expectedBinding = {
      format: FORMAT,
      rootId: intent.rootId,
      activeJournalId: intent.journalId,
      nextGeneration: '1',
      ownershipDatabase: {
        dev: ownership.dev.toString(),
        ino: ownership.ino.toString(),
      },
    } satisfies RootBinding
    if (lstatState(paths.rootBinding).state === 'missing') {
      writeJsonExclusive(paths.rootBinding, expectedBinding)
    } else {
      const actualBinding = parseRootBinding(paths.rootBinding)
      if (JSON.stringify(actualBinding) !== JSON.stringify(expectedBinding)) {
        throw new Error('known-good acceptance root binding conflicts with its durable intent')
      }
    }
    ensureRecoveryOperationDirectories(dataDir)
    fs.rmSync(intentFile)
    syncDirectory(dataDir)
    const accepted = inspectDatabase(journalPath, options.maxSchemaVersion)
    inspection = { ...inspection, sha256: intent.sourceSha256 }
    return {
      ...inspection,
      schemaVersion: accepted.schemaVersion,
      eventCount: accepted.eventCount,
      maxSeq: accepted.maxSeq,
      eventHighWater: accepted.eventHighWater,
      operationId,
      archiveDirectory,
    }
  } finally {
    lease.release()
  }
}

function fingerprint(
  name: (typeof SQLITE_FAMILY)[number],
  file: string,
  requireSingleLink: boolean
): FileFingerprint {
  const stat = assertRegular(file, requireSingleLink)
  return {
    name,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    sha256: sha256File(file),
  }
}

function sameFingerprint(file: string, expected: FileFingerprint): boolean {
  try {
    const actual = fingerprint(expected.name, file, false)
    return (
      actual.dev === expected.dev &&
      actual.ino === expected.ino &&
      actual.size === expected.size &&
      actual.mtimeNs === expected.mtimeNs &&
      actual.sha256 === expected.sha256
    )
  } catch {
    return false
  }
}

function captureFamily(dataDir: string, requireSingleLink = true): FileFingerprint[] {
  const family: FileFingerprint[] = []
  for (const name of SQLITE_FAMILY) {
    const file = path.join(dataDir, name)
    try {
      family.push(fingerprint(name, file, requireSingleLink))
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error
    }
  }
  return family
}

function assertLiveFamilyExactPlan(dataDir: string, plan: RecoveryPlan): void {
  const actual = captureFamily(dataDir)
  if (actual.length !== plan.family.length) {
    throw new Error('SQLite family exact set changed before recovery mutation')
  }
  const actualByName = new Map(actual.map((entry) => [entry.name, entry]))
  for (const planned of plan.family) {
    const entry = actualByName.get(planned.name)
    if (
      !entry ||
      entry.dev !== planned.dev ||
      entry.ino !== planned.ino ||
      entry.size !== planned.size ||
      entry.mtimeNs !== planned.mtimeNs ||
      entry.sha256 !== planned.sha256
    ) {
      throw new Error(`SQLite family changed before recovery mutation: ${planned.name}`)
    }
  }
}

function assertFamilyTransitionState(dataDir: string, plan: RecoveryPlan): void {
  const expected = new Map(plan.family.map((entry) => [entry.name, entry]))
  for (const actual of captureFamily(dataDir)) {
    const planned = expected.get(actual.name)
    if (
      !planned ||
      actual.dev !== planned.dev ||
      actual.ino !== planned.ino ||
      actual.size !== planned.size ||
      actual.mtimeNs !== planned.mtimeNs ||
      actual.sha256 !== planned.sha256
    ) {
      throw new Error(`SQLite family closure changed after classification: ${actual.name}`)
    }
  }
  for (const planned of plan.family) {
    const source = path.join(dataDir, planned.name)
    const quarantined = path.join(plan.quarantineDirectory, planned.name)
    if (!sameFingerprint(source, planned) && !sameFingerprint(quarantined, planned)) {
      throw new Error(`classified SQLite family member disappeared: ${planned.name}`)
    }
  }
}

function assertLiveFamilyEmpty(dataDir: string): void {
  const remaining = captureFamily(dataDir)
  if (remaining.length > 0) {
    throw new Error(`SQLite family reappeared before recovery publication: ${remaining[0]!.name}`)
  }
}

function parsePlan(file: string): RecoveryPlan {
  const raw = object(readJson(file))
  if (
    !raw ||
    raw.format !== FORMAT ||
    typeof raw.id !== 'string' ||
    !SAFE_UUID.test(raw.id) ||
    !['sqlite-corruption', 'orphan-family'].includes(String(raw.cause)) ||
    typeof raw.rootId !== 'string' ||
    !SAFE_UUID.test(raw.rootId) ||
    typeof raw.journalId !== 'string' ||
    !SAFE_UUID.test(raw.journalId) ||
    typeof raw.generationDirectory !== 'string' ||
    typeof raw.stagingFile !== 'string' ||
    typeof raw.quarantineDirectory !== 'string' ||
    typeof raw.rootRealPath !== 'string' ||
    typeof raw.rootDev !== 'string' ||
    typeof raw.rootIno !== 'string' ||
    typeof raw.createdAt !== 'string' ||
    !object(raw.directories) ||
    !['prepared', 'quarantining', 'publishing', 'verifying', 'cleaning'].includes(
      String(raw.phase)
    ) ||
    !Array.isArray(raw.family) ||
    raw.family.length > SQLITE_FAMILY.length
  ) {
    throw new Error('active journal recovery plan is malformed')
  }
  timestamp(raw.createdAt, 'recovery plan creation time')
  if (raw.priorActiveGeneration !== undefined) {
    decimal(raw.priorActiveGeneration, 'prior active recovery generation', true)
  }
  if (
    raw.priorActiveManifestSha256 !== undefined &&
    (typeof raw.priorActiveManifestSha256 !== 'string' ||
      !SHA256.test(raw.priorActiveManifestSha256))
  ) {
    throw new Error('active recovery plan prior manifest digest is malformed')
  }
  if (
    (raw.priorActiveGeneration === undefined) !==
    (raw.priorActiveManifestSha256 === undefined)
  ) {
    throw new Error('active recovery plan prior generation authority is incomplete')
  }
  const directories = raw.directories as Record<string, unknown>
  for (const name of ['recoveryRoot', 'generations', 'staging', 'quarantine', 'receipts']) {
    const identity = object(directories[name])
    if (
      !identity ||
      typeof identity.realPath !== 'string' ||
      typeof identity.dev !== 'string' ||
      typeof identity.ino !== 'string'
    ) {
      throw new Error(`active recovery plan has a malformed ${name} directory identity`)
    }
  }
  if (raw.phase !== 'prepared') {
    const incident = object(raw.incidentDirectory)
    if (
      !incident ||
      typeof incident.realPath !== 'string' ||
      typeof incident.dev !== 'string' ||
      typeof incident.ino !== 'string'
    ) {
      throw new Error('active recovery plan has a malformed incident directory identity')
    }
  }
  decimal(raw.generation, 'planned recovery generation', true)
  const familyNames = new Set<string>()
  for (const item of raw.family) {
    const entry = object(item)
    if (
      !entry ||
      !SQLITE_FAMILY.includes(entry.name as (typeof SQLITE_FAMILY)[number]) ||
      typeof entry.dev !== 'string' ||
      typeof entry.ino !== 'string' ||
      typeof entry.size !== 'string' ||
      typeof entry.mtimeNs !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error('active recovery plan contains a malformed family fingerprint')
    }
    if (familyNames.has(String(entry.name))) {
      throw new Error('active recovery plan repeats a SQLite family member')
    }
    familyNames.add(String(entry.name))
  }
  return raw as RecoveryPlan
}

function planPathsAreContained(plan: RecoveryPlan, paths: RecoveryPaths): void {
  const contained = (candidate: string, parent: string): boolean => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate))
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  }
  if (
    !contained(plan.generationDirectory, paths.generations) ||
    !contained(plan.stagingFile, paths.staging) ||
    !contained(plan.quarantineDirectory, paths.quarantine)
  ) {
    throw new Error('active recovery plan escapes its owned recovery directories')
  }
}

function assertPlanDirectories(plan: RecoveryPlan, paths: RecoveryPaths): void {
  assertDirectoryIdentity(paths.root, plan.directories.recoveryRoot)
  assertDirectoryIdentity(paths.generations, plan.directories.generations)
  assertDirectoryIdentity(paths.staging, plan.directories.staging)
  assertDirectoryIdentity(paths.quarantine, plan.directories.quarantine)
  assertDirectoryIdentity(paths.receipts, plan.directories.receipts)
}

function quarantineOne(
  dataDir: string,
  quarantineDirectory: string,
  expected: FileFingerprint,
  failpoint?: (edge: string) => void
): void {
  const source = path.join(dataDir, expected.name)
  const destination = path.join(quarantineDirectory, expected.name)
  const sourceState = lstatState(source)
  const destinationState = lstatState(destination)
  if (destinationState.state === 'present') {
    if (!sameFingerprint(destination, expected)) {
      throw new Error(`quarantine destination changed for ${expected.name}`)
    }
    if (sourceState.state === 'present') {
      const sourceStat = fs.lstatSync(source, { bigint: true })
      const destinationStat = fs.lstatSync(destination, { bigint: true })
      if (sourceStat.dev !== destinationStat.dev || sourceStat.ino !== destinationStat.ino) {
        throw new Error(`both source and quarantine contain different ${expected.name} files`)
      }
      fs.unlinkSync(source)
      failpoint?.(`after-quarantine-source-unlink-${expected.name}`)
      syncDirectory(dataDir)
    }
    return
  }
  if (sourceState.state === 'missing' || !sameFingerprint(source, expected)) {
    throw new Error(`SQLite family changed after corruption classification: ${expected.name}`)
  }
  fs.linkSync(source, destination)
  failpoint?.(`after-quarantine-link-${expected.name}`)
  syncFile(destination)
  syncDirectory(quarantineDirectory)
  fs.unlinkSync(source)
  failpoint?.(`after-quarantine-source-unlink-${expected.name}`)
  syncDirectory(dataDir)
}

function writePlan(paths: RecoveryPaths, plan: RecoveryPlan): void {
  writeJsonAtomic(paths.activePlan, plan)
}

function recoveryEvidence(plan: RecoveryPlan): Record<string, unknown> {
  return {
    format: FORMAT,
    planId: plan.id,
    cause: plan.cause,
    rootId: plan.rootId,
    journalId: plan.journalId,
    generation: plan.generation,
    priorActiveGeneration: plan.priorActiveGeneration,
    priorActiveManifestSha256: plan.priorActiveManifestSha256,
    root: {
      realPath: plan.rootRealPath,
      dev: plan.rootDev,
      ino: plan.rootIno,
    },
    family: plan.family,
    createdAt: plan.createdAt,
  }
}

function assertQuarantineComplete(plan: RecoveryPlan): void {
  if (!plan.incidentDirectory) {
    throw new Error('recovery incident directory identity is missing')
  }
  assertDirectoryIdentity(plan.quarantineDirectory, plan.incidentDirectory)
  for (const expected of plan.family) {
    if (!sameFingerprint(path.join(plan.quarantineDirectory, expected.name), expected)) {
      throw new Error(`quarantine evidence member changed or disappeared: ${expected.name}`)
    }
  }
  const evidenceFile = path.join(plan.quarantineDirectory, EVIDENCE_FILE)
  assertRegular(evidenceFile, true)
  const expectedBytes = Buffer.from(`${JSON.stringify(recoveryEvidence(plan), null, 2)}\n`)
  if (!fs.readFileSync(evidenceFile).equals(expectedBytes)) {
    throw new Error('quarantine evidence manifest changed or disappeared')
  }
}

function readReceipt(file: string): RecoveryReceipt {
  const raw = object(readJson(file))
  if (
    !raw ||
    raw.format !== FORMAT ||
    typeof raw.planId !== 'string' ||
    !SAFE_UUID.test(raw.planId) ||
    !['sqlite-corruption', 'orphan-family'].includes(String(raw.cause)) ||
    typeof raw.rootId !== 'string' ||
    !SAFE_UUID.test(raw.rootId) ||
    typeof raw.journalId !== 'string' ||
    !SAFE_UUID.test(raw.journalId) ||
    typeof raw.quarantineDir !== 'string' ||
    typeof raw.evidenceSha256 !== 'string' ||
    !SHA256.test(raw.evidenceSha256) ||
    typeof raw.receiptFile !== 'string' ||
    (raw.notification !== 'pending' && raw.notification !== 'consumed') ||
    typeof raw.completedAt !== 'string'
  ) {
    throw new Error('journal recovery receipt is malformed')
  }
  decimal(raw.generation, 'receipt recovery generation', true)
  if (raw.previousActiveGeneration !== undefined) {
    decimal(raw.previousActiveGeneration, 'receipt previous active recovery generation', true)
  }
  if (
    raw.previousActiveManifestSha256 !== undefined &&
    (typeof raw.previousActiveManifestSha256 !== 'string' ||
      !SHA256.test(raw.previousActiveManifestSha256))
  ) {
    throw new Error('receipt previous active manifest digest is malformed')
  }
  if (
    (raw.previousActiveGeneration === undefined) !==
    (raw.previousActiveManifestSha256 === undefined)
  ) {
    throw new Error('receipt previous generation authority is incomplete')
  }
  decimal(raw.snapshotMaxSeq, 'receipt snapshot max sequence')
  decimal(raw.snapshotEventHighWater, 'receipt snapshot event high-water')
  if (BigInt(raw.snapshotEventHighWater as string) < BigInt(raw.snapshotMaxSeq as string)) {
    throw new Error('receipt event high-water is below its snapshot max sequence')
  }
  timestamp(raw.completedAt, 'recovery receipt completion time')
  return raw as RecoveryReceipt
}

function verifyCanonicalQuarantineEvidence(
  paths: RecoveryPaths,
  receipt: RecoveryReceipt
): void {
  const canonicalDirectory = path.join(paths.quarantine, receipt.planId)
  if (path.resolve(receipt.quarantineDir) !== path.resolve(canonicalDirectory)) {
    throw new Error('recovery receipt does not bind its canonical quarantine incident')
  }
  const incidentState = lstatState(canonicalDirectory)
  if (
    incidentState.state !== 'present' ||
    !incidentState.stat.isDirectory() ||
    incidentState.stat.isSymbolicLink()
  ) {
    throw new Error('canonical quarantine incident is missing or not a real directory')
  }
  const quarantineReal = fs.realpathSync.native(paths.quarantine)
  if (path.dirname(fs.realpathSync.native(canonicalDirectory)) !== quarantineReal) {
    throw new Error('canonical quarantine incident escaped its owned directory')
  }

  const evidenceFile = path.join(canonicalDirectory, EVIDENCE_FILE)
  assertRegular(evidenceFile, true)
  if (sha256File(evidenceFile) !== receipt.evidenceSha256) {
    throw new Error('recovery receipt evidence digest is invalid')
  }
  const evidence = object(readJson(evidenceFile))
  const evidenceRoot = object(evidence?.root)
  if (
    !evidence ||
    evidence.format !== FORMAT ||
    evidence.planId !== receipt.planId ||
    evidence.cause !== receipt.cause ||
    evidence.rootId !== receipt.rootId ||
    evidence.journalId !== receipt.journalId ||
    evidence.generation !== receipt.generation ||
    evidence.priorActiveGeneration !== receipt.previousActiveGeneration ||
    evidence.priorActiveManifestSha256 !== receipt.previousActiveManifestSha256 ||
    !evidenceRoot ||
    typeof evidenceRoot.realPath !== 'string' ||
    typeof evidenceRoot.dev !== 'string' ||
    !DECIMAL.test(evidenceRoot.dev) ||
    typeof evidenceRoot.ino !== 'string' ||
    !DECIMAL.test(evidenceRoot.ino) ||
    typeof evidence.createdAt !== 'string' ||
    !Array.isArray(evidence.family) ||
    evidence.family.length < 1 ||
    evidence.family.length > SQLITE_FAMILY.length
  ) {
    throw new Error('canonical quarantine evidence manifest is malformed or conflicts with its receipt')
  }
  timestamp(evidence.createdAt, 'recovery evidence creation time')

  const family: FileFingerprint[] = []
  const familyNames = new Set<string>()
  for (const item of evidence.family) {
    const entry = object(item)
    if (
      !entry ||
      !SQLITE_FAMILY.includes(entry.name as (typeof SQLITE_FAMILY)[number]) ||
      familyNames.has(String(entry.name)) ||
      typeof entry.dev !== 'string' ||
      !DECIMAL.test(entry.dev) ||
      typeof entry.ino !== 'string' ||
      !DECIMAL.test(entry.ino) ||
      typeof entry.size !== 'string' ||
      !DECIMAL.test(entry.size) ||
      typeof entry.mtimeNs !== 'string' ||
      !DECIMAL.test(entry.mtimeNs) ||
      typeof entry.sha256 !== 'string' ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error('canonical quarantine evidence contains a malformed family identity')
    }
    familyNames.add(String(entry.name))
    family.push(entry as FileFingerprint)
  }

  const incidentEntries = boundedEntries(
    canonicalDirectory,
    SQLITE_FAMILY.length + 1,
    'recovery incident files'
  )
  const expectedEntries = new Set<string>([EVIDENCE_FILE, ...family.map((entry) => entry.name)])
  if (
    incidentEntries.length !== expectedEntries.size ||
    incidentEntries.some((entry) => !expectedEntries.has(entry))
  ) {
    throw new Error('canonical quarantine incident closure differs from its evidence manifest')
  }
  for (const expected of family) {
    const file = path.join(canonicalDirectory, expected.name)
    assertRegular(file, true)
    if (!sameFingerprint(file, expected)) {
      throw new Error(`quarantined SQLite family identity changed: ${expected.name}`)
    }
  }
}

function completeRecoveryTransition(
  paths: RecoveryPaths,
  plan: RecoveryPlan,
  receiptFile: string
): void {
  const binding = parseRootBinding(paths.rootBinding)
  const lowering =
    plan.priorActiveGeneration !== undefined &&
    BigInt(plan.generation) < BigInt(plan.priorActiveGeneration)
  const receiptSha256 = sha256File(receiptFile)
  let recoveryTransition = binding.recoveryTransition
  if (lowering) {
    const transition = binding.recoveryTransition
    if (
      binding.activeGeneration !== plan.generation ||
      !transition ||
      transition.planId !== plan.id ||
      transition.previousGeneration !== plan.priorActiveGeneration ||
      transition.previousManifestSha256 !== plan.priorActiveManifestSha256 ||
      transition.restoredGeneration !== plan.generation
    ) {
      throw new Error('recovery transition authority changed before receipt completion')
    }
    if (
      transition.receiptSha256 !== undefined &&
      transition.receiptSha256 !== receiptSha256
    ) {
      throw new Error('recovery transition receipt digest conflicts with durable receipt')
    }
    recoveryTransition = { ...transition, receiptSha256 }
  }
  const completedRecoveries = [...(binding.completedRecoveries ?? [])]
  const prior = completedRecoveries.find((entry) => entry.planId === plan.id)
  if (prior && prior.receiptSha256 !== receiptSha256) {
    throw new Error('completed recovery receipt digest conflicts with root authority')
  }
  if (!prior) {
    if (completedRecoveries.length >= MAX_INCIDENTS) {
      throw new Error('completed recovery receipt authority exceeds its bound')
    }
    completedRecoveries.push({ planId: plan.id, receiptSha256 })
  }
  if (
    prior &&
    (!lowering || binding.recoveryTransition?.receiptSha256 === receiptSha256)
  ) return
  writeJsonAtomic(paths.rootBinding, {
    ...binding,
    recoveryTransition,
    completedRecoveries,
  } satisfies RootBinding)
}

function runPlan(
  dataDir: string,
  journalPath: string,
  schemaVersion: number,
  plan: RecoveryPlan,
  failpoint?: (edge: string) => void
): RecoveryReceipt {
  const paths = recoveryPaths(dataDir)
  planPathsAreContained(plan, paths)
  assertPlanDirectories(plan, paths)
  const currentRoot = rootIdentity(dataDir)
  if (
    currentRoot.realPath !== plan.rootRealPath ||
    currentRoot.dev !== plan.rootDev ||
    currentRoot.ino !== plan.rootIno
  ) {
    throw new Error('data-root filesystem identity changed during recovery')
  }
  const rootRealPath = currentRoot.realPath
  const binding = parseRootBinding(paths.rootBinding)
  if (binding.rootId !== plan.rootId || binding.activeJournalId !== plan.journalId) {
    throw new Error('active recovery plan no longer matches the data-root identity')
  }
  const generation = verifyGeneration(plan.generationDirectory, binding, schemaVersion)
  if (generation.manifest.generation !== plan.generation) {
    throw new Error('active recovery plan generation changed')
  }
  const verifyPublishedRecovery = (): void => {
    assertPlanDirectories(plan, paths)
    assertQuarantineComplete(plan)
    const restored = inspectDatabase(journalPath, schemaVersion)
    if (
      restored.journalId !== plan.journalId ||
      restored.schemaVersion !== generation.manifest.schemaVersion ||
      restored.eventCount !== generation.manifest.eventCount ||
      restored.maxSeq !== generation.manifest.maxSeq ||
      restored.eventHighWater !== generation.manifest.eventHighWater ||
      sha256File(journalPath) !== generation.manifest.databaseSha256
    ) {
      throw new Error('published recovery database failed exact readonly re-verification')
    }
    const preflight = runHubPreflight({ dataDir, journalPath, schemaVersion })
    if (!preflight.ok) {
      throw new Error(
        `published recovery database failed fresh preflight [${preflight.failure.code}]: ${preflight.failure.message}`
      )
    }
  }
  const receiptFile = path.join(paths.receipts, `${plan.id}.json`)
  if (lstatState(receiptFile).state === 'present') {
    const receipt = readReceipt(receiptFile)
    if (
      receipt.planId !== plan.id ||
      receipt.cause !== plan.cause ||
      receipt.rootId !== plan.rootId ||
      receipt.journalId !== plan.journalId ||
      receipt.generation !== plan.generation ||
      receipt.previousActiveGeneration !== plan.priorActiveGeneration ||
      receipt.previousActiveManifestSha256 !== plan.priorActiveManifestSha256 ||
      receipt.snapshotMaxSeq !== generation.manifest.maxSeq ||
      receipt.snapshotEventHighWater !== generation.manifest.eventHighWater ||
      path.resolve(receipt.receiptFile) !== path.resolve(receiptFile) ||
      path.resolve(receipt.quarantineDir) !== path.resolve(plan.quarantineDirectory)
    ) {
      throw new Error('existing recovery receipt conflicts with active plan')
    }
    const evidenceFile = path.join(plan.quarantineDirectory, EVIDENCE_FILE)
    assertRegular(evidenceFile, true)
    const expectedEvidenceSha256 = sha256(
      `${JSON.stringify(recoveryEvidence(plan), null, 2)}\n`
    )
    if (
      receipt.evidenceSha256 !== expectedEvidenceSha256 ||
      sha256File(evidenceFile) !== expectedEvidenceSha256
    ) {
      throw new Error('existing recovery receipt no longer matches quarantine evidence')
    }
    verifyPublishedRecovery()
    completeRecoveryTransition(paths, plan, receiptFile)
    if (lstatState(paths.activePlan).state === 'present') {
      fs.rmSync(paths.activePlan)
      syncDirectory(paths.root)
    }
    return receipt
  }
  const stagingState = lstatState(plan.stagingFile)
  const publishedState = lstatState(journalPath)
  if (stagingState.state === 'missing' && publishedState.state === 'missing') {
    throw new Error('staged and published recovery databases are both missing')
  }
  if (stagingState.state === 'present') {
    const stagedInspection = inspectDatabase(plan.stagingFile, schemaVersion)
    if (stagedInspection.journalId !== plan.journalId) {
      throw new Error('staged recovery database belongs to a different journal')
    }
  }

  const evidenceFile = path.join(plan.quarantineDirectory, EVIDENCE_FILE)
  const evidence = recoveryEvidence(plan)
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`
  if (plan.phase === 'prepared' || plan.phase === 'quarantining') {
    if (plan.phase === 'prepared') assertLiveFamilyExactPlan(dataDir, plan)
    ensureRealDirectory(paths.quarantine, plan.quarantineDirectory)
    if (!plan.incidentDirectory) {
      plan.incidentDirectory = directoryIdentity(plan.quarantineDirectory)
    }
    plan.phase = 'quarantining'
    assertPlanDirectories(plan, paths)
    writePlan(paths, plan)
    syncDirectory(paths.quarantine)
    for (const expected of plan.family) {
      assertRootStable(dataDir, rootRealPath)
      assertFamilyTransitionState(dataDir, plan)
      quarantineOne(dataDir, plan.quarantineDirectory, expected, failpoint)
      failpoint?.(`after-quarantine-${expected.name}`)
    }
    assertLiveFamilyEmpty(dataDir)
    if (lstatState(evidenceFile).state === 'missing') {
      writeJsonExclusive(evidenceFile, evidence, failpoint, 'evidence')
    } else {
      readJson(evidenceFile)
      assertRegular(evidenceFile, true)
      if (!fs.readFileSync(evidenceFile).equals(Buffer.from(evidenceBytes))) {
        throw new Error('quarantine evidence manifest conflicts with the active recovery plan')
      }
    }
    assertQuarantineComplete(plan)
    plan.phase = 'publishing'
    assertPlanDirectories(plan, paths)
    writePlan(paths, plan)
  }
  assertRegular(evidenceFile, true)
  assertQuarantineComplete(plan)
  const evidenceSha256 = sha256File(evidenceFile)

  if (plan.phase === 'publishing') {
    assertRootStable(dataDir, rootRealPath)
    const liveBeforePublish = captureFamily(dataDir, false)
    if (
      liveBeforePublish.some(
        (entry) =>
          entry.name !== 'hub.db' ||
          entry.sha256 !== generation.manifest.databaseSha256
      )
    ) {
      throw new Error('unexpected SQLite family member appeared during publication')
    }
    if (lstatState(journalPath).state === 'missing') {
      if (lstatState(plan.stagingFile).state === 'missing') {
        throw new Error('staged recovery database disappeared before publication')
      }
      fs.linkSync(plan.stagingFile, journalPath)
      failpoint?.('after-publish-link')
      syncFile(journalPath)
      syncDirectory(dataDir)
    } else {
      const stagingNow = lstatState(plan.stagingFile)
      if (stagingNow.state === 'present') {
        const journalStat = fs.lstatSync(journalPath, { bigint: true })
        const stagingStat = fs.lstatSync(plan.stagingFile, { bigint: true })
        if (journalStat.dev !== stagingStat.dev || journalStat.ino !== stagingStat.ino) {
          throw new Error('journal publication target was replaced during recovery')
        }
      } else if (sha256File(journalPath) !== generation.manifest.databaseSha256) {
        throw new Error('published recovery database changed after staging cleanup')
      }
    }
    failpoint?.('after-publish')
    plan.phase = 'verifying'
    assertPlanDirectories(plan, paths)
    writePlan(paths, plan)
  }

  if (plan.phase === 'verifying') {
    verifyPublishedRecovery()
    const activeBinding = parseRootBinding(paths.rootBinding)
    if (activeBinding.activeGeneration !== plan.generation) {
      const lowering =
        plan.priorActiveGeneration !== undefined &&
        BigInt(plan.generation) < BigInt(plan.priorActiveGeneration)
      if (lowering && !plan.priorActiveManifestSha256) {
        throw new Error('recovery plan lacks the prior publication digest')
      }
      writeJsonAtomic(paths.rootBinding, {
        ...activeBinding,
        activeGeneration: plan.generation,
        recoveryTransition: lowering
          ? {
              planId: plan.id,
              previousGeneration: plan.priorActiveGeneration!,
              previousManifestSha256: plan.priorActiveManifestSha256!,
              restoredGeneration: plan.generation,
            }
          : undefined,
      } satisfies RootBinding)
      failpoint?.('after-recovery-head-transition')
    }
    plan.phase = 'cleaning'
    assertPlanDirectories(plan, paths)
    writePlan(paths, plan)
    failpoint?.('after-cleaning-phase')
  }
  verifyPublishedRecovery()
  if (lstatState(plan.stagingFile).state === 'present') {
    fs.unlinkSync(plan.stagingFile)
    failpoint?.('after-staging-unlink')
    syncDirectory(paths.staging)
  }
  const receipt: RecoveryReceipt = {
    format: FORMAT,
    planId: plan.id,
    cause: plan.cause,
    rootId: plan.rootId,
    journalId: plan.journalId,
    generation: plan.generation,
    previousActiveGeneration: plan.priorActiveGeneration,
    previousActiveManifestSha256: plan.priorActiveManifestSha256,
    snapshotMaxSeq: generation.manifest.maxSeq,
    snapshotEventHighWater: generation.manifest.eventHighWater,
    quarantineDir: plan.quarantineDirectory,
    evidenceSha256,
    receiptFile,
    notification: 'pending',
    completedAt: new Date().toISOString(),
  }
  assertPlanDirectories(plan, paths)
  writeJsonExclusive(receiptFile, receipt, failpoint, 'receipt')
  failpoint?.('after-receipt')
  completeRecoveryTransition(paths, plan, receiptFile)
  failpoint?.('after-recovery-transition-complete')
  fs.rmSync(paths.activePlan)
  syncDirectory(paths.root)
  return receipt
}

function preparePlan(
  dataDir: string,
  schemaVersion: number,
  failure: PreflightFailure,
  operationId: string = crypto.randomUUID(),
  capturedFamily?: FileFingerprint[],
  failpoint?: (edge: string) => void
): RecoveryPlan {
  if (
    failure.recoveryCause !== 'sqlite-corruption' &&
    failure.recoveryCause !== 'orphan-family'
  ) {
    throw new Error('preflight failure is not eligible for automatic recovery')
  }
  const paths = recoveryPaths(dataDir)
  if (lstatState(paths.rootBinding).state === 'missing') {
    throw new Error('no identity-bound verified recovery generation is available')
  }
  const binding = parseRootBinding(paths.rootBinding)
  const generation = selectRecoveryGeneration(dataDir, schemaVersion)
  if (!generation) {
    throw new Error('no identity-bound verified recovery generation is available')
  }
  if (!SAFE_UUID.test(operationId)) throw new Error('recovery operation id is malformed')
  const id = operationId
  const root = rootIdentity(dataDir)
  ensureRecoveryOperationDirectories(dataDir)
  const stagingFile = path.join(paths.staging, `${id}.db`)
  const sourceSnapshot = path.join(generation.directory, SNAPSHOT_FILE)
  const stagingState = lstatState(stagingFile)
  if (stagingState.state === 'missing') {
    const partial = `${stagingFile}.partial`
    const partialState = lstatState(partial)
    if (partialState.state === 'present') {
      if (!partialState.stat.isFile() || partialState.stat.isSymbolicLink()) {
        throw new Error('operation restore partial is not a regular file')
      }
      fs.unlinkSync(partial)
      syncDirectory(paths.staging)
    }
    fs.copyFileSync(sourceSnapshot, partial, fs.constants.COPYFILE_EXCL)
    failpoint?.('after-restore-copy')
    syncFile(partial)
    failpoint?.('after-restore-fsync')
    if (lstatState(stagingFile).state === 'present') {
      throw new Error('operation staging target appeared before publication')
    }
    publishPartialNoReplace(partial, stagingFile, paths.staging, failpoint, 'restore-publish')
  } else if (
    sha256File(stagingFile) !== generation.manifest.databaseSha256 ||
    fs.lstatSync(stagingFile).isSymbolicLink()
  ) {
    throw new Error('existing operation staging database does not match selected generation')
  } else {
    removeMatchingPublishedPartial(`${stagingFile}.partial`, stagingFile, paths.staging)
  }
  const staged = inspectDatabase(stagingFile, schemaVersion)
  failpoint?.('after-restore-verify')
  if (
    staged.journalId !== generation.manifest.journalId ||
    sha256File(stagingFile) !== generation.manifest.databaseSha256
  ) {
    throw new Error('staged recovery database failed independent verification')
  }
  const priorHead = controllingPublishedHead(dataDir, binding)
  const plan: RecoveryPlan = {
    format: FORMAT,
    id,
    cause: failure.recoveryCause,
    rootId: binding.rootId,
    journalId: binding.activeJournalId,
    generation: generation.manifest.generation,
    priorActiveGeneration: priorHead?.generation,
    priorActiveManifestSha256: priorHead?.manifestSha256,
    generationDirectory: generation.directory,
    stagingFile,
    quarantineDirectory: path.join(paths.quarantine, id),
    rootRealPath: root.realPath,
    rootDev: root.dev,
    rootIno: root.ino,
    directories: {
      recoveryRoot: directoryIdentity(paths.root),
      generations: directoryIdentity(paths.generations),
      staging: directoryIdentity(paths.staging),
      quarantine: directoryIdentity(paths.quarantine),
      receipts: directoryIdentity(paths.receipts),
    },
    family: capturedFamily ?? captureFamily(dataDir),
    createdAt: new Date().toISOString(),
    phase: 'prepared',
  }
  failpoint?.('before-plan-publication')
  writeJsonExclusive(paths.activePlan, plan, failpoint, 'active-plan')
  return plan
}

function cleanupUnpublishedRecoveryPreparation(
  paths: RecoveryPaths,
  operationId: string,
  classifierDir: string
): void {
  // A durable active plan owns its staging artifacts and must always be resumed. Without that boundary,
  // these are disposable derived copies; leaving them behind changes the next boot's classification from
  // the original journal-family failure to an unrelated "incomplete recovery" failure.
  if (lstatState(paths.activePlan).state === 'present') return
  if (
    path.dirname(classifierDir) !== paths.staging ||
    path.basename(classifierDir) !== `.classifier-${operationId}`
  ) {
    throw new Error('refusing to clean an out-of-scope recovery classifier directory')
  }
  for (const file of [
    path.join(paths.staging, `${operationId}.db.partial`),
    path.join(paths.staging, `${operationId}.db`),
  ]) {
    if (lstatState(file).state === 'present') fs.rmSync(file, { force: true })
  }
  const classifierState = lstatState(classifierDir)
  if (classifierState.state === 'present') {
    if (!classifierState.stat.isDirectory() || classifierState.stat.isSymbolicLink()) {
      throw new Error('refusing to clean a non-directory recovery classifier path')
    }
    fs.rmSync(classifierDir, { recursive: true, force: true })
  }
  syncDirectory(paths.staging)
}

export function bootstrapJournalRecovery(options: {
  dataDir: string
  journalPath: string
  schemaVersion: number
  lease?: JournalRecoveryLease
  operationId?: string
  failpoint?: (edge: string) => void
  /** Tests may lower, never raise, the production 1 TiB retained-evidence ceiling. */
  evidenceByteLimit?: bigint
}): {
  preflight: HubPreflightResult
  recovery?: RecoveryReceipt
  lease: JournalRecoveryLease
} {
  const dataDir = path.resolve(options.dataDir)
  const journalPath = path.resolve(options.journalPath)
  if (path.dirname(journalPath) !== dataDir || path.basename(journalPath) !== 'hub.db') {
    throw new Error('journal recovery requires the exact data-root hub.db path')
  }
  const ownsLease = options.lease === undefined
  const lease = options.lease ?? new JournalRecoveryLease(dataDir)
  lease.acquireShared()
  let recovery: RecoveryReceipt | undefined
  try {
    const paths = recoveryPaths(dataDir)
    if (options.operationId) {
      if (!SAFE_UUID.test(options.operationId)) throw new Error('recovery operation id is malformed')
      const receiptFile = path.join(paths.receipts, `${options.operationId}.json`)
      if (lstatState(receiptFile).state === 'present') recovery = readReceipt(receiptFile)
    }
    if (lstatState(paths.activePlan).state === 'present') {
      const activePlan = parsePlan(paths.activePlan)
      lease.acquireExclusive()
      lease.assertExclusiveAuthority()
      recovery = runPlan(
        dataDir,
        journalPath,
        options.schemaVersion,
        activePlan,
        options.failpoint
      )
      options.failpoint?.('after-plan-complete-before-classifier-cleanup')
      const completedClassifier = path.join(paths.staging, `.classifier-${activePlan.id}`)
      if (lstatState(completedClassifier).state === 'present') {
        const state = lstatState(completedClassifier)
        if (
          state.state !== 'present' ||
          !state.stat.isDirectory() ||
          state.stat.isSymbolicLink()
        ) {
          throw new Error('completed classifier operation path is not a real directory')
        }
        fs.rmSync(completedClassifier, { recursive: true })
        syncDirectory(paths.staging)
      }
      lease.downgradeToShared()
      let resumedPreflight = runHubPreflight({
        dataDir,
        journalPath,
        schemaVersion: options.schemaVersion,
      })
      if (resumedPreflight.ok) {
        const lineageFailure = verifyNormalJournalLineage({
          dataDir,
          journalPath,
          maxSchemaVersion: options.schemaVersion,
        })
        if (lineageFailure) {
          resumedPreflight = {
            ok: false,
            checks: resumedPreflight.checks,
            failure: lineageFailure,
          }
        }
      }
      return { preflight: resumedPreflight, recovery, lease }
    }
    lease.acquireExclusive()
    lease.assertExclusiveAuthority()
    const operationPaths = ensureRecoveryOperationDirectories(dataDir)
    // With no active plan, every prior classifier/restore staging member is an unpublished derived copy.
    // Start classification from the live family instead of allowing interrupted debris to manufacture a
    // different refusal on the next boot.
    reconcileInterruptedRecoveryStaging(operationPaths, true)
    if (lstatState(operationPaths.rootBinding).state === 'present') {
      reconcilePublishedGenerationActivation(
        dataDir,
        parseRootBinding(operationPaths.rootBinding),
        options.schemaVersion,
        true
      )
    }
    const incompleteClassifierEntries = boundedEntries(
      paths.staging,
      MAX_STAGING_ENTRIES,
      'recovery staging'
    ).filter((entry) => /^\.classifier-[0-9a-f-]{36}$/i.test(entry))
    if (incompleteClassifierEntries.length === 1) {
      const entry = incompleteClassifierEntries[0]!
      const id = entry.slice('.classifier-'.length)
      const receiptFile = path.join(paths.receipts, `${id}.json`)
      if (lstatState(receiptFile).state === 'present') {
        const binding = parseRootBinding(paths.rootBinding)
        const receipt = readReceipt(receiptFile)
        const completed = binding.completedRecoveries?.find((item) => item.planId === id)
        if (
          receipt.planId !== id ||
          !completed ||
          completed.receiptSha256 !== sha256File(receiptFile)
        ) {
          throw new Error('completed classifier cleanup lacks matching receipt authority')
        }
        const evidenceFile = path.join(receipt.quarantineDir, EVIDENCE_FILE)
        assertRegular(evidenceFile, true)
        if (sha256File(evidenceFile) !== receipt.evidenceSha256) {
          throw new Error('completed classifier cleanup evidence changed')
        }
        fs.rmSync(path.join(paths.staging, entry), { recursive: true })
        syncDirectory(paths.staging)
      }
    }
    const capturedFamily = captureFamily(dataDir)
    assertRecoveryEvidenceQuota(
      operationPaths,
      capturedFamily,
      options.evidenceByteLimit !== undefined &&
        options.evidenceByteLimit < MAX_QUARANTINE_BYTES
        ? options.evidenceByteLimit
        : MAX_QUARANTINE_BYTES,
      { staging: 2 }
    )
    const classifierRoot = rootIdentity(dataDir)
    const priorClassifierEntries = boundedEntries(
      paths.staging,
      MAX_STAGING_ENTRIES,
      'recovery staging'
    ).filter((entry) => /^\.classifier-[0-9a-f-]{36}$/i.test(entry))
    if (priorClassifierEntries.length > 1) {
      throw new Error('multiple incomplete classifier operations are ambiguous')
    }
    let classifierOperationId = options.operationId ?? crypto.randomUUID()
    if (priorClassifierEntries.length === 1) {
      const priorEntry = priorClassifierEntries[0]!
      const priorId = priorEntry.slice('.classifier-'.length)
      if (!SAFE_UUID.test(priorId)) throw new Error('classifier operation id is malformed')
      const priorDirectory = path.join(paths.staging, priorEntry)
      const priorIntentFile = path.join(priorDirectory, 'family.json')
      const priorIntentState = lstatState(priorIntentFile)
      if (priorIntentState.state === 'present') {
        const priorIntent = object(readJson(priorIntentFile))
        if (
          !priorIntent ||
          JSON.stringify(priorIntent.root) !== JSON.stringify(classifierRoot) ||
          JSON.stringify(priorIntent.family) !== JSON.stringify(capturedFamily)
        ) {
          throw new Error('incomplete classifier operation conflicts with the current exact family')
        }
      } else if (boundedEntries(priorDirectory, 1, 'classifier operation').length > 0) {
        throw new Error('incomplete classifier operation has no durable family intent')
      }
      classifierOperationId = priorId
    }
    const classifierDir = path.join(paths.staging, `.classifier-${classifierOperationId}`)
    const classifierState = lstatState(classifierDir)
    if (classifierState.state === 'missing') {
      fs.mkdirSync(classifierDir, { recursive: false })
      options.failpoint?.('after-classifier-directory')
    } else if (
      !classifierState.stat.isDirectory() ||
      classifierState.stat.isSymbolicLink()
    ) {
      throw new Error('operation classifier path is not a real directory')
    }
    syncDirectory(paths.staging)
    const classifierIntent = {
      format: FORMAT,
      operationId: classifierOperationId,
      root: classifierRoot,
      family: capturedFamily,
    }
    const classifierIntentFile = path.join(classifierDir, 'family.json')
    if (lstatState(classifierIntentFile).state === 'missing') {
      writeJsonExclusive(classifierIntentFile, classifierIntent)
    } else if (
      JSON.stringify(readJson(classifierIntentFile)) !== JSON.stringify(classifierIntent)
    ) {
      throw new Error('operation classifier family intent conflicts with current family')
    }
    let preflight: HubPreflightResult
    let classifierCompleted = false
    try {
      for (const captured of capturedFamily) {
        const source = path.join(dataDir, captured.name)
        if (!sameFingerprint(source, captured)) {
          throw new Error(`SQLite family changed before isolated classification: ${captured.name}`)
        }
        const target = path.join(classifierDir, captured.name)
        const targetState = lstatState(target)
        if (targetState.state === 'missing') {
          const partial = `${target}.partial`
          const partialState = lstatState(partial)
          if (partialState.state === 'present') {
            if (!partialState.stat.isFile() || partialState.stat.isSymbolicLink()) {
              throw new Error(`classifier partial is not a regular file: ${captured.name}`)
            }
            fs.unlinkSync(partial)
            syncDirectory(classifierDir)
          }
          fs.copyFileSync(source, partial, fs.constants.COPYFILE_EXCL)
          options.failpoint?.(`after-classifier-copy-${captured.name}`)
          syncFile(partial)
          options.failpoint?.(`after-classifier-fsync-${captured.name}`)
          if (lstatState(target).state === 'present') {
            throw new Error(`classifier target appeared before publication: ${captured.name}`)
          }
          publishPartialNoReplace(
            partial,
            target,
            classifierDir,
            options.failpoint,
            `classifier-publish-${captured.name}`
          )
        } else if (
          !targetState.stat.isFile() ||
          targetState.stat.isSymbolicLink()
        ) {
          throw new Error(`operation classifier target is not a regular file: ${captured.name}`)
        } else {
          removeMatchingPublishedPartial(`${target}.partial`, target, classifierDir)
        }
        if (sha256File(target) !== captured.sha256) {
          throw new Error(`isolated classifier copy hash mismatch: ${captured.name}`)
        }
      }
      syncDirectory(classifierDir)
      preflight = runHubPreflight({
        dataDir: classifierDir,
        journalPath: path.join(classifierDir, 'hub.db'),
        schemaVersion: options.schemaVersion,
        stableFamily: true,
      })
      if (preflight.ok) {
        const lineageFailure = verifyNormalJournalLineage({
          dataDir,
          journalPath: path.join(classifierDir, 'hub.db'),
          maxSchemaVersion: options.schemaVersion,
        })
        if (lineageFailure) {
          preflight = { ok: false, checks: preflight.checks, failure: lineageFailure }
        }
      }
      classifierCompleted = true
    } finally {
      // Keep the exact classifier intent until either a durable active plan exists or classification
      // concludes without recovery. A supervisor crash before plan publication can then resume the
      // same operation ID instead of leaking one staging directory per restart.
    }
    if (
      !preflight.ok &&
      (preflight.failure.recoveryCause === 'sqlite-corruption' ||
        preflight.failure.recoveryCause === 'orphan-family')
    ) {
      const eligibleFailure = preflight.failure
      let preparationFailpointThrew = false
      const preparationFailpoint = options.failpoint
        ? (edge: string): void => {
            try {
              options.failpoint?.(edge)
            } catch (error) {
              preparationFailpointThrew = true
              throw error
            }
          }
        : undefined
      try {
        const plan = preparePlan(
          dataDir,
          options.schemaVersion,
          eligibleFailure,
          classifierOperationId,
          capturedFamily,
          preparationFailpoint
        )
        options.failpoint?.('after-plan-publication-before-classifier-cleanup')
        fs.rmSync(classifierDir, { recursive: true, force: true })
        syncDirectory(paths.staging)
        recovery = runPlan(
          dataDir,
          journalPath,
          options.schemaVersion,
          plan,
          options.failpoint
        )
        lease.downgradeToShared()
        // The fresh child performs the controlling normal preflight. This local check is evidence that
        // the published bytes can be opened, not authority to start serving.
        preflight = runHubPreflight({ dataDir, journalPath, schemaVersion: options.schemaVersion })
      } catch (error) {
        if (!preparationFailpointThrew && lstatState(paths.activePlan).state === 'missing') {
          try {
            cleanupUnpublishedRecoveryPreparation(paths, classifierOperationId, classifierDir)
          } catch (cleanupError) {
            throw new JournalRecoveryBootstrapError(
              eligibleFailure,
              new AggregateError(
                [error, cleanupError],
                'recovery preparation failed and its unpublished staging debris could not be removed'
              )
            )
          }
        }
        throw new JournalRecoveryBootstrapError(eligibleFailure, error)
      }
    } else {
      if (classifierCompleted) {
        fs.rmSync(classifierDir, { recursive: true, force: true })
        syncDirectory(paths.staging)
      }
      lease.downgradeToShared()
    }
    return { preflight, recovery, lease }
  } catch (error) {
    try {
      if (ownsLease) lease.release()
      else lease.downgradeToShared()
    } catch {
      /* retain the original recovery failure */
    }
    throw error
  }
}

/**
 * Run independent classification/recovery off the supervisor thread. A valid result is bound to the
 * exact Worker instance and fresh attempt ID. Timeout, exit without a result, malformed output, or a
 * lost acknowledgement leaves the root offline; callers must never infer completion from absence.
 */
export function bootstrapJournalRecoveryInWorker(options: {
  dataDir: string
  journalPath: string
  schemaVersion: number
  operationId: string
  attemptId: string
  timeoutMs?: number
  onLiveness?: (elapsedMs: number) => void
}): Promise<JournalRecoveryWorkerResult> {
  if (!isMainThread) {
    return Promise.reject(new Error('nested journal recovery workers are forbidden'))
  }
  const timeoutMs = options.timeoutMs ?? JOURNAL_RECOVERY_WORKER_ABSOLUTE_MS
  if (
    !SAFE_UUID.test(options.operationId) ||
    !SAFE_UUID.test(options.attemptId) ||
    !Number.isSafeInteger(options.schemaVersion) ||
    options.schemaVersion < 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > JOURNAL_RECOVERY_WORKER_ABSOLUTE_MS
  ) {
    return Promise.reject(new Error('invalid journal recovery worker contract'))
  }
  return new Promise((resolve, reject) => {
    const moduleUrl = new URL(import.meta.url)
    const sourceIsTypeScript = fileURLToPath(moduleUrl).endsWith('.ts')
    const worker = new Worker(moduleUrl, {
      ...(sourceIsTypeScript
        ? {
            execArgv: [
              '--import',
              pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,
            ],
          }
        : {}),
      workerData: {
        kind: 'journal-recovery-v1',
        attemptId: options.attemptId,
        operationId: options.operationId,
        dataDir: options.dataDir,
        journalPath: options.journalPath,
        schemaVersion: options.schemaVersion,
      } satisfies JournalRecoveryWorkerRequest,
    })
    const startedAt = Date.now()
    let settled = false
    const livenessTimer = setInterval(() => {
      options.onLiveness?.(Date.now() - startedAt)
    }, 10_000)
    const absoluteTimer = setTimeout(() => {
      finish(new Error('journal recovery worker exceeded its absolute execution ceiling'))
    }, timeoutMs)
    const finish = (error?: unknown, result?: JournalRecoveryWorkerResult): void => {
      if (settled) return
      settled = true
      clearInterval(livenessTimer)
      clearTimeout(absoluteTimer)
      void worker.terminate()
      if (error !== undefined) reject(error)
      else resolve(result!)
    }
    worker.on('message', (message: unknown) => {
      const raw =
        message !== null && typeof message === 'object'
          ? (message as Record<string, unknown>)
          : undefined
      if (!raw || raw.attemptId !== options.attemptId) {
        finish(new Error('journal recovery worker result attempt binding is invalid'))
        return
      }
      if (raw.kind === 'journal-recovery-error-v1') {
        if (
          Object.keys(raw).sort().join(',') !== 'attemptId,error,kind' ||
          typeof raw.error !== 'string' ||
          raw.error.length < 1 ||
          raw.error.length > 4_096
        ) {
          finish(new Error('journal recovery worker returned a malformed error'))
        } else {
          finish(new Error(`journal recovery worker failed: ${raw.error}`))
        }
        return
      }
      if (
        raw.kind !== 'journal-recovery-result-v1' ||
        Object.keys(raw).sort().join(',') !== 'attemptId,kind,result' ||
        raw.result === null ||
        typeof raw.result !== 'object'
      ) {
        finish(new Error('journal recovery worker returned a malformed result'))
        return
      }
      const result = raw.result as Record<string, unknown>
      const keys = Object.keys(result).sort().join(',')
      if (
        (keys !== 'preflight' && keys !== 'preflight,recovery') ||
        result.preflight === null ||
        typeof result.preflight !== 'object' ||
        typeof (result.preflight as Record<string, unknown>).ok !== 'boolean'
      ) {
        finish(new Error('journal recovery worker returned invalid preflight evidence'))
        return
      }
      if (result.recovery !== undefined) {
        const recovery = result.recovery as Partial<RecoveryReceipt>
        if (
          recovery === null ||
          typeof recovery !== 'object' ||
          typeof recovery.planId !== 'string' ||
          !SAFE_UUID.test(recovery.planId) ||
          typeof recovery.generation !== 'string' ||
          !DECIMAL.test(recovery.generation) ||
          typeof recovery.quarantineDir !== 'string' ||
          typeof recovery.receiptFile !== 'string' ||
          typeof recovery.evidenceSha256 !== 'string' ||
          !SHA256.test(recovery.evidenceSha256)
        ) {
          finish(new Error('journal recovery worker returned invalid receipt evidence'))
          return
        }
      }
      finish(undefined, result as JournalRecoveryWorkerResult)
    })
    worker.once('error', (error) => finish(error))
    worker.once('exit', (exitCode) => {
      if (!settled) {
        finish(
          new Error(
            `journal recovery worker exited without an acknowledged result (code ${exitCode})`
          )
        )
      }
    })
  })
}

const recoveryWorkerRequest =
  !isMainThread && workerData !== null && typeof workerData === 'object'
    ? (workerData as Partial<JournalRecoveryWorkerRequest>)
    : undefined
if (recoveryWorkerRequest?.kind === 'journal-recovery-v1') {
  try {
    if (
      Object.keys(recoveryWorkerRequest).sort().join(',') !==
        'attemptId,dataDir,journalPath,kind,operationId,schemaVersion' ||
      typeof recoveryWorkerRequest.attemptId !== 'string' ||
      !SAFE_UUID.test(recoveryWorkerRequest.attemptId) ||
      typeof recoveryWorkerRequest.operationId !== 'string' ||
      !SAFE_UUID.test(recoveryWorkerRequest.operationId) ||
      typeof recoveryWorkerRequest.dataDir !== 'string' ||
      recoveryWorkerRequest.dataDir.length < 1 ||
      recoveryWorkerRequest.dataDir.length > 32_768 ||
      typeof recoveryWorkerRequest.journalPath !== 'string' ||
      recoveryWorkerRequest.journalPath.length < 1 ||
      recoveryWorkerRequest.journalPath.length > 32_768 ||
      !Number.isSafeInteger(recoveryWorkerRequest.schemaVersion) ||
      Number(recoveryWorkerRequest.schemaVersion) < 0
    ) {
      throw new Error('journal recovery worker request is malformed')
    }
    const boot = bootstrapJournalRecovery({
      dataDir: recoveryWorkerRequest.dataDir,
      journalPath: recoveryWorkerRequest.journalPath,
      schemaVersion: Number(recoveryWorkerRequest.schemaVersion),
      operationId: recoveryWorkerRequest.operationId,
    })
    const result: JournalRecoveryWorkerResult = {
      preflight: boot.preflight,
      ...(boot.recovery ? { recovery: boot.recovery } : {}),
    }
    boot.lease.release()
    parentPort?.postMessage({
      kind: 'journal-recovery-result-v1',
      attemptId: recoveryWorkerRequest.attemptId,
      result,
    })
  } catch (error) {
    parentPort?.postMessage({
      kind: 'journal-recovery-error-v1',
      attemptId: recoveryWorkerRequest.attemptId,
      error: String(error).slice(0, 4_096),
    })
  }
}

function ensureRecoveryNoticeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_recovery_notices (
      plan_id TEXT PRIMARY KEY,
      generation TEXT NOT NULL,
      snapshot_max_seq TEXT NOT NULL,
      snapshot_event_high_water TEXT NOT NULL,
      quarantine_dir TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      dismissed_at TEXT
    )
  `)
  const noticeColumns = new Set(
    (db.pragma('table_info(journal_recovery_notices)') as Array<{ name?: unknown }>).map(
      (column) => String(column.name)
    )
  )
  if (
    !noticeColumns.has('generation') ||
    !noticeColumns.has('snapshot_max_seq') ||
    !noticeColumns.has('snapshot_event_high_water') ||
    !noticeColumns.has('quarantine_dir') ||
    !noticeColumns.has('dismissed_at')
  ) {
    throw new Error('journal recovery notice schema is incomplete')
  }
}

export function consumeRecoveryReceipts(journal: {
  db: Database.Database
}): number {
  const file = journal.db.name
  if (!file || file === ':memory:') return 0
  const dataDir = path.dirname(path.resolve(file))
  const paths = recoveryPaths(dataDir)
  ensureRecoveryNoticeSchema(journal.db)
  let entries: string[]
  try {
    entries = fs.readdirSync(paths.receipts)
  } catch (error) {
    if (code(error) === 'ENOENT') return 0
    throw error
  }
  const insertNotice = journal.db.prepare(
    `INSERT OR IGNORE INTO journal_recovery_notices (
       plan_id, generation, snapshot_max_seq, snapshot_event_high_water,
       quarantine_dir, recorded_at, dismissed_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL)`
  )
  const insertEvent = journal.db.prepare(
    'INSERT INTO events (ts, session, kind, payload) VALUES (?, NULL, ?, ?)'
  )
  const selectNotice = journal.db.prepare(
    `SELECT generation, snapshot_max_seq AS snapshotMaxSeq,
            snapshot_event_high_water AS snapshotEventHighWater,
            quarantine_dir AS quarantineDir, recorded_at AS recordedAt
     FROM journal_recovery_notices WHERE plan_id = ?`
  )
  let consumed = 0
  const receiptEntries = entries.filter((entry) => entry.endsWith('.json')).sort()
  if (receiptEntries.length > 64) {
    throw new Error('recovery receipt evidence exceeds the explicit 64-incident bound')
  }
  const binding = parseRootBinding(paths.rootBinding)
  const currentJournalId = readJournalIdentity(journal.db)
  if (currentJournalId !== binding.activeJournalId) {
    throw new Error('recovery receipts cannot be consumed by a foreign journal')
  }
  for (const entry of receiptEntries) {
    const receiptPath = path.join(paths.receipts, entry)
    const receipt = readReceipt(receiptPath)
    if (
      entry !== `${receipt.planId}.json` ||
      path.resolve(receipt.receiptFile) !== path.resolve(receiptPath) ||
      path.dirname(path.resolve(receipt.quarantineDir)) !== path.resolve(paths.quarantine) ||
      path.basename(receipt.quarantineDir) !== receipt.planId
    ) {
      throw new Error(`recovery receipt ${entry} contains a non-canonical owned path`)
    }
    if (receipt.rootId !== binding.rootId || receipt.journalId !== currentJournalId) {
      throw new Error(`recovery receipt ${receipt.planId} belongs to a different root or journal`)
    }
    verifyCanonicalQuarantineEvidence(paths, receipt)
    const existing = selectNotice.get(receipt.planId) as
      | {
          generation?: unknown
          snapshotMaxSeq?: unknown
          snapshotEventHighWater?: unknown
          quarantineDir?: unknown
          recordedAt?: unknown
        }
      | undefined
    if (existing) {
      if (
        existing.generation !== receipt.generation ||
        existing.snapshotMaxSeq !== receipt.snapshotMaxSeq ||
        existing.snapshotEventHighWater !== receipt.snapshotEventHighWater ||
        existing.quarantineDir !== receipt.quarantineDir ||
        existing.recordedAt !== receipt.completedAt
      ) {
        throw new Error(`recovery notice ${receipt.planId} conflicts with its immutable receipt`)
      }
      continue
    }
    const recordedAt = receipt.completedAt
    const payload = {
      planId: receipt.planId,
      generation: receipt.generation,
      snapshotMaxSeq: receipt.snapshotMaxSeq,
      snapshotEventHighWater: receipt.snapshotEventHighWater,
      quarantineDir: receipt.quarantineDir,
      postSnapshotTailOutcome: 'unknown',
      message:
        'Journal recovery restored an identity-bound verified generation. The outcome of events after the snapshot high-water is unknown; no lost-row count is inferred.',
    }
    const transaction = journal.db.transaction(() => {
      const inserted = insertNotice.run(
        receipt.planId,
        receipt.generation,
        receipt.snapshotMaxSeq,
        receipt.snapshotEventHighWater,
        receipt.quarantineDir,
        recordedAt
      )
      if (inserted.changes === 1) {
        insertEvent.run(recordedAt, 'journal/recovered', JSON.stringify(payload))
        consumed += 1
      }
    })
    transaction()
  }
  return consumed
}

export function validateRecoveryReceiptsBeforeWritableOpen(options: {
  dataDir: string
  journalPath: string
}): PreflightFailure | undefined {
  const paths = recoveryPaths(options.dataDir)
  const contained = (candidate: string, parent: string): boolean => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate))
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  }
  let db: Database.Database | undefined
  let result: PreflightFailure | undefined
  try {
    const bindingState = lstatState(paths.rootBinding)
    if (bindingState.state === 'missing') {
      const rootState = lstatState(paths.root)
      if (rootState.state === 'missing') return undefined
      if (!rootState.stat.isDirectory() || rootState.stat.isSymbolicLink()) {
        throw new Error('recovery namespace is not a real directory')
      }
      if (hasPriorRecoveryNamespaceHistory(paths)) {
        throw new Error('root binding is missing despite prior recovery receipt history')
      }
      // The shared lease deliberately creates the guarded ownership database before
      // first-install preflight. That lease alone is not recovery enrollment or receipt
      // history, so a genuinely empty journal may proceed and enroll on its first snapshot.
      return undefined
    }
    const binding = parseRootBinding(paths.rootBinding)
    const receiptState = lstatState(paths.receipts)
    if (receiptState.state === 'missing') {
      if ((binding.completedRecoveries?.length ?? 0) > 0) {
        throw new Error('completed recovery receipt directory is missing')
      }
      return undefined
    }
    const completed = new Map(
      (binding.completedRecoveries ?? []).map((entry) => [entry.planId, entry.receiptSha256])
    )
    const retainedIncidentIds = new Set<string>()
    if (lstatState(paths.quarantine).state === 'present') {
      for (const entry of boundedEntries(
        paths.quarantine,
        MAX_INCIDENTS,
        'recovery incidents'
      )) {
        if (!SAFE_UUID.test(entry) || retainedIncidentIds.has(entry)) {
          throw new Error('quarantine incident name is noncanonical or duplicated')
        }
        retainedIncidentIds.add(entry)
        if (!completed.has(entry)) {
          throw new Error('quarantine incident lacks completed receipt authority')
        }
      }
    }
    const rawReceiptEntries = boundedEntries(
      paths.receipts,
      MAX_INCIDENTS,
      'recovery receipts'
    )
    for (const entry of rawReceiptEntries) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(entry)) {
        throw new Error('recovery receipt directory contains a noncanonical entry')
      }
    }
    const receiptEntries = rawReceiptEntries.sort()
    const existing = new Map<string, Record<string, unknown>>()
    if (lstatState(options.journalPath).state === 'present') {
      db = new Database(options.journalPath, { readonly: true, fileMustExist: true })
      db.pragma('query_only = ON')
      const hasNotices = (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'table' AND name = 'journal_recovery_notices'`
          )
          .get() as { count: number }
      ).count === 1
      if (hasNotices) {
        for (const row of db
          .prepare(
            `SELECT plan_id AS planId, generation, snapshot_max_seq AS snapshotMaxSeq,
                    snapshot_event_high_water AS snapshotEventHighWater,
                    quarantine_dir AS quarantineDir, recorded_at AS recordedAt
             FROM journal_recovery_notices`
          )
          .all() as Array<Record<string, unknown>>) {
          existing.set(String(row.planId), row)
        }
      }
    }
    for (const entry of receiptEntries) {
      const receiptFile = path.join(paths.receipts, entry)
      const receipt = readReceipt(receiptFile)
      const boundDigest = completed.get(receipt.planId)
      if (
        boundDigest === undefined ||
        sha256File(receiptFile) !== boundDigest ||
        entry !== `${receipt.planId}.json` ||
        path.resolve(receipt.receiptFile) !== path.resolve(receiptFile) ||
        receipt.rootId !== binding.rootId ||
        receipt.journalId !== binding.activeJournalId ||
        !contained(receipt.quarantineDir, paths.quarantine) ||
        path.basename(receipt.quarantineDir) !== receipt.planId
      ) {
        throw new Error('recovery receipt identity or canonical path is invalid')
      }
      const notice = existing.get(receipt.planId)
      if (notice) {
        if (
          notice.generation !== receipt.generation ||
          notice.snapshotMaxSeq !== receipt.snapshotMaxSeq ||
          notice.snapshotEventHighWater !== receipt.snapshotEventHighWater ||
          path.resolve(String(notice.quarantineDir)) !== path.resolve(receipt.quarantineDir) ||
          notice.recordedAt !== receipt.completedAt
        ) {
          throw new Error('durable recovery notice conflicts with its immutable receipt')
        }
      }
      verifyCanonicalQuarantineEvidence(paths, receipt)
    }
    if (receiptEntries.length !== completed.size) {
      throw new Error('completed recovery receipt index is incomplete')
    }
    if (retainedIncidentIds.size !== completed.size) {
      throw new Error('completed recovery receipt lacks its canonical quarantine incident')
    }
    for (const planId of existing.keys()) {
      if (!SAFE_UUID.test(planId) || !completed.has(planId)) {
        throw new Error('durable recovery notice lacks completed receipt authority')
      }
    }
  } catch (error) {
    result = {
      code: 'database-validation-unavailable',
      message: `Recovery receipt evidence could not be validated before writable open: ${text(error)}`,
      recovery:
        'Keep the data root offline. Restore the exact receipt/evidence metadata or archive it for operator review before retrying.',
    }
  }
  try {
    db?.close()
  } catch (error) {
    result = {
      code: 'database-validation-unavailable',
      message: `Recovery receipt validation handle could not close: ${text(error)}`,
      recovery:
        'Keep the data root offline until the validating process exits and releases the uncertain handle.',
    }
  }
  return result
}

export type RecoveryNotice = {
  planId: string
  generation: string
  snapshotMaxSeq: string
  snapshotEventHighWater: string
  quarantineDir: string
  recordedAt: string
}

export function listRecoveryNotices(
  db: Database.Database,
  limit = 8
): RecoveryNotice[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
    throw new Error('recovery notice limit must be between 1 and 8')
  }
  ensureRecoveryNoticeSchema(db)
  return db
    .prepare(
      `SELECT plan_id AS planId, generation,
              snapshot_max_seq AS snapshotMaxSeq,
              snapshot_event_high_water AS snapshotEventHighWater,
              quarantine_dir AS quarantineDir, recorded_at AS recordedAt
       FROM journal_recovery_notices
       WHERE dismissed_at IS NULL
       ORDER BY recorded_at, plan_id
       LIMIT ?`
    )
    .all(limit) as RecoveryNotice[]
}

export function dismissRecoveryNotice(
  db: Database.Database,
  planId: string
): boolean {
  if (!SAFE_UUID.test(planId)) throw new Error('recovery notice plan id is malformed')
  ensureRecoveryNoticeSchema(db)
  const result = db
    .prepare(
      `UPDATE journal_recovery_notices
       SET dismissed_at = COALESCE(dismissed_at, ?)
       WHERE plan_id = ?`
    )
    .run(new Date().toISOString(), planId)
  return result.changes === 1
}
