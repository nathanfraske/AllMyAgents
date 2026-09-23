import type { Profile, ProfileAvailableModel } from './types.js'

export const MODEL_CATALOG_TTL_MS = 6 * 60 * 60_000
export const MODEL_CATALOG_RETRY_MS = 5 * 60_000
export const MODEL_CATALOG_TIMEOUT_MS = 30_000
export interface ModelCatalogSnapshot {
  models: ProfileAvailableModel[]
  updatedAt: string
}
interface Entry {
  identity: string
  snapshot?: ModelCatalogSnapshot
  pending?: Promise<ModelCatalogSnapshot>
  nextAttempt: number
}

/** Stale-while-revalidate. Listing never waits for a vendor. One read/account, at most two globally.
 * Metadata only: no inference turn, model change, vendor restart, or per-poll journal payload. */
export class ModelCatalog {
  private readonly entries = new Map<string, Entry>()
  private active = 0
  constructor(private readonly now: () => number = Date.now) {}

  private identity(profile: Profile): string {
    return JSON.stringify([profile.provider, profile.dir, profile.providerAccountId, profile.accountEmail, profile.authStatus])
  }

  private entry(profile: Profile): Entry {
    const identity = this.identity(profile)
    let entry = this.entries.get(profile.id)
    if (!entry || entry.identity !== identity) {
      entry = { identity, nextAttempt: 0 }
      this.entries.set(profile.id, entry)
    }
    return entry
  }

  peek(profile: Profile): ModelCatalogSnapshot | undefined { return this.entry(profile).snapshot }

  refresh(profile: Profile, read: () => Promise<ProfileAvailableModel[]>, force = false): Promise<ModelCatalogSnapshot> | undefined {
    const entry = this.entry(profile)
    if (entry.pending) return entry.pending
    if (!force && this.now() < entry.nextAttempt) return undefined
    if (this.active >= 2) {
      if (force) return Promise.reject(new Error('Other model catalogs are refreshing. Try again shortly.'))
      return undefined
    }
    this.active++
    entry.nextAttempt = this.now() + MODEL_CATALOG_RETRY_MS
    const pending = Promise.resolve().then(read).then(models => {
      if (this.entries.get(profile.id) !== entry || this.identity(profile) !== entry.identity) {
        throw new Error('Account changed during model refresh. Refresh the selected account again.')
      }
      if (models.length > 200) throw new Error('Provider model catalog exceeds the supported size')
      const snapshot = { models, updatedAt: new Date(this.now()).toISOString() }
      entry.snapshot = snapshot
      entry.nextAttempt = this.now() + MODEL_CATALOG_TTL_MS
      return snapshot
    }).finally(() => { this.active--; entry.pending = undefined })
    entry.pending = pending
    return pending
  }
}

/** Provider metadata calls are read-only. A late reply cannot replace a newer catalog. */
export async function modelCatalogDeadline<T>(operation: Promise<T>, timeout = MODEL_CATALOG_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Model discovery timed out; the previous list is unchanged.')), timeout)
    })])
  } finally { clearTimeout(timer) }
}
