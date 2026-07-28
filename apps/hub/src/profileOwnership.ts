import fs from 'node:fs'
import path from 'node:path'

export const PROFILE_OWNER_FILE = '.allmyagents-owner.json'

export interface ProfileOwner {
  ownerId: string
  pid: number
  port: number
  startedAt: string
}

export interface ClaimResult {
  owned: boolean
  owner: ProfileOwner
  reclaimed?: boolean
}

export class ProfileOwnershipError extends Error {
  constructor(
    readonly profileId: string,
    readonly owner: ProfileOwner
  ) {
    super(`Another AllMyAgents hub (port ${owner.port}) is using ${profileId}. This hub will not refresh its credentials.`)
    this.name = 'ProfileOwnershipError'
  }
}

function live(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readClaim(file: string): ProfileOwner | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProfileOwner>
    if (
      typeof value.ownerId === 'string' &&
      Number.isSafeInteger(value.pid) &&
      Number.isSafeInteger(value.port) &&
      typeof value.startedAt === 'string'
    ) return value as ProfileOwner
  } catch {
    // Missing, malformed, or concurrently replaced claims are handled by the atomic create below.
  }
  return undefined
}

export class ProfileOwnership {
  private readonly held = new Map<string, string>()
  private readonly self: ProfileOwner

  constructor(self: Omit<ProfileOwner, 'startedAt'> & { startedAt?: string }) {
    this.self = { ...self, startedAt: self.startedAt ?? new Date().toISOString() }
  }

  claim(profileId: string, profileDir: string): ClaimResult {
    fs.mkdirSync(profileDir, { recursive: true })
    const file = path.join(profileDir, PROFILE_OWNER_FILE)
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const fd = fs.openSync(file, 'wx', 0o600)
        try {
          fs.writeFileSync(fd, `${JSON.stringify(this.self, null, 2)}\n`)
        } finally {
          fs.closeSync(fd)
        }
        this.held.set(profileId, file)
        return { owned: true, owner: this.self, reclaimed: attempt > 0 }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }

      const owner = readClaim(file)
      if (owner?.ownerId === this.self.ownerId) {
        this.held.set(profileId, file)
        return { owned: true, owner }
      }
      if (owner && live(owner.pid)) return { owned: false, owner }

      // Dead/malformed claims are renamed first. That preserves evidence and makes competing reclaimers
      // race on the next atomic `wx`; only one can become owner.
      try {
        fs.renameSync(file, `${file}.stale-${Date.now()}-${process.pid}`)
      } catch {
        // Another contender changed it; retry from disk.
      }
    }
    const owner = readClaim(file)
    if (owner) return { owned: false, owner }
    throw new Error(`Could not establish ownership of ${profileId}; its claim changed repeatedly`)
  }

  assertOwned(profileId: string, profileDir: string, _operation: string): void {
    const result = this.claim(profileId, profileDir)
    if (!result.owned) throw new ProfileOwnershipError(profileId, result.owner)
  }

  releaseAll(): void {
    for (const [profileId, file] of this.held) {
      const owner = readClaim(file)
      if (owner?.ownerId !== this.self.ownerId) continue
      try {
        fs.rmSync(file)
      } catch {
        // Best effort. A crash leaves the same artifact; dead-pid reclamation handles it.
      }
      this.held.delete(profileId)
    }
  }
}
