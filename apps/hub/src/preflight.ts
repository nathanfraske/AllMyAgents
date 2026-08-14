import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads'
import Database from 'better-sqlite3'

export const PREFLIGHT_EXIT_CODE = 78

export type PreflightFailureCode =
  | 'data-dir-not-writable'
  | 'database-corrupt'
  | 'database-orphan-family'
  | 'database-lineage-invalid'
  | 'database-validation-unavailable'
  | 'schema-too-new'
  | 'schema-version-unrecordable'
  | 'question-owner-activation-failed'

export type PreflightCheck = {
  name: 'data-dir-writable' | 'database-schema' | 'database-integrity'
  status: 'passed' | 'skipped'
  detail: string
  durationMs: number
}

export type PreflightFailure = {
  code: PreflightFailureCode
  message: string
  recovery: string
  recoveryCause?: 'sqlite-corruption' | 'orphan-family' | 'lineage-rollback'
}

export type HubPreflightResult =
  | { ok: true; checks: PreflightCheck[] }
  | { ok: false; checks: PreflightCheck[]; failure: PreflightFailure }

const WRITE_FAILURE_CODES = new Set(['EACCES', 'EDQUOT', 'ENOSPC', 'EPERM', 'EROFS'])
const CORRUPT_SQLITE_CODES = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB'])
const WAL_MAGIC = new Set([0x377f0682, 0x377f0683])
const WAL_VERSION = 3_007_000
const MAX_WAL_FRAMES = 16_777_216
const PREFLIGHT_WORKER_LIVENESS_INTERVAL_MS = 1_000
const PREFLIGHT_WORKER_ABSOLUTE_MS = 5 * 60_000

type WalValidation =
  | { status: 'ok'; validCommit: boolean; ignoredTail: boolean }
  | { status: 'corrupt'; detail: string }
  | { status: 'unavailable'; detail: string }

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = 'code' in error && typeof error.code === 'string' ? `${error.code}: ` : ''
  return `${code}${error.message}`
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10
}

/** Exact, bounded family identity used only to reuse a pass inside one still-running supervisor. */
export function journalPreflightIdentity(dataDir: string, journalPath: string): string | undefined {
  const describe = (file: string): Record<string, string> => {
    try {
      const stat = fs.lstatSync(file, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink()) return { state: 'invalid' }
      return {
        state: 'file',
        dev: String(stat.dev),
        ino: String(stat.ino),
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { state: 'missing' }
      throw error
    }
  }
  try {
    const files = [
      journalPath,
      `${journalPath}-wal`,
      `${journalPath}-shm`,
      `${journalPath}-journal`,
      path.join(path.resolve(dataDir), 'journal-recovery', 'root.json'),
    ].map((file) => [path.resolve(file), describe(file)] as const)
    return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')
  } catch {
    return undefined
  }
}

function writeFailure(error: unknown, dataDir: string): PreflightFailure | undefined {
  const code = errorCode(error)
  if (!code || !WRITE_FAILURE_CODES.has(code)) return undefined
  return {
    code: 'data-dir-not-writable',
    message: `The hub data directory is not writable (${dataDir}): ${errorText(error)}`,
    recovery: 'Free disk space or restore write permission to the data directory, then restart AllMyAgents. No data was changed.',
  }
}

function corruptionFailure(error: unknown, journalPath: string): PreflightFailure | undefined {
  const code = errorCode(error)
  const text = errorText(error)
  if (!code || !CORRUPT_SQLITE_CODES.has(code)) return undefined
  return {
    code: 'database-corrupt',
    message: `The journal database failed SQLite validation (${journalPath}): ${text}`,
    recovery:
      'Keep the damaged SQLite family for evidence. AllMyAgents may restore only an identity-bound verified recovery generation; otherwise it stays offline.',
    recoveryCause: 'sqlite-corruption',
  }
}

function walChecksum(
  bytes: Buffer,
  littleEndian: boolean,
  seed: readonly [number, number]
): [number, number] {
  let [s1, s2] = seed
  for (let offset = 0; offset < bytes.length; offset += 8) {
    const first = littleEndian
      ? bytes.readUInt32LE(offset)
      : bytes.readUInt32BE(offset)
    const second = littleEndian
      ? bytes.readUInt32LE(offset + 4)
      : bytes.readUInt32BE(offset + 4)
    s1 = (s1 + first + s2) >>> 0
    s2 = (s2 + second + s1) >>> 0
  }
  return [s1, s2]
}

function validateWalFile(walPath: string): WalValidation {
  let fd: number | undefined
  let result: WalValidation = { status: 'unavailable', detail: 'validation did not complete' }
  try {
    const stat = fs.lstatSync(walPath, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: 'unavailable', detail: 'WAL path is not a regular non-link file' }
    }
    if (stat.size === 0n) return { status: 'ok', validCommit: false, ignoredTail: false }
    if (stat.size < 4n) {
      return { status: 'unavailable', detail: 'sidecar is too short to identify as SQLite WAL' }
    }
    fd = fs.openSync(walPath, 'r')
    const header = Buffer.alloc(32)
    const headerBytes = fs.readSync(fd, header, 0, header.length, 0)
    if (headerBytes < 4) {
      return { status: 'unavailable', detail: 'sidecar is too short to identify as SQLite WAL' }
    }
    const magic = header.readUInt32BE(0)
    if (!WAL_MAGIC.has(magic)) {
      return { status: 'unavailable', detail: 'sidecar does not have a recognized SQLite WAL magic' }
    }
    if (headerBytes !== header.length) {
      return { status: 'corrupt', detail: 'recognized SQLite WAL header is truncated' }
    }
    if (header.readUInt32BE(4) !== WAL_VERSION) {
      return { status: 'corrupt', detail: 'recognized SQLite WAL has an invalid format version' }
    }
    const encodedPageSize = header.readUInt32BE(8)
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize
    if (
      pageSize < 512 ||
      pageSize > 65_536 ||
      (pageSize & (pageSize - 1)) !== 0
    ) {
      return { status: 'corrupt', detail: 'recognized SQLite WAL has an invalid page size' }
    }
    const frameBytes = BigInt(pageSize + 24)
    const payloadBytes = stat.size - 32n
    const frameCount = payloadBytes / frameBytes
    const tailBytes = payloadBytes % frameBytes
    if (frameCount > BigInt(MAX_WAL_FRAMES)) {
      return {
        status: 'unavailable',
        detail: 'recognized SQLite WAL exceeds the bounded validation frame count',
      }
    }
    const littleEndian = magic === 0x377f0682
    let checksum = walChecksum(header.subarray(0, 24), littleEndian, [0, 0])
    if (checksum[0] !== header.readUInt32BE(24) || checksum[1] !== header.readUInt32BE(28)) {
      return { status: 'corrupt', detail: 'recognized SQLite WAL header checksum is invalid' }
    }
    const salt1 = header.readUInt32BE(16)
    const salt2 = header.readUInt32BE(20)
    const frame = Buffer.alloc(pageSize + 24)
    let validCommit = false
    const laterSameSaltCommit = (start: bigint): boolean => {
      const laterHeader = Buffer.alloc(24)
      for (let later = start; later < frameCount; later += 1n) {
        const laterPosition = 32n + later * frameBytes
        if (laterPosition > BigInt(Number.MAX_SAFE_INTEGER)) break
        if (
          fs.readSync(fd!, laterHeader, 0, laterHeader.length, Number(laterPosition)) !==
          laterHeader.length
        ) {
          break
        }
        if (
          laterHeader.readUInt32BE(8) === salt1 &&
          laterHeader.readUInt32BE(12) === salt2 &&
          laterHeader.readUInt32BE(4) !== 0
        ) {
          return true
        }
      }
      return false
    }
    for (let index = 0n; index < frameCount; index += 1n) {
      const position = 32n + index * frameBytes
      if (position > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { status: 'unavailable', detail: 'recognized SQLite WAL offset exceeds safe bounds' }
      }
      const bytes = fs.readSync(fd, frame, 0, frame.length, Number(position))
      if (bytes !== frame.length) {
        return { status: 'corrupt', detail: 'recognized SQLite WAL frame is truncated' }
      }
      if (frame.readUInt32BE(0) === 0) {
        if (frame.readUInt32BE(4) !== 0 || laterSameSaltCommit(index + 1n)) {
          return { status: 'corrupt', detail: 'recognized committed WAL frame has page number zero' }
        }
        if (validCommit) return { status: 'ok', validCommit, ignoredTail: true }
        return { status: 'unavailable', detail: 'WAL page-zero boundary is ambiguous' }
      }
      if (frame.readUInt32BE(8) !== salt1 || frame.readUInt32BE(12) !== salt2) {
        if (laterSameSaltCommit(index + 1n)) {
          return { status: 'corrupt', detail: 'WAL salt mismatch hides a later committed frame' }
        }
        if (validCommit) return { status: 'ok', validCommit, ignoredTail: true }
        return { status: 'unavailable', detail: 'WAL salt boundary is ambiguous' }
      }
      checksum = walChecksum(frame.subarray(0, 8), littleEndian, checksum)
      checksum = walChecksum(frame.subarray(24), littleEndian, checksum)
      if (
        checksum[0] !== frame.readUInt32BE(16) ||
        checksum[1] !== frame.readUInt32BE(20)
      ) {
        let committedTail = frame.readUInt32BE(4) !== 0
        if (!committedTail) {
          committedTail = laterSameSaltCommit(index + 1n)
        }
        if (!committedTail) {
          return { status: 'ok', validCommit, ignoredTail: true }
        }
        return {
          status: 'corrupt',
          detail: `recognized committed SQLite WAL frame ${index + 1n} checksum is invalid`,
        }
      }
      if (frame.readUInt32BE(4) !== 0) validCommit = true
    }
    result = { status: 'ok', validCommit, ignoredTail: tailBytes !== 0n }
  } catch (error) {
    result = { status: 'unavailable', detail: errorText(error) }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch (error) {
        result = {
          status: 'unavailable',
          detail: `WAL validation handle could not close: ${errorText(error)}`,
        }
      }
    }
  }
  return result
}

export function runHubPreflight(options: {
  dataDir: string
  journalPath: string
  schemaVersion: number
  /** Injectable only so error classification can be exercised without damaging a real database. */
  openReadonly?: (file: string) => Database.Database
  /** Injectable only for conclusive missing/path-shape classification tests. */
  lstat?: typeof fs.lstatSync
  /** Only an exclusive supervisor classifier may interpret stable raw sidecar bytes. */
  stableFamily?: boolean
  /** Exact unchanged-family receipt from this supervisor boot; skips repeated database content scans. */
  reuseVerifiedIdentity?: boolean
}): HubPreflightResult {
  const { dataDir, journalPath, schemaVersion } = options
  const checks: PreflightCheck[] = []

  const writeStarted = performance.now()
  let probeFd: number | undefined
  let probePath: string | undefined
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    probePath = path.join(dataDir, `.ama-write-probe-${process.pid}-${crypto.randomUUID()}`)
    probeFd = fs.openSync(probePath, 'wx')
    fs.writeSync(probeFd, Buffer.from([0x61]))
    fs.fsyncSync(probeFd)
    checks.push({
      name: 'data-dir-writable',
      status: 'passed',
      detail: 'created, flushed, and removed a probe file',
      durationMs: elapsed(writeStarted),
    })
  } catch (error) {
    const failure = writeFailure(error, dataDir)
    if (failure) return { ok: false, checks, failure }
    return {
      ok: false,
      checks,
      failure: {
        code: 'database-validation-unavailable',
        message: `The hub data directory write probe failed unexpectedly (${dataDir}): ${errorText(error)}`,
        recovery:
          'Do not open or recover the journal until the data-root filesystem error is resolved.',
      },
    }
  } finally {
    if (probeFd !== undefined) {
      try {
        fs.closeSync(probeFd)
      } catch {
        /* a failed cleanup must not turn a conclusive write into a boot failure */
      }
    }
    if (probePath) {
      try {
        fs.rmSync(probePath, { force: true })
      } catch {
        /* a failed cleanup must not turn a conclusive write into a boot failure */
      }
    }
  }

  const lstat = (file: fs.PathLike): fs.Stats | fs.BigIntStats =>
    options.lstat
      ? options.lstat(file)
      : fs.lstatSync(file, { bigint: true })
  type PathClassification =
    | { state: 'missing' }
    | {
        state: 'regular'
        identity: {
          dev: string
          ino: string
          size: string
          mtimeNs: string
          ctimeNs: string
        }
      }
    | { state: 'invalid'; detail: string }
  const classifyPath = (
    file: string
  ): PathClassification => {
    try {
      const stat = lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { state: 'invalid', detail: 'path is not a regular non-symlink file' }
      }
      return {
        state: 'regular',
        identity: {
          dev: String(stat.dev),
          ino: String(stat.ino),
          size: String(stat.size),
          mtimeNs:
            'mtimeNs' in stat
              ? String(stat.mtimeNs)
              : String(BigInt(Math.trunc(Number(stat.mtimeMs) * 1_000_000))),
          ctimeNs:
            'ctimeNs' in stat
              ? String(stat.ctimeNs)
              : String(BigInt(Math.trunc(Number(stat.ctimeMs) * 1_000_000))),
        },
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { state: 'missing' }
      return { state: 'invalid', detail: errorText(error) }
    }
  }
  const main = classifyPath(journalPath)
  if (main.state === 'invalid') {
    return {
      ok: false,
      checks,
      failure: {
        code: 'database-validation-unavailable',
        message: `The journal path could not be conclusively classified (${journalPath}): ${main.detail}`,
        recovery:
          'Do not attempt automatic recovery. Resolve the path, permission, or filesystem error and restart AllMyAgents.',
      },
    }
  }
  const sidecars = ['-wal', '-shm', '-journal'].map((suffix) => ({
    suffix,
    classification: classifyPath(`${journalPath}${suffix}`),
  }))
  const initialFamily = [
    { file: journalPath, classification: main },
    ...sidecars.map(({ suffix, classification }) => ({
      file: `${journalPath}${suffix}`,
      classification,
    })),
  ]
  const familyChange = (allowEmptyDerivedSidecars = false): string | undefined => {
    for (const expected of initialFamily) {
      const actual = classifyPath(expected.file)
      if (actual.state !== expected.classification.state) {
        if (
          allowEmptyDerivedSidecars &&
          expected.classification.state === 'missing' &&
          actual.state === 'regular' &&
          (expected.file.endsWith('-wal') || expected.file.endsWith('-shm'))
        ) {
          continue
        }
        return `${expected.file} changed from ${expected.classification.state} to ${actual.state}`
      }
      if (
        actual.state === 'regular' &&
        expected.classification.state === 'regular' &&
        (actual.identity.dev !== expected.classification.identity.dev ||
          actual.identity.ino !== expected.classification.identity.ino)
      ) {
        return `${expected.file} filesystem identity changed`
      }
      if (actual.state === 'invalid') {
        return `${expected.file} became unverifiable: ${actual.detail}`
      }
    }
    return undefined
  }
  const invalidSidecar = sidecars.find(({ classification }) => classification.state === 'invalid')
  if (invalidSidecar?.classification.state === 'invalid') {
    return {
      ok: false,
      checks,
      failure: {
        code: 'database-validation-unavailable',
        message: `A SQLite sidecar could not be conclusively classified (${journalPath}${invalidSidecar.suffix}): ${invalidSidecar.classification.detail}`,
        recovery:
          'Do not attempt automatic recovery. Resolve the path, permission, or filesystem error and restart AllMyAgents.',
      },
    }
  }
  if (main.state === 'missing') {
    const orphanSidecars = sidecars
      .filter(({ classification }) => classification.state === 'regular')
      .map(({ suffix }) => suffix)
    if (orphanSidecars.length > 0) {
      return {
        ok: false,
        checks,
        failure: {
          code: 'database-orphan-family',
          message: `The main journal is missing while SQLite sidecars remain (${orphanSidecars.join(', ')}).`,
          recovery:
            'Keep the orphaned SQLite family for evidence. AllMyAgents may restore only an identity-bound verified recovery generation; otherwise it stays offline.',
          recoveryCause: 'orphan-family',
        },
      }
    }
    checks.push({
      name: 'database-schema',
      status: 'skipped',
      detail: 'journal does not exist yet',
      durationMs: 0,
    })
    checks.push({
      name: 'database-integrity',
      status: 'skipped',
      detail: 'journal does not exist yet',
      durationMs: 0,
    })
    return { ok: true, checks }
  }

  const wal = sidecars.find(({ suffix }) => suffix === '-wal')
  if (wal?.classification.state === 'regular') {
    const validation = validateWalFile(`${journalPath}-wal`)
    if (validation.status === 'corrupt') {
      return {
        ok: false,
        checks,
        failure: {
          code: options.stableFamily
            ? 'database-corrupt'
            : 'database-validation-unavailable',
          message: `The journal WAL failed bounded read-only validation (${journalPath}-wal): ${validation.detail}`,
          recovery: options.stableFamily
            ? 'Keep the damaged SQLite family for evidence. AllMyAgents may restore only an identity-bound verified recovery generation; otherwise it stays offline.'
            : 'Stop shared-root processes and run the exclusive isolated-family classifier. This concurrent scan is suspicion only and does not authorize mutation.',
          ...(options.stableFamily ? { recoveryCause: 'sqlite-corruption' as const } : {}),
        },
      }
    }
    if (validation.status === 'unavailable') {
      return {
        ok: false,
        checks,
        failure: {
          code: 'database-validation-unavailable',
          message: `The journal WAL could not be conclusively validated read-only (${journalPath}-wal): ${validation.detail}`,
          recovery:
            'Do not attempt automatic recovery. Preserve the SQLite family and resolve the sidecar, permission, or filesystem ambiguity.',
        },
      }
    }
  }
  const shm = sidecars.find(({ suffix }) => suffix === '-shm')
  if (options.stableFamily && shm?.classification.state === 'regular') {
    const bytes = BigInt(shm.classification.identity.size)
    if (bytes === 0n || bytes % 32_768n !== 0n) {
      return {
        ok: false,
        checks,
        failure: {
          code: 'database-validation-unavailable',
          message: `The journal shared-memory sidecar has an unverifiable size (${journalPath}-shm): ${bytes} bytes`,
          recovery:
            'Do not attempt automatic recovery. Preserve the SQLite family and resolve the derived shared-memory ambiguity.',
        },
      }
    }
  }
  const beforeOpenChange = familyChange()
  if (beforeOpenChange) {
    return {
      ok: false,
      checks,
      failure: {
        code: 'database-validation-unavailable',
        message: `The SQLite family changed before read-only validation: ${beforeOpenChange}`,
        recovery:
          'Do not attempt automatic recovery. Stop concurrent mutation and restart from a stable data root.',
      },
    }
  }

  const databaseStarted = performance.now()
  let db: Database.Database | undefined
  let schemaChecked = false
  let result: HubPreflightResult
  try {
    db =
      options.openReadonly?.(journalPath) ??
      new Database(journalPath, { readonly: true, fileMustExist: true })
    const afterOpenChange = familyChange(true)
    if (afterOpenChange) {
      throw Object.assign(
        new Error(`SQLite family changed while opening read-only: ${afterOpenChange}`),
        { code: 'AMA_PATH_IDENTITY_CHANGED' }
      )
    }
    db.pragma('query_only = ON')
    db.pragma('busy_timeout = 1000')

    const storedVersion = Number(db.pragma('user_version', { simple: true }))
    schemaChecked = true
    checks.push({
      name: 'database-schema',
      status: 'passed',
      detail: `database v${storedVersion}; hub supports through v${schemaVersion}`,
      durationMs: elapsed(databaseStarted),
    })
    if (storedVersion > schemaVersion) {
      result = {
        ok: false,
        checks,
        failure: {
          code: 'schema-too-new',
          message: `The journal schema is v${storedVersion}, but this hub only supports through v${schemaVersion}.`,
          recovery:
            'Reinstall a hub version compatible with this database, or restore a backup created by this older version. Do not lower user_version by hand.',
        },
      }
    } else {
      const integrityStarted = performance.now()
      if (options.reuseVerifiedIdentity) {
        checks.push({
          name: 'database-integrity',
          status: 'skipped',
          detail: 'unchanged journal family already passed preflight during this supervisor boot',
          durationMs: elapsed(integrityStarted),
        })
        result = { ok: true, checks }
      } else {
      const integrityPragma = options.stableFamily ? 'integrity_check' : 'quick_check'
      const rows = db.pragma(integrityPragma) as Array<Record<string, unknown>>
      const findings = rows.flatMap((row) => Object.values(row).map(String))
      if (findings.length !== 1 || findings[0]?.toLowerCase() !== 'ok') {
        result = {
          ok: false,
          checks,
          failure: {
            code: 'database-corrupt',
            message: `The journal failed PRAGMA ${integrityPragma}: ${findings.join('; ') || 'SQLite returned no result'}`,
            recovery:
              'Keep the damaged SQLite family for evidence. AllMyAgents may restore only an identity-bound verified recovery generation; otherwise it stays offline.',
            recoveryCause: 'sqlite-corruption',
          },
        }
      } else {
        const invalidPayload = db
          .prepare('SELECT seq FROM events WHERE json_valid(payload) = 0 ORDER BY seq LIMIT 1')
          .get() as { seq?: unknown } | undefined
        if (invalidPayload) {
          result = {
            ok: false,
            checks,
            failure: {
              code: 'database-corrupt',
              message: `The journal contains invalid JSON in event sequence ${String(invalidPayload.seq)}.`,
              recovery:
                'Keep the damaged SQLite family for evidence. AllMyAgents may restore only an identity-bound verified recovery generation; otherwise it stays offline.',
              recoveryCause: 'sqlite-corruption',
            },
          }
        } else {
          checks.push({
            name: 'database-integrity',
            status: 'passed',
            detail: `${integrityPragma} ok; event payload JSON is valid`,
            durationMs: elapsed(integrityStarted),
          })
          result = { ok: true, checks }
        }
      }
      }
    }
  } catch (error) {
    const failure = corruptionFailure(error, journalPath)
    if (failure) {
      result = { ok: false, checks, failure }
    } else {
      if (!schemaChecked) {
        checks.push({
          name: 'database-schema',
          status: 'skipped',
          detail: `read-only check was unavailable: ${errorText(error)}`,
          durationMs: elapsed(databaseStarted),
        })
      }
      checks.push({
        name: 'database-integrity',
        status: 'skipped',
        detail: `read-only check was unavailable: ${errorText(error)}`,
        durationMs: elapsed(databaseStarted),
      })
      result = {
        ok: false,
        checks,
        failure: {
          code: 'database-validation-unavailable',
          message: `The journal could not be conclusively validated read-only (${journalPath}): ${errorText(error)}`,
          recovery:
            'Do not attempt automatic recovery. Resolve the lock, I/O, disk, permission, or SQLite error and restart AllMyAgents.',
        },
      }
    }
  }
  let closeFailed = false
  try {
    db?.close()
  } catch (error) {
    closeFailed = true
    result = {
      ok: false,
      checks,
      failure: {
        code: 'database-validation-unavailable',
        message: `The journal read-only validation handle could not be closed (${journalPath}): ${errorText(error)}`,
        recovery:
          'Do not attempt automatic recovery. The validating process must exit so the OS closes the uncertain handle before a supervisor may retry.',
      },
    }
  }
  if (!closeFailed && db?.open) {
    try {
      db.close()
    } catch {
      /* the first close failure is already the typed result */
    }
  }
  const afterCloseChange = familyChange(true)
  if (afterCloseChange) {
    result = {
      ok: false,
      checks,
      failure: {
        code: 'database-validation-unavailable',
        message: `The SQLite family changed during read-only validation: ${afterCloseChange}`,
        recovery:
          'Do not attempt automatic recovery. Stop concurrent mutation and restart from a stable data root.',
      },
    }
  }
  return result
}

export function recordSchemaVersion(db: Database.Database, schemaVersion: number): void {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > 2_147_483_647) {
    throw new Error(`invalid SQLite schema version: ${schemaVersion}`)
  }
  const storedVersion = Number(db.pragma('user_version', { simple: true }))
  if (storedVersion > schemaVersion) {
    throw new Error(`refusing to lower journal schema v${storedVersion} to v${schemaVersion}`)
  }
  if (storedVersion < schemaVersion) db.pragma(`user_version = ${schemaVersion}`)
}

export function recordExistingSchemaVersion(journalPath: string, schemaVersion: number): void {
  const db = new Database(journalPath, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    recordSchemaVersion(db, schemaVersion)
  } finally {
    db.close()
  }
}

type PreflightWorkerRequest = {
  kind: 'hub-preflight-v1'
  dataDir: string
  journalPath: string
  schemaVersion: number
  reuseVerifiedIdentity?: boolean
}

type PreflightWorkerResponse =
  | { kind: 'result'; result: HubPreflightResult }
  | { kind: 'error'; error: string }

export function runHubPreflightInWorker(options: {
  dataDir: string
  journalPath: string
  schemaVersion: number
  onLiveness: () => void
  reuseVerifiedIdentity?: boolean
}): Promise<HubPreflightResult> {
  if (!isMainThread) {
    return Promise.reject(new Error('nested preflight workers are forbidden'))
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
        kind: 'hub-preflight-v1',
        dataDir: options.dataDir,
        journalPath: options.journalPath,
        schemaVersion: options.schemaVersion,
        ...(options.reuseVerifiedIdentity ? { reuseVerifiedIdentity: true } : {}),
      } satisfies PreflightWorkerRequest,
    })
    let settled = false
    let livenessTimer: ReturnType<typeof setInterval> | undefined
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: unknown, result?: HubPreflightResult): void => {
      if (settled) return
      settled = true
      if (livenessTimer) clearInterval(livenessTimer)
      if (absoluteTimer) clearTimeout(absoluteTimer)
      void worker.terminate()
      if (error !== undefined) reject(error)
      else resolve(result!)
    }
    const renewLivenessLease = (): void => {
      try {
        options.onLiveness()
      } catch (error) {
        finish(error)
      }
    }
    livenessTimer = setInterval(
      renewLivenessLease,
      PREFLIGHT_WORKER_LIVENESS_INTERVAL_MS
    )
    absoluteTimer = setTimeout(() => {
      finish(new Error('preflight worker exceeded its absolute verification ceiling'))
    }, PREFLIGHT_WORKER_ABSOLUTE_MS)
    worker.on('message', (message: unknown) => {
      const response =
        message !== null && typeof message === 'object'
          ? (message as Record<string, unknown>)
          : undefined
      if (
        response?.kind === 'result' &&
        response.result !== null &&
        typeof response.result === 'object'
      ) {
        finish(undefined, response.result as HubPreflightResult)
      } else if (
        response?.kind === 'error' &&
        typeof response.error === 'string' &&
        response.error.length > 0 &&
        response.error.length <= 4096
      ) {
        finish(new Error(`preflight worker failed: ${response.error}`))
      } else {
        finish(new Error('preflight worker returned a malformed result'))
      }
    })
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`preflight worker exited before a result (code ${code})`))
    })
    renewLivenessLease()
  })
}

const workerRequest =
  !isMainThread && workerData !== null && typeof workerData === 'object'
    ? (workerData as Partial<PreflightWorkerRequest>)
    : undefined
if (workerRequest?.kind === 'hub-preflight-v1') {
  try {
    if (
      typeof workerRequest.dataDir !== 'string' ||
      typeof workerRequest.journalPath !== 'string' ||
      !Number.isSafeInteger(workerRequest.schemaVersion) ||
      Number(workerRequest.schemaVersion) < 0
    ) {
      throw new Error('preflight worker request is malformed')
    }
    const result = runHubPreflight({
      dataDir: workerRequest.dataDir,
      journalPath: workerRequest.journalPath,
      schemaVersion: Number(workerRequest.schemaVersion),
      reuseVerifiedIdentity: workerRequest.reuseVerifiedIdentity === true,
    })
    parentPort?.postMessage({ kind: 'result', result } satisfies PreflightWorkerResponse)
  } catch (error) {
    parentPort?.postMessage({
      kind: 'error',
      error: errorText(error).slice(0, 4096),
    } satisfies PreflightWorkerResponse)
  }
}
