import type { ProfileInfo } from './api'
import { profileLabel, profileNativeId } from './profileLabel'

export type AccountPresenceStatus = 'signed_in' | 'signed_out' | 'unknown'

export interface AccountDevicePresence {
  key: string
  label: string
  local: boolean
  online: boolean
  status: AccountPresenceStatus
  profiles: ProfileInfo[]
}

export interface FleetAccountCatalogEntry {
  key: string
  provider: ProfileInfo['provider']
  label: string
  email?: string
  providerAccountId?: string
  profiles: ProfileInfo[]
  localProfiles: ProfileInfo[]
  devices: AccountDevicePresence[]
}

const normalizedEmail = (value: string | undefined): string | undefined => {
  const clean = value?.trim().toLocaleLowerCase()
  return clean || undefined
}

function identityKey(profile: ProfileInfo): string {
  const email = normalizedEmail(profile.accountEmail)
  if (email) return `${profile.provider}:email:${email}`
  if (profile.providerAccountId?.trim()) {
    return `${profile.provider}:account:${profile.providerAccountId.trim()}`
  }
  // A profile name is a device-local credential slot, not an account identity. Never merge two
  // unidentified `claude-a` rows from different machines merely because their aliases happen to match.
  return `${profile.provider}:slot:${profile.siteId ?? 'local'}:${profileNativeId(profile)}`
}

function presenceStatus(profiles: readonly ProfileInfo[]): AccountPresenceStatus {
  if (profiles.some((profile) => profile.authStatus === 'signed_in')) return 'signed_in'
  if (profiles.length > 0 && profiles.every((profile) => profile.authStatus === 'signed_out')) {
    return 'signed_out'
  }
  return 'unknown'
}

function devicePresence(
  profiles: readonly ProfileInfo[],
  localDeviceLabel: string,
): AccountDevicePresence[] {
  const grouped = new Map<string, ProfileInfo[]>()
  for (const profile of profiles) {
    const key = profile.siteId ?? 'local'
    grouped.set(key, [...(grouped.get(key) ?? []), profile])
  }
  return [...grouped.entries()]
    .map(([key, rows]) => ({
      key,
      label: key === 'local' ? localDeviceLabel : rows[0]?.siteLabel?.trim() || key.slice(0, 12),
      local: key === 'local',
      online: key === 'local' || rows.some((profile) => profile.siteOnline !== false),
      status: presenceStatus(rows),
      profiles: rows,
    }))
    .sort((left, right) => Number(right.local) - Number(left.local) || left.label.localeCompare(right.label))
}

/** Build one fleet-wide account row per provider identity, with device-local credential slots beneath it. */
export function buildFleetAccountCatalog(
  profiles: readonly ProfileInfo[],
  localDeviceLabel = 'This device',
): FleetAccountCatalogEntry[] {
  const grouped = new Map<string, ProfileInfo[]>()
  for (const profile of profiles) {
    const key = identityKey(profile)
    grouped.set(key, [...(grouped.get(key) ?? []), profile])
  }

  return [...grouped.entries()]
    .map(([key, rows]) => {
      const localProfiles = rows.filter((profile) => !profile.siteId)
      const preferred = localProfiles[0] ?? rows[0]!
      const email = rows.map((profile) => profile.accountEmail?.trim()).find(Boolean)
      const providerAccountId = rows.map((profile) => profile.providerAccountId?.trim()).find(Boolean)
      const alias = localProfiles
        .map((profile) => profile.displayName?.trim())
        .find((label): label is string => !!label)
      return {
        key,
        provider: preferred.provider,
        label: alias || email || profileLabel(preferred),
        ...(email ? { email } : {}),
        ...(providerAccountId ? { providerAccountId } : {}),
        profiles: rows,
        localProfiles,
        devices: devicePresence(rows, localDeviceLabel),
      }
    })
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label))
}

/**
 * Choose a local credential-slot id for a fleet account without overwriting an unrelated local login.
 * Reuse the remote slot name when it is available; otherwise derive a readable provider/email id.
 */
export function suggestedLocalProfileId(
  account: FleetAccountCatalogEntry,
  allProfiles: readonly ProfileInfo[],
): string {
  if (account.localProfiles[0]) return profileNativeId(account.localProfiles[0])
  const used = new Set(
    allProfiles.filter((profile) => !profile.siteId).map((profile) => profileNativeId(profile).toLocaleLowerCase()),
  )
  const remoteId = account.profiles
    .map(profileNativeId)
    .find((id) => /^[a-zA-Z0-9_-]{1,80}$/u.test(id) && !used.has(id.toLocaleLowerCase()))
  const emailStem = account.email?.split('@')[0] ?? account.label
  const slug = emailStem
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 52) || 'account'
  const base = remoteId ?? `${account.provider}-${slug}`
  if (!used.has(base.toLocaleLowerCase())) return base
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 72)}-${suffix}`
    if (!used.has(candidate.toLocaleLowerCase())) return candidate
  }
  return `${account.provider}-${Date.now()}`
}
