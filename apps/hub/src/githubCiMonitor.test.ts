import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GitHubCiMonitor,
  queryGitHubCiWithApi,
  type GitHubCiNotification,
  type GitHubCiPollResult,
} from './githubCiMonitor.js'

describe('GitHubCiMonitor', () => {
  const databases: Database.Database[] = []
  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
  })

  function harness(results: Array<GitHubCiPollResult | Error>) {
    const db = new Database(':memory:')
    databases.push(db)
    const events: Array<{ sessionId: string | null; kind: string; payload: unknown }> = []
    const notifications: GitHubCiNotification[] = []
    const query = async (): Promise<GitHubCiPollResult> => {
      const result = results.shift()
      if (!result) throw new Error('unexpected poll')
      if (result instanceof Error) throw result
      return result
    }
    const monitor = new GitHubCiMonitor(db, {
      append: (sessionId, kind, payload) => {
        events.push({ sessionId, kind, payload })
        return { seq: events.length, ts: '', sessionId, kind, payload }
      },
    }, query, 10_000)
    monitor.setNotifier((notification) => {
      notifications.push(notification)
      return true
    })
    return { db, monitor, events, notifications }
  }

  it('settles successful pull-request CI twice, wakes exactly once, and restores terminal state', async () => {
    const success = {
      state: 'succeeded' as const,
      headSha: 'a'.repeat(40),
      summary: 'All 4 observed checks passed.',
      url: 'https://github.com/acme/widgets/pull/7',
      observation: 'stable-check-set',
    }
    const h = harness([success, success])
    const watched = h.monitor.watch({
      sessionId: 'manager-1',
      projectId: 'project-1',
      repository: 'Acme/Widgets',
      target: { kind: 'pull-request', number: 7 },
    })
    expect(watched.repository).toBe('acme/widgets')

    const firstAt = new Date(watched.nextPollAt)
    await h.monitor.pollDue(firstAt)
    expect(h.monitor.get(watched.id)).toMatchObject({ state: 'active', successObservations: 1 })
    expect(h.notifications).toEqual([])

    await h.monitor.pollDue(new Date(firstAt.getTime() + 10_001))
    expect(h.monitor.get(watched.id)).toMatchObject({
      state: 'succeeded',
      successObservations: 2,
      notificationPending: false,
      notifiedAt: expect.any(String),
    })
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]).toMatchObject({ outcome: 'success', monitor: { id: watched.id } })

    await h.monitor.pollDue(new Date(firstAt.getTime() + 20_002))
    expect(h.notifications).toHaveLength(1)
    const restored = new GitHubCiMonitor(h.db, {
      append: (sessionId, kind, payload) => ({ seq: 0, ts: '', sessionId, kind, payload }),
    }, async () => {
      throw new Error('terminal records must not poll after restart')
    })
    expect(restored.get(watched.id)).toMatchObject({ state: 'succeeded', notificationPending: false })
  })

  it('wakes immediately on failure and persists bounded polling errors for retry', async () => {
    const h = harness([
      new Error('temporary GitHub outage with a long diagnostic'),
      {
        state: 'failed',
        headSha: 'b'.repeat(40),
        summary: 'Failed checks: js gates, rust gates',
        observation: 'failed-set',
      },
    ])
    const watched = h.monitor.watch({
      sessionId: 'manager-2',
      repository: 'acme/widgets',
      target: { kind: 'workflow-run', runId: 99 },
      wakeOn: ['failure'],
    })
    const firstAt = new Date(watched.nextPollAt)
    await h.monitor.pollDue(firstAt)
    expect(h.monitor.get(watched.id)).toMatchObject({
      state: 'active',
      consecutiveErrors: 1,
      lastError: expect.stringContaining('temporary GitHub outage'),
    })
    expect(h.events.some((event) => event.kind === 'github-ci/poll-degraded')).toBe(true)

    await h.monitor.pollDue(new Date(firstAt.getTime() + 10_001))
    expect(h.monitor.get(watched.id)).toMatchObject({ state: 'failed', consecutiveErrors: 0 })
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]?.outcome).toBe('failure')
  })

  it('keeps cancelled watches scoped to their owning chat', () => {
    const h = harness([])
    const watched = h.monitor.watch({
      sessionId: 'manager-3',
      repository: 'acme/widgets',
      target: { kind: 'workflow-run', runId: 100 },
    })
    expect(h.monitor.cancel(watched.id, 'someone-else')).toMatchObject({ state: 'active' })
    expect(h.monitor.cancel(watched.id, 'manager-3')).toMatchObject({ state: 'cancelled' })
  })

  it('classifies complete PR checks, commit statuses, and exact workflow conclusions', async () => {
    const responses = new Map<string, unknown>([
      ['pulls/7', { head: { sha: 'abc123' }, html_url: 'https://github.com/acme/widgets/pull/7' }],
      ['commits/abc123/check-runs?per_page=100', {
        total_count: 2,
        check_runs: [
          { name: 'js', status: 'completed', conclusion: 'success' },
          { name: 'rust', status: 'completed', conclusion: 'failure' },
        ],
      }],
      ['commits/abc123/status', { statuses: [{ context: 'release', state: 'success' }] }],
      ['actions/runs/19', {
        status: 'completed', conclusion: 'success', head_sha: 'def456', name: 'CI',
      }],
    ])
    const api = async (_repository: string, endpoint: string): Promise<unknown> => responses.get(endpoint)
    await expect(queryGitHubCiWithApi('acme/widgets', { kind: 'pull-request', number: 7 }, api))
      .resolves.toMatchObject({ state: 'failed', headSha: 'abc123', summary: 'Failed checks: rust' })
    await expect(queryGitHubCiWithApi('acme/widgets', { kind: 'workflow-run', runId: 19 }, api))
      .resolves.toMatchObject({ state: 'succeeded', headSha: 'def456', summary: 'CI completed: success.' })
  })
})
