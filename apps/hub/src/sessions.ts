import crypto from 'node:crypto'
import path from 'node:path'
import type { ApprovalService } from './approvals.js'
import type { Journal } from './journal.js'
import type { ProjectStore } from './projects.js'
import type { SessionStore } from './store.js'
import type { UsageMonitor } from './usage.js'
import type { WorkspaceManager } from './workspace.js'
import type { ClaudeLimitInfo, Profile, SessionRecord, SessionStatus } from './types.js'
import { ClaudeDriver } from './adapters/claude.js'
import { CodexClient } from './adapters/codex.js'

export interface CreateOptions {
  cwd?: string
  repo?: string
  projectId?: string
  prompt?: string
  model?: string
  effort?: string
  serviceTier?: string
  permissionMode?: 'safe' | 'edits' | 'full'
}

export interface TurnOverride {
  model?: string
  effort?: string
  serviceTier?: string
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly claudeDrivers = new Map<string, ClaudeDriver>()
  private readonly codexClients = new Map<string, CodexClient>()
  private readonly codexThreads = new Map<string, string>()

  constructor(
    private readonly journal: Journal,
    private readonly store: SessionStore,
    private readonly profiles: Map<string, Profile>,
    private readonly approvals: ApprovalService,
    private readonly usage: UsageMonitor,
    private readonly workspace: WorkspaceManager,
    private readonly projects: ProjectStore,
    private readonly defaultCwd: string
  ) {}

  boot(): void {
    for (const record of this.store.all()) {
      if (record.status === 'active' || record.status === 'starting') {
        record.status = 'idle'
        this.journal.append(record.id, 'session/restored-stale', { note: 'hub restarted mid-turn' })
        this.store.upsert(record)
      }
      this.sessions.set(record.id, record)
    }
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()]
  }

  private persist(record: SessionRecord): void {
    this.store.upsert(record)
  }

  private setStatus(record: SessionRecord, status: SessionStatus): void {
    record.status = status
    this.persist(record)
    this.journal.append(record.id, 'session/status', { status })
  }

  private profileOf(record: SessionRecord): Profile {
    const profile = this.profiles.get(record.profileId)
    if (!profile) throw new Error(`unknown profile: ${record.profileId}`)
    return profile
  }

  private checkWriteScope(record: SessionRecord, toolName: string, input: unknown): string | undefined {
    if (!record.worktree) return undefined
    if (!['Write', 'Edit', 'NotebookEdit'].includes(toolName)) return undefined
    const filePath = (input as { file_path?: string } | null)?.file_path
    if (!filePath) return undefined
    const resolved = path.resolve(record.cwd, filePath).toLowerCase()
    const root = record.worktree.toLowerCase()
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return `write to ${filePath} is outside this session's worktree (${record.worktree}) — use a path inside the worktree`
    }
    return undefined
  }

  private sessionForThread(threadId: string): SessionRecord | undefined {
    for (const [sessionId, tid] of this.codexThreads) {
      if (tid === threadId) return this.sessions.get(sessionId)
    }
    return undefined
  }

  private codexClientFor(profile: Profile): CodexClient {
    let client = this.codexClients.get(profile.id)
    if (!client) {
      client = new CodexClient(
        profile.dir,
        (kind, payload) => {
          const threadId = (payload as { threadId?: string } | null)?.threadId
          const record = threadId ? this.sessionForThread(threadId) : undefined
          this.journal.append(record?.id ?? null, kind, payload)
          if (record && kind === 'codex/turn/completed') this.setStatus(record, 'idle')
        },
        async (method, params) => {
          const threadId = (params as { threadId?: string } | null)?.threadId
          const record = threadId ? this.sessionForThread(threadId) : undefined
          const approved = await this.approvals.request(record?.id ?? 'unattributed', `codex/${method}`, params)
          return approved ? { decision: 'accept' } : { decision: 'decline' }
        }
      )
      this.codexClients.set(profile.id, client)
    }
    return client
  }

  private claudeDriverFor(record: SessionRecord): ClaudeDriver {
    let driver = this.claudeDrivers.get(record.id)
    if (!driver) {
      const profile = this.profileOf(record)
      driver = new ClaudeDriver(
        profile.dir,
        record.cwd,
        (kind, payload) => {
          this.journal.append(record.id, kind, payload)
          if (kind === 'claude/rate_limit_event') {
            const info = (payload as { rate_limit_info?: ClaudeLimitInfo }).rate_limit_info
            if (info) this.usage.noteClaude(record.profileId, info)
          } else if (kind === 'claude/result') {
            const cost = (payload as { total_cost_usd?: number }).total_cost_usd
            this.usage.noteClaudeCost(record.profileId, cost)
          }
        },
        async (toolName, input) => {
          const scopeError = this.checkWriteScope(record, toolName, input)
          if (scopeError) {
            this.journal.append(record.id, 'approval/auto-denied-scope', { toolName, reason: scopeError })
            return { behavior: 'deny', message: scopeError }
          }
          const approved = await this.approvals.request(record.id, 'claude/tool', { toolName, input })
          return approved
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'denied from hub' }
        }
      )
      if (record.vendorSessionId) driver.restore(record.vendorSessionId)
      this.claudeDrivers.set(record.id, driver)
    }
    return driver
  }

  async create(profileId: string, opts: CreateOptions): Promise<SessionRecord> {
    const profile = this.profiles.get(profileId)
    if (!profile) throw new Error(`unknown profile: ${profileId}`)
    this.usage.assertNotBlocked(profileId)
    const id = crypto.randomUUID()
    // Resolve a project (named folder) into a working directory / repo, if given.
    // An explicit cwd (e.g. a handoff/port reusing an existing worktree) wins over the
    // project path and skips worktree creation, while still tagging the project for grouping.
    let cwd = opts.cwd ?? this.defaultCwd
    let repo = opts.repo
    if (opts.projectId && !opts.cwd) {
      const project = this.projects.get(opts.projectId)
      if (!project) throw new Error(`unknown project: ${opts.projectId}`)
      cwd = project.path
      if (this.workspace.isRepo(project.path)) repo = project.path
    }
    let worktree: string | undefined
    if (repo) {
      worktree = this.workspace.create(repo, id)
      cwd = worktree
      this.journal.append(id, 'session/worktree-created', { repo, worktree })
    }
    const record: SessionRecord = {
      id,
      profileId,
      provider: profile.provider,
      projectId: opts.projectId,
      cwd,
      repo,
      worktree,
      status: 'starting',
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.serviceTier,
      permissionMode: opts.permissionMode,
      createdAt: new Date().toISOString(),
    }
    this.sessions.set(id, record)
    this.persist(record)
    this.journal.append(id, 'session/created', record)

    if (profile.provider === 'claude') {
      this.claudeDriverFor(record)
      this.setStatus(record, 'idle')
      if (opts.prompt) void this.runClaudeTurn(record, opts.prompt)
    } else {
      const client = this.codexClientFor(profile)
      const threadId = await client.startThread(cwd)
      this.codexThreads.set(id, threadId)
      record.vendorSessionId = threadId
      this.persist(record)
      this.setStatus(record, 'idle')
      if (opts.prompt) await this.runCodexTurn(record, opts.prompt)
    }
    return record
  }

  private async runClaudeTurn(record: SessionRecord, prompt: string): Promise<void> {
    const driver = this.claudeDriverFor(record)
    this.setStatus(record, 'active')
    try {
      await driver.send(prompt, { model: record.model, permissionMode: record.permissionMode, effort: record.effort })
      if (driver.sessionId) {
        record.vendorSessionId = driver.sessionId
        this.persist(record)
      }
      this.setStatus(record, 'idle')
    } catch (err) {
      this.journal.append(record.id, 'session/error', {
        message: err instanceof Error ? err.message : String(err),
      })
      this.setStatus(record, 'error')
    }
  }

  private async ensureCodexThread(record: SessionRecord): Promise<{ client: CodexClient; threadId: string }> {
    const client = this.codexClientFor(this.profileOf(record))
    let threadId = this.codexThreads.get(record.id)
    if (!threadId) {
      if (!record.vendorSessionId) throw new Error('codex session has no persisted thread id')
      await client.resumeThread(record.vendorSessionId)
      threadId = record.vendorSessionId
      this.codexThreads.set(record.id, threadId)
      this.journal.append(record.id, 'session/thread-resumed', { threadId })
    }
    return { client, threadId }
  }

  private async runCodexTurn(record: SessionRecord, prompt: string): Promise<void> {
    this.setStatus(record, 'active')
    try {
      const { client, threadId } = await this.ensureCodexThread(record)
      await client.sendTurn(threadId, prompt, {
        model: record.model,
        effort: record.effort,
        serviceTier: record.serviceTier,
        approvalPolicy:
          record.permissionMode === 'full' ? 'never' : record.permissionMode ? 'onRequest' : undefined,
      })
    } catch (err) {
      this.journal.append(record.id, 'session/error', {
        message: err instanceof Error ? err.message : String(err),
      })
      this.setStatus(record, 'error')
    }
  }

  async send(sessionId: string, text: string, override: TurnOverride = {}): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)
    if (record.status === 'stopped') throw new Error('session is stopped')
    this.usage.assertNotBlocked(record.profileId)
    if (override.model) record.model = override.model
    if (override.effort !== undefined) record.effort = override.effort
    if (override.serviceTier !== undefined) record.serviceTier = override.serviceTier
    if (override.model || override.effort !== undefined || override.serviceTier !== undefined) this.persist(record)
    if (record.provider === 'claude') {
      if (this.claudeDrivers.get(sessionId)?.busy) throw new Error('a turn is already in progress')
      void this.runClaudeTurn(record, text)
    } else {
      await this.runCodexTurn(record, text)
    }
  }

  setMode(sessionId: string, mode: 'safe' | 'edits' | 'full'): void {
    const record = this.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)
    record.permissionMode = mode
    this.persist(record)
    this.journal.append(sessionId, 'session/mode', { permissionMode: mode })
  }

  async interrupt(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)
    if (record.provider === 'claude') {
      await this.claudeDrivers.get(sessionId)?.interrupt()
    } else {
      const threadId = this.codexThreads.get(sessionId)
      if (threadId) await this.codexClientFor(this.profileOf(record)).interrupt(threadId)
    }
    this.journal.append(sessionId, 'session/interrupted', {})
  }

  async stop(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record) return
    await this.interrupt(sessionId).catch(() => undefined)
    if (record.repo && record.worktree) {
      this.workspace.remove(record.repo, record.worktree)
      this.journal.append(sessionId, 'session/worktree-removed', { worktree: record.worktree })
    }
    this.setStatus(record, 'stopped')
  }

  readCodexLimits(profileId: string): Promise<unknown> {
    const profile = this.profiles.get(profileId)
    if (!profile) throw new Error(`unknown profile: ${profileId}`)
    return this.codexClientFor(profile).readRateLimits()
  }
}
