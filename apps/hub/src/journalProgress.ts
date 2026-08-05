import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const FORMAT = 1 as const
const MAX_PROGRESS_BYTES = 64 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type JournalProgressUpdate = {
  operationId: string
  phase: string
  active: boolean
  suspendWatchdog?: boolean
  rowsCompleted?: number
  bytesCompleted?: number
  databaseBytes?: number
  detail?: string
}

export type JournalProgressState = {
  format: 1
  ownerPid: number
  ownerInstanceId: string
  operationId: string
  sequence: number
  phase: string
  active: boolean
  suspendWatchdog: boolean
  rowsCompleted: number
  bytesCompleted: number
  databaseBytes: number
  startedAtMs: number
  updatedAtMs: number
  detail: string
}

export function journalProgressFile(dataDir: string, ownerPid: number): string {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) {
    throw new Error('journal progress owner pid must be a positive integer')
  }
  return path.join(path.resolve(dataDir), `.journal-progress-${ownerPid}.json`)
}

function boundedCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function boundedText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximum)
}

/**
 * A tiny out-of-band heartbeat that the supervisor can read even while the hub's JavaScript event loop
 * is blocked in SQLite verification or hashing. It is diagnostic/progress state only, never journal
 * authority. Publication is one same-directory rename so a reader sees the previous or next full JSON.
 */
export class JournalProgressReporter {
  private sequence = 0
  private operationId = ''
  private startedAtMs = 0
  private readonly file: string

  constructor(
    dataDir: string,
    private readonly ownerPid: number,
    private readonly ownerInstanceId: string,
    private readonly onError: (error: unknown) => void = () => {}
  ) {
    if (!UUID.test(ownerInstanceId)) {
      throw new Error('journal progress owner instance id must be a UUID')
    }
    this.file = journalProgressFile(dataDir, ownerPid)
  }

  report(update: JournalProgressUpdate): void {
    try {
      if (!UUID.test(update.operationId)) throw new Error('journal progress operation id must be a UUID')
      const now = Date.now()
      if (this.operationId !== update.operationId) {
        this.operationId = update.operationId
        this.startedAtMs = now
      }
      const state: JournalProgressState = {
        format: FORMAT,
        ownerPid: this.ownerPid,
        ownerInstanceId: this.ownerInstanceId,
        operationId: update.operationId,
        sequence: ++this.sequence,
        phase: boundedText(update.phase, 80),
        active: update.active,
        suspendWatchdog: update.suspendWatchdog === true,
        rowsCompleted: boundedCount(update.rowsCompleted),
        bytesCompleted: boundedCount(update.bytesCompleted),
        databaseBytes: boundedCount(update.databaseBytes),
        startedAtMs: this.startedAtMs,
        updatedAtMs: now,
        detail: boundedText(update.detail ?? '', 512),
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp-${process.pid}-${crypto.randomUUID()}`
      try {
        const bytes = `${JSON.stringify(state)}\n`
        if (Buffer.byteLength(bytes) > MAX_PROGRESS_BYTES) {
          throw new Error('journal progress heartbeat exceeded its byte bound')
        }
        const fd = fs.openSync(temporary, 'wx')
        try {
          fs.writeFileSync(fd, bytes, 'utf8')
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        fs.renameSync(temporary, this.file)
      } finally {
        try {
          fs.rmSync(temporary, { force: true })
        } catch {
          /* heartbeat publication failure is reported through onError */
        }
      }
    } catch (error) {
      this.onError(error)
    }
  }
}

export function readJournalProgress(
  dataDir: string,
  ownerPid: number,
  ownerInstanceId: string
): JournalProgressState | undefined {
  try {
    const file = journalProgressFile(dataDir, ownerPid)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROGRESS_BYTES) return undefined
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<JournalProgressState>
    if (
      value.format !== FORMAT ||
      value.ownerPid !== ownerPid ||
      value.ownerInstanceId !== ownerInstanceId ||
      !UUID.test(value.operationId ?? '') ||
      !Number.isSafeInteger(value.sequence) ||
      Number(value.sequence) < 1 ||
      typeof value.phase !== 'string' ||
      value.phase.length > 80 ||
      typeof value.active !== 'boolean' ||
      typeof value.suspendWatchdog !== 'boolean' ||
      !Number.isSafeInteger(value.rowsCompleted) ||
      Number(value.rowsCompleted) < 0 ||
      !Number.isSafeInteger(value.bytesCompleted) ||
      Number(value.bytesCompleted) < 0 ||
      !Number.isSafeInteger(value.databaseBytes) ||
      Number(value.databaseBytes) < 0 ||
      !Number.isSafeInteger(value.startedAtMs) ||
      Number(value.startedAtMs) < 1 ||
      !Number.isSafeInteger(value.updatedAtMs) ||
      Number(value.updatedAtMs) < Number(value.startedAtMs) ||
      typeof value.detail !== 'string' ||
      value.detail.length > 512
    ) {
      return undefined
    }
    return value as JournalProgressState
  } catch {
    return undefined
  }
}

const MIB = 1024 * 1024

/** A 1.7 GiB journal gets ~10.5 minutes instead of the old fixed four-minute livelock window. */
export function sizeAwareJournalMaintenanceBudgetMs(databaseBytes: number): number {
  const bytes = boundedCount(databaseBytes)
  const chunks = Math.max(1, Math.ceil(bytes / (256 * MIB)))
  return Math.min(30 * 60_000, Math.max(4 * 60_000, chunks * 90_000))
}

/** A bounded SQL batch may be slow on a saturated disk, but silence must eventually be observable. */
export function sizeAwareJournalMaintenanceNoProgressMs(databaseBytes: number): number {
  const bytes = boundedCount(databaseBytes)
  const chunks = Math.max(1, Math.ceil(bytes / (512 * MIB)))
  return Math.min(10 * 60_000, Math.max(2 * 60_000, chunks * 60_000))
}
