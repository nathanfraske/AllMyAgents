import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import { renderRestartContinuity } from './restartContinuity.js'

const roots: string[] = []

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('restart continuity', () => {
  it('renders recent operator context and the exact interrupted question without tool output', () => {
    const rendered = renderRestartContinuity([
      { seq: 1, kind: 'session/input', payload: { text: 'Help repair the trust policy.' } },
      {
        seq: 2,
        kind: 'claude/assistant',
        payload: {
          message: {
            content: [
              { type: 'text', text: 'I found three possible remedies.' },
              { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which expiry should I use?' }] } },
            ],
          },
        },
      },
      { seq: 3, kind: 'claude/user', payload: { tool_use_result: { content: 'secret tool output' } } },
    ])

    expect(rendered).toContain('OPERATOR: Help repair the trust policy.')
    expect(rendered).toContain('INTERRUPTED QUESTION')
    expect(rendered).toContain('Which expiry should I use?')
    expect(rendered).not.toContain('secret tool output')
    expect(rendered).toContain('Never claim the conversation is fresh')
  })

  it('returns an interruption exactly until its matching capsule is journaled', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-restart-continuity-'))
    roots.push(root)
    const journal = new Journal(path.join(root, 'hub.db'))
    try {
      journal.append('s1', 'session/input', { text: 'Ask me a deployment question.' })
      journal.append('s1', 'claude/assistant', {
        message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Blue or green?' }] } }] },
      })
      const interrupted = journal.append('s1', 'question/restart-interrupted', {
        questionCount: 1,
        turnBoundary: 'unknown',
      })

      const excerpt = journal.restartContinuityExcerpt('s1')
      expect(excerpt?.sourceSeq).toBe(interrupted.seq)
      expect(excerpt?.events.map((event) => event.kind)).toEqual(['session/input', 'claude/assistant'])

      journal.append('s1', 'session/restart-continuity-injected', { sourceSeq: interrupted.seq })
      expect(journal.restartContinuityExcerpt('s1')).toBeUndefined()
    } finally {
      journal.db.close()
    }
  })
})
