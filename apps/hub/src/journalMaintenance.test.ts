import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { Journal } from './journal.js'
import { snapshotJournal } from './journalBackup.js'

const cleanup: string[] = []

afterEach(() => {
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('journal maintenance steady state', () => {
  it('does not require or verify a recovery snapshot when there is no deletion candidate', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-maintenance-noop-'))
    cleanup.push(directory)
    const journalFile = path.join(directory, 'hub.db')
    const journal = new Journal(journalFile)
    journal.db.close()

    const operationId = '11111111-1111-4111-8111-111111111111'
    const child = fork(
      new URL('./journalMaintenance.ts', import.meta.url),
      [
        journalFile,
        path.join(directory, 'deliberately-missing-backups'),
        operationId,
        '3600000',
        '1000',
        '1000',
        '1000',
        String(1024 * 1024),
        '60000',
      ],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    )
    const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('journal maintenance child did not finish'))
      }, 15_000)
      child.on('message', (value) => {
        const candidate = value as Record<string, unknown>
        if (!['journal-condensed', 'journal-condense-deferred', 'journal-condense-error'].includes(String(candidate.type))) {
          return
        }
        clearTimeout(timeout)
        resolve(candidate)
      })
      child.once('error', reject)
    })

    if (message.type !== 'journal-condensed') {
      throw new Error(`maintenance returned ${JSON.stringify(message)}`)
    }
    expect(message).toMatchObject({
      type: 'journal-condensed',
      operationId,
      result: {
        commandOutputDeltasDeleted: 0,
        historyRowsDeleted: 0,
        writerLockMs: 0,
      },
    })
  })

  it('performs deferred payload validation before any maintenance mutation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-maintenance-invalid-'))
    cleanup.push(directory)
    const journalFile = path.join(directory, 'hub.db')
    const journal = new Journal(journalFile)
    journal.append('session-a', 'test/event', { valid: true })
    journal.db.close()
    const raw = new Database(journalFile)
    raw.prepare('UPDATE events SET payload = ? WHERE kind = ?').run('not-json', 'test/event')
    raw.close()

    const operationId = '22222222-2222-4222-8222-222222222222'
    const child = fork(
      new URL('./journalMaintenance.ts', import.meta.url),
      [
        journalFile, path.join(directory, 'backups'), operationId, '3600000',
        '1000', '1000', '1000', String(1024 * 1024), '60000',
      ],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    )
    const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('journal maintenance child did not finish'))
      }, 15_000)
      child.on('message', (value) => {
        const candidate = value as Record<string, unknown>
        if (candidate.type !== 'journal-condense-error') return
        clearTimeout(timeout)
        resolve(candidate)
      })
      child.once('error', reject)
    })
    expect(message).toMatchObject({
      type: 'journal-condense-error',
      operationId,
      error: expect.stringMatching(/invalid JSON.*maintenance refused/iu),
    })
  })

  it('deletes the eligible prefix covered by the newest recovery generation while retaining newer candidates', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-maintenance-covered-prefix-'))
    cleanup.push(directory)
    const journalFile = path.join(directory, 'hub.db')
    const backups = path.join(directory, 'backups')
    const journal = new Journal(journalFile)
    journal.append('session-a', 'codex/item/completed', {
      threadId: 'thread-a',
      turnId: 'turn-a',
      item: {
        type: 'commandExecution', id: 'command-a', command: 'echo test',
        aggregatedOutput: 'test\n', exitCode: 0,
      },
    })
    const covered = journal.append('session-a', 'codex/item/commandExecution/outputDelta', {
      threadId: 'thread-a', turnId: 'turn-a', itemId: 'command-a', delta: 'covered',
    }).seq
    const snapshot = await snapshotJournal(journal.db, {
      dir: backups,
      recoveryDataDir: directory,
      recoveryKeep: 2,
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    })
    if (!snapshot.ok) throw new Error(`strong snapshot failed: ${snapshot.error}`)
    const newer = journal.append('session-a', 'codex/item/commandExecution/outputDelta', {
      threadId: 'thread-a', turnId: 'turn-a', itemId: 'command-a', delta: 'not covered yet',
    }).seq
    journal.db.close()

    const operationId = '33333333-3333-4333-8333-333333333333'
    const child = fork(
      new URL('./journalMaintenance.ts', import.meta.url),
      [
        journalFile, backups, operationId, '0',
        '1000', '1000', '1000', String(1024 * 1024), '60000',
      ],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    )
    const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('journal maintenance child did not finish'))
      }, 30_000)
      child.on('message', (value) => {
        const candidate = value as Record<string, unknown>
        if (!['journal-condensed', 'journal-condense-deferred', 'journal-condense-error'].includes(String(candidate.type))) return
        clearTimeout(timeout)
        resolve(candidate)
      })
      child.once('error', reject)
    })

    expect(message).toMatchObject({
      type: 'journal-condensed',
      operationId,
      result: { commandOutputDeltasDeleted: 1 },
    })
    const raw = new Database(journalFile, { readonly: true })
    expect(raw.prepare('SELECT seq FROM events WHERE seq = ?').get(covered)).toBeUndefined()
    expect(raw.prepare('SELECT seq FROM events WHERE seq = ?').get(newer)).toEqual({ seq: newer })
    raw.close()
  })
})
