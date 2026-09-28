import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { Journal } from './journal.js'
import { snapshotJournal } from './journalBackup.js'

const cleanup: string[] = []
const children = new Map<ChildProcess, Promise<void>>()
// Resolve relative to this package, not the shell's cwd (Vitest --root does not chdir).
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

afterEach(async () => {
  for (const [child, closed] of children) {
    child.kill()
    await closed
  }
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function runMaintenance(args: string[], options: { cwd?: string; loader?: string } = {}): Promise<Record<string, unknown>> {
  const child = fork(new URL('./journalMaintenance.ts', import.meta.url), args, {
    cwd: options.cwd,
    execArgv: ['--import', options.loader ?? tsxLoader],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  children.set(child, new Promise(resolve => child.once('close', () => {
    children.delete(child)
    resolve()
  })))
  return new Promise((resolve, reject) => {
    let message: Record<string, unknown> | undefined
    let failure: Error | undefined
    let stderr = ''
    const timeout = setTimeout(() => {
      failure = new Error('journal maintenance child did not finish')
      child.kill()
    }, 15_000)
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096) })
    child.on('message', value => {
      const candidate = value as Record<string, unknown>
      if (['journal-condensed', 'journal-condense-deferred', 'journal-condense-error'].includes(String(candidate.type))) {
        message = candidate
      }
    })
    child.once('error', error => { failure = error })
    // Wait for closed pipes/process before inspecting or deleting its database. An early loader
    // failure must report its real error immediately, not masquerade as a 5-second test timeout.
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (failure) return reject(failure)
      if (!message) return reject(new Error(`maintenance exited before terminal IPC (exit ${code}, signal ${signal}): ${stderr}`))
      const expectedCode = message.type === 'journal-condense-error' ? 1 : 0
      if (code !== expectedCode) return reject(new Error(`maintenance IPC/exit mismatch: ${JSON.stringify(message)}; exit ${code}: ${stderr}`))
      resolve(message)
    })
  })
}

describe('journal maintenance steady state', () => {
  it('starts from an unrelated cwd and reports an early loader failure without waiting for timeout', async () => {
    const message = await runMaintenance([], { cwd: os.tmpdir() })
    expect(message).toMatchObject({ type: 'journal-condense-error', error: 'journal database path is required' })
    await expect(runMaintenance([], { cwd: os.tmpdir(), loader: new URL('./not-present-tsx-loader.mjs', import.meta.url).href }))
      .rejects.toThrow(/exited before terminal IPC.*[\s\S]*ERR_MODULE_NOT_FOUND/u)
    expect(children.size).toBe(0)
  })

  it('does not require or verify a recovery snapshot when there is no deletion candidate', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-maintenance-noop-'))
    cleanup.push(directory)
    const journalFile = path.join(directory, 'hub.db')
    const journal = new Journal(journalFile)
    journal.db.close()

    const operationId = '11111111-1111-4111-8111-111111111111'
    const message = await runMaintenance(
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
    )

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
    const message = await runMaintenance(
      [
        journalFile, path.join(directory, 'backups'), operationId, '3600000',
        '1000', '1000', '1000', String(1024 * 1024), '60000',
      ],
    )
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
    const message = await runMaintenance(
      [
        journalFile, backups, operationId, '0',
        '1000', '1000', '1000', String(1024 * 1024), '60000',
      ],
    )

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
