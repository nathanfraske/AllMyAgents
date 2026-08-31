import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import type Database from 'better-sqlite3'
import type { Journal } from './journal.js'

const execFileAsync = promisify(execFile)

export type GitHubCiMonitorState = 'active' | 'succeeded' | 'failed' | 'cancelled'
export type GitHubCiWakeOutcome = 'failure' | 'success'
export type GitHubCiTarget =
  | { kind: 'pull-request'; number: number }
  | { kind: 'workflow-run'; runId: number }

export interface GitHubCiMonitorRecord {
  id: string
  sessionId: string
  projectId?: string
  repository: string
  target: GitHubCiTarget
  wakeOn: GitHubCiWakeOutcome[]
  state: GitHubCiMonitorState
  headSha?: string
  summary?: string
  url?: string
  createdAt: string
  updatedAt: string
  nextPollAt: string
  consecutiveErrors: number
  lastError?: string
  successObservation?: string
  successObservations: number
  notificationPending: boolean
  notifiedAt?: string
}

export interface GitHubCiPollResult {
  state: 'pending' | 'succeeded' | 'failed'
  headSha?: string
  summary: string
  url?: string
  /** Stable digest of the complete observed check set. Two equal success observations prevent a
   * transiently incomplete check list from waking an agent before late-created jobs appear. */
  observation?: string
}

export type GitHubCiQuery = (
  repository: string,
  target: GitHubCiTarget,
) => Promise<GitHubCiPollResult>

export interface GitHubCiNotification {
  monitor: GitHubCiMonitorRecord
  outcome: GitHubCiWakeOutcome
}

interface MonitorRow {
  id: string
  session_id: string
  project_id: string | null
  repository: string
  target_kind: 'pull-request' | 'workflow-run'
  target_number: number
  wake_on: string
  state: GitHubCiMonitorState
  head_sha: string | null
  summary: string | null
  url: string | null
  created_at: string
  updated_at: string
  next_poll_at: string
  consecutive_errors: number
  last_error: string | null
  success_observation: string | null
  success_observations: number
  notification_pending: number
  notified_at: string | null
}

const DEFAULT_POLL_MS = 30_000
const MIN_POLL_MS = 10_000
const MAX_POLL_MS = 5 * 60_000
const GH_TIMEOUT_MS = 20_000
const MAX_ACTIVE_PER_SESSION = 8
const MAX_ACTIVE_GLOBAL = 128
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000
const MAX_TERMINAL_RECORDS = 1_000
const MAX_GH_OUTPUT = 8 * 1024 * 1024
const FAILURE_CONCLUSIONS = new Set([
  'failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale',
])
const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])

function normalizedRepository(value: string): string | undefined {
  const candidate = value.trim().replace(/\.git$/iu, '').replace(/^https?:\/\/(?:www\.)?github\.com\//iu, '')
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(candidate)
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined
}

function parseWakeOn(value: string): GitHubCiWakeOutcome[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is GitHubCiWakeOutcome => item === 'failure' || item === 'success')
  } catch {
    return []
  }
}

function hydrate(row: MonitorRow): GitHubCiMonitorRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    repository: row.repository,
    target: row.target_kind === 'pull-request'
      ? { kind: 'pull-request', number: row.target_number }
      : { kind: 'workflow-run', runId: row.target_number },
    wakeOn: parseWakeOn(row.wake_on),
    state: row.state,
    ...(row.head_sha ? { headSha: row.head_sha } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.url ? { url: row.url } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextPollAt: row.next_poll_at,
    consecutiveErrors: row.consecutive_errors,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.success_observation ? { successObservation: row.success_observation } : {}),
    successObservations: row.success_observations,
    notificationPending: row.notification_pending === 1,
    ...(row.notified_at ? { notifiedAt: row.notified_at } : {}),
  }
}

async function ghApi(repository: string, endpoint: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    process.platform === 'win32' ? 'gh.exe' : 'gh',
    ['api', `repos/${repository}/${endpoint}`],
    { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: MAX_GH_OUTPUT, windowsHide: true },
  )
  return JSON.parse(stdout) as unknown
}

function boundedSummary(names: string[], prefix: string): string {
  const shown = names.slice(0, 8)
  return `${prefix}: ${shown.join(', ')}${names.length > shown.length ? ` (+${names.length - shown.length} more)` : ''}`
}

export async function queryGitHubCiWithApi(
  repository: string,
  target: GitHubCiTarget,
  api: (repository: string, endpoint: string) => Promise<unknown>,
): Promise<GitHubCiPollResult> {
  if (target.kind === 'workflow-run') {
    const raw = await api(repository, `actions/runs/${target.runId}`) as {
      status?: unknown; conclusion?: unknown; head_sha?: unknown; html_url?: unknown; name?: unknown
    }
    const status = typeof raw.status === 'string' ? raw.status : ''
    const conclusion = typeof raw.conclusion === 'string' ? raw.conclusion : ''
    const name = typeof raw.name === 'string' ? raw.name : `workflow run ${target.runId}`
    const common = {
      headSha: typeof raw.head_sha === 'string' ? raw.head_sha : undefined,
      url: typeof raw.html_url === 'string' ? raw.html_url : undefined,
      observation: crypto.createHash('sha256').update(`${status}:${conclusion}`).digest('hex'),
    }
    if (status !== 'completed') return { state: 'pending', summary: `${name} is ${status || 'pending'}.`, ...common }
    if (SUCCESS_CONCLUSIONS.has(conclusion)) return { state: 'succeeded', summary: `${name} completed: ${conclusion}.`, ...common }
    return { state: 'failed', summary: `${name} completed: ${conclusion || 'unknown failure'}.`, ...common }
  }

  const pull = await api(repository, `pulls/${target.number}`) as {
    head?: { sha?: unknown }; html_url?: unknown; state?: unknown
  }
  const headSha = typeof pull.head?.sha === 'string' ? pull.head.sha : ''
  if (!headSha) throw new Error('GitHub did not return an immutable head SHA for the pull request')
  const [checksRaw, statusRaw] = await Promise.all([
    api(repository, `commits/${headSha}/check-runs?per_page=100`),
    api(repository, `commits/${headSha}/status`),
  ])
  const checks = (checksRaw as { total_count?: unknown; check_runs?: unknown }).check_runs
  const totalCount = Number((checksRaw as { total_count?: unknown }).total_count ?? 0)
  if (totalCount > 100) throw new Error(`pull request has ${totalCount} check runs; the bounded monitor supports at most 100`)
  const runs = Array.isArray(checks) ? checks as Array<{
    name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown
  }> : []
  const statuses = Array.isArray((statusRaw as { statuses?: unknown }).statuses)
    ? (statusRaw as { statuses: Array<{ context?: unknown; state?: unknown; target_url?: unknown }> }).statuses
    : []
  const observed = [
    ...runs.map((run) => ({
      name: typeof run.name === 'string' ? run.name : 'unnamed check',
      terminal: run.status === 'completed',
      failure: run.status === 'completed' && FAILURE_CONCLUSIONS.has(String(run.conclusion ?? '')),
      success: run.status === 'completed' && SUCCESS_CONCLUSIONS.has(String(run.conclusion ?? '')),
      value: `${String(run.status ?? '')}:${String(run.conclusion ?? '')}`,
    })),
    ...statuses.map((status) => ({
      name: typeof status.context === 'string' ? status.context : 'unnamed status',
      terminal: status.state !== 'pending',
      failure: status.state === 'failure' || status.state === 'error',
      success: status.state === 'success',
      value: String(status.state ?? ''),
    })),
  ].sort((a, b) => a.name.localeCompare(b.name))
  const observation = crypto.createHash('sha256')
    .update(JSON.stringify([headSha, observed.map(({ name, value }) => [name, value])]))
    .digest('hex')
  const common = {
    headSha,
    url: typeof pull.html_url === 'string' ? pull.html_url : undefined,
    observation,
  }
  if (observed.length === 0) return { state: 'pending', summary: 'No CI checks have been reported yet.', ...common }
  const failed = observed.filter((item) => item.failure).map((item) => item.name)
  if (failed.length) return { state: 'failed', summary: boundedSummary(failed, 'Failed checks'), ...common }
  const pending = observed.filter((item) => !item.terminal || !item.success).map((item) => item.name)
  if (pending.length) return { state: 'pending', summary: boundedSummary(pending, 'Checks still running'), ...common }
  return { state: 'succeeded', summary: `All ${observed.length} observed checks passed.`, ...common }
}

export const queryGitHubCi: GitHubCiQuery = (repository, target) =>
  queryGitHubCiWithApi(repository, target, ghApi)

export class GitHubCiMonitor {
  private readonly pollMs: number
  private timer?: NodeJS.Timeout
  private polling = false
  private notify?: (notification: GitHubCiNotification) => Promise<boolean> | boolean

  constructor(
    private readonly db: Database.Database,
    private readonly journal: Pick<Journal, 'append'>,
    private readonly query: GitHubCiQuery = queryGitHubCi,
    pollMs = Number(process.env.ALLMYAGENTS_GITHUB_CI_POLL_MS ?? DEFAULT_POLL_MS),
  ) {
    this.pollMs = Math.max(MIN_POLL_MS, Math.min(Number.isFinite(pollMs) ? pollMs : DEFAULT_POLL_MS, MAX_POLL_MS))
    db.exec(`CREATE TABLE IF NOT EXISTS github_ci_monitors (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT,
      repository TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK(target_kind IN ('pull-request', 'workflow-run')),
      target_number INTEGER NOT NULL,
      wake_on TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active', 'succeeded', 'failed', 'cancelled')),
      head_sha TEXT,
      summary TEXT,
      url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_poll_at TEXT NOT NULL,
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      success_observation TEXT,
      success_observations INTEGER NOT NULL DEFAULT 0,
      notification_pending INTEGER NOT NULL DEFAULT 0,
      notified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS github_ci_monitors_due ON github_ci_monitors(state, next_poll_at);
    CREATE INDEX IF NOT EXISTS github_ci_monitors_session ON github_ci_monitors(session_id, created_at DESC);`)
  }

  setNotifier(notify: (notification: GitHubCiNotification) => Promise<boolean> | boolean): void {
    this.notify = notify
  }

  start(): void {
    if (this.timer) return
    void this.pollDue()
    this.timer = setInterval(() => void this.pollDue(), this.pollMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  watch(input: {
    sessionId: string
    projectId?: string
    repository: string
    target: GitHubCiTarget
    wakeOn?: GitHubCiWakeOutcome[]
  }): GitHubCiMonitorRecord {
    const repository = normalizedRepository(input.repository)
    if (!repository) throw new Error('repository must be owner/name on github.com')
    if (!Number.isSafeInteger(input.target.kind === 'pull-request' ? input.target.number : input.target.runId) ||
      (input.target.kind === 'pull-request' ? input.target.number : input.target.runId) <= 0) {
      throw new Error('pull request or workflow run id must be a positive integer')
    }
    const sessionActive = Number(this.db.prepare(
      "SELECT COUNT(*) FROM github_ci_monitors WHERE session_id = ? AND state = 'active'",
    ).pluck().get(input.sessionId))
    const globalActive = Number(this.db.prepare(
      "SELECT COUNT(*) FROM github_ci_monitors WHERE state = 'active'",
    ).pluck().get())
    if (sessionActive >= MAX_ACTIVE_PER_SESSION) throw new Error(`this chat already has ${MAX_ACTIVE_PER_SESSION} active CI monitors`)
    if (globalActive >= MAX_ACTIVE_GLOBAL) throw new Error(`the hub already has ${MAX_ACTIVE_GLOBAL} active CI monitors`)
    const wakeOn = [...new Set(input.wakeOn?.length ? input.wakeOn : ['failure', 'success'])]
      .filter((value): value is GitHubCiWakeOutcome => value === 'failure' || value === 'success')
    if (!wakeOn.length) throw new Error('wakeOn must include failure and/or success')
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO github_ci_monitors (
        id, session_id, project_id, repository, target_kind, target_number, wake_on, state,
        created_at, updated_at, next_poll_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
        .run(
          id, input.sessionId, input.projectId ?? null, repository, input.target.kind,
          input.target.kind === 'pull-request' ? input.target.number : input.target.runId,
          JSON.stringify(wakeOn), now, now, now,
        )
      this.journal.append(input.sessionId, 'github-ci/monitor-created', {
        monitorId: id, repository, target: input.target, wakeOn, projectId: input.projectId ?? null,
      })
    })()
    if (this.timer) void this.pollDue()
    return this.get(id)!
  }

  list(sessionId?: string): GitHubCiMonitorRecord[] {
    const rows = sessionId
      ? this.db.prepare('SELECT * FROM github_ci_monitors WHERE session_id = ? ORDER BY created_at DESC LIMIT 100').all(sessionId)
      : this.db.prepare('SELECT * FROM github_ci_monitors ORDER BY created_at DESC LIMIT 200').all()
    return (rows as MonitorRow[]).map(hydrate)
  }

  get(id: string): GitHubCiMonitorRecord | undefined {
    const row = this.db.prepare('SELECT * FROM github_ci_monitors WHERE id = ?').get(id) as MonitorRow | undefined
    return row ? hydrate(row) : undefined
  }

  cancel(id: string, sessionId: string): GitHubCiMonitorRecord | undefined {
    const now = new Date().toISOString()
    const changed = this.db.transaction(() => {
      const result = this.db.prepare(
        "UPDATE github_ci_monitors SET state = 'cancelled', updated_at = ?, notification_pending = 0 WHERE id = ? AND session_id = ? AND state = 'active'",
      ).run(now, id, sessionId)
      if (result.changes === 1) this.journal.append(sessionId, 'github-ci/monitor-cancelled', { monitorId: id })
      return result
    })()
    return this.get(id)
  }

  async pollDue(now = new Date()): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const due = this.db.prepare(
        "SELECT * FROM github_ci_monitors WHERE state = 'active' AND next_poll_at <= ? ORDER BY next_poll_at ASC LIMIT 32",
      ).all(now.toISOString()) as MonitorRow[]
      const queries = new Map<string, Promise<GitHubCiPollResult>>()
      for (let cursor = 0; cursor < due.length; cursor += 4) {
        await Promise.all(due.slice(cursor, cursor + 4).map((row) => {
          const record = hydrate(row)
          const targetNumber = record.target.kind === 'pull-request' ? record.target.number : record.target.runId
          const key = `${record.repository}:${record.target.kind}:${targetNumber}`
          let query = queries.get(key)
          if (!query) {
            query = this.query(record.repository, record.target)
            queries.set(key, query)
          }
          return this.pollOne(record, now, query)
        }))
      }
      await this.flushNotifications()
      this.prune(now)
    } finally {
      this.polling = false
    }
  }

  private async pollOne(
    record: GitHubCiMonitorRecord,
    now: Date,
    query: Promise<GitHubCiPollResult>,
  ): Promise<void> {
    let result: GitHubCiPollResult
    try {
      result = await query
    } catch (error) {
      const count = record.consecutiveErrors + 1
      const delay = Math.min(this.pollMs * 2 ** Math.min(count - 1, 4), MAX_POLL_MS)
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 500)
      this.db.transaction(() => {
        this.db.prepare(`UPDATE github_ci_monitors SET
          consecutive_errors = ?, last_error = ?, updated_at = ?, next_poll_at = ? WHERE id = ? AND state = 'active'`)
          .run(count, message, now.toISOString(), new Date(now.getTime() + delay).toISOString(), record.id)
        if (count === 1 || count === 5) this.journal.append(record.sessionId, 'github-ci/poll-degraded', {
          monitorId: record.id, consecutiveErrors: count, error: message, retryInMs: delay,
        })
      })()
      return
    }

    let state: GitHubCiMonitorState = 'active'
    let successObservations = 0
    let successObservation: string | null = null
    if (result.state === 'failed') state = 'failed'
    if (result.state === 'succeeded') {
      successObservation = result.observation ?? null
      successObservations = result.observation && result.observation === record.successObservation
        ? record.successObservations + 1
        : 1
      if (successObservations >= 2) state = 'succeeded'
    }
    const nextPollAt = new Date(now.getTime() + this.pollMs).toISOString()
    const terminalOutcome: GitHubCiWakeOutcome | undefined = state === 'failed'
      ? 'failure'
      : state === 'succeeded' ? 'success' : undefined
    const notificationPending = terminalOutcome && record.wakeOn.includes(terminalOutcome) ? 1 : 0
    this.db.transaction(() => {
      this.db.prepare(`UPDATE github_ci_monitors SET
        state = ?, head_sha = ?, summary = ?, url = ?, updated_at = ?, next_poll_at = ?,
        consecutive_errors = 0, last_error = NULL, success_observation = ?, success_observations = ?,
        notification_pending = ?
        WHERE id = ? AND state = 'active'`)
        .run(
          state, result.headSha ?? null, result.summary.slice(0, 1_000), result.url ?? null,
          now.toISOString(), nextPollAt, successObservation, successObservations, notificationPending, record.id,
        )
      if (terminalOutcome) this.journal.append(record.sessionId, 'github-ci/monitor-terminal', {
        monitorId: record.id, outcome: terminalOutcome, repository: record.repository,
        target: record.target, headSha: result.headSha ?? null, summary: result.summary, url: result.url ?? null,
      })
    })()
  }

  private async flushNotifications(): Promise<void> {
    if (!this.notify) return
    const pending = this.db.prepare(
      "SELECT * FROM github_ci_monitors WHERE notification_pending = 1 AND state IN ('succeeded', 'failed') ORDER BY updated_at ASC LIMIT 32",
    ).all() as MonitorRow[]
    for (const row of pending) {
      const monitor = hydrate(row)
      const outcome: GitHubCiWakeOutcome = monitor.state === 'succeeded' ? 'success' : 'failure'
      let accepted = false
      try {
        accepted = await this.notify({ monitor, outcome })
      } catch {
        // Durable pending bit retries on the next bounded cycle.
      }
      if (!accepted) continue
      const at = new Date().toISOString()
      this.db.prepare(
        'UPDATE github_ci_monitors SET notification_pending = 0, notified_at = ?, updated_at = ? WHERE id = ? AND notification_pending = 1',
      ).run(at, at, monitor.id)
    }
  }

  private prune(now: Date): void {
    const cutoff = new Date(now.getTime() - TERMINAL_RETENTION_MS).toISOString()
    this.db.prepare("DELETE FROM github_ci_monitors WHERE state != 'active' AND updated_at < ?").run(cutoff)
    this.db.prepare(`DELETE FROM github_ci_monitors WHERE id IN (
      SELECT id FROM github_ci_monitors WHERE state != 'active' ORDER BY updated_at DESC LIMIT -1 OFFSET ?
    )`).run(MAX_TERMINAL_RECORDS)
  }
}
