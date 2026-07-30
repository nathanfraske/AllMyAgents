import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import type { CodexLimitInfo, HubConfig, Profile } from './types.js'
import { UsageMonitor } from './usage.js'

const roots: string[] = []
const journals: Journal[] = []

afterEach(() => {
  for (const journal of journals.splice(0)) journal.db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function monitor(): { usage: UsageMonitor; journal: Journal } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-usage-authority-'))
  roots.push(root)
  const journal = new Journal(path.join(root, 'hub.db'))
  journals.push(journal)
  const profile: Profile = {
    id: 'codex-a',
    provider: 'codex',
    dir: path.join(root, 'profile'),
  }
  return {
    usage: new UsageMonitor(journal, [profile], {} as HubConfig),
    journal,
  }
}

describe('profile-scoped usage publication authority', () => {
  it('discards an async usage result when the profile epoch changes before publication', async () => {
    const { usage, journal } = monitor()
    let resolveRead!: (value: unknown) => void
    usage.setCodexReader(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
    )
    usage.setProfileAuthority('codex-a', 7, true)

    const polling = usage.pollCodexOnce()
    usage.setProfileAuthority('codex-a', 7, false)
    usage.setProfileAuthority('codex-a', 8, true)
    resolveRead({
      rateLimits: {
        primary: { rateLimitReachedType: 'requests' },
      },
    })
    await polling

    expect(usage.list()[0]?.codex).toBeUndefined()
    expect(journal.since(0).filter((event) => event.kind === 'usage/snapshot')).toEqual([])
  })

  it('publishes only with the exact live authority token and rejects stale direct results', () => {
    const { usage, journal } = monitor()
    usage.setProfileAuthority('codex-a', 3, true)
    const stale = usage.captureProfileAuthority('codex-a')
    expect(stale).toBeDefined()

    usage.setProfileAuthority('codex-a', 3, false)
    usage.setProfileAuthority('codex-a', 4, true)
    usage.noteCodex(
      'codex-a',
      { rateLimitReachedType: 'stale' } as CodexLimitInfo,
      stale,
    )
    expect(usage.list()[0]?.codex).toBeUndefined()
    expect(journal.since(0).filter((event) => event.kind === 'usage/alert')).toEqual([])

    const current = usage.captureProfileAuthority('codex-a')
    usage.noteCodex(
      'codex-a',
      { rateLimitReachedType: 'current' } as CodexLimitInfo,
      current,
    )
    expect(usage.list()[0]?.codex).toMatchObject({ rateLimitReachedType: 'current' })
  })

  it('rejects backward authority epochs', () => {
    const { usage } = monitor()
    usage.setProfileAuthority('codex-a', 9, true)
    expect(() => usage.setProfileAuthority('codex-a', 8, true)).toThrow(/backwards/i)
  })
})
