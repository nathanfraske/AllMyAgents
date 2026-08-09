import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import { createJournalSnapshotChildTask } from './journalBackupProcess.js'

const roots: string[] = []
const journals: Journal[] = []

afterEach(() => {
  for (const journal of journals.splice(0)) {
    try {
      journal.db.close()
    } catch {
      /* already closed */
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('journal backup child process', () => {
  it('copies and verifies a live journal without occupying the hub event loop', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-backup-child-'))
    roots.push(root)
    const journalPath = path.join(root, 'hub.db')
    const journal = new Journal(journalPath)
    journals.push(journal)
    for (let index = 0; index < 100; index += 1) {
      journal.append('session', 'test/event', { index, text: 'x'.repeat(256) })
    }
    const logs: string[] = []
    const phases: string[] = []
    let eventLoopTurns = 0
    const interval = setInterval(() => {
      eventLoopTurns += 1
    }, 1)
    const result = await createJournalSnapshotChildTask(journalPath)(journal.db, {
      dir: path.join(root, 'backups'),
      keep: 2,
      log: (message) => logs.push(message),
      onProgress: (progress) => phases.push(progress.phase),
    })
    clearInterval(interval)

    expect(result.ok).toBe(true)
    expect(eventLoopTurns).toBeGreaterThan(0)
    expect(phases).toContain('verifying-snapshot')
    expect(logs.some((message) => message.includes('verified snapshot'))).toBe(true)
    expect(result.file).toBeTruthy()
    const snapshot = new Database(result.file!, { readonly: true, fileMustExist: true })
    try {
      expect(
        snapshot.prepare('SELECT COUNT(*) FROM events').pluck().get()
      ).toBe(100)
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      snapshot.close()
    }
  }, 20_000)
})
