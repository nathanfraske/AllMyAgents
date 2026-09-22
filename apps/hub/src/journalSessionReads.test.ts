import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Journal } from './journal.js'

describe('indexed session inspection and turn provenance', () => {
  const roots: string[] = []
  const journals: Journal[] = []
  const open = (file?: string) => {
    if (!file) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-session-reads-'))
      roots.push(root)
      file = path.join(root, 'hub.db')
    }
    const journal = new Journal(file)
    journals.push(journal)
    return journal
  }
  afterEach(() => {
    vi.restoreAllMocks()
    for (const j of journals.splice(0)) if (j.db.open) j.db.close()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('uses session-key lookups for idle-agent status, transcript pages and turn authority', () => {
    const j = open()
    const expected = [j.append('idle', 'session/turn-origin', { origin: 'operator' }),
      j.append('idle', 'session/input', { text: 'kept' })]
    j.db.transaction(() => {
      for (let i = 0; i < 10_100; i++) j.append('busy', 'session/status', { status: 'active' })
    })()
    const prepare = vi.spyOn(j.db, 'prepare')
    expect(j.recentEventsForSession('idle')).toEqual([...expected].reverse())
    expect(j.eventsForSession('idle', 0, 1)).toEqual({ events: [expected[0]], nextAfterSeq: expected[0]!.seq })
    expect(j.lastTurnOrigin('idle')).toBe('operator')
    const reads = prepare.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('SELECT e.seq'))
    expect(reads).toHaveLength(3)
    prepare.mockRestore()
    // Structural performance gate, not a flaky millisecond bound: none of the three may walk other chats.
    for (const sql of reads) {
      expect(sql).toContain('journal_session_event_index AS si')
      const plan = j.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({
        session: 'idle', after: 0, limit: 100, ...(sql.includes('@kind') ? {kind:'session/turn-origin'} : {}),
      }) as {detail: string}[]
      expect(plan.map(row => row.detail).join('\n')).toMatch(/SEARCH si USING PRIMARY KEY/)
      expect(plan.map(row => row.detail).join('\n')).not.toMatch(/SCAN (?:events|e)\b/)
    }
    expect(j.eventsForSession('idle', expected[0]!.seq, 1)).toEqual({ events: [expected[1]], nextAfterSeq: null })
    expect(j.recentEventsForSession('absent')).toEqual([])
    expect(j.eventsForSession('absent')).toEqual({ events: [], nextAfterSeq: null })
    expect(j.lastTurnOrigin('absent')).toBeUndefined()
  })

  it('remains complete during partial backfill, across new appends, and after restart', () => {
    let j = open()
    const file = j.db.name
    const first = j.append('s', 'session/turn-origin', { origin: 'operator' })
    const hidden = j.append('s', 'session/turn-origin', { origin: 'bus' })
    j.db.prepare('DELETE FROM journal_session_event_index WHERE seq = ?').run(hidden.seq)
    j.db.prepare('UPDATE journal_session_index_state SET scanned_through = ?').run(first.seq)
    const newest = j.append('s', 'session/input', { text: 'indexed new row beyond an old gap' })
    const verify = () => {
      expect(j.lastTurnOrigin('s')).toBe('bus') // incomplete index must never revive old operator authority
      expect(j.recentEventsForSession('s').map(e => e.seq)).toEqual([newest.seq, hidden.seq, first.seq])
      const page = j.eventsForSession('s', first.seq, 1)
      expect(page.events.map(e => e.seq)).toEqual([hidden.seq])
      expect(page.nextAfterSeq).toBe(hidden.seq)
      expect(j.eventsForSession('s', page.nextAfterSeq!, 1).events.map(e => e.seq)).toEqual([newest.seq])
    }
    verify()
    j.db.close()
    j = open(file)
    verify()
    expect(j.backfillSessionEventIndex().complete).toBe(true)
    verify()
    j.db.prepare('DELETE FROM events WHERE seq = ?').run(hidden.seq)
    expect(j.lastTurnOrigin('s')).toBe('operator')
    expect(j.recentEventsForSession('s').map(e => e.seq)).toEqual([newest.seq, first.seq])
  })

  it('preserves hydration, malformed-payload handling, ordering and row caps', () => {
    const j = open()
    const text = 'large exact text '.repeat(10_000)
    j.append('s', 'session/input', {text})
    expect(j.recentEventsForSession('s')[0]!.payload).toEqual({text})
    expect(j.eventsForSession('s').events[0]!.payload).toEqual({text})
    const invalid = j.append('s', 'session/turn-origin', {origin:'operator'})
    j.db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run('{invalid', invalid.seq)
    expect(j.lastTurnOrigin('s')).toBeUndefined()
    expect(() => j.recentEventsForSession('s')).not.toThrow()
    expect(() => j.eventsForSession('s')).not.toThrow()
    j.db.transaction(() => {
      for (let i = 0; i < 510; i++) j.append('s', 'session/status', {status:'idle'})
    })()
    expect(j.recentEventsForSession('s', 999)).toHaveLength(100)
    const page = j.eventsForSession('s', 0, 999)
    expect(page.events).toHaveLength(500)
    expect(page.nextAfterSeq).toBe(page.events.at(-1)!.seq)
  })
})
