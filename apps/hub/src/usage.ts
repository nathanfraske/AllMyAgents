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

export interface ProfileUsageAuthority {
  readonly profileId: string
  readonly publicEpoch: number
  readonly nonce: number
}

export class UsageMonitor {
  private readonly snapshots = new Map<string, UsageSnapshot>()
  private codexReader: ((profileId: string) => Promise<unknown>) | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private claudeTimer: NodeJS.Timeout | undefined
  private readonly profileAuthorities = new Map<
    string,
    { publicEpoch: number; active: boolean; nonce: number }
  >()

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

  addProfile(p: Profile): void {
    if (this.snapshots.has(p.id)) return
    this.profiles.push(p)
    this.snapshots.set(p.id, {
      profileId: p.id,
      provider: p.provider,
      updatedAt: new Date().toISOString(),
      blocked: false,
    })
  }

  policyFor(profileId: string): OveragePolicy {
    return this.config.overage?.[profileId] ?? 'block'
  }

  private snapshot(profileId: string): UsageSnapshot | undefined {
    return this.snapshots.get(profileId)
  }

  setProfileAuthority(profileId: string, publicEpoch: number, active: boolean): void {
    if (!Number.isSafeInteger(publicEpoch) || publicEpoch < 0) {
      throw new Error(`Profile usage epoch must be a non-negative safe integer; got ${publicEpoch}`)
    }
    const current = this.profileAuthorities.get(profileId)
    if (current && publicEpoch < current.publicEpoch) {
      throw new Error(
        `Cannot move profile ${profileId} usage authority backwards from ${current.publicEpoch} to ${publicEpoch}`,
      )
    }
    this.profileAuthorities.set(profileId, {
      publicEpoch,
      active,
      nonce: (current?.nonce ?? 0) + 1,
    })
  }

  captureProfileAuthority(profileId: string): ProfileUsageAuthority | undefined {
    const current = this.profileAuthorities.get(profileId)
    if (!current?.active) return undefined
    return { profileId, publicEpoch: current.publicEpoch, nonce: current.nonce }
  }

  private canPublish(profileId: string, authority?: ProfileUsageAuthority): boolean {
    const current = this.profileAuthorities.get(profileId)
    if (!current) return authority === undefined
    return (
      authority?.profileId === profileId &&
      current.active &&
      authority.publicEpoch === current.publicEpoch &&
      authority.nonce === current.nonce
    )
  }

  noteClaude(
    profileId: string,
    info: ClaudeLimitInfo,
    authority?: ProfileUsageAuthority,
  ): void {
    if (!this.canPublish(profileId, authority)) return
    const snap = this.snapshot(profileId)
    if (!snap) return
    snap.claude = info
    snap.updatedAt = new Date().toISOString()
    this.evaluate(snap)
  }

  noteClaudeCost(
    profileId: string,
    costUsd: number | undefined,
    authority?: ProfileUsageAuthority,
  ): void {
    if (!this.canPublish(profileId, authority)) return
    const snap = this.snapshot(profileId)
    if (!snap || typeof costUsd !== 'number') return
    snap.totalCostUsd = (snap.totalCostUsd ?? 0) + costUsd
  }

  noteCodex(
    profileId: string,
    limits: CodexLimitInfo,
    authority?: ProfileUsageAuthority,
  ): void {
    if (!this.canPublish(profileId, authority)) return
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
    for (const p of this.profiles.filter((x) => x.provider === 'claude' && x.available !== false && x.authStatus !== 'signed_out')) {
      const authority = this.captureProfileAuthority(p.id)
      if (this.profileAuthorities.has(p.id) && !authority) continue
      try {
        const lines = await readClaudeUsage(p.dir)
        if (lines.length === 0) continue
        if (!this.canPublish(p.id, authority)) continue
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
    for (const p of this.profiles.filter((x) => x.provider === 'codex' && x.available !== false && x.authStatus !== 'signed_out')) {
      const authority = this.captureProfileAuthority(p.id)
      if (this.profileAuthorities.has(p.id) && !authority) continue
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
        if (!this.canPublish(p.id, authority)) continue
        this.noteCodex(p.id, flat, authority)
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
