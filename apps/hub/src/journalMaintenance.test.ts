import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'

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
})
