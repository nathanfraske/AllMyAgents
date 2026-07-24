import { readClaudeUsage } from './claudeUsage.js'
import type { Journal } from './journal.js'
import type {
  ClaudeLimitInfo,
  CodexLimitInfo,
  HubConfig,
  OveragePolicy,
  Profile,
  UsageSnapshot,
} from './types.js'

const CODEX_POLL_MS = 15 * 60 * 1000
const CLAUDE_POLL_MS = 20 * 60 * 1000

export class UsageMonitor {
  private readonly snapshots = new Map<string, UsageSnapshot>()
  private codexReader: ((profileId: string) => Promise<unknown>) | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private claudeTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly journal: Journal,
    private readonly profiles: Profile[],
    private readonly config: HubConfig
  ) {
    for (const p of profiles) {
      this.snapshots.set(p.id, {
        profileId: p.id,
        provider: p.provider,
        updatedAt: new Date().toISOString(),
        blocked: false,
      })
    }
  }

  setCodexReader(reader: (profileId: string) => Promise<unknown>): void {
    this.codexReader = reader
  }

  list(): UsageSnapshot[] {
    return [...this.snapshots.values()]
  }

  policyFor(profileId: string): OveragePolicy {
    return this.config.overage?.[profileId] ?? 'block'
  }

  private snapshot(profileId: string): UsageSnapshot | undefined {
    return this.snapshots.get(profileId)
  }

  noteClaude(profileId: string, info: ClaudeLimitInfo): void {
    const snap = this.snapshot(profileId)
    if (!snap) return
    snap.claude = info
    snap.updatedAt = new Date().toISOString()
    this.evaluate(snap)
  }

  noteClaudeCost(profileId: string, costUsd: number | undefined): void {
    const snap = this.snapshot(profileId)
    if (!snap || typeof costUsd !== 'number') return
    snap.totalCostUsd = (snap.totalCostUsd ?? 0) + costUsd
  }

  noteCodex(profileId: string, limits: CodexLimitInfo): void {
    const snap = this.snapshot(profileId)
    if (!snap) return
    snap.codex = limits
    snap.updatedAt = new Date().toISOString()
    this.evaluate(snap)
  }

  private evaluate(snap: UsageSnapshot): void {
    const policy = this.policyFor(snap.profileId)
    let limited = false
    let reason: string | undefined
    if (snap.claude) {
      if (snap.claude.isUsingOverage) {
        limited = true
        reason = 'session is consuming overage credits'
      } else if (snap.claude.status && snap.claude.status !== 'allowed' && snap.claude.status !== 'allowed_warning') {
        limited = true
        reason = `rate limit status: ${snap.claude.status}`
      }
    }
    if (snap.codex) {
      if (snap.codex.rateLimitReachedType) {
        limited = true
        reason = `rate limit reached: ${snap.codex.rateLimitReachedType}`
      }
    }
    const wasBlocked = snap.blocked
    snap.blocked = limited && policy === 'block'
    snap.blockedReason = snap.blocked ? reason : undefined
    if (limited && (!wasBlocked || policy !== 'block')) {
      this.journal.append(null, 'usage/alert', {
        profileId: snap.profileId,
        policy,
        reason,
        blocked: snap.blocked,
      })
    }
  }

  assertNotBlocked(profileId: string): void {
    const snap = this.snapshot(profileId)
    if (snap?.blocked) {
      throw new Error(
        `profile ${profileId} is at its usage limit (${snap.blockedReason ?? 'limited'}); overage is blocked by settings`
      )
    }
  }

  async pollClaudeOnce(): Promise<void> {
    for (const p of this.profiles.filter((x) => x.provider === 'claude')) {
      try {
        const lines = await readClaudeUsage(p.dir)
        if (lines.length === 0) continue
        const snap = this.snapshot(p.id)
        if (!snap) continue
        snap.claudeUsage = lines
        snap.updatedAt = new Date().toISOString()
        this.journal.append(null, 'usage/snapshot', { profileId: p.id, claudeUsage: lines })
      } catch (err) {
        this.journal.append(null, 'usage/poll-error', {
          profileId: p.id,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  async pollCodexOnce(): Promise<void> {
    if (!this.codexReader) return
    for (const p of this.profiles.filter((x) => x.provider === 'codex')) {
      try {
        const raw = (await this.codexReader(p.id)) as { rateLimits?: CodexLimitInfo & { primary?: CodexLimitInfo } }
        const limits = raw?.rateLimits
        if (!limits) continue
        const flat: CodexLimitInfo = {
          ...limits.primary,
          credits: (limits as CodexLimitInfo).credits,
          spendControlReached: (limits as CodexLimitInfo).spendControlReached,
          rateLimitReachedType: (limits as CodexLimitInfo).rateLimitReachedType,
          planType: (limits as CodexLimitInfo).planType,
        }
        this.noteCodex(p.id, flat)
        this.journal.append(null, 'usage/snapshot', { profileId: p.id, codex: flat })
      } catch (err) {
        this.journal.append(null, 'usage/poll-error', {
          profileId: p.id,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  startPolling(): void {
    void this.pollCodexOnce()
    this.pollTimer = setInterval(() => void this.pollCodexOnce(), CODEX_POLL_MS)
    this.pollTimer.unref()
    // Claude usage via periodic `/usage` scrape; delay first run so startup isn't blocked.
    setTimeout(() => void this.pollClaudeOnce(), 3000).unref()
    this.claudeTimer = setInterval(() => void this.pollClaudeOnce(), CLAUDE_POLL_MS)
    this.claudeTimer.unref()
  }

  async refreshNow(): Promise<void> {
    await Promise.all([this.pollCodexOnce(), this.pollClaudeOnce()])
  }
}
