import { describe, expect, it, vi } from 'vitest'
import { JournalPressureMonitor, type JournalStoragePressure } from './journalPressure.js'

const empty: JournalStoragePressure = {
  fileBytes: 1,
  reusableBytes: 0,
  allocatedBytes: 1,
  retainedLogicalBytes: 1,
  retainedUniqueBytes: 1,
  backupFiles: 0,
  recoveryFiles: 0,
}

describe('JournalPressureMonitor', () => {
  it('stays silent below the configured storage bounds', async () => {
    const publish = vi.fn()
    const monitor = new JournalPressureMonitor({
      dbPath: 'unused',
      db: { pragma: vi.fn() } as never,
      notifications: { publish },
      inspect: async () => empty,
      thresholds: {
        allocatedWarningBytes: 10,
        allocatedCriticalBytes: 20,
        retainedWarningBytes: 10,
        retainedCriticalBytes: 20,
      },
    })
    expect(await monitor.poll()).toEqual(empty)
    expect(publish).not.toHaveBeenCalled()
  })

  it('reports unique retained bytes, reusable pages, and a day-bounded dedupe key', async () => {
    const publish = vi.fn()
    const snapshot = {
      ...empty,
      fileBytes: 18 * 1024,
      allocatedBytes: 8 * 1024,
      reusableBytes: 10 * 1024,
      retainedLogicalBytes: 50 * 1024,
      retainedUniqueBytes: 21 * 1024,
    }
    const monitor = new JournalPressureMonitor({
      dbPath: 'unused',
      db: { pragma: vi.fn() } as never,
      notifications: { publish },
      inspect: async () => snapshot,
      thresholds: {
        allocatedWarningBytes: 10 * 1024,
        allocatedCriticalBytes: 20 * 1024,
        retainedWarningBytes: 10 * 1024,
        retainedCriticalBytes: 20 * 1024,
      },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
    })
    await monitor.poll()
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'journal-pressure',
      severity: 'error',
      dedupeKey: 'journal-pressure:critical:2026-08-05',
      body: expect.stringContaining('reusable SQLite space'),
    }))
  })
})
