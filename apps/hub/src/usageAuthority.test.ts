import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InProcessExecutor } from './executor.js'
import { Journal } from './journal.js'
import type { CodexLimitInfo, HubConfig, Profile, Provider } from './types.js'
import { UsageMonitor } from './usage.js'
import type { WorkerSessionSpec } from './workerProtocol.js'

const roots: string[] = []
const journals: Journal[] = []

afterEach(() => {
  for (const journal of journals.splice(0)) journal.db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function monitor(provider: Provider = 'codex'): {
  usage: UsageMonitor
  journal: Journal
  profile: Profile
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-usage-authority-'))
  roots.push(root)
  const journal = new Journal(path.join(root, 'hub.db'))
  journals.push(journal)
  const profile: Profile = {
    id: `${provider}-a`,
    provider,
    dir: path.join(root, 'profile'),
  }
  return {
    usage: new UsageMonitor(journal, [profile], {} as HubConfig),
    journal,
    profile,
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

  it('publishes in-process Claude rate limits and cost with the current authority token', () => {
    const { usage, profile } = monitor('claude')
    usage.setProfileAuthority(profile.id, 11, true)
    const executor = new InProcessExecutor({
      approvals: {},
      questions: {},
      usage,
      danger: {},
      memory: {},
      practices: {},
    } as never)
    executor.bindHub({ journal: vi.fn() } as never)
    const spec: WorkerSessionSpec = {
      sessionId: 's1',
      provider: 'claude',
      profileId: profile.id,
      profileDir: profile.dir,
      cwd: profile.dir,
      label: 'usage authority',
      permissionMode: 'safe',
    }
    const driver = (
      executor as unknown as {
        claudeDriverFor(value: WorkerSessionSpec): unknown
      }
    ).claudeDriverFor(spec) as {
      onEvent(kind: string, payload: unknown): void
    }

    driver.onEvent('claude/rate_limit_event', {
      rate_limit_info: { status: 'allowed' },
    })
    driver.onEvent('claude/result', { total_cost_usd: 1.25 })

    expect(usage.list()[0]).toMatchObject({
      claude: { status: 'allowed' },
      totalCostUsd: 1.25,
    })
  })

  it.each(['codex', 'claude'] as const)(
    'does not journal a delayed %s poll rejection after the authority flips',
    async (provider) => {
      const { usage, journal, profile } = monitor(provider)
      let rejectRead!: (error: Error) => void
      const reader = () =>
        new Promise<never>((_resolve, reject) => {
          rejectRead = reject
        })
      if (provider === 'codex') usage.setCodexReader(reader)
      else usage.setClaudeReader(reader)
      usage.setProfileAuthority(profile.id, 20, true)

      const polling =
        provider === 'codex' ? usage.pollCodexOnce() : usage.pollClaudeOnce()
      usage.setProfileAuthority(profile.id, 20, false)
      usage.setProfileAuthority(profile.id, 21, true)
      rejectRead(new Error('stale poll failed'))
      await polling

      expect(
        journal.since(0).filter((event) => event.kind === 'usage/poll-error'),
      ).toEqual([])
    },
  )
})
