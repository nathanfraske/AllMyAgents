import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { repairCodexRolloutPaths } from './codexRolloutRelocation.js'

const roots: string[] = []

function profile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-codex-rollout-'))
  roots.push(root)
  return root
}

function stateDatabase(root: string): Database.Database {
  const db = new Database(path.join(root, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)')
  return db
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Codex rollout path relocation', () => {
  it('rebases a missing packaged-AppData path to the identical rollout under the current profile', () => {
    const root = profile()
    const threadId = '019fb040-8e8c-7c92-98fc-92b9acdf398a'
    const relative = path.join('2026', '07', '29', `rollout-2026-07-29T18-40-48-${threadId}.jsonl`)
    const current = path.join(root, 'sessions', relative)
    fs.mkdirSync(path.dirname(current), { recursive: true })
    fs.writeFileSync(current, '{}\n')
    const stale = `\\\\?\\C:\\Users\\Admin\\AppData\\Local\\Packages\\OldApp\\LocalCache\\Roaming\\AllMyAgents\\profiles\\codex-b\\sessions\\${relative.replaceAll(path.sep, '\\')}`
    const db = stateDatabase(root)
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(threadId, stale)
    db.close()

    expect(repairCodexRolloutPaths(root)).toEqual({
      repairs: [{
        stateDatabase: 'state_5.sqlite',
        threadId,
        rolloutRelativePath: path.join('sessions', relative),
      }],
      warnings: [],
    })
    const checked = new Database(path.join(root, 'state_5.sqlite'), { readonly: true })
    const row = checked.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId) as { rollout_path: string }
    checked.close()
    expect(fs.realpathSync.native(row.rollout_path)).toBe(fs.realpathSync.native(current))
  })

  it('leaves an existing indexed rollout untouched', () => {
    const root = profile()
    const threadId = 'thread-existing'
    const current = path.join(root, 'sessions', `rollout-now-${threadId}.jsonl`)
    fs.mkdirSync(path.dirname(current), { recursive: true })
    fs.writeFileSync(current, '{}\n')
    const db = stateDatabase(root)
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(threadId, current)
    db.close()

    expect(repairCodexRolloutPaths(root)).toEqual({ repairs: [], warnings: [] })
  })

  it('does not guess when the same relative rollout is absent', () => {
    const root = profile()
    const threadId = 'thread-missing'
    const db = stateDatabase(root)
    const stale = `C:\\old\\sessions\\2026\\07\\29\\rollout-now-${threadId}.jsonl`
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(threadId, stale)
    db.close()

    expect(repairCodexRolloutPaths(root)).toEqual({ repairs: [], warnings: [] })
    const checked = new Database(path.join(root, 'state_5.sqlite'), { readonly: true })
    const row = checked.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId) as { rollout_path: string }
    checked.close()
    expect(row.rollout_path).toBe(stale)
  })

  it('rejects a sessions-relative traversal even if its target is a real matching file', () => {
    const root = profile()
    const threadId = 'thread-escape'
    const outside = path.join(root, `rollout-now-${threadId}.jsonl`)
    fs.writeFileSync(outside, '{}\n')
    const db = stateDatabase(root)
    const stale = `C:\\old\\sessions\\..\\rollout-now-${threadId}.jsonl`
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(threadId, stale)
    db.close()

    expect(repairCodexRolloutPaths(root)).toEqual({ repairs: [], warnings: [] })
  })
})
