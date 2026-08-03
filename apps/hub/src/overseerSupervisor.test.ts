import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readOverseerSupervisorStatus, writeOverseerSupervisorStatus } from './overseerSupervisor.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('journal-independent Overseer supervisor status', () => {
  it('persists bounded recovery state and only the designated profile identity from config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-overseer-supervisor-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      overseer: { profileId: 'codex-main', sessionId: 'secret-session' },
      security: { token: 'must-not-leak' },
    }))
    writeOverseerSupervisorStatus(dir, {
      phase: 'offline',
      detail: 'journal preflight refused',
      error: 'integrity check failed at C:\\private\\hub.db with token=must-not-leak',
      attempt: 3,
    })
    const value = readOverseerSupervisorStatus(dir)
    expect(value).toMatchObject({
      version: 1,
      phase: 'offline',
      overseerProfileId: 'codex-main',
      attempt: 3,
    })
    const raw = fs.readFileSync(path.join(dir, 'overseer-supervisor.json'), 'utf8')
    expect(raw).not.toContain('must-not-leak')
    expect(raw).not.toContain('secret-session')
    expect(raw).not.toContain('C:\\private')
    expect(value?.error).toMatch(/Journal validation/u)
  })
})
