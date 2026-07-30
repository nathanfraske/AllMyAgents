import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  cancelLogin,
  getLogin,
  getLoginForProfile,
  startLogin,
  type LoginAttempt,
  type LoginStatus,
  type StartLoginOptions,
} from './loginLauncher.js'
import type { ProfileOwnership } from './profileOwnership.js'
import type { ProfileRuntime } from './profileRuntime.js'
import type {
  ProfileTurnFreezeReceipt,
  ProfileTurnSettlementResult,
  SessionManager,
} from './sessions.js'
import type { Provider } from './types.js'

const REGISTRY_FORMAT = 1 as const
const ACTIVE = new Set<LoginStatus>(['capturing', 'waiting', 'settling'])
const TERMINAL = new Set<LoginStatus>(['complete', 'failed', 'cancelled', 'timed-out'])
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 4_000
const DEFAULT_OBSERVE_INTERVAL_MS = 100

interface ProfileLoginRecord {
  format: typeof REGISTRY_FORMAT
  loginId: string
  launcherId?: string
  idempotencyKey: string
  profileId: string
  profileDir: string
  provider: Provider
  reauth: boolean
  status: LoginStatus
  error?: string
  createdAt: string
  updatedAt: string
}

interface RegistryDocument {
  format: typeof REGISTRY_FORMAT
  records: ProfileLoginRecord[]
}

export interface ProfileLoginResult {
  ok: boolean
  loginId: string
  profileId: string
  provider: Provider
  status: LoginStatus
  url?: string
  code?: string
  error?: string
  added?: string
}

export interface StartProfileLoginRequest {
  provider: Provider
  profileId: string
  reauth: boolean
  idempotencyKey: string
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
      throw new Error(`Profile-login durability barrier is not a regular file: ${barrier}`)
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
      throw new Error(`Profile-login durability barrier changed while opening: ${barrier}`)
    }
    fs.ftruncateSync(barrierFd, 0)
    fs.writeSync(barrierFd, 'ama-dir-sync-v1\n', null, 'utf8')
    fs.fsyncSync(barrierFd)
  } finally {
    fs.closeSync(barrierFd)
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(temporary, file)
    syncDirectory(path.dirname(file))
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* preserve the publication failure */
    }
    throw error
  }
}

function validRecord(value: unknown): value is ProfileLoginRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ProfileLoginRecord>
  return (
    record.format === REGISTRY_FORMAT &&
    typeof record.loginId === 'string' &&
    /^[a-f0-9-]{36}$/i.test(record.loginId) &&
    (record.launcherId === undefined || typeof record.launcherId === 'string') &&
    typeof record.idempotencyKey === 'string' &&
    /^[a-zA-Z0-9._:-]{1,128}$/.test(record.idempotencyKey) &&
    typeof record.profileId === 'string' &&
    /^[a-zA-Z0-9_-]+$/.test(record.profileId) &&
    typeof record.profileDir === 'string' &&
    (record.provider === 'claude' || record.provider === 'codex') &&
    typeof record.reauth === 'boolean' &&
    typeof record.status === 'string' &&
    (ACTIVE.has(record.status as LoginStatus) ||
      TERMINAL.has(record.status as LoginStatus)) &&
    (record.error === undefined || typeof record.error === 'string') &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  )
}

/**
 * Durable, non-secret public attempt identity. The vendor launcher owns credential bytes and its own
 * crash saga; this registry only makes an authenticated HTTP retry refer to that exact saga.
 */
export class ProfileLoginRegistry {
  private readonly records = new Map<string, ProfileLoginRecord>()
  private unavailableReason: string | undefined

  constructor(private readonly file: string) {
    try {
      this.load()
    } catch (error) {
      this.unavailableReason =
        error instanceof Error ? error.message : String(error)
    }
  }

  begin(request: StartProfileLoginRequest, profileDir: string): {
    record: ProfileLoginRecord
    created: boolean
  } {
    if (this.unavailableReason) {
      throw new Error(
        `Profile sign-in recovery registry is unavailable: ${this.unavailableReason}`,
      )
    }
    const existing = this.records.get(request.profileId)
    if (
      existing &&
      (ACTIVE.has(existing.status) ||
        existing.idempotencyKey === request.idempotencyKey)
    ) {
      return { record: { ...existing }, created: false }
    }
    const now = new Date().toISOString()
    const record: ProfileLoginRecord = {
      format: REGISTRY_FORMAT,
      loginId: crypto.randomUUID(),
      idempotencyKey: request.idempotencyKey,
      profileId: request.profileId,
      profileDir: path.resolve(profileDir),
      provider: request.provider,
      reauth: request.reauth,
      status: 'settling',
      createdAt: now,
      updatedAt: now,
    }
    this.records.set(record.profileId, record)
    this.persist()
    return { record: { ...record }, created: true }
  }

  get(loginId: string): ProfileLoginRecord | undefined {
    const record = [...this.records.values()].find(
      (candidate) => candidate.loginId === loginId,
    )
    return record ? { ...record } : undefined
  }

  getForProfile(
    profileId: string,
    idempotencyKey: string,
  ): ProfileLoginRecord | undefined {
    const record = this.records.get(profileId)
    if (!record || record.idempotencyKey !== idempotencyKey) return undefined
    return { ...record }
  }

  update(
    profileId: string,
    patch: Partial<
      Pick<ProfileLoginRecord, 'launcherId' | 'status' | 'error'>
    >,
  ): ProfileLoginRecord {
    const current = this.records.get(profileId)
    if (!current) throw new Error(`Unknown profile login record for ${profileId}`)
    const next: ProfileLoginRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    if (patch.error === undefined) delete next.error
    this.records.set(profileId, next)
    this.persist()
    return { ...next }
  }

  active(): ProfileLoginRecord[] {
    return [...this.records.values()]
      .filter((record) => ACTIVE.has(record.status))
      .map((record) => ({ ...record }))
  }

  private load(): void {
    let raw: string
    try {
      const stat = fs.lstatSync(this.file)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Profile-login registry is not a regular file: ${this.file}`)
      }
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const document = JSON.parse(raw) as Partial<RegistryDocument>
    if (
      document.format !== REGISTRY_FORMAT ||
      !Array.isArray(document.records) ||
      !document.records.every(validRecord)
    ) {
      throw new Error(`Profile-login registry is malformed: ${this.file}`)
    }
    for (const record of document.records) {
      this.records.set(record.profileId, { ...record })
    }
  }

  private persist(): void {
    const document: RegistryDocument = {
      format: REGISTRY_FORMAT,
      records: [...this.records.values()],
    }
    writeJsonAtomic(this.file, document)
  }
}

interface ProfileLoginCoordinatorOptions {
  profilesDir: string
  registry: ProfileLoginRegistry
  profileRuntime: Pick<ProfileRuntime, 'currentGeneration' | 'rescan'>
  profileOwnership: Pick<ProfileOwnership, 'acquireRefreshLease'>
  sessions: Pick<
    SessionManager,
    | 'freezeProfileTurnAdmission'
    | 'settleProfileTurns'
    | 'thawProfileTurnAdmission'
  >
  startLogin?: typeof startLogin
  getLogin?: typeof getLogin
  getLoginForProfile?: typeof getLoginForProfile
  cancelLogin?: typeof cancelLogin
  settlementTimeoutMs?: number
  observeIntervalMs?: number
}

export class ProfileLoginCoordinator {
  private readonly profilesDir: string
  private readonly startLoginFn: typeof startLogin
  private readonly getLoginFn: typeof getLogin
  private readonly getLoginForProfileFn: typeof getLoginForProfile
  private readonly cancelLoginFn: typeof cancelLogin
  private readonly settlementTimeoutMs: number
  private readonly observeIntervalMs: number
  private readonly receipts = new Map<string, ProfileTurnFreezeReceipt>()
  private readonly observers = new Map<string, NodeJS.Timeout>()
  private readonly details = new Map<string, Pick<LoginAttempt, 'url' | 'code'>>()
  private readonly finished = new Set<string>()
  private readonly cancellationRequested = new Set<string>()
  private readonly pendingLaunch = new Set<string>()

  constructor(private readonly options: ProfileLoginCoordinatorOptions) {
    this.profilesDir = path.resolve(options.profilesDir)
    this.startLoginFn = options.startLogin ?? startLogin
    this.getLoginFn = options.getLogin ?? getLogin
    this.getLoginForProfileFn = options.getLoginForProfile ?? getLoginForProfile
    this.cancelLoginFn = options.cancelLogin ?? cancelLogin
    this.settlementTimeoutMs =
      options.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS
    this.observeIntervalMs =
      options.observeIntervalMs ?? DEFAULT_OBSERVE_INTERVAL_MS
  }

  async start(request: StartProfileLoginRequest): Promise<ProfileLoginResult> {
    this.validateRequest(request)
    const generation = this.options.profileRuntime.currentGeneration()
    if (!generation.active) {
      return this.failure(
        request,
        crypto.randomUUID(),
        'Sign-in is available only from the active public hub generation.',
      )
    }
    const profileDir = path.join(this.profilesDir, request.profileId)
    let begun: ReturnType<ProfileLoginRegistry['begin']>
    try {
      begun = this.options.registry.begin(request, profileDir)
    } catch (error) {
      return this.failure(
        request,
        crypto.randomUUID(),
        error instanceof Error ? error.message : String(error),
      )
    }
    if (!begun.created) {
      if (begun.record.idempotencyKey !== request.idempotencyKey) {
        return this.failure(
          request,
          begun.record.loginId,
          'A different sign-in request is already active for this profile.',
        )
      }
      return this.refresh(begun.record)
    }
    const record = begun.record
    if (
      record.provider !== request.provider ||
      record.reauth !== request.reauth ||
      record.profileDir !== path.resolve(profileDir)
    ) {
      return this.failure(
        request,
        record.loginId,
        'The idempotency key belongs to a different sign-in request.',
      )
    }
    this.pendingLaunch.add(record.loginId)
    let receipt: ProfileTurnFreezeReceipt | undefined
    try {
      if (request.reauth) {
        receipt = this.options.sessions.freezeProfileTurnAdmission(
          request.profileId,
          generation.publicEpoch,
          generation.generationId,
        )
        this.receipts.set(record.loginId, receipt)
        const settlement = await this.options.sessions.settleProfileTurns(
          receipt,
          this.settlementTimeoutMs,
        )
        if (this.cancellationRequested.has(record.loginId)) {
          return this.failRecord(
            record,
            'Sign-in was cancelled before credentials changed.',
            'cancelled',
          )
        }
        if (!settlement.settled) {
          return this.failRecord(
            record,
            this.settlementFailure(settlement),
          )
        }
      }

      const login = await this.startLoginFn(request.provider, profileDir, {
        reauth: request.reauth,
        profileId: request.profileId,
        idempotencyKey: request.idempotencyKey,
        acquireLease: () =>
          this.options.profileOwnership.acquireRefreshLease(
            request.profileId,
            profileDir,
            request.reauth
              ? 'replace credentials'
              : 'create credentials',
          ),
      })
      this.details.set(record.loginId, { url: login.url, code: login.code })
      const updated = this.options.registry.update(request.profileId, {
        launcherId: login.id,
        status: login.status,
        ...(login.error ? { error: login.error } : {}),
      })
      this.pendingLaunch.delete(record.loginId)
      if (TERMINAL.has(updated.status)) this.finish(updated)
      else this.observe(updated)
      return this.view(updated)
    } catch (error) {
      this.pendingLaunch.delete(record.loginId)
      return this.failRecord(
        record,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  get(loginId: string): ProfileLoginResult | undefined {
    const record = this.options.registry.get(loginId)
    return record ? this.refresh(record) : undefined
  }

  getForProfile(
    profileId: string,
    idempotencyKey: string,
  ): ProfileLoginResult | undefined {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(profileId) ||
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(idempotencyKey)
    ) {
      return undefined
    }
    const record = this.options.registry.getForProfile(
      profileId,
      idempotencyKey,
    )
    return record ? this.refresh(record) : undefined
  }

  cancel(loginId: string): ProfileLoginResult | undefined {
    const record = this.options.registry.get(loginId)
    if (!record) return undefined
    const refreshed = this.refreshRecord(record)
    if (TERMINAL.has(refreshed.status)) return this.view(refreshed)
    this.cancellationRequested.add(loginId)
    if (!refreshed.launcherId) {
      const settling = this.options.registry.update(refreshed.profileId, {
        status: 'settling',
        error:
          'Cancellation requested; waiting for the pre-credential settlement boundary.',
      })
      return this.view(settling)
    }
    const cancelled = this.cancelLoginFn(refreshed.launcherId)
    if (!cancelled) {
      const unknown = this.options.registry.update(refreshed.profileId, {
        status: 'settling',
        error:
          'The vendor sign-in process is unavailable; recovery will reconcile its durable credential state.',
      })
      return this.view(unknown)
    }
    const updated = this.options.registry.update(refreshed.profileId, {
      status: cancelled.status,
      ...(cancelled.error ? { error: cancelled.error } : {}),
    })
    if (TERMINAL.has(updated.status)) this.finish(updated)
    else this.observe(updated)
    return this.view(updated)
  }

  /**
   * Called after active ProfileRuntime bootstrap has reconciled crash-left launcher state. A successor
   * never recreates the predecessor's in-memory freeze: it reports the same public attempt and observes
   * any still-live launcher, otherwise it publishes a conservative terminal system-interruption result.
   */
  recoverAfterProfileBootstrap(): void {
    if (!this.options.profileRuntime.currentGeneration().active) return
    for (const record of this.options.registry.active()) {
      const live =
        (record.launcherId && this.getLoginFn(record.launcherId)) ||
        this.getLoginForProfileFn(record.profileDir)
      if (live) {
        this.details.set(record.loginId, { url: live.url, code: live.code })
        const updated = this.applyLive(record, live)
        if (TERMINAL.has(updated.status)) this.finish(updated)
        else this.observe(updated)
        continue
      }
      this.options.registry.update(record.profileId, {
        status: 'failed',
        error:
          'SYSTEM INTERRUPTION: the prior sign-in process did not survive restart. Credential recovery completed without treating this as a user response; retry sign-in if needed.',
      })
      this.finished.add(record.loginId)
    }
  }

  dispose(): void {
    for (const timer of this.observers.values()) clearTimeout(timer)
    this.observers.clear()
  }

  private refresh(record: ProfileLoginRecord): ProfileLoginResult {
    return this.view(this.refreshRecord(record))
  }

  private refreshRecord(record: ProfileLoginRecord): ProfileLoginRecord {
    if (!ACTIVE.has(record.status)) {
      this.finish(record)
      return record
    }
    if (!record.launcherId && this.pendingLaunch.has(record.loginId)) {
      return record
    }
    const live =
      (record.launcherId && this.getLoginFn(record.launcherId)) ||
      this.getLoginForProfileFn(record.profileDir)
    if (!live) {
      if (this.options.profileRuntime.currentGeneration().active) {
        const interrupted = this.options.registry.update(record.profileId, {
          status: 'failed',
          error:
            'SYSTEM INTERRUPTION: the sign-in process is no longer available. Credential recovery did not treat this as a user response; retry sign-in if needed.',
        })
        this.finish(interrupted)
        return interrupted
      }
      return record
    }
    this.details.set(record.loginId, { url: live.url, code: live.code })
    const updated = this.applyLive(record, live)
    if (TERMINAL.has(updated.status)) this.finish(updated)
    return updated
  }

  private observe(record: ProfileLoginRecord): void {
    if (this.observers.has(record.loginId)) return
    const check = (): void => {
      this.observers.delete(record.loginId)
      const current = this.options.registry.get(record.loginId)
      if (!current || TERMINAL.has(current.status)) return
      let terminal = false
      try {
        terminal = TERMINAL.has(this.refreshRecord(current).status)
      } catch (error) {
        console.error(
          `[profiles] could not publish sign-in status for ${current.profileId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      if (!terminal) {
        const timer = setTimeout(check, this.observeIntervalMs)
        timer.unref()
        this.observers.set(record.loginId, timer)
      }
    }
    const timer = setTimeout(check, this.observeIntervalMs)
    timer.unref()
    this.observers.set(record.loginId, timer)
  }

  private applyLive(
    record: ProfileLoginRecord,
    live: LoginAttempt,
  ): ProfileLoginRecord {
    const same =
      record.launcherId === live.id &&
      record.status === live.status &&
      record.error === live.error
    if (same) return record
    return this.options.registry.update(record.profileId, {
      launcherId: live.id,
      status: live.status,
      ...(live.error ? { error: live.error } : {}),
    })
  }

  private finish(record: ProfileLoginRecord): void {
    if (!TERMINAL.has(record.status) || this.finished.has(record.loginId)) return
    this.finished.add(record.loginId)
    const observer = this.observers.get(record.loginId)
    if (observer) clearTimeout(observer)
    this.observers.delete(record.loginId)
    try {
      this.options.profileRuntime.rescan()
    } catch {
      // The launcher terminal is still durable truth. A later account rescan can refresh presentation.
    }
    const receipt = this.receipts.get(record.loginId)
    if (receipt) {
      this.options.sessions.thawProfileTurnAdmission(receipt)
      this.receipts.delete(record.loginId)
    }
  }

  private failRecord(
    record: ProfileLoginRecord,
    error: string,
    status: Extract<LoginStatus, 'failed' | 'cancelled'> = 'failed',
  ): ProfileLoginResult {
    this.pendingLaunch.delete(record.loginId)
    const updated = this.options.registry.update(record.profileId, {
      status,
      error,
    })
    this.finish(updated)
    return this.view(updated)
  }

  private view(record: ProfileLoginRecord): ProfileLoginResult {
    const detail = this.details.get(record.loginId)
    return {
      ok: ACTIVE.has(record.status) || record.status === 'complete',
      loginId: record.loginId,
      profileId: record.profileId,
      provider: record.provider,
      status: record.status,
      ...(detail?.url ? { url: detail.url } : {}),
      ...(detail?.code ? { code: detail.code } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(record.status === 'complete' ? { added: record.profileId } : {}),
    }
  }

  private failure(
    request: StartProfileLoginRequest,
    loginId: string,
    error: string,
  ): ProfileLoginResult {
    return {
      ok: false,
      loginId,
      profileId: request.profileId,
      provider: request.provider,
      status: 'failed',
      error,
    }
  }

  private settlementFailure(result: ProfileTurnSettlementResult): string {
    const sessions = result.outcomeUnknownSessionIds.join(', ') || 'none'
    const operations = result.outcomeUnknownOperationIds.join(', ') || 'none'
    return `Profile turns could not settle safely before credential replacement (sessions: ${sessions}; admissions: ${operations}). The live credential was not changed.`
  }

  private validateRequest(request: StartProfileLoginRequest): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(request.profileId)) {
      throw new Error('Profile name must match ^[a-zA-Z0-9_-]+$.')
    }
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(request.idempotencyKey)) {
      throw new Error('Sign-in idempotency key is invalid.')
    }
    const resolved = path.resolve(this.profilesDir, request.profileId)
    if (path.dirname(resolved) !== this.profilesDir) {
      throw new Error('Profile path escapes the managed profiles directory.')
    }
  }
}
