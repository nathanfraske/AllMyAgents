import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'

export const PREFLIGHT_EXIT_CODE = 78

export type PreflightFailureCode =
  | 'data-dir-not-writable'
  | 'database-corrupt'
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
      'Keep the damaged hub.db for recovery, then restore a known-good backup or move it aside and restart to create an empty journal.',
  }
}

export function runHubPreflight(options: {
  dataDir: string
  journalPath: string
  schemaVersion: number
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
    return { ok: true, checks }
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
            'Keep the damaged hub.db for recovery, then restore a known-good backup or move it aside and restart to create an empty journal.',
        },
      }
    }
    checks.push({
      name: 'database-integrity',
      status: 'passed',
      detail: 'ok',
      durationMs: elapsed(integrityStarted),
    })
  } catch (error) {
    const failure = corruptionFailure(error, journalPath)
    if (failure) return { ok: false, checks, failure }
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

  return { ok: true, checks }
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
