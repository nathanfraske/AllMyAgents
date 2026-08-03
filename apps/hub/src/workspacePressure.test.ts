import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord, WorkspacePressure } from './types.js'
import {
  classifyWorkspacePressure,
  scanWorkspaceSize,
  WorkspacePressureMonitor,
  type WorkspacePressureThresholds,
  type WorkspaceSizeScan,
} from './workspacePressure.js'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-pressure-'))
  roots.push(root)
  return root
}

function thresholds(over: Partial<WorkspacePressureThresholds> = {}): WorkspacePressureThresholds {
  return {
    warningBytes: 1_000,
    criticalBytes: 10_000,
    warningArtifactBytes: 500,
    criticalArtifactBytes: 5_000,
    warningFreeBytes: 1_000,
    criticalFreeBytes: 100,
    minimumWorkspaceForDiskWarning: 100,
    ...over,
  }
}

function scan(over: Partial<WorkspaceSizeScan> = {}): WorkspaceSizeScan {
  return {
    ok: true,
    totalBytes: 0,
    artifactBytes: 0,
    artifactGroups: [],
    entries: 0,
    partial: false,
    unreadableEntries: 0,
    durationMs: 1,
    ...over,
  }
}

function session(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    profileId: 'codex-a',
    provider: 'codex',
    cwd: `C:\\project\\${id}`,
    status: 'idle',
    createdAt: '2026-08-02T00:00:00.000Z',
    ...over,
  }
}

describe('managed workspace size scanning', () => {
  it('counts recognized artifacts but never follows symlinks or junctions', async () => {
    const root = tempRoot()
    const outside = tempRoot()
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(root, 'source.ts'), Buffer.alloc(64))
    fs.writeFileSync(path.join(root, 'node_modules', 'package.bin'), Buffer.alloc(1_000))
    fs.writeFileSync(path.join(outside, 'do-not-count.bin'), Buffer.alloc(4_096))
    fs.symlinkSync(outside, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = await scanWorkspaceSize(root, { stopAfterBytes: 100_000 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.totalBytes).toBe(1_064)
    expect(result.artifactBytes).toBe(1_000)
    expect(result.artifactGroups).toEqual([{ name: 'node_modules', bytes: 1_000 }])
    expect(result.partial).toBe(false)
  })

  it('marks a byte-ceiling result as a lower bound even when no directory remains queued', async () => {
    const root = tempRoot()
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(2_000))

    const result = await scanWorkspaceSize(root, { stopAfterBytes: 1_000 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.totalBytes).toBe(2_000)
      expect(result.partial).toBe(true)
    }
  })

  it('bounds an individual filesystem call so a disconnected provider cannot stop future scans', async () => {
    vi.spyOn(fsPromises, 'realpath').mockImplementationOnce(() => new Promise(() => {}))

    const started = Date.now()
    const result = await scanWorkspaceSize('unreachable-workspace', { maxDurationMs: 15 })

    expect(result).toEqual({ ok: false, error: 'workspace scan timed out' })
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('classifies artifact and low-disk pressure independently of total size', () => {
    expect(
      classifyWorkspacePressure(
        scan({ totalBytes: 600, artifactBytes: 550, freeBytes: 20_000 }),
        undefined,
        thresholds(),
      ),
    ).toMatchObject({ level: 'warning', reasons: ['build-artifacts'] })

    expect(
      classifyWorkspacePressure(
        scan({ totalBytes: 200, artifactBytes: 0, freeBytes: 50 }),
        undefined,
        thresholds(),
      ),
    ).toMatchObject({ level: 'critical', reasons: ['low-disk'] })
  })

  it('uses hysteresis so a just-cleaned workspace does not chatter at the warning boundary', () => {
    const current: WorkspacePressure = {
      level: 'warning',
      totalBytes: 1_100,
      artifactBytes: 0,
      artifactGroups: [],
      reasons: ['workspace-size'],
      partial: false,
      observedAt: '2026-08-02T00:00:00.000Z',
    }
    expect(classifyWorkspacePressure(scan({ totalBytes: 800 }), current, thresholds())).toBeDefined()
    expect(classifyWorkspacePressure(scan({ totalBytes: 700 }), current, thresholds())).toBeUndefined()
    expect(classifyWorkspacePressure(scan({ totalBytes: 9_500 }), current, thresholds())).toMatchObject({
      level: 'warning',
    })
  })
})

describe('WorkspacePressureMonitor', () => {
  it('scans only hub-managed worktrees/scratch spaces and repeats notices on a bounded cadence', async () => {
    const managed = session('managed', { worktree: 'C:\\managed\\one', status: 'active' })
    const direct = session('direct')
    const records = [managed, direct]
    const reports: Array<{ id: string; pressure?: WorkspacePressure; notify: boolean }> = []
    let now = Date.parse('2026-08-02T00:00:00.000Z')
    const scanFn = vi.fn(async () => scan({ totalBytes: 2_000 }))
    const monitor = new WorkspacePressureMonitor({
      sessions: () => records,
      workspace: { isScratch: () => false },
      scan: scanFn,
      thresholds: thresholds({ warningArtifactBytes: 50_000 }),
      repeatNotificationMs: 1_000,
      now: () => now,
      isoNow: () => new Date(now).toISOString(),
      report: (id, pressure, notify) => {
        reports.push({ id, pressure, notify })
        managed.workspacePressure = pressure
      },
    })

    await monitor.poll()
    expect(scanFn).toHaveBeenCalledTimes(1)
    expect(reports).toMatchObject([{ id: 'managed', notify: true }])

    await monitor.poll()
    expect(reports).toHaveLength(1)

    now += 1_001
    await monitor.poll()
    expect(reports).toHaveLength(2)
    expect(reports[1]).toMatchObject({ id: 'managed', notify: true })
  })

  it('never clears an existing warning from a partial lower-bound scan', async () => {
    const existing: WorkspacePressure = {
      level: 'warning',
      totalBytes: 2_000,
      artifactBytes: 0,
      artifactGroups: [],
      reasons: ['workspace-size'],
      partial: false,
      observedAt: '2026-08-02T00:00:00.000Z',
    }
    const managed = session('managed', {
      worktree: 'C:\\managed\\one',
      workspacePressure: existing,
    })
    const report = vi.fn()
    const monitor = new WorkspacePressureMonitor({
      sessions: () => [managed],
      workspace: { isScratch: () => false },
      scan: async () => scan({ totalBytes: 10, partial: true }),
      thresholds: thresholds(),
      report,
    })

    await monitor.poll()

    expect(report).not.toHaveBeenCalled()
    expect(managed.workspacePressure).toBe(existing)
  })
})
