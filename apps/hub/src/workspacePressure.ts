import fs from 'node:fs/promises'
import path from 'node:path'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import type { SessionRecord, WorkspacePressure } from './types.js'
import type { WorkspaceManager } from './workspace.js'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

export const WORKSPACE_PRESSURE_POLL_MS = 2 * 60_000
export const DEFAULT_WORKSPACE_PRESSURE_THRESHOLDS = {
  warningBytes: 4 * GIB,
  criticalBytes: 12 * GIB,
  warningArtifactBytes: 2 * GIB,
  criticalArtifactBytes: 8 * GIB,
  warningFreeBytes: 10 * GIB,
  criticalFreeBytes: 3 * GIB,
  minimumWorkspaceForDiskWarning: 512 * MIB,
} as const

export interface WorkspaceSizeScan {
  ok: true
  totalBytes: number
  artifactBytes: number
  artifactGroups: Array<{ name: string; bytes: number }>
  entries: number
  partial: boolean
  unreadableEntries: number
  durationMs: number
  freeBytes?: number
}

export interface WorkspaceSizeScanFailure {
  ok: false
  error: string
}

export interface WorkspaceScanOptions {
  maxEntries?: number
  maxDurationMs?: number
  stopAfterBytes?: number
  now?: () => number
}

export interface WorkspacePressureThresholds {
  warningBytes: number
  criticalBytes: number
  warningArtifactBytes: number
  criticalArtifactBytes: number
  warningFreeBytes: number
  criticalFreeBytes: number
  minimumWorkspaceForDiskWarning: number
}

const ARTIFACT_DIRECTORIES = new Map<string, string>([
  ['node_modules', 'node_modules'],
  ['target', 'Rust target'],
  ['dist', 'dist'],
  ['build', 'build'],
  ['out', 'out'],
  ['coverage', 'coverage'],
  ['.next', 'Next.js cache'],
  ['.nuxt', 'Nuxt cache'],
  ['.turbo', 'Turborepo cache'],
  ['.cache', 'tool caches'],
  ['__pycache__', 'Python bytecode'],
  ['.pytest_cache', 'pytest cache'],
  ['.venv', 'Python virtualenv'],
  ['venv', 'Python virtualenv'],
  ['bin', 'compiled bin'],
  ['obj', 'compiled obj'],
])

function safeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code ? `workspace scan failed (${code})` : 'workspace scan failed'
}

function artifactName(directoryName: string): string | undefined {
  return ARTIFACT_DIRECTORIES.get(directoryName.toLowerCase())
}

const OPERATION_TIMED_OUT = Symbol('workspace-operation-timed-out')

/**
 * Node's async filesystem calls do not block the event loop, but a disconnected WSL/network provider can
 * leave one promise unresolved indefinitely. Race every individual operation against the scan deadline.
 * The native operation cannot be cancelled; a late directory handle is explicitly closed by its caller.
 */
function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onLateValue?: (value: T) => void,
): Promise<T | typeof OPERATION_TIMED_OUT> {
  return new Promise((resolve, reject) => {
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      resolve(OPERATION_TIMED_OUT)
    }, Math.max(1, timeoutMs))
    operation.then(
      (value) => {
        if (expired) {
          onLateValue?.(value)
          return
        }
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (expired) return
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Bounded apparent-size scan. It never follows symlinks/junctions, yields frequently, and stops once
 * enough bytes have been observed to establish the critical condition. A partial scan is a lower bound,
 * never permission to clear an existing warning.
 */
export async function scanWorkspaceSize(
  workspace: string,
  options: WorkspaceScanOptions = {},
): Promise<WorkspaceSizeScan | WorkspaceSizeScanFailure> {
  const maxEntries = Math.max(1, options.maxEntries ?? 250_000)
  const maxDurationMs = Math.max(1, options.maxDurationMs ?? 8_000)
  const stopAfterBytes = Math.max(1, options.stopAfterBytes ?? DEFAULT_WORKSPACE_PRESSURE_THRESHOLDS.criticalBytes)
  const clock = options.now ?? (() => performance.now())
  const started = clock()
  const timeRemaining = (): number => Math.max(0, maxDurationMs - (clock() - started))
  let root: string
  try {
    const resolved = await withinDeadline(fs.realpath(workspace), timeRemaining())
    if (resolved === OPERATION_TIMED_OUT) return { ok: false, error: 'workspace scan timed out' }
    root = resolved
    const rootStat = await withinDeadline(fs.lstat(root), timeRemaining())
    if (rootStat === OPERATION_TIMED_OUT) return { ok: false, error: 'workspace scan timed out' }
    if (!rootStat.isDirectory()) return { ok: false, error: 'workspace is not a directory' }
  } catch (error) {
    return { ok: false, error: safeError(error) }
  }

  const ordinaryQueue: Array<{ directory: string; artifact?: string }> = [{ directory: root }]
  const artifactStack: Array<{ directory: string; artifact: string }> = []
  let ordinaryIndex = 0
  const artifacts = new Map<string, number>()
  let totalBytes = 0
  let artifactBytes = 0
  let entries = 0
  let unreadableEntries = 0
  let partial = false

  scan: while (artifactStack.length > 0 || ordinaryIndex < ordinaryQueue.length) {
    if (clock() - started >= maxDurationMs) {
      partial = true
      break
    }
    // Once an artifact root is found, walk it depth-first before unrelated source directories. This
    // makes a bounded scan find the bytes that matter even in a checkout with a very broad source tree.
    const current = artifactStack.pop() ?? ordinaryQueue[ordinaryIndex++]!
    let handle: Awaited<ReturnType<typeof fs.opendir>>
    try {
      const opened = await withinDeadline(
        fs.opendir(current.directory),
        timeRemaining(),
        (lateHandle) => void lateHandle.close().catch(() => {}),
      )
      if (opened === OPERATION_TIMED_OUT) {
        partial = true
        break
      }
      handle = opened
    } catch {
      unreadableEntries += 1
      partial = true
      continue
    }
    try {
      while (true) {
        const read = await withinDeadline(handle.read(), timeRemaining())
        if (read === OPERATION_TIMED_OUT) {
          partial = true
          break scan
        }
        const entry = read
        if (!entry) break
        entries += 1
        if (entries > maxEntries || clock() - started >= maxDurationMs) {
          partial = true
          break scan
        }
        const candidate = path.join(current.directory, entry.name)
        try {
          const stat = await withinDeadline(fs.lstat(candidate), timeRemaining())
          if (stat === OPERATION_TIMED_OUT) {
            partial = true
            break scan
          }
          if (stat.isSymbolicLink()) continue
          if (stat.isDirectory()) {
            const artifact = current.artifact ?? artifactName(entry.name)
            if (artifact) artifactStack.push({ directory: candidate, artifact })
            else ordinaryQueue.push({ directory: candidate })
          } else if (stat.isFile()) {
            const bytes = Math.max(0, stat.size)
            totalBytes += bytes
            if (current.artifact) {
              artifactBytes += bytes
              artifacts.set(current.artifact, (artifacts.get(current.artifact) ?? 0) + bytes)
            }
            if (totalBytes >= stopAfterBytes) {
              // The current directory iterator may still contain entries even when the queued
              // directory list is empty. Stopping on the byte ceiling is therefore always a
              // lower-bound result.
              partial = true
              break scan
            }
          }
        } catch {
          unreadableEntries += 1
          partial = true
        }
        if (entries % 256 === 0) await yieldImmediate()
      }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  let freeBytes: number | undefined
  if (timeRemaining() > 0) {
    try {
      const volume = await withinDeadline(fs.statfs(root), Math.min(1_000, timeRemaining()))
      if (volume !== OPERATION_TIMED_OUT) {
        freeBytes = Number(volume.bavail) * Number(volume.bsize)
        if (!Number.isSafeInteger(freeBytes)) freeBytes = undefined
      }
    } catch {
      // A network/WSL filesystem may not expose statfs through the host provider. Size alerts still work.
    }
  }
  return {
    ok: true,
    totalBytes,
    artifactBytes,
    artifactGroups: [...artifacts.entries()]
      .map(([name, bytes]) => ({ name, bytes }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5),
    entries: Math.min(entries, maxEntries),
    partial,
    unreadableEntries,
    durationMs: Math.max(0, Math.round((clock() - started) * 10) / 10),
    ...(freeBytes === undefined ? {} : { freeBytes }),
  }
}

export function classifyWorkspacePressure(
  scan: WorkspaceSizeScan,
  current: WorkspacePressure | undefined,
  thresholds: WorkspacePressureThresholds = DEFAULT_WORKSPACE_PRESSURE_THRESHOLDS,
  observedAt = new Date().toISOString(),
): WorkspacePressure | undefined {
  const warningHysteresis = current ? 0.75 : 1
  // A warning needs to reach the real critical boundary before escalating. The lower boundary is used
  // only to keep an already-critical condition stable while cleanup is in progress.
  const criticalHysteresis = current?.level === 'critical' ? 0.75 : 1
  const totalCritical = scan.totalBytes >= thresholds.criticalBytes * criticalHysteresis
  const artifactsCritical = scan.artifactBytes >= thresholds.criticalArtifactBytes * criticalHysteresis
  // Free-space thresholds run in the opposite direction from byte thresholds. Once a disk warning
  // exists, require 33% more headroom before clearing it instead of chattering at the boundary.
  const freeSpaceHysteresis = current ? 1 / 0.75 : 1
  const diskCritical =
    scan.totalBytes >= thresholds.minimumWorkspaceForDiskWarning &&
    scan.freeBytes !== undefined &&
    scan.freeBytes <=
      thresholds.criticalFreeBytes *
        (current?.level === 'critical' && current.reasons.includes('low-disk') ? freeSpaceHysteresis : 1)
  const totalWarning = scan.totalBytes >= thresholds.warningBytes * warningHysteresis
  const artifactsWarning = scan.artifactBytes >= thresholds.warningArtifactBytes * warningHysteresis
  const diskWarning =
    scan.totalBytes >= thresholds.minimumWorkspaceForDiskWarning &&
    scan.freeBytes !== undefined &&
    scan.freeBytes <=
      thresholds.warningFreeBytes * (current?.reasons.includes('low-disk') ? freeSpaceHysteresis : 1)
  const level = totalCritical || artifactsCritical || diskCritical
    ? 'critical'
    : totalWarning || artifactsWarning || diskWarning
      ? 'warning'
      : undefined
  if (!level) return undefined
  const reasons: WorkspacePressure['reasons'] = []
  if (level === 'critical' ? totalCritical : totalWarning) reasons.push('workspace-size')
  if (level === 'critical' ? artifactsCritical : artifactsWarning) reasons.push('build-artifacts')
  if (level === 'critical' ? diskCritical : diskWarning) reasons.push('low-disk')
  return {
    level,
    totalBytes: scan.totalBytes,
    artifactBytes: scan.artifactBytes,
    artifactGroups: scan.artifactGroups,
    reasons,
    partial: scan.partial,
    observedAt,
    ...(scan.freeBytes === undefined ? {} : { freeBytes: scan.freeBytes }),
    ...(current?.lastNotifiedAt ? { lastNotifiedAt: current.lastNotifiedAt } : {}),
  }
}

export function formatWorkspaceBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(bytes >= 10 * GIB ? 1 : 2)} GiB`
  return `${Math.max(0, Math.round(bytes / MIB))} MiB`
}

export function workspacePressureMessage(pressure: WorkspacePressure): string {
  const artifacts = pressure.artifactGroups.length
    ? pressure.artifactGroups
        .slice(0, 3)
        .map((group) => `${group.name} ${formatWorkspaceBytes(group.bytes)}`)
        .join(', ')
    : 'no single artifact directory identified'
  const lowerBound = pressure.partial ? 'at least ' : ''
  const disk = pressure.freeBytes === undefined
    ? ''
    : ` The volume has ${formatWorkspaceBytes(pressure.freeBytes)} free.`
  const urgency = pressure.level === 'critical'
    ? 'Pause additional builds and reclaim regenerable output before continuing.'
    : 'Avoid redundant rebuilds and reclaim regenerable output soon.'
  return (
    `Workspace size ${pressure.level}: this managed checkout is ${lowerBound}${formatWorkspaceBytes(pressure.totalBytes)} ` +
    `(${formatWorkspaceBytes(pressure.artifactBytes)} recognized build/dependency artifacts; ${artifacts}).${disk} ` +
    `${urgency} Remove only outputs you can regenerate (for example target, node_modules, dist, build, caches); ` +
    'do not delete source, uncommitted work, or required deliverables. Report what you cleaned up.'
  )
}

export interface WorkspacePressureMonitorOptions {
  sessions: () => readonly SessionRecord[]
  workspace: Pick<WorkspaceManager, 'isScratch'>
  report: (
    sessionId: string,
    pressure: WorkspacePressure | undefined,
    notifyAgent: boolean,
  ) => Promise<void> | void
  pollMs?: number
  maxWorkspacesPerPoll?: number
  repeatNotificationMs?: number
  thresholds?: WorkspacePressureThresholds
  scan?: typeof scanWorkspaceSize
  now?: () => number
  isoNow?: () => string
}

function scanPath(record: SessionRecord, workspace: Pick<WorkspaceManager, 'isScratch'>): string | undefined {
  if (record.worktree) return record.worktree
  return workspace.isScratch(record.cwd, record.id) ? record.cwd : undefined
}

function materiallyChanged(before: WorkspacePressure, after: WorkspacePressure): boolean {
  if (before.level !== after.level || before.partial !== after.partial) return true
  const baseline = Math.max(before.totalBytes, 1)
  if (Math.abs(after.totalBytes - before.totalBytes) / baseline >= 0.25) return true
  const priorArtifacts = before.artifactGroups.map((group) => group.name).join('\0')
  return priorArtifacts !== after.artifactGroups.map((group) => group.name).join('\0')
}

export class WorkspacePressureMonitor {
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false
  private readonly lastScanned = new Map<string, number>()

  constructor(private readonly options: WorkspacePressureMonitorOptions) {}

  start(): void {
    if (this.timer) return
    const pollMs = this.options.pollMs ?? WORKSPACE_PRESSURE_POLL_MS
    this.timer = setInterval(() => void this.poll(), pollMs)
    this.timer.unref?.()
    setImmediate(() => void this.poll())
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    const now = this.options.now?.() ?? Date.now()
    const isoNow = this.options.isoNow?.() ?? new Date(now).toISOString()
    const thresholds = this.options.thresholds ?? DEFAULT_WORKSPACE_PRESSURE_THRESHOLDS
    try {
      const candidates = this.options.sessions()
        .map((record) => ({ record, path: scanPath(record, this.options.workspace) }))
        .filter((entry): entry is { record: SessionRecord; path: string } => !!entry.path)
        .sort((a, b) => {
          const rank = (record: SessionRecord): number =>
            record.status === 'active' ? 0 : record.status === 'starting' ? 1 : record.status === 'idle' ? 2 : 3
          return rank(a.record) - rank(b.record) ||
            (this.lastScanned.get(a.record.id) ?? 0) - (this.lastScanned.get(b.record.id) ?? 0)
        })
        .slice(0, Math.max(1, this.options.maxWorkspacesPerPoll ?? 4))
      const liveIds = new Set(this.options.sessions().map((record) => record.id))
      for (const id of this.lastScanned.keys()) if (!liveIds.has(id)) this.lastScanned.delete(id)

      for (const { record, path: candidate } of candidates) {
        this.lastScanned.set(record.id, now)
        const scan = await (this.options.scan ?? scanWorkspaceSize)(candidate, {
          stopAfterBytes: thresholds.criticalBytes,
        })
        if (!scan.ok) continue
        const current = record.workspacePressure
        const pressure = classifyWorkspacePressure(scan, current, thresholds, isoNow)
        // A bounded partial scan is a lower bound. It may raise/escalate a warning, but never proves that
        // an existing condition cleared.
        if (!pressure && scan.partial && current) continue
        if (!pressure) {
          if (current) await this.options.report(record.id, undefined, false)
          continue
        }
        const repeatMs = this.options.repeatNotificationMs ?? 24 * 60 * 60_000
        const lastNotice = pressure.lastNotifiedAt ? Date.parse(pressure.lastNotifiedAt) : 0
        const notifyAgent =
          !current ||
          (current.level === 'warning' && pressure.level === 'critical') ||
          !Number.isFinite(lastNotice) ||
          now - lastNotice >= repeatMs
        if (notifyAgent) pressure.lastNotifiedAt = isoNow
        if (!current || materiallyChanged(current, pressure) || notifyAgent) {
          await this.options.report(record.id, pressure, notifyAgent)
        }
      }
    } finally {
      this.polling = false
    }
  }
}
