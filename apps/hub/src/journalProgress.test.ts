import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  JournalProgressReporter,
  journalProgressFile,
  readJournalProgress,
  sizeAwareJournalMaintenanceBudgetMs,
  sizeAwareJournalMaintenanceNoProgressMs,
} from './journalProgress.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('out-of-band journal progress', () => {
  it('publishes complete instance-bound states and rejects stale instance identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-journal-progress-'))
    roots.push(root)
    const instance = '11111111-1111-4111-8111-111111111111'
    const operation = '22222222-2222-4222-8222-222222222222'
    const reporter = new JournalProgressReporter(root, 12345, instance)

    reporter.report({
      operationId: operation,
      phase: 'publishing-lineage',
      active: true,
      suspendWatchdog: true,
      rowsCompleted: 70_000,
      bytesCompleted: 1_688_000_000,
      databaseBytes: 1_770_000_000,
    })

    expect(readJournalProgress(root, 12345, instance)).toMatchObject({
      operationId: operation,
      sequence: 1,
      phase: 'publishing-lineage',
      active: true,
      suspendWatchdog: true,
      rowsCompleted: 70_000,
      bytesCompleted: 1_688_000_000,
    })
    expect(
      readJournalProgress(root, 12345, '33333333-3333-4333-8333-333333333333')
    ).toBeUndefined()

    reporter.report({
      operationId: operation,
      phase: 'completed',
      active: false,
      bytesCompleted: 1_770_000_000,
      databaseBytes: 1_770_000_000,
    })
    expect(readJournalProgress(root, 12345, instance)).toMatchObject({
      operationId: operation,
      sequence: 2,
      phase: 'completed',
      active: false,
      suspendWatchdog: false,
      bytesCompleted: 1_770_000_000,
    })
  })

  it('never lets heartbeat IO failure become a backup failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-journal-progress-error-'))
    roots.push(root)
    const instance = '11111111-1111-4111-8111-111111111111'
    const error = vi.fn()
    const file = journalProgressFile(root, 12346)
    fs.mkdirSync(file)
    const reporter = new JournalProgressReporter(root, 12346, instance, error)

    expect(() =>
      reporter.report({
        operationId: '22222222-2222-4222-8222-222222222222',
        phase: 'copying',
        active: true,
      })
    ).not.toThrow()
    expect(error).toHaveBeenCalledOnce()
  })

  it('scales work and no-progress windows with journal bytes', () => {
    expect(sizeAwareJournalMaintenanceBudgetMs(0)).toBe(4 * 60_000)
    expect(sizeAwareJournalMaintenanceBudgetMs(1_770_000_000)).toBe(7 * 90_000)
    expect(sizeAwareJournalMaintenanceNoProgressMs(0)).toBe(2 * 60_000)
    expect(sizeAwareJournalMaintenanceNoProgressMs(1_770_000_000)).toBe(4 * 60_000)
  })
})
