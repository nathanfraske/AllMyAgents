import {
  discoverInterruptedLoginProfiles,
  reconcileInterruptedLogins,
  setLoginAdmission,
  settleLoginsForRestart,
  type InterruptedLoginDiscovery,
  type LoginDrainResult,
  type LoginReconcileResult,
} from './loginLauncher.js'
import type { ProfileOwnership } from './profileOwnership.js'
import { reconcileProfileRegistry } from './profileRegistry.js'
import type { Profile } from './types.js'
import type { UsageMonitor } from './usage.js'

export interface ProfileRuntimeGeneration {
  readonly generationId: string
  readonly publicEpoch: number
  readonly active: boolean
}

interface ProfileUsageRuntime {
  addProfile(profile: Profile): void
  setProfileAuthority(profileId: string, publicEpoch: number, active: boolean): void
}

export interface ProfileRuntimeOptions {
  profilesDir: string
  profiles: Profile[]
  profileMap: Map<string, Profile>
  profileOwnership: ProfileOwnership
  usage: ProfileUsageRuntime | UsageMonitor
  generation: ProfileRuntimeGeneration
  scanProfiles: () => Profile[]
  refreshAuth: (profile: Profile) => void
  onAdded: (profile: Profile) => void
  applyConnectorPolicy: (profile: Profile) => void
  discoverInterrupted?: () => InterruptedLoginDiscovery
  reconcileInterrupted?: () => LoginReconcileResult[]
  setLoginAdmission?: (open: boolean) => void
  settleLoginsForRestart?: (timeoutMs: number) => Promise<LoginDrainResult>
  loginSettlementTimeoutMs?: number
  log?: (message: string) => void
}

export const PROFILE_LOGIN_RESTART_SETTLEMENT_TIMEOUT_MS = 4_000

/**
 * Generation-scoped boundary for profile mutations that otherwise run independently at boot, rescan,
 * restart drain, or usage-poll completion.
 */
export class ProfileRuntime {
  private generation: ProfileRuntimeGeneration
  private readonly discoverInterrupted: () => InterruptedLoginDiscovery
  private readonly reconcileInterrupted: () => LoginReconcileResult[]
  private readonly setLoginAdmission: (open: boolean) => void
  private readonly settleLoginsForRestart: (timeoutMs: number) => Promise<LoginDrainResult>
  private readonly log: (message: string) => void

  constructor(private readonly options: ProfileRuntimeOptions) {
    this.generation = { ...options.generation }
    this.discoverInterrupted =
      options.discoverInterrupted ??
      (() => discoverInterruptedLoginProfiles(options.profilesDir))
    this.reconcileInterrupted =
      options.reconcileInterrupted ??
      (() =>
        reconcileInterruptedLogins(
          options.profilesDir,
          (profileId, profileDir, operation) =>
            options.profileOwnership.acquireRefreshLease(profileId, profileDir, operation),
        ))
    this.setLoginAdmission = options.setLoginAdmission ?? setLoginAdmission
    this.settleLoginsForRestart =
      options.settleLoginsForRestart ?? settleLoginsForRestart
    this.log = options.log ?? ((message) => console.error(message))
  }

  bootstrap(): Profile[] {
    this.setLoginAdmission(this.generation.active)
    return this.rescan()
  }

  rescan(): Profile[] {
    const discovery = this.discoverInterrupted()
    for (const notice of discovery.notices) {
      this.log(
        `[profiles] interrupted sign-in recovery is unavailable${
          notice.profileId ? ` for ${notice.profileId}` : ''
        }: ${notice.error}`,
      )
    }

    // A booting green may inspect bounded discovery metadata for health, but it must not claim a
    // profile, refresh credentials, reconcile a durable attempt, publish usage, or write config.
    if (!this.generation.active) return this.options.profiles

    this.reconcileRegistry(this.mergeProfiles(this.options.scanProfiles(), discovery.profiles))
    const recovery = this.reconcileInterrupted()
    for (const result of recovery) {
      if (result.outcome === 'conflict' || result.outcome === 'busy') {
        this.log(
          `[profiles] interrupted sign-in for ${result.profileId} is ${result.outcome}: ${
            result.error ?? 'retry the account rescan'
          }`,
        )
      }
    }

    // Recovery may restore the prior credential or accept a new one. Re-read the exact long-lived
    // profile objects before exposing auth status or changing connector settings.
    const afterRecovery = this.discoverInterrupted()
    this.reconcileRegistry(
      this.mergeProfiles(this.options.scanProfiles(), afterRecovery.profiles),
    )
    this.applyConnectorPolicy()
    this.setUsageAuthority(true)
    return this.options.profiles
  }

  async prepareRestart(): Promise<LoginDrainResult> {
    this.setLoginAdmission(false)
    return this.settleLoginsForRestart(
      this.options.loginSettlementTimeoutMs ??
        PROFILE_LOGIN_RESTART_SETTLEMENT_TIMEOUT_MS,
    )
  }

  deactivatePublicGeneration(): void {
    this.setLoginAdmission(false)
    this.options.profileOwnership.setPublicGenerationActive(
      false,
      this.generation.publicEpoch,
    )
    this.generation = { ...this.generation, active: false }
    this.setUsageAuthority(false)
  }

  activatePublicGeneration(publicEpoch: number): void {
    if (
      !Number.isSafeInteger(publicEpoch) ||
      publicEpoch <= this.generation.publicEpoch
    ) {
      throw new Error(
        `Profile public generation requires a strictly newer safe epoch than ${this.generation.publicEpoch}; got ${publicEpoch}`,
      )
    }
    this.setLoginAdmission(false)
    this.options.profileOwnership.setPublicGenerationActive(true, publicEpoch)
    this.generation = { ...this.generation, publicEpoch, active: true }
    try {
      this.rescan()
      this.setLoginAdmission(true)
    } catch (error) {
      this.options.profileOwnership.setPublicGenerationActive(false, publicEpoch)
      this.generation = { ...this.generation, active: false }
      this.setUsageAuthority(false)
      throw error
    }
  }

  resumeLoginAdmission(): void {
    if (this.generation.active) this.setLoginAdmission(true)
  }

  currentGeneration(): ProfileRuntimeGeneration {
    return { ...this.generation }
  }

  private reconcileRegistry(scanned: Profile[]): void {
    reconcileProfileRegistry({
      profiles: this.options.profiles,
      profileMap: this.options.profileMap,
      scanned,
      claim: (profileId, profileDir) =>
        this.options.profileOwnership.claim(profileId, profileDir),
      refreshAuth: this.options.refreshAuth,
      onAdded: (profile) => {
        if (!this.options.profiles.some((existing) => existing.id === profile.id)) {
          this.options.profiles.push(profile)
        }
        this.options.onAdded(profile)
        this.options.usage.setProfileAuthority(
          profile.id,
          this.generation.publicEpoch,
          this.generation.active,
        )
      },
      log: this.log,
    })
  }

  private mergeProfiles(scanned: Profile[], recovered: Profile[]): Profile[] {
    const merged = new Map<string, Profile>()
    for (const profile of recovered) merged.set(profile.id, profile)
    for (const profile of scanned) merged.set(profile.id, profile)
    return [...merged.values()]
  }

  private applyConnectorPolicy(): void {
    for (const profile of this.options.profiles) {
      if (profile.available === false) continue
      let lease
      try {
        lease = this.options.profileOwnership.acquireRefreshLease(
          profile.id,
          profile.dir,
          'apply connector policy',
        )
        if (!lease.isCurrent()) {
          throw new Error('profile mutation authority changed before connector policy')
        }
        this.options.applyConnectorPolicy(profile)
        if (!lease.isCurrent()) {
          throw new Error('profile mutation authority changed while applying connector policy')
        }
      } catch (error) {
        profile.available = false
        profile.unavailableReason =
          'Profile connector policy could not be updated safely. Retry the account rescan.'
        this.log(
          `[profiles] connector policy for ${profile.id} could not be updated safely: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      } finally {
        lease?.release()
      }
    }
  }

  private setUsageAuthority(active: boolean): void {
    for (const profile of this.options.profiles) {
      this.options.usage.setProfileAuthority(
        profile.id,
        this.generation.publicEpoch,
        active,
      )
    }
  }
}
