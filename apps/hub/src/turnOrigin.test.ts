import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Journal } from './journal.js'

/**
 * REGRESSION — a turn that outlived its hub lost the fact that the OPERATOR started it.
 *
 * Turn provenance decides whether the hub may auto-approve a tool call: the operator's own turn may, a
 * teammate's bus-delivered turn must not. It lived only in hub memory, so a restart erased it — and the
 * policy correctly fails closed on "unknown", which meant a surviving Full Access turn began raising
 * approvals mid-work for tools it had been running freely a second earlier. The agent stalls on a prompt
 * the operator never expected and may not even be looking at.
 *
 * Observed exactly that in the sandbox: hub killed mid-turn, hub recovered in 3s, and the turn then sat
 * blocked on an `approval/requested` having written none of its files. After this fix the same test wrote
 * all ten and raised zero approvals.
 *
 * Journaling the origin makes it last as long as the turn does, rather than as long as the process.
 */
const dirs: string[] = []
const opened: Journal[] = []
afterEach(() => {
  for (const j of opened.splice(0)) j.db.close()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function makeJournal(): Journal {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-origin-'))
  dirs.push(dir)
  const j = new Journal(path.join(dir, 'hub.db'))
  opened.push(j)
  return j
}

describe('Journal.lastTurnOrigin', () => {
  it('is undefined for a session that has never run a turn', () => {
    expect(makeJournal().lastTurnOrigin('s1')).toBeUndefined()
  })

  it('reads back an operator turn', () => {
    const j = makeJournal()
    j.append('s1', 'session/turn-origin', { origin: 'operator' })
    expect(j.lastTurnOrigin('s1')).toBe('operator')
  })

  it('reads back a bus turn — the case that must NOT be auto-approved', () => {
    const j = makeJournal()
    j.append('s1', 'session/turn-origin', { origin: 'bus' })
    expect(j.lastTurnOrigin('s1')).toBe('bus')
  })

  /** The CURRENT turn's origin, not the first one — a chat alternates between operator and bus turns. */
  it('returns the most recent origin, not the earliest', () => {
    const j = makeJournal()
    j.append('s1', 'session/turn-origin', { origin: 'operator' })
    j.append('s1', 'session/turn-origin', { origin: 'bus' })
    expect(j.lastTurnOrigin('s1')).toBe('bus')
    j.append('s1', 'session/turn-origin', { origin: 'operator' })
    expect(j.lastTurnOrigin('s1')).toBe('operator')
  })

  it('does not leak one session\'s provenance into another', () => {
    const j = makeJournal()
    j.append('s1', 'session/turn-origin', { origin: 'operator' })
    expect(j.lastTurnOrigin('s2')).toBeUndefined()
  })

  /** Anything unrecognised stays undefined, so the policy keeps failing closed rather than guessing. */
  it('treats an unrecognised or malformed origin as unknown', () => {
    const j = makeJournal()
    j.append('s1', 'session/turn-origin', { origin: 'something-else' })
    expect(j.lastTurnOrigin('s1')).toBeUndefined()
    j.append('s2', 'session/turn-origin', {})
    expect(j.lastTurnOrigin('s2')).toBeUndefined()
  })

  it('ignores other event kinds', () => {
    const j = makeJournal()
    j.append('s1', 'session/input', { text: 'origin: operator' })
    expect(j.lastTurnOrigin('s1')).toBeUndefined()
  })
})
