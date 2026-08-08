import type { ProfileInfo } from './api'

type ProfileIdentity = Pick<ProfileInfo, 'id' | 'displayName' | 'siteId' | 'siteLabel'>

/** Strip the fleet transport namespace while retaining the immutable account id on its own hub. */
export function profileNativeId(profile: Pick<ProfileInfo, 'id' | 'siteId'>): string {
  const prefix = profile.siteId ? `${profile.siteId}:` : ''
  return prefix && profile.id.startsWith(prefix) ? profile.id.slice(prefix.length) : profile.id
}

/** Human-facing account name. Identity and API calls must continue to use `profile.id`. */
export function profileLabel(profile: ProfileIdentity): string {
  return profile.displayName?.trim() || profileNativeId(profile)
}

/** Selectors keep the immutable id visible when an alias is present, avoiding ambiguous grants. */
export function profileOptionLabel(profile: ProfileIdentity): string {
  const label = profileLabel(profile)
  const nativeId = profileNativeId(profile)
  const account = label === nativeId ? nativeId : `${label} · ${nativeId}`
  return profile.siteLabel?.trim() ? `${account} · ${profile.siteLabel.trim()}` : account
}
