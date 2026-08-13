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

export interface UsageAlert {
  profileId: string
  kind: 'headroom-low' | 'rejected' | 'entitlement-denied'
  reason: string
  resetsAt?: number
  headroom: number
}

export class UsageMonitor {
  private readonly snapshots = new Map<string, UsageSnapshot>()
  private readonly restored = new Map<string, UsageSnapshot>()
  private readonly persistStatement
  private alertListener: ((alert: UsageAlert) => void) | undefined
  private codexReader: ((profileId: string) => Promise<unknown>) | undefined
  private claudeReader = readClaudeUsage
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
    this.journal.db.exec(`
      CREATE TABLE IF NOT EXISTS account_usage_ledger (
        profile_id TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.persistStatement = this.journal.db.prepare(
      `INSERT INTO account_usage_ledger (profile_id, snapshot, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
    )
    const rows = this.journal.db
      .prepare('SELECT profile_id, snapshot FROM account_usage_ledger')
      .all() as Array<{ profile_id: string; snapshot: string }>
    for (const row of rows) {
      try {
        const value = JSON.parse(row.snapshot) as UsageSnapshot
        if (value && value.profileId === row.profile_id) this.restored.set(row.profile_id, value)
      } catch {
        // A corrupt replaceable projection is ignored; live provider telemetry rebuilds it.
      }
    }
    for (const p of profiles) {
      this.installProfile(p)
    }
  }

  setAlertListener(listener: (alert: UsageAlert) => void): void {
    this.alertListener = listener
  }

  setCodexReader(reader: (profileId: string) => Promise<unknown>): void {
    this.codexReader = reader
  }

  setClaudeReader(reader: typeof readClaudeUsage): void {
    this.claudeReader = reader
  }

  list(): UsageSnapshot[] {
    for (const snapshot of this.snapshots.values()) this.refreshDerived(snapshot)
    return [...this.snapshots.values()]
  }

  addProfile(p: Profile): void {
    if (this.snapshots.has(p.id)) return
    if (!this.profiles.some((profile) => profile.id === p.id)) this.profiles.push(p)
    this.installProfile(p)
  }

  private installProfile(p: Profile): void {
    const saved = this.restored.get(p.id)
    const snapshot: UsageSnapshot = {
      ...(saved?.provider === p.provider ? saved : {}),
      profileId: p.id,
      provider: p.provider,
      updatedAt: saved?.updatedAt ?? new Date().toISOString(),
      blocked: saved?.blocked === true,
      entitlement: saved?.entitlement ?? p.entitlementStatus ?? 'unknown',
      headroom: typeof saved?.headroom === 'number' ? saved.headroom : 1,
      authenticated: p.authStatus === undefined ? saved?.authenticated : p.authStatus === 'signed_in',
    }
    this.refreshDerived(snapshot)
    p.entitlementStatus = snapshot.entitlement
    p.entitlementReason = snapshot.entitlementReason
    p.entitlementCheckedAt = snapshot.entitlementCheckedAt
    this.snapshots.set(p.id, snapshot)
    this.persist(snapshot)
  }

  policyFor(profileId: string): OveragePolicy {
    return this.config.overage?.[profileId] ?? 'block'
  }

  private snapshot(profileId: string): UsageSnapshot | undefined {
    return this.snapshots.get(profileId)
  }

  noteProfileAuth(profile: Profile): void {
    const snap = this.snapshot(profile.id)
    if (!snap) return
    const wasAuthenticated = snap.authenticated
    snap.authenticated = profile.authStatus === undefined ? undefined : profile.authStatus === 'signed_in'
    if (wasAuthenticated === false && snap.authenticated === true && !profile.authError) {
      this.setEntitlement(snap, 'unknown')
    }
    snap.updatedAt = new Date().toISOString()
    this.refreshDerived(snap)
    this.persist(snap)
  }

  noteEntitlement(profileId: string, status: 'unknown' | 'entitled' | 'denied', reason?: string): void {
    const snap = this.snapshot(profileId)
    if (!snap) return
    const previous = snap.entitlement
    this.setEntitlement(snap, status, reason)
    snap.updatedAt = new Date().toISOString()
    this.refreshDerived(snap)
    this.persist(snap)
    if (status === 'denied' && previous !== 'denied') {
      this.alertListener?.({
        profileId,
        kind: 'entitlement-denied',
        reason: reason ?? 'the provider rejected this account for agent execution',
        headroom: 0,
      })
    }
  }

  private setEntitlement(
    snap: UsageSnapshot,
    status: 'unknown' | 'entitled' | 'denied',
    reason?: string,
  ): void {
    snap.entitlement = status
    snap.entitlementReason = status === 'denied' ? reason : undefined
    snap.entitlementCheckedAt = new Date().toISOString()
    const profile = this.profiles.find((candidate) => candidate.id === snap.profileId)
    if (profile) {
      profile.entitlementStatus = status
      profile.entitlementReason = snap.entitlementReason
      profile.entitlementCheckedAt = snap.entitlementCheckedAt
    }
  }

  private persist(snap: UsageSnapshot): void {
    this.persistStatement.run(snap.profileId, JSON.stringify(snap), snap.updatedAt)
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
    const previousHeadroom = snap.headroom
    snap.claude = info
    snap.updatedAt = new Date().toISOString()
    if (info.status) this.setEntitlement(snap, 'entitled')
    this.evaluate(snap)
    this.persist(snap)
    this.emitCapacityAlert(snap, previousHeadroom)
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
    this.setEntitlement(snap, 'entitled')
    snap.updatedAt = new Date().toISOString()
    this.refreshDerived(snap)
    this.persist(snap)
  }

  noteCodex(
    profileId: string,
    limits: CodexLimitInfo,
    authority?: ProfileUsageAuthority,
  ): void {
    if (!this.canPublish(profileId, authority)) return
    const snap = this.snapshot(profileId)
    if (!snap) return
    const previousHeadroom = snap.headroom
    snap.codex = limits
    snap.updatedAt = new Date().toISOString()
    this.setEntitlement(snap, 'entitled')
    this.evaluate(snap)
    this.persist(snap)
    this.emitCapacityAlert(snap, previousHeadroom)
  }

  private evaluate(snap: UsageSnapshot): void {
    const policy = this.policyFor(snap.profileId)
    let limited = false
    let reason: string | undefined
    if (snap.claude && this.activeResetWindow(snap.claude.resetsAt)) {
      if (snap.claude.isUsingOverage) {
        limited = true
        reason = 'session is consuming overage credits'
      } else if (snap.claude.status && snap.claude.status !== 'allowed' && snap.claude.status !== 'allowed_warning') {
        limited = true
        reason = `rate limit status: ${snap.claude.status}`
      }
    }
    if (snap.codex && this.activeResetWindow(snap.codex.resetsAt)) {
      if (snap.codex.rateLimitReachedType) {
        limited = true
        reason = `rate limit reached: ${snap.codex.rateLimitReachedType}`
      }
    }
    const wasBlocked = snap.blocked
    snap.blocked = limited && policy === 'block'
    snap.blockedReason = snap.blocked ? reason : undefined
    this.refreshDerived(snap)
    if (limited && (!wasBlocked || policy !== 'block')) {
      this.journal.append(null, 'usage/alert', {
        profileId: snap.profileId,
        policy,
        reason,
        blocked: snap.blocked,
      })
    }
  }

  private activeResetWindow(resetsAt: number | undefined): boolean {
    return resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt > Date.now() / 1000
  }

  private refreshDerived(snap: UsageSnapshot): void {
    const now = Date.now() / 1000
    const claudeActive = snap.claude?.resetsAt === undefined || snap.claude.resetsAt > now
    const codexActive = snap.codex?.resetsAt === undefined || snap.codex.resetsAt > now
    const claudeStatus = claudeActive ? snap.claude?.status?.toLocaleLowerCase() : undefined
    const rejected = Boolean(
      (claudeStatus && claudeStatus !== 'allowed' && claudeStatus !== 'allowed_warning') ||
      (codexActive && snap.codex?.rateLimitReachedType),
    )
    if (!this.activeResetWindow(snap.resetsAt) && snap.blocked) {
      snap.blocked = false
      snap.blockedReason = undefined
    }
    const percentages: number[] = []
    if (codexActive && typeof snap.codex?.usedPercent === 'number') percentages.push(snap.codex.usedPercent)
    for (const line of snap.claudeUsage ?? []) {
      if (line.resetsAt === undefined || line.resetsAt > now) percentages.push(line.percent)
    }
    const used = percentages.length ? Math.max(...percentages) : 0
    snap.headroom = snap.authenticated === false || snap.entitlement === 'denied' || rejected || snap.blocked
      ? 0
      : Math.max(0, Math.min(1, 1 - used / 100))
    snap.limitStatus = claudeStatus ?? (snap.codex?.rateLimitReachedType ? 'rejected' : 'allowed')
    snap.windowType = snap.claude?.rateLimitType ??
      (snap.codex?.windowDurationMins ? `${snap.codex.windowDurationMins}-minute` : undefined)
    snap.resetsAt = snap.provider === 'claude'
      ? snap.claude?.resetsAt ?? snap.claudeUsage?.map((line) => line.resetsAt).filter((v): v is number => v !== undefined).sort()[0]
      : snap.codex?.resetsAt
  }

  private emitCapacityAlert(snap: UsageSnapshot, previousHeadroom: number): void {
    if (!this.alertListener) return
    if (snap.headroom === 0 && previousHeadroom > 0) {
      this.alertListener({
        profileId: snap.profileId,
        kind: 'rejected',
        reason: snap.blockedReason ?? `${snap.limitStatus ?? 'usage'} is rejecting new work`,
        resetsAt: snap.resetsAt,
        headroom: 0,
      })
    } else if (snap.headroom <= 0.2 && previousHeadroom > 0.2) {
      this.alertListener({
        profileId: snap.profileId,
        kind: 'headroom-low',
        reason: `${Math.round(snap.headroom * 100)}% estimated provider headroom remains`,
        resetsAt: snap.resetsAt,
        headroom: snap.headroom,
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
        const lines = await this.claudeReader(p.dir)
        if (lines.length === 0) continue
        if (!this.canPublish(p.id, authority)) continue
        const snap = this.snapshot(p.id)
        if (!snap) continue
        const previousHeadroom = snap.headroom
        snap.claudeUsage = lines
        snap.updatedAt = new Date().toISOString()
        this.refreshDerived(snap)
        this.persist(snap)
        this.emitCapacityAlert(snap, previousHeadroom)
        this.journal.append(null, 'usage/snapshot', { profileId: p.id, claudeUsage: lines })
      } catch (err) {
        if (!this.canPublish(p.id, authority)) continue
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
        if (!this.canPublish(p.id, authority)) continue
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
