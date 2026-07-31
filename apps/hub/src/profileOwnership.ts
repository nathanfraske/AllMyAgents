import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export const PROFILE_OWNER_FILE = '.allmyagents-owner.json'
const PROFILE_LOCK_FILE = '.allmyagents-owner-lock.sqlite'
const PROFILE_REFRESH_FILE = '.allmyagents-refresh.json'
const PROFILE_TAKEOVER_FILE = '.allmyagents-owner-takeover.json'

export interface ProfileOwner {
  ownerId: string
  pid: number
  port: number
  startedAt: string
  /** Changes whenever a different logical supervisor reclaims this profile. */
  epoch?: string
  /**
   * A disposable hub — a sandbox — rather than the operator's own app.
   *
   * The operator's app may preempt a live sandbox. A sandbox may never preempt the real app.
   */
  transient?: boolean
}

export interface ClaimResult {
  owned: boolean
  owner: ProfileOwner
  reclaimed?: boolean
  takeover?: ProfileTakeoverProof
}

export interface ProfileTakeoverProof {
  /** Root owner whose durable operations this takeover is allowed to reconcile. */
  predecessorOwnerId: string
  predecessorOwnerEpoch: string
  predecessorPid: number
  predecessorClaimPath: string
  predecessorClaimSha256: string
  /** Exact owner file displaced by this transition (equal to predecessor on the first hop). */
  displacedOwnerId: string
  displacedOwnerEpoch: string
  displacedPid: number
  displacedClaimPath: string
  displacedClaimSha256: string
  successorOwnerId: string
  successorOwnerEpoch: string
  successorPid: number
  reason: 'dead-predecessor' | 'live-transient-preemption'
  reclaimedAt: string
}

export interface ProfileRefreshLease {
  readonly ownerId: string
  readonly ownerEpoch: string
  readonly publicEpoch: number
  readonly generationId: string
  readonly leaseId: string
  readonly takeover?: ProfileTakeoverProof
  isCurrent(): boolean
  release(): void
}

export class ProfileOwnershipError extends Error {
  constructor(
    readonly profileId: string,
    readonly owner: ProfileOwner,
  ) {
    super(
      `Another AllMyAgents hub (port ${owner.port}) is using ${profileId}. This hub will not refresh its credentials.`,
    )
    this.name = 'ProfileOwnershipError'
  }
}

export class ProfileGenerationInactiveError extends Error {
  constructor(readonly generationId: string) {
    super(
      `Credential changes are allowed only from the active public hub generation; ${generationId} is inactive.`,
    )
    this.name = 'ProfileGenerationInactiveError'
  }
}

interface ProfileOwnershipOptions {
  generationId?: string
  publicGenerationActive?: boolean
  publicEpoch?: number
  isProcessLive?: (pid: number) => boolean
  failpoint?: (edge: 'after-takeover-intent' | 'after-predecessor-rename' | 'after-successor-claim') => void
}

interface HeldClaim {
  file: string
  epoch: string
}

interface RefreshRecord {
  ownerId: string
  ownerEpoch: string
  generationId: string
  publicEpoch: number
  generationPid: number
  leaseId: string
  operation: string
  acquiredAt: string
}

function processLive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readClaim(file: string): ProfileOwner | undefined {
  let text: string
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Profile owner claim is not a regular file: ${file}`)
    }
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: Partial<ProfileOwner>
  try {
    value = JSON.parse(text) as Partial<ProfileOwner>
  } catch {
    throw new Error(`Profile owner claim is malformed: ${file}`)
  }
  if (
    typeof value.ownerId === 'string' &&
    value.ownerId.length > 0 &&
    value.ownerId.length <= 128 &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.port === 'number' &&
    Number.isSafeInteger(value.port) &&
    value.port >= 0 &&
    value.port <= 65_535 &&
    typeof value.startedAt === 'string' &&
    (value.epoch === undefined ||
      (typeof value.epoch === 'string' && value.epoch.length > 0 && value.epoch.length <= 128))
  ) {
    return value as ProfileOwner
  }
  throw new Error(`Profile owner claim is malformed: ${file}`)
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function writeJsonNew(file: string, value: unknown): void {
  const fd = fs.openSync(file, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  syncDirectory(path.dirname(file))
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    writeJsonNew(temporary, value)
    fs.renameSync(temporary, file)
    syncDirectory(path.dirname(file))
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* preserve the write failure */
    }
    throw error
  }
}

function syncDirectory(directory: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(directory, 'r')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    return
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* preserve the durability error */
      }
    }
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'EACCES', 'EISDIR'].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    ) {
      throw error
    }
  }
  const barrier = path.join(directory, '.ama-directory-barrier')
  let existing: fs.Stats | undefined
  try {
    const stat = fs.lstatSync(barrier)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Profile durability barrier is not a regular file: ${barrier}`)
    }
    existing = stat
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const barrierFd = fs.openSync(barrier, existing ? 'r+' : 'wx', 0o600)
  try {
    const opened = fs.fstatSync(barrierFd)
    if (
      !opened.isFile() ||
      (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino))
    ) {
      throw new Error(`Profile durability barrier changed while opening: ${barrier}`)
    }
    fs.ftruncateSync(barrierFd, 0)
    fs.writeSync(barrierFd, 'ama-dir-sync-v1\n', null, 'utf8')
    fs.fsyncSync(barrierFd)
  } finally {
    fs.closeSync(barrierFd)
  }
}

function readRefresh(file: string): RefreshRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RefreshRecord>
    if (
      typeof value.ownerId === 'string' &&
      typeof value.ownerEpoch === 'string' &&
      typeof value.generationId === 'string' &&
      Number.isSafeInteger(value.publicEpoch) &&
      Number.isSafeInteger(value.generationPid) &&
      typeof value.leaseId === 'string' &&
      typeof value.operation === 'string' &&
      typeof value.acquiredAt === 'string'
    ) {
      return value as RefreshRecord
    }
  } catch {
    // A stale diagnostic record grants nothing; the SQLite transaction below is the authority.
  }
  return undefined
}

function readTakeover(
  file: string,
  profileDir: string,
  currentOwner: ProfileOwner,
  isProcessLive: (pid: number) => boolean,
): ProfileTakeoverProof | undefined {
  const value = readTakeoverIntent(file, profileDir)
  if (!value) return undefined
  try {
    if (
      value.successorOwnerId !== currentOwner.ownerId ||
      value.successorOwnerEpoch !== currentOwner.epoch ||
      value.successorPid !== currentOwner.pid
    ) {
      return undefined
    }
    const stat = fs.lstatSync(value.predecessorClaimPath)
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined
    if (sha256File(value.predecessorClaimPath) !== value.predecessorClaimSha256) return undefined
    if (value.reason === 'dead-predecessor' && isProcessLive(value.predecessorPid)) return undefined
    const displaced = fs.lstatSync(value.displacedClaimPath)
    if (!displaced.isFile() || displaced.isSymbolicLink()) return undefined
    if (sha256File(value.displacedClaimPath) !== value.displacedClaimSha256) return undefined
    if (value.reason === 'dead-predecessor' && isProcessLive(value.displacedPid)) return undefined
    return value
  } catch {
    return undefined
  }
}

function readTakeoverIntent(
  file: string,
  profileDir: string,
): ProfileTakeoverProof | undefined {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProfileTakeoverProof>
    const stalePrefix = `${PROFILE_OWNER_FILE}.stale-`
    if (
      typeof value.predecessorOwnerId !== 'string' ||
      !value.predecessorOwnerId ||
      typeof value.predecessorOwnerEpoch !== 'string' ||
      !value.predecessorOwnerEpoch ||
      typeof value.predecessorPid !== 'number' ||
      !Number.isSafeInteger(value.predecessorPid) ||
      value.predecessorPid <= 0 ||
      typeof value.predecessorClaimPath !== 'string' ||
      path.dirname(path.resolve(value.predecessorClaimPath)) !== path.resolve(profileDir) ||
      !path.basename(value.predecessorClaimPath).startsWith(stalePrefix) ||
      !/^[a-f0-9]{64}$/.test(String(value.predecessorClaimSha256)) ||
      typeof value.displacedOwnerId !== 'string' ||
      !value.displacedOwnerId ||
      typeof value.displacedOwnerEpoch !== 'string' ||
      !value.displacedOwnerEpoch ||
      typeof value.displacedPid !== 'number' ||
      !Number.isSafeInteger(value.displacedPid) ||
      value.displacedPid <= 0 ||
      typeof value.displacedClaimPath !== 'string' ||
      path.dirname(path.resolve(value.displacedClaimPath)) !== path.resolve(profileDir) ||
      !path.basename(value.displacedClaimPath).startsWith(stalePrefix) ||
      !/^[a-f0-9]{64}$/.test(String(value.displacedClaimSha256)) ||
      typeof value.successorOwnerId !== 'string' ||
      !value.successorOwnerId ||
      typeof value.successorOwnerEpoch !== 'string' ||
      !value.successorOwnerEpoch ||
      typeof value.successorPid !== 'number' ||
      !Number.isSafeInteger(value.successorPid) ||
      value.successorPid <= 0 ||
      (value.reason !== 'dead-predecessor' &&
        value.reason !== 'live-transient-preemption') ||
      typeof value.reclaimedAt !== 'string'
    ) {
      return undefined
    }
    return value as ProfileTakeoverProof
  } catch {
    return undefined
  }
}

/**
 * Profile ownership has two layers:
 *  - a durable logical-supervisor claim used for availability and stale-owner reclamation;
 *  - an OS-released SQLite EXCLUSIVE transaction held for the whole credential mutation.
 *
 * Blue and green intentionally share the logical owner id. They do not share a generation id, and
 * only the generation explicitly marked public may acquire the mutation transaction.
 */
export class ProfileOwnership {
  private readonly held = new Map<string, HeldClaim>()
  private readonly self: ProfileOwner
  private readonly generationId: string
  private readonly isProcessLive: (pid: number) => boolean
  private readonly failpoint?: ProfileOwnershipOptions['failpoint']
  private publicGenerationActive: boolean
  private publicEpoch: number
  private authorityNonce = 0

  constructor(
    self: Omit<ProfileOwner, 'startedAt' | 'epoch'> & { startedAt?: string },
    options: ProfileOwnershipOptions = {},
  ) {
    this.self = { ...self, startedAt: self.startedAt ?? new Date().toISOString() }
    this.generationId = options.generationId ?? crypto.randomUUID()
    this.publicGenerationActive = options.publicGenerationActive ?? true
    this.publicEpoch = options.publicEpoch ?? (this.publicGenerationActive ? 1 : 0)
    if (!Number.isSafeInteger(this.publicEpoch) || this.publicEpoch < 0) {
      throw new Error(`Profile public epoch must be a non-negative safe integer; got ${this.publicEpoch}`)
    }
    this.isProcessLive = options.isProcessLive ?? processLive
    this.failpoint = options.failpoint
  }

  get transient(): boolean {
    return this.self.transient === true
  }

  setPublicGenerationActive(active: boolean, epoch = this.publicEpoch): void {
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error(`Profile public epoch must be a non-negative safe integer; got ${epoch}`)
    }
    if (active && epoch < this.publicEpoch) {
      throw new Error(`Cannot reactivate profile generation at stale epoch ${epoch}; current epoch is ${this.publicEpoch}`)
    }
    this.publicEpoch = Math.max(this.publicEpoch, epoch)
    this.publicGenerationActive = active
    this.authorityNonce++
  }

  claim(profileId: string, profileDir: string): ClaimResult {
    if (!this.publicGenerationActive) {
      const owner = readClaim(path.join(profileDir, PROFILE_OWNER_FILE))
      if (!owner) {
        throw new ProfileGenerationInactiveError(this.generationId)
      }
      return { owned: owner.ownerId === this.self.ownerId, owner }
    }
    fs.mkdirSync(profileDir, { recursive: true })
    const lock = this.tryAcquireFilesystemLease(profileDir)
    if (!lock) {
      const owner = readClaim(path.join(profileDir, PROFILE_OWNER_FILE))
      if (owner) return { owned: owner.ownerId === this.self.ownerId, owner }
      throw new Error(`Could not establish ownership of ${profileId}; its claim is locked and unreadable`)
    }
    try {
      return this.claimWhileLocked(profileId, profileDir)
    } finally {
      this.releaseFilesystemLease(lock)
    }
  }

  private claimWhileLocked(profileId: string, profileDir: string): ClaimResult {
    const file = path.join(profileDir, PROFILE_OWNER_FILE)
    const takeoverFile = path.join(profileDir, PROFILE_TAKEOVER_FILE)
    const owner = readClaim(file)
    if (!owner) {
      const pending = readTakeoverIntent(takeoverFile, profileDir)
      if (pending) {
        const successorStillLive =
          pending.successorOwnerId !== this.self.ownerId &&
          this.isProcessLive(pending.successorPid)
        const predecessorPermitsTakeover =
          pending.reason === 'dead-predecessor'
            ? !this.isProcessLive(pending.predecessorPid)
            : this.self.transient !== true
        if (successorStillLive || !predecessorPermitsTakeover) {
          throw new Error(`Incomplete profile takeover for ${profileId} is still owned by a live process`)
        }
        const stale = fs.lstatSync(pending.displacedClaimPath)
        if (
          !stale.isFile() ||
          stale.isSymbolicLink() ||
          sha256File(pending.displacedClaimPath) !== pending.displacedClaimSha256
        ) {
          throw new Error(`Incomplete profile takeover evidence changed for ${profileId}`)
        }
        const next: ProfileOwner = { ...this.self, epoch: crypto.randomUUID() }
        const resumed: ProfileTakeoverProof = {
          ...pending,
          successorOwnerId: next.ownerId,
          successorOwnerEpoch: next.epoch as string,
          successorPid: next.pid,
          reclaimedAt: new Date().toISOString(),
        }
        writeJsonAtomic(takeoverFile, resumed)
        writeJsonNew(file, next)
        this.failpoint?.('after-successor-claim')
        this.held.set(profileId, { file, epoch: next.epoch as string })
        return { owned: true, owner: next, reclaimed: true, takeover: resumed }
      }
      try {
        fs.lstatSync(takeoverFile)
        throw new Error(`Profile ${profileId} has malformed takeover state`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (owner?.ownerId === this.self.ownerId) {
      const current = owner.epoch ? owner : { ...owner, epoch: crypto.randomUUID() }
      if (!owner.epoch) writeJsonAtomic(file, current)
      this.held.set(profileId, { file, epoch: current.epoch as string })
      const takeover = readTakeover(
        takeoverFile,
        profileDir,
        current,
        this.isProcessLive,
      )
      return { owned: true, owner: current, ...(takeover ? { takeover } : {}) }
    }

    const preemptable = owner?.transient === true && this.self.transient !== true
    if (owner && this.isProcessLive(owner.pid) && !preemptable) {
      return { owned: false, owner }
    }

    const next: ProfileOwner = { ...this.self, epoch: crypto.randomUUID() }
    let takeover: ProfileTakeoverProof | undefined
    let predecessorClaimPath: string | undefined
    if (owner?.epoch) {
      predecessorClaimPath = `${file}.stale-${Date.now()}-${process.pid}-${crypto.randomUUID()}`
      const prior =
        !preemptable
          ? readTakeover(takeoverFile, profileDir, owner, this.isProcessLive)
          : undefined
      takeover = {
        predecessorOwnerId: prior?.predecessorOwnerId ?? owner.ownerId,
        predecessorOwnerEpoch: prior?.predecessorOwnerEpoch ?? owner.epoch,
        predecessorPid: prior?.predecessorPid ?? owner.pid,
        predecessorClaimPath: prior?.predecessorClaimPath ?? predecessorClaimPath,
        predecessorClaimSha256: prior?.predecessorClaimSha256 ?? sha256File(file),
        displacedOwnerId: owner.ownerId,
        displacedOwnerEpoch: owner.epoch,
        displacedPid: owner.pid,
        displacedClaimPath: predecessorClaimPath,
        displacedClaimSha256: sha256File(file),
        successorOwnerId: next.ownerId,
        successorOwnerEpoch: next.epoch as string,
        successorPid: next.pid,
        reason: preemptable ? 'live-transient-preemption' : 'dead-predecessor',
        reclaimedAt: new Date().toISOString(),
      }
      // Publish the intent before the first destructive rename. If this process dies at any later edge,
      // a successor can verify the exact stale claim bytes and resume without losing the predecessor proof.
      writeJsonAtomic(takeoverFile, takeover)
      this.failpoint?.('after-takeover-intent')
    }
    let reclaimed = false
    if (owner) {
      if (!predecessorClaimPath) {
        predecessorClaimPath = `${file}.stale-${Date.now()}-${process.pid}-${crypto.randomUUID()}`
      }
      fs.renameSync(file, predecessorClaimPath)
      syncDirectory(profileDir)
      this.failpoint?.('after-predecessor-rename')
      reclaimed = true
    }
    writeJsonNew(file, next)
    this.failpoint?.('after-successor-claim')
    this.held.set(profileId, { file, epoch: next.epoch as string })
    return {
      owned: true,
      owner: next,
      ...(reclaimed ? { reclaimed: true } : {}),
      ...(takeover ? { takeover } : {}),
    }
  }

  assertOwned(profileId: string, profileDir: string, operation: string): void {
    const lease = this.acquireRefreshLease(profileId, profileDir, operation)
    lease.release()
  }

  acquireRefreshLease(
    profileId: string,
    profileDir: string,
    operation: string,
  ): ProfileRefreshLease {
    if (!this.publicGenerationActive) {
      throw new ProfileGenerationInactiveError(this.generationId)
    }
    fs.mkdirSync(profileDir, { recursive: true })
    const lock = this.tryAcquireFilesystemLease(profileDir)
    if (!lock) {
      const owner = readClaim(path.join(profileDir, PROFILE_OWNER_FILE))
      if (owner && owner.ownerId !== this.self.ownerId) {
        throw new ProfileOwnershipError(profileId, owner)
      }
      throw new Error(`Another hub generation is already refreshing ${profileId}; retry after it finishes.`)
    }

    let released = false
    const acquiredNonce = this.authorityNonce
    const refreshFile = path.join(profileDir, PROFILE_REFRESH_FILE)
    try {
      const claim = this.claimWhileLocked(profileId, profileDir)
      if (!claim.owned) throw new ProfileOwnershipError(profileId, claim.owner)
      const ownerEpoch = claim.owner.epoch
      if (!ownerEpoch) throw new Error(`Profile ${profileId} has no ownership epoch`)
      const record: RefreshRecord = {
        ownerId: this.self.ownerId,
        ownerEpoch,
        generationId: this.generationId,
        publicEpoch: this.publicEpoch,
        generationPid: process.pid,
        leaseId: crypto.randomUUID(),
        operation,
        acquiredAt: new Date().toISOString(),
      }
      writeJsonAtomic(refreshFile, record)
      return {
        ownerId: this.self.ownerId,
        ownerEpoch,
        publicEpoch: this.publicEpoch,
        generationId: this.generationId,
        leaseId: record.leaseId,
        ...(claim.takeover ? { takeover: claim.takeover } : {}),
        isCurrent: () =>
          !released &&
          this.publicGenerationActive &&
          this.authorityNonce === acquiredNonce &&
          this.publicEpoch === record.publicEpoch,
        release: () => {
          if (released) return
          released = true
          const current = readRefresh(refreshFile)
          if (
            current?.ownerId === record.ownerId &&
            current.ownerEpoch === record.ownerEpoch &&
            current.generationId === record.generationId &&
            current.publicEpoch === record.publicEpoch &&
            current.leaseId === record.leaseId
          ) {
            try {
              fs.rmSync(refreshFile)
            } catch {
              // The SQLite transaction remains authoritative. A stale diagnostic record grants nothing.
            }
          }
          this.releaseFilesystemLease(lock)
        },
      }
    } catch (error) {
      this.releaseFilesystemLease(lock)
      throw error
    }
  }

  releaseAll(): void {
    // Logical ownership belongs to the supervisor lifetime, not to a blue/green child. Blue and green
    // deliberately share ownerId + epoch, so deleting here lets a retiring blue erase green's claim.
    // Leaving the tiny claim is safe for standalone too: its recorded PID dies with this process and the
    // next owner reclaims it under the serialized transition lease.
    this.held.clear()
  }

  private tryAcquireFilesystemLease(profileDir: string): Database.Database | undefined {
    const file = path.join(profileDir, PROFILE_LOCK_FILE)
    let db: Database.Database | undefined
    try {
      db = new Database(file, { timeout: 0 })
      db.pragma('journal_mode = DELETE')
      db.exec('BEGIN EXCLUSIVE')
      return db
    } catch {
      try {
        db?.close()
      } catch {
        /* the unavailable lease is the useful result */
      }
      return undefined
    }
  }

  private releaseFilesystemLease(db: Database.Database): void {
    try {
      if (db.inTransaction) db.exec('ROLLBACK')
    } finally {
      db.close()
    }
  }
}
