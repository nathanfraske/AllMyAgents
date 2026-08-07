import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { NotificationService } from './notifications.js'

export interface JournalStoragePressure {
  fileBytes: number
  reusableBytes: number
  allocatedBytes: number
  retainedLogicalBytes: number
  retainedUniqueBytes: number
  backupFiles: number
  recoveryFiles: number
}

export interface JournalPressureThresholds {
  allocatedWarningBytes: number
  allocatedCriticalBytes: number
  retainedWarningBytes: number
  retainedCriticalBytes: number
}

export const DEFAULT_JOURNAL_PRESSURE_THRESHOLDS: JournalPressureThresholds = {
  allocatedWarningBytes: 1.5 * 1024 * 1024 * 1024,
  allocatedCriticalBytes: 4 * 1024 * 1024 * 1024,
  retainedWarningBytes: 8 * 1024 * 1024 * 1024,
  retainedCriticalBytes: 16 * 1024 * 1024 * 1024,
}

function formatBytes(value: number): string {
  const gib = value / (1024 * 1024 * 1024)
  return gib >= 0.1 ? `${gib.toFixed(1)} GiB` : `${(value / (1024 * 1024)).toFixed(0)} MiB`
}

async function directoryInventory(root: string, seen: Set<string>): Promise<{
  files: number
  logicalBytes: number
  uniqueBytes: number
}> {
  let files = 0
  let logicalBytes = 0
  let uniqueBytes = 0
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(target)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = await fs.promises.stat(target, { bigint: true })
        const bytes = Number(stat.size)
        files += 1
        logicalBytes += bytes
        const identity = stat.ino === 0n
          ? `path:${path.resolve(target).toLocaleLowerCase()}`
          : `${stat.dev}:${stat.ino}`
        if (!seen.has(identity)) {
          seen.add(identity)
          uniqueBytes += bytes
        }
      } catch {
        // Backup rotation can remove an oldest generation between readdir and stat.
      }
    }
  }
  return { files, logicalBytes, uniqueBytes }
}

export async function inspectJournalStorage(
  dbPath: string,
  db: Pick<Database.Database, 'pragma'>,
): Promise<JournalStoragePressure> {
  const fileBytes = (await fs.promises.stat(dbPath)).size
  const pageSize = Number(db.pragma('page_size', { simple: true }))
  const freePages = Number(db.pragma('freelist_count', { simple: true }))
  const reusableBytes = Number.isSafeInteger(pageSize) && Number.isSafeInteger(freePages)
    ? pageSize * freePages
    : 0
  const dataDir = path.dirname(dbPath)
  const seen = new Set<string>()
  const backups = await directoryInventory(path.join(dataDir, 'backups'), seen)
  const recovery = await directoryInventory(path.join(dataDir, 'journal-recovery'), seen)
  return {
    fileBytes,
    reusableBytes,
    allocatedBytes: Math.max(0, fileBytes - reusableBytes),
    retainedLogicalBytes: backups.logicalBytes + recovery.logicalBytes,
    retainedUniqueBytes: backups.uniqueBytes + recovery.uniqueBytes,
    backupFiles: backups.files,
    recoveryFiles: recovery.files,
  }
}

export interface JournalPressureMonitorOptions {
  dbPath: string
  db: Pick<Database.Database, 'pragma'>
  notifications: Pick<NotificationService, 'publish'>
  thresholds?: JournalPressureThresholds
  inspect?: typeof inspectJournalStorage
  pollMs?: number
  initialDelayMs?: number
  now?: () => Date
}

/** Low-frequency storage telemetry. It performs no event-table scan and never writes the main journal. */
export class JournalPressureMonitor {
  private interval: ReturnType<typeof setInterval> | undefined
  private initial: ReturnType<typeof setTimeout> | undefined
  private polling = false

  constructor(private readonly options: JournalPressureMonitorOptions) {}

  start(): void {
    if (this.interval || this.initial) return
    this.initial = setTimeout(() => {
      this.initial = undefined
      void this.poll()
    }, this.options.initialDelayMs ?? 30_000)
    this.initial.unref?.()
    this.interval = setInterval(
      () => void this.poll(),
      this.options.pollMs ?? 30 * 60_000,
    )
    this.interval.unref?.()
  }

  stop(): void {
    if (this.initial) clearTimeout(this.initial)
    if (this.interval) clearInterval(this.interval)
    this.initial = undefined
    this.interval = undefined
  }

  async poll(): Promise<JournalStoragePressure | undefined> {
    if (this.polling) return undefined
    this.polling = true
    try {
      const snapshot = await (this.options.inspect ?? inspectJournalStorage)(
        this.options.dbPath,
        this.options.db,
      )
      const thresholds = this.options.thresholds ?? DEFAULT_JOURNAL_PRESSURE_THRESHOLDS
      const critical =
        snapshot.allocatedBytes >= thresholds.allocatedCriticalBytes ||
        snapshot.retainedUniqueBytes >= thresholds.retainedCriticalBytes
      const warning =
        critical ||
        snapshot.allocatedBytes >= thresholds.allocatedWarningBytes ||
        snapshot.retainedUniqueBytes >= thresholds.retainedWarningBytes
      if (!warning) return snapshot
      const now = this.options.now?.() ?? new Date()
      const reusable = snapshot.reusableBytes > 0
        ? ` ${formatBytes(snapshot.reusableBytes)} of the live file is already reusable SQLite space.`
        : ''
      this.options.notifications.publish({
        kind: 'journal-pressure',
        severity: critical ? 'error' : 'warning',
        sourceRole: 'system',
        route: 'operator',
        title: critical ? 'Journal storage pressure is critical' : 'Journal storage is growing',
        body:
          `Live journal ${formatBytes(snapshot.fileBytes)} (${formatBytes(snapshot.allocatedBytes)} allocated). ` +
          `Backups and recovery retain ${formatBytes(snapshot.retainedUniqueBytes)} of unique file data ` +
          `(${formatBytes(snapshot.retainedLogicalBytes)} across directory entries).${reusable} ` +
          'Open Settings → System or run pnpm journal:audit for the event-kind and retention breakdown.',
        dedupeKey: `journal-pressure:${critical ? 'critical' : 'warning'}:${now.toISOString().slice(0, 10)}`,
        createdAt: now.toISOString(),
      })
      return snapshot
    } finally {
      this.polling = false
    }
  }
}
