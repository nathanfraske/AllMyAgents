import type { ClaimResult } from './profileOwnership.js'
import type { Profile } from './types.js'

interface ReconcileProfileRegistryOptions {
  profiles: Profile[]
  profileMap: Map<string, Profile>
  scanned: Profile[]
  claim: (profileId: string, profileDir: string) => ClaimResult
  refreshAuth: (profile: Profile) => void
  onAdded: (profile: Profile) => void
  log?: (message: string) => void
}

/**
 * Reconcile the long-lived Profile objects shared by SessionManager, UsageMonitor, and the API.
 *
 * A profile object can outlive the claim that made it unavailable at boot. Every rescan therefore
 * reclaims every existing object as well as newly scanned directories. Availability is written only
 * from that fresh claim; stale owner metadata is cleared only after success.
 *
 * Existing objects remain registered while their credential is temporarily absent during re-auth.
 * That keeps the UI entry and ownership state observable while authentication becomes signed-out.
 */
export function reconcileProfileRegistry(options: ReconcileProfileRegistryOptions): Profile[] {
  const {
    profiles,
    profileMap,
    scanned,
    claim,
    refreshAuth,
    onAdded,
    log = () => {},
  } = options
  const scannedById = new Map(scanned.map((profile) => [profile.id, profile]))

  for (const existing of profiles) {
    const latest = scannedById.get(existing.id)
    if (latest) {
      existing.provider = latest.provider
      existing.dir = latest.dir
      if (latest.accountEmail) existing.accountEmail = latest.accountEmail
      else delete existing.accountEmail
      if (latest.providerAccountId) existing.providerAccountId = latest.providerAccountId
      else delete existing.providerAccountId
      scannedById.delete(existing.id)
    }
    reconcileOne(existing, claim, refreshAuth, log)
  }

  for (const profile of scannedById.values()) {
    reconcileOne(profile, claim, refreshAuth, log)
    profileMap.set(profile.id, profile)
    onAdded(profile)
  }

  return profiles
}

function reconcileOne(
  profile: Profile,
  claim: (profileId: string, profileDir: string) => ClaimResult,
  refreshAuth: (profile: Profile) => void,
  log: (message: string) => void,
): void {
  let result: ClaimResult
  try {
    result = claim(profile.id, profile.dir)
  } catch {
    // Do not leak filesystem/SQLite details into the public profile record, and do not clear a prior
    // ownerPort without a fresh authoritative claim. One unreadable claim must not abort every account's
    // rescan or let this hub inspect credentials whose single-writer ownership is unverifiable.
    profile.available = false
    profile.unavailableReason =
      'Profile ownership could not be verified safely. Retry the account rescan.'
    log(`[profiles] ownership for ${profile.id} could not be verified safely`)
    return
  }

  applyClaim(profile, result, log)
  if (!result.owned) return
  try {
    refreshAuth(profile)
  } catch {
    profile.available = false
    profile.unavailableReason =
      'Profile authentication state could not be refreshed safely. Retry the account rescan.'
    log(`[profiles] authentication for ${profile.id} could not be refreshed safely`)
  }
}

function applyClaim(
  profile: Profile,
  claim: ClaimResult,
  log: (message: string) => void,
): void {
  if (claim.owned) {
    profile.available = true
    delete profile.ownerPort
    delete profile.unavailableReason
    if (claim.reclaimed) log(`[profiles] owns ${profile.id} (reclaimed stale claim)`)
    return
  }

  profile.available = false
  profile.ownerPort = claim.owner.port
  profile.unavailableReason =
    `Another AllMyAgents hub (port ${claim.owner.port}) is using ${profile.id}. ` +
    'This hub will not refresh its credentials.'
  log(`[profiles] ${profile.unavailableReason}`)
}
