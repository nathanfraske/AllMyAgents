import type { ProfileInfo } from './api'

/** Human-facing account name. Identity and API calls must continue to use `profile.id`. */
export function profileLabel(profile: Pick<ProfileInfo, 'id' | 'displayName'>): string {
  return profile.displayName?.trim() || profile.id
}

/** Selectors keep the immutable id visible when an alias is present, avoiding ambiguous grants. */
export function profileOptionLabel(profile: Pick<ProfileInfo, 'id' | 'displayName'>): string {
  const label = profileLabel(profile)
  return label === profile.id ? profile.id : `${label} · ${profile.id}`
}
