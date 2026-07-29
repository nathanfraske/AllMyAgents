import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import type { HubDataRootExpectation } from './dataRoot.js'

export const PREFLIGHT_EXIT_CODE = 78

export type PreflightFailureCode =
  | 'data-dir-not-writable'
  | 'database-corrupt'
  | 'schema-too-new'
  | 'schema-version-unrecordable'
  | 'data-root-required'
  | 'data-root-expectation-required'
  | 'expected-data-root-missing'
  | 'expected-journal-missing'
  | 'expected-journal-unreadable'
  | 'data-root-expectation-invalid'
  | 'restored-session-expectation-invalid'
  | 'restored-session-floor-missed'

export type PreflightCheck = {
  name: 'data-dir-writable' | 'database-schema' | 'database-integrity' | 'restored-session-floor'
  status: 'passed' | 'skipped'
  detail: string
  durationMs: number
}

export type PreflightFailure = {
  code: PreflightFailureCode
  message: string
  recovery: string
}

export type HubPreflightResult =
  | { ok: true; checks: PreflightCheck[] }
  | { ok: false; checks: PreflightCheck[]; failure: PreflightFailure }

const WRITE_FAILURE_CODES = new Set(['EACCES', 'EDQUOT', 'ENOSPC', 'EPERM', 'EROFS'])
const CORRUPT_SQLITE_CODES = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB'])

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

function checkDataDirWritable(
  dataDir: string,
  checks: PreflightCheck[]
): PreflightFailure | undefined {
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
    if (failure) return failure
    checks.push({
      name: 'data-dir-writable',
      status: 'skipped',
      detail: `probe was inconclusive: ${errorText(error)}`,
      durationMs: elapsed(writeStarted),
    })
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
  return undefined
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
  if (
    (!code || !CORRUPT_SQLITE_CODES.has(code)) &&
    !/database disk image is malformed|file is not a database|malformed database schema/i.test(text)
  ) {
    return undefined
  }
  return {
    code: 'database-corrupt',
    message: `The journal database failed SQLite validation (${journalPath}): ${text}`,
    recovery:
      'Keep the damaged hub.db for recovery and restore a known-good backup. Creating a new journal requires an explicit first-run confirmation.',
  }
}

export function runHubPreflight(options: {
  dataDir: string
  journalPath: string
  schemaVersion: number
  dataRootExpectation?: HubDataRootExpectation
  expectedRestoredSessions?: number
}): HubPreflightResult {
  const {
    dataDir,
    journalPath,
    schemaVersion,
    dataRootExpectation = 'development',
    expectedRestoredSessions = 0,
  } = options
  const checks: PreflightCheck[] = []

  if (!Number.isSafeInteger(expectedRestoredSessions) || expectedRestoredSessions < 0) {
    return {
      ok: false,
      checks,
      failure: {
        code: 'data-root-expectation-invalid',
        message: `The restored-session expectation is invalid: ${String(expectedRestoredSessions)}.`,
        recovery: 'Correct the desktop/supervisor handover before restarting. The journal was not opened.',
      },
    }
  }
  if (dataRootExpectation === 'first-run' && expectedRestoredSessions !== 0) {
    return {
      ok: false,
      checks,
      failure: {
        code: 'data-root-expectation-invalid',
        message: `A first-run root cannot expect ${expectedRestoredSessions} restored session(s).`,
        recovery: 'Mark the root as existing, or explicitly expect zero only for a genuine first run.',
      },
    }
  }
  if (dataRootExpectation === 'existing') {
    let rootStat: fs.Stats
    try {
      rootStat = fs.statSync(dataDir)
    } catch {
      return {
        ok: false,
        checks,
        failure: {
          code: 'expected-data-root-missing',
          message: `The expected existing hub data directory is missing or unreadable: ${dataDir}`,
          recovery: 'Restore or remount the exact data directory. Do not create a replacement journal in another location.',
        },
      }
    }
    if (!rootStat.isDirectory()) {
      return {
        ok: false,
        checks,
        failure: {
          code: 'expected-data-root-missing',
          message: `The expected hub data root is not a directory: ${dataDir}`,
          recovery: 'Restore the exact data directory. Do not allow the hub to create a replacement journal.',
        },
      }
    }
    let journalStat: fs.Stats
    try {
      journalStat = fs.statSync(journalPath)
    } catch {
      return {
        ok: false,
        checks,
        failure: {
          code: 'expected-journal-missing',
          message: `The expected existing journal is missing or unreadable: ${journalPath}`,
          recovery: 'Restore the expected hub.db or a verified backup. Explicitly choose first-run only if no prior journal should exist.',
        },
      }
    }
    if (!journalStat.isFile()) {
      return {
        ok: false,
        checks,
        failure: {
          code: 'expected-journal-missing',
          message: `The expected journal is not a regular file: ${journalPath}`,
          recovery: 'Restore the expected hub.db. Do not let the hub create another database over this path.',
        },
      }
    }
  }

  if (!fs.existsSync(journalPath)) {
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
    const failure = checkDataDirWritable(dataDir, checks)
    return failure ? { ok: false, checks, failure } : { ok: true, checks }
  }

  const databaseStarted = performance.now()
  let db: Database.Database | undefined
  let schemaChecked = false
  try {
    db = new Database(journalPath, { readonly: true, fileMustExist: true })
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
      return {
        ok: false,
        checks,
        failure: {
          code: 'schema-too-new',
          message: `The journal schema is v${storedVersion}, but this hub only supports through v${schemaVersion}.`,
          recovery:
            'Reinstall a hub version compatible with this database, or restore a backup created by this older version. Do not lower user_version by hand.',
        },
      }
    }

    const integrityStarted = performance.now()
    const rows = db.pragma('integrity_check') as Array<Record<string, unknown>>
    const findings = rows.flatMap((row) => Object.values(row).map(String))
    if (findings.length !== 1 || findings[0]?.toLowerCase() !== 'ok') {
      return {
        ok: false,
        checks,
        failure: {
          code: 'database-corrupt',
          message: `The journal failed PRAGMA integrity_check: ${findings.join('; ') || 'SQLite returned no result'}`,
          recovery:
            'Keep the damaged hub.db for recovery and restore a known-good backup. Creating a new journal requires an explicit first-run confirmation.',
        },
      }
    }
    checks.push({
      name: 'database-integrity',
      status: 'passed',
      detail: 'ok',
      durationMs: elapsed(integrityStarted),
    })

    if (expectedRestoredSessions > 0) {
      const floorStarted = performance.now()
      const hasSessionsTable = db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .get() as { present?: number } | undefined
      const persistedSessions = hasSessionsTable
        ? Number(
            (
              db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as
                | { count?: number | bigint }
                | undefined
            )?.count ?? 0
          )
        : 0
      if (persistedSessions < expectedRestoredSessions) {
        return {
          ok: false,
          checks,
          failure: {
            code: 'restored-session-floor-missed',
            message:
              `The selected journal contains ${persistedSessions} persisted session(s), but the supervisor ` +
              `expected at least ${expectedRestoredSessions}.`,
            recovery:
              `Keep ${journalPath} unchanged. Verify HUB_DATA_DIR and restore a known-good journal backup before retrying.`,
          },
        }
      }
      checks.push({
        name: 'restored-session-floor',
        status: 'passed',
        detail: `${persistedSessions} persisted session(s); expected at least ${expectedRestoredSessions}`,
        durationMs: elapsed(floorStarted),
      })
    }
  } catch (error) {
    const failure = corruptionFailure(error, journalPath)
    if (failure) return { ok: false, checks, failure }
    if (dataRootExpectation === 'existing' || expectedRestoredSessions > 0) {
      return {
        ok: false,
        checks,
        failure: {
          code: 'expected-journal-unreadable',
          message: `The expected existing journal could not be validated read-only (${journalPath}): ${errorText(error)}`,
          recovery:
            'Keep the journal unchanged. Restore read access or a verified backup, then retry with the same HUB_DATA_DIR.',
        },
      }
    }
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
  } finally {
    try {
      db?.close()
    } catch {
      /* a read-only preflight cleanup cannot make a healthy hub fail to boot */
    }
  }

  const failure = checkDataDirWritable(dataDir, checks)
  return failure ? { ok: false, checks, failure } : { ok: true, checks }
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
