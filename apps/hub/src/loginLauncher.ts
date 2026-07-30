import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { profileAuthEvidence } from './profiles.js'
import type { ProfileRefreshLease } from './profileOwnership.js'
import type { Profile, Provider } from './types.js'

const CRED_FILE: Record<Provider, string> = {
  claude: '.credentials.json',
  codex: 'auth.json',
}

const ENV_VAR: Record<Provider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
}

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

const ACTIVE = new Set<LoginStatus>(['capturing', 'waiting'])
const UNSETTLED = new Set<LoginStatus>(['capturing', 'waiting', 'settling'])
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g
const URL = /https?:\/\/[^\s<>"'`\\]+/gi
const MAX_OUTPUT = 16_000
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000
const DEFAULT_TERMINATION_TIMEOUT_MS = 2_000
const ATTEMPT_FORMAT = 1 as const
const ATTEMPT_FILE = '.allmyagents-login-attempt.json'

export type LoginStatus =
  | 'capturing'
  | 'waiting'
  | 'settling'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'timed-out'

export interface LoginAttempt {
  id: string
  provider: Provider
  status: LoginStatus
  url?: string
  code?: string
  error?: string
}

export interface LoginDrainResult {
  settled: number
  outcomeUnknown: number
}

export interface LoginReconcileResult {
  profileId: string
  attemptId?: string
  outcome: 'none' | 'restored-prior' | 'accepted-new' | 'conflict' | 'busy'
  error?: string
}

export interface InterruptedLoginRecoveryNotice {
  profileDir: string
  profileId?: string
  error: string
}

export interface InterruptedLoginDiscovery {
  profiles: Profile[]
  notices: InterruptedLoginRecoveryNotice[]
}

interface DurableLoginAttempt {
  format: typeof ATTEMPT_FORMAT
  attemptId: string
  requestKey?: string
  provider: Provider
  profileId: string
  profileDir: string
  credentialPath: string
  archivePath?: string
  priorSha256?: string
  ownerId: string
  ownerEpoch: string
  publicEpoch: number
  generationId: string
  leaseId: string
  phase: 'prepared' | 'archived' | 'spawned' | 'waiting'
  createdAt: string
  updatedAt: string
}

type DurableLoginAttemptRead =
  | { kind: 'absent' }
  | { kind: 'valid'; attempt: DurableLoginAttempt }
  | { kind: 'unverifiable'; error: string }

interface LoginAttemptInternal extends LoginAttempt {
  requestKey?: string
  profileId: string
  profileDir: string
  child?: ChildProcessWithoutNullStreams
  childClosed: boolean
  output: string
  settledCapture: boolean
  captureTimer?: NodeJS.Timeout
  loginTimer?: NodeJS.Timeout
  credentialPoll?: NodeJS.Timeout
  authority?: ProfileRefreshLease
  durable?: DurableLoginAttempt
  pendingTerminal?: {
    status: Exclude<LoginStatus, 'capturing' | 'waiting' | 'settling'>
    error?: string
  }
  finalized: boolean
  finalizedPromise: Promise<void>
  resolveFinalized: () => void
}

export interface StartLoginOptions {
  captureTimeoutMs?: number
  loginTimeoutMs?: number
  terminationTimeoutMs?: number
  spawnProcess?: typeof spawn
  reauth?: boolean
  profileId?: string
  acquireLease?: () => ProfileRefreshLease
  idempotencyKey?: string
}

const attempts = new Map<string, LoginAttemptInternal>()
let loginAdmissionOpen = true

/** Compatibility helper for the manual/legacy caller; durable re-auth uses the attempt saga below. */
export function archiveCredentialForReauth(
  provider: Provider,
  profileDir: string,
): string | undefined {
  const credential = path.join(profileDir, CRED_FILE[provider])
  try {
    const stat = fs.lstatSync(credential)
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const archived = `${credential}.signed-out-${Date.now()}-${crypto.randomUUID()}`
  fs.renameSync(credential, archived)
  return archived
}

export function setLoginAdmission(open: boolean): void {
  loginAdmissionOpen = open
}

function binDir(): string {
  return path.resolve(import.meta.dirname, '..', 'node_modules', '.bin')
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..')
}

function cleanOutput(value: string): string {
  return value
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .replace(/[^\x09\x0a\x20-\x7e\u00a0-\uffff]/g, '')
}

function conciseOutput(value: string): string {
  const clean = cleanOutput(value).trim()
  if (!clean) return '(the command produced no readable output)'
  return clean.length > 2_400 ? `…${clean.slice(-2_400)}` : clean
}

function trimUrl(raw: string): string {
  return raw.replace(/[\]),.;:!?]+$/g, '')
}

function candidateScore(provider: Provider, url: globalThis.URL, context: string): number {
  const host = url.hostname.toLowerCase()
  const text = `${url.pathname} ${context}`.toLowerCase()
  let score = 0
  if (url.protocol === 'https:') score += 20
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') score -= 1_000
  if (
    provider === 'claude' &&
    (host.endsWith('claude.ai') ||
      host.endsWith('claude.com') ||
      host.endsWith('anthropic.com'))
  ) {
    score += 100
  }
  if (provider === 'codex' && (host.endsWith('openai.com') || host.endsWith('chatgpt.com'))) {
    score += 100
  }
  if (/^\/(?:docs?|help|support)(?:\/|$)/.test(url.pathname.toLowerCase())) score -= 100
  if (/\b(oauth|authorize|authenticate|login|sign-in|signin|device)\b/.test(text)) score += 40
  if (/\b(browser|navigate|open|visit|continue)\b/.test(context.toLowerCase())) score += 15
  return score
}

export function parseLoginOutput(
  provider: Provider,
  output: string,
): { url: string; code?: string } | null {
  const clean = cleanOutput(output)
  const candidates: Array<{ url: string; score: number }> = []
  for (const match of clean.matchAll(URL)) {
    const raw = trimUrl(match[0])
    try {
      const parsed = new globalThis.URL(raw)
      if (parsed.protocol !== 'https:') continue
      const start = Math.max(0, (match.index ?? 0) - 120)
      const context = clean.slice(start, (match.index ?? 0) + raw.length + 80)
      candidates.push({ url: parsed.toString(), score: candidateScore(provider, parsed, context) })
    } catch {
      // Stream chunks may temporarily end inside a URL. The whole buffer is reparsed on the next chunk.
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  if (!best || best.score < 75) return null
  const code = /\b([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8}){1,3})\b/.exec(clean)?.[1]
  return code ? { url: best.url, code } : { url: best.url }
}

export function loginCaptureError(provider: Provider, output: string): string {
  return `${PROVIDER_LABEL[provider]} did not provide a sign-in URL. Command output:\n${conciseOutput(output)}`
}

export function credentialsPath(provider: Provider, profileDir: string): string {
  return path.join(profileDir, CRED_FILE[provider])
}

export function credentialsExist(provider: Provider, profileDir: string): boolean {
  try {
    return fs.lstatSync(credentialsPath(provider, profileDir)).isFile()
  } catch {
    return false
  }
}

function durableCredentialReady(provider: Provider, profileDir: string): boolean {
  const credential = credentialsPath(provider, profileDir)
  try {
    const stat = fs.lstatSync(credential, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    const evidence = profileAuthEvidence({ id: path.basename(profileDir), provider, dir: profileDir })
    if (evidence.authStatus !== 'signed_in') return false
    const fd = fs.openSync(credential, 'r+')
    try {
      const opened = fs.fstatSync(fd, { bigint: true })
      if (!sameFileIdentity(stat, opened)) return false
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    const after = fs.lstatSync(credential, { bigint: true })
    if (!sameFileIdentity(stat, after)) return false
    return true
  } catch {
    return false
  }
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  )
}

function loginCommand(provider: Provider): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    if (provider === 'claude') {
      return {
        command: path.resolve(
          binDir(),
          '..',
          '@anthropic-ai',
          'claude-code',
          'bin',
          'claude.exe',
        ),
        args: ['auth', 'login'],
      }
    }
    return {
      command: process.execPath,
      args: [
        path.resolve(binDir(), '..', '@openai', 'codex', 'bin', 'codex.js'),
        'login',
        '--device-auth',
      ],
    }
  }
  return {
    command: path.join(binDir(), provider),
    args: provider === 'claude' ? ['auth', 'login'] : ['login', '--device-auth'],
  }
}

function publicAttempt(attempt: LoginAttemptInternal): LoginAttempt {
  const { id, provider, status, url, code, error } = attempt
  return {
    id,
    provider,
    status,
    ...(url ? { url } : {}),
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
  }
}

function clearAttemptTimers(attempt: LoginAttemptInternal): void {
  if (attempt.captureTimer) clearTimeout(attempt.captureTimer)
  if (attempt.loginTimer) clearTimeout(attempt.loginTimer)
  if (attempt.credentialPoll) clearInterval(attempt.credentialPoll)
}

function terminate(attempt: LoginAttemptInternal): void {
  const child = attempt.child
  if (!child || attempt.childClosed) return
  try {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.unref()
    } else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill()
      }
    } else {
      child.kill()
    }
  } catch {
    // The child may cross its exit boundary while termination is dispatched.
  }
}

function attemptStateFile(profileDir: string): string {
  return path.join(profileDir, ATTEMPT_FILE)
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, 'r+')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
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
    fsyncParentDirectory(file)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* preserve the publication failure */
    }
    throw error
  }
}

function fsyncParentDirectory(file: string): void {
  const directory = path.dirname(file)
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
  // Node cannot open a directory for FlushFileBuffers on Windows. Flushing this fixed-size,
  // same-directory barrier issues the required volume flush after the metadata operation.
  const barrier = path.join(directory, '.ama-directory-barrier')
  let existing: fs.Stats | undefined
  try {
    const stat = fs.lstatSync(barrier)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Login durability barrier is not a regular file: ${barrier}`)
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
      throw new Error(`Login durability barrier changed while opening: ${barrier}`)
    }
    fs.ftruncateSync(barrierFd, 0)
    fs.writeSync(barrierFd, 'ama-dir-sync-v1\n', null, 'utf8')
    fs.fsyncSync(barrierFd)
  } finally {
    fs.closeSync(barrierFd)
  }
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function restoreArchiveNoReplace(
  archive: string,
  target: string,
  expectedSha256: string,
  beforeLink?: () => void,
): void {
  const archiveStat = fs.lstatSync(archive, { bigint: true })
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    throw new Error('prior credential archive is not a regular file')
  }
  const archiveFd = fs.openSync(archive, 'r')
  let targetCreated = false
  let publishedTarget: fs.BigIntStats | undefined
  try {
    const openedArchive = fs.fstatSync(archiveFd, { bigint: true })
    if (!sameFileIdentity(archiveStat, openedArchive)) {
      throw new Error('prior credential archive changed while opening')
    }
    const digest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(archiveFd))
      .digest('hex')
    if (digest !== expectedSha256) {
      throw new Error('prior credential archive digest changed')
    }
    try {
      fs.lstatSync(target)
      throw Object.assign(new Error('credential rollback target already exists'), {
        code: 'EEXIST',
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    beforeLink?.()
    fs.linkSync(archive, target)
    targetCreated = true
    const targetStat = fs.lstatSync(target, { bigint: true })
    publishedTarget = targetStat
    if (!sameFileIdentity(openedArchive, targetStat)) {
      throw new Error('credential archive changed during no-replace publication')
    }
    const targetFd = fs.openSync(target, 'r+')
    try {
      const openedTarget = fs.fstatSync(targetFd, { bigint: true })
      if (!sameFileIdentity(openedArchive, openedTarget)) {
        throw new Error('restored credential changed while opening')
      }
      fs.fsyncSync(targetFd)
    } finally {
      fs.closeSync(targetFd)
    }
    fsyncParentDirectory(target)
    const archiveAfter = fs.lstatSync(archive, { bigint: true })
    if (!sameFileIdentity(openedArchive, archiveAfter)) {
      throw new Error('credential archive path changed before cleanup')
    }
    fs.rmSync(archive)
    fsyncParentDirectory(archive)
  } catch (error) {
    if (targetCreated) {
      try {
        const targetNow = fs.lstatSync(target, { bigint: true })
        if (publishedTarget && sameFileIdentity(publishedTarget, targetNow)) {
          fs.rmSync(target)
          fsyncParentDirectory(target)
        }
      } catch {
        // Never remove a path that no longer has the exact inode this operation published.
      }
    }
    throw error
  } finally {
    fs.closeSync(archiveFd)
  }
}

function assertCurrentAuthority(attempt: LoginAttemptInternal): void {
  if (attempt.authority && !attempt.authority.isCurrent()) {
    throw new Error(
      `Credential authority for public generation ${attempt.authority.publicEpoch} is no longer current.`,
    )
  }
}

function updateDurablePhase(
  attempt: LoginAttemptInternal,
  phase: DurableLoginAttempt['phase'],
): void {
  if (!attempt.durable) return
  assertCurrentAuthority(attempt)
  attempt.durable = {
    ...attempt.durable,
    phase,
    updatedAt: new Date().toISOString(),
  }
  writeJsonAtomic(attemptStateFile(attempt.profileDir), attempt.durable)
}

function removeAttemptState(attempt: LoginAttemptInternal): void {
  try {
    fs.rmSync(attemptStateFile(attempt.profileDir), { force: true })
    fsyncParentDirectory(attemptStateFile(attempt.profileDir))
  } catch {
    // A stale state is safe: successor reconciliation is idempotent and identity-bound.
  }
}

function retainConflictState(attempt: LoginAttemptInternal): void {
  const state = attemptStateFile(attempt.profileDir)
  try {
    fs.renameSync(state, `${state}.conflict-${attempt.id}`)
    fsyncParentDirectory(state)
  } catch {
    // Keep the original state if the diagnostic rename cannot be published.
  }
}

function restorePriorCredential(attempt: LoginAttemptInternal): string | undefined {
  const durable = attempt.durable
  if (!durable?.archivePath || !durable.priorSha256) return undefined
  const target = durable.credentialPath
  const archive = durable.archivePath
  try {
    restoreArchiveNoReplace(archive, target, durable.priorSha256)
    return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      retainConflictState(attempt)
      return `Credential rollback conflict: ${path.basename(target)} changed while sign-in was active; the prior credential was retained at ${path.basename(archive)}.`
    }
    retainConflictState(attempt)
    return `Credential rollback failed; the prior credential was retained at ${path.basename(archive)}: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function finalizeAttempt(attempt: LoginAttemptInternal): void {
  if (attempt.finalized) return
  if (
    attempt.status === 'complete' &&
    attempt.authority &&
    !attempt.authority.isCurrent()
  ) {
    attempt.status = 'failed'
    attempt.error =
      'Sign-in completed after its hub generation lost credential authority. The result was not accepted.'
  }
  attempt.finalized = true
  if (attempt.status === 'complete') {
    removeAttemptState(attempt)
  } else {
    const rollbackError = restorePriorCredential(attempt)
    if (rollbackError) {
      attempt.error = attempt.error ? `${attempt.error} ${rollbackError}` : rollbackError
    } else {
      removeAttemptState(attempt)
    }
  }
  attempt.authority?.release()
  attempt.resolveFinalized()
  const cleanup = setTimeout(() => attempts.delete(attempt.id), 10 * 60_000)
  cleanup.unref()
}

function finish(
  attempt: LoginAttemptInternal,
  status: Exclude<LoginStatus, 'capturing' | 'waiting' | 'settling'>,
  error?: string,
): void {
  if (!ACTIVE.has(attempt.status)) return
  clearAttemptTimers(attempt)
  if (attempt.child && !attempt.childClosed) {
    attempt.pendingTerminal = { status, ...(error ? { error } : {}) }
    attempt.status = 'settling'
    attempt.error = error
      ? `${error} Waiting for the vendor process to stop and credential state to settle.`
      : 'Waiting for the vendor process to stop and credential state to settle.'
    terminate(attempt)
    return
  }
  attempt.status = status
  attempt.error = error
  finalizeAttempt(attempt)
}

function watchForCredentials(attempt: LoginAttemptInternal, loginTimeoutMs: number): void {
  const check = (): void => {
    if (!ACTIVE.has(attempt.status)) return
    if (durableCredentialReady(attempt.provider, attempt.profileDir)) {
      if (attempt.authority && !attempt.authority.isCurrent()) {
        finish(
          attempt,
          'failed',
          'Sign-in produced credentials after its hub generation lost authority. The result was not accepted.',
        )
      } else {
        finish(attempt, 'complete')
      }
    }
  }
  attempt.credentialPoll = setInterval(check, 100)
  attempt.credentialPoll.unref()
  attempt.loginTimer = setTimeout(() => {
    finish(
      attempt,
      'timed-out',
      `${PROVIDER_LABEL[attempt.provider]} sign-in timed out. Open the sign-in URL again or cancel and retry.`,
    )
  }, loginTimeoutMs)
  attempt.loginTimer.unref()
  check()
}

function makeAttempt(input: {
  id: string
  provider: Provider
  profileId: string
  profileDir: string
  authority?: ProfileRefreshLease
  requestKey?: string
}): LoginAttemptInternal {
  let resolveFinalized = (): void => {}
  const finalizedPromise = new Promise<void>((resolve) => {
    resolveFinalized = resolve
  })
  return {
    ...input,
    status: 'capturing',
    childClosed: false,
    output: '',
    settledCapture: false,
    finalized: false,
    finalizedPromise,
    resolveFinalized,
  }
}

function prepareDurableAttempt(
  attempt: LoginAttemptInternal,
  reauth: boolean,
): void {
  const authority = attempt.authority
  if (!authority) return
  assertCurrentAuthority(attempt)
  const credentialPath = credentialsPath(attempt.provider, attempt.profileDir)
  let archivePath: string | undefined
  let priorSha256: string | undefined
  if (reauth) {
    try {
      const stat = fs.lstatSync(credentialPath)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('credential target is not a regular file')
      }
      priorSha256 = sha256File(credentialPath)
      archivePath = `${credentialPath}.signed-out-${attempt.id}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const now = new Date().toISOString()
  attempt.durable = {
    format: ATTEMPT_FORMAT,
    attemptId: attempt.id,
    ...(attempt.requestKey ? { requestKey: attempt.requestKey } : {}),
    provider: attempt.provider,
    profileId: attempt.profileId,
    profileDir: attempt.profileDir,
    credentialPath,
    ...(archivePath ? { archivePath } : {}),
    ...(priorSha256 ? { priorSha256 } : {}),
    ownerEpoch: authority.ownerEpoch,
    ownerId: authority.ownerId,
    publicEpoch: authority.publicEpoch,
    generationId: authority.generationId,
    leaseId: authority.leaseId,
    phase: 'prepared',
    createdAt: now,
    updatedAt: now,
  }
  writeJsonAtomic(attemptStateFile(attempt.profileDir), attempt.durable)
  assertCurrentAuthority(attempt)
  if (archivePath) {
    fs.renameSync(credentialPath, archivePath)
    fsyncFile(archivePath)
    fsyncParentDirectory(archivePath)
    assertCurrentAuthority(attempt)
    updateDurablePhase(attempt, 'archived')
  }
}

export function startLogin(
  provider: Provider,
  profileDir: string,
  opts: StartLoginOptions = {},
): Promise<LoginAttempt> {
  const resolvedProfileDir = path.resolve(profileDir)
  fs.mkdirSync(resolvedProfileDir, { recursive: true })
  const existing = [...attempts.values()].find(
    (attempt) => attempt.profileDir === resolvedProfileDir && UNSETTLED.has(attempt.status),
  )
  if (existing) {
    if (
      existing.provider !== provider ||
      (opts.idempotencyKey &&
        existing.requestKey &&
        opts.idempotencyKey !== existing.requestKey)
    ) {
      return Promise.resolve({
        id: existing.id,
        provider,
        status: 'failed',
        error: 'A different sign-in request is already active for this profile.',
      })
    }
    return Promise.resolve(publicAttempt(existing))
  }
  if (!loginAdmissionOpen) {
    return Promise.resolve({
      id: crypto.randomUUID(),
      provider,
      status: 'failed',
      error: 'Sign-in is temporarily unavailable while the hub changes active generations. Retry shortly.',
    })
  }
  const prior = readDurableAttempt(resolvedProfileDir)
  if (prior.kind === 'valid') {
    const durable = prior.attempt
      if (
        durable.provider !== provider ||
        (opts.idempotencyKey &&
          durable.requestKey &&
          opts.idempotencyKey !== durable.requestKey)
      ) {
        return Promise.resolve({
          id: durable.attemptId,
          provider,
          status: 'failed',
          error: 'A different interrupted sign-in request must be reconciled first.',
        })
      }
      return Promise.resolve({
        id: durable.attemptId,
        provider: durable.provider,
        status: 'settling',
        error:
          'A previous sign-in attempt is being recovered. Poll this attempt or rescan profiles.',
      })
  }
  if (prior.kind === 'unverifiable') {
    return Promise.resolve({
      id: crypto.randomUUID(),
      provider,
      status: 'failed',
      error: `A previous sign-in attempt cannot be verified safely: ${prior.error}`,
    })
  }

  const id = crypto.randomUUID()
  if (
    opts.idempotencyKey !== undefined &&
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(opts.idempotencyKey)
  ) {
    return Promise.resolve({
      id,
      provider,
      status: 'failed',
      error: 'Sign-in idempotency key is invalid.',
    })
  }
  const profileId = opts.profileId ?? path.basename(resolvedProfileDir)
  const authority = opts.acquireLease?.()
  const attempt = makeAttempt({
    id,
    provider,
    profileId,
    profileDir: resolvedProfileDir,
    ...(authority ? { authority } : {}),
    ...(opts.idempotencyKey ? { requestKey: opts.idempotencyKey } : {}),
  })
  attempts.set(id, attempt)

  try {
    prepareDurableAttempt(attempt, opts.reauth === true)
  } catch (error) {
    finish(
      attempt,
      'failed',
      `Could not prepare ${PROVIDER_LABEL[provider]} sign-in safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return Promise.resolve(publicAttempt(attempt))
  }

  const { command, args } = loginCommand(provider)
  const spawnProcess = opts.spawnProcess ?? spawn
  try {
    attempt.child = spawnProcess(command, args, {
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      cwd: repoRoot(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${binDir()}${path.delimiter}${process.env.PATH ?? ''}`,
        [ENV_VAR[provider]]: resolvedProfileDir,
      },
    }) as ChildProcessWithoutNullStreams
    updateDurablePhase(attempt, 'spawned')
  } catch (error) {
    finish(
      attempt,
      'failed',
      `${PROVIDER_LABEL[provider]} login process could not start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return Promise.resolve(publicAttempt(attempt))
  }

  const child = attempt.child as ChildProcessWithoutNullStreams
  const captureTimeoutMs = opts.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS
  const loginTimeoutMs = opts.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS

  const settleCapture = (): void => {
    if (attempt.settledCapture) return
    const parsed = parseLoginOutput(provider, attempt.output)
    if (!parsed) return
    if (provider === 'codex' && parsed.url.includes('/codex/device') && !parsed.code) return
    try {
      assertCurrentAuthority(attempt)
    } catch (error) {
      attempt.settledCapture = true
      finish(attempt, 'failed', error instanceof Error ? error.message : String(error))
      return
    }
    attempt.settledCapture = true
    if (attempt.captureTimer) clearTimeout(attempt.captureTimer)
    attempt.status = 'waiting'
    attempt.url = parsed.url
    attempt.code = parsed.code
    updateDurablePhase(attempt, 'waiting')
    watchForCredentials(attempt, loginTimeoutMs)
  }

  const append = (chunk: Buffer | string): void => {
    attempt.output = `${attempt.output}${String(chunk)}`
    if (attempt.output.length > MAX_OUTPUT) attempt.output = attempt.output.slice(-MAX_OUTPUT)
    settleCapture()
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  attempt.captureTimer = setTimeout(() => {
    if (attempt.settledCapture) return
    attempt.settledCapture = true
    const error = loginCaptureError(provider, attempt.output)
    console.error(`[login] URL capture failed for ${provider}:\n${conciseOutput(attempt.output)}`)
    finish(attempt, 'failed', error)
  }, captureTimeoutMs)
  attempt.captureTimer.unref()

  child.once('error', (error) => {
    append(error.message)
    if (!attempt.settledCapture) {
      attempt.settledCapture = true
      const message = loginCaptureError(provider, attempt.output)
      finish(attempt, 'failed', message)
    } else if (!durableCredentialReady(provider, resolvedProfileDir)) {
      finish(attempt, 'failed', `${PROVIDER_LABEL[provider]} login process failed: ${error.message}`)
    }
  })
  child.once('close', (code, signal) => {
    attempt.childClosed = true
    if (attempt.pendingTerminal) {
      const pending = attempt.pendingTerminal
      attempt.pendingTerminal = undefined
      attempt.status = pending.status
      attempt.error = pending.error
      finalizeAttempt(attempt)
      return
    }
    if (durableCredentialReady(provider, resolvedProfileDir)) {
      if (
        ACTIVE.has(attempt.status) &&
        (!attempt.authority || attempt.authority.isCurrent())
      ) {
        finish(attempt, 'complete')
      } else if (ACTIVE.has(attempt.status)) {
        finish(
          attempt,
          'failed',
          'Sign-in produced credentials after its hub generation lost authority. The result was not accepted.',
        )
      }
      finalizeAttempt(attempt)
      return
    }
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
    if (!attempt.settledCapture) {
      attempt.settledCapture = true
      const message = `${loginCaptureError(provider, attempt.output)}\nThe command ended with ${reason}.`
      finish(attempt, 'failed', message)
    } else if (ACTIVE.has(attempt.status)) {
      finish(
        attempt,
        'failed',
        `${PROVIDER_LABEL[provider]} sign-in ended before credentials were saved (${reason}).`,
      )
    }
    finalizeAttempt(attempt)
  })

  return Promise.resolve(publicAttempt(attempt))
}

export function getLogin(id: string): LoginAttempt | undefined {
  const attempt = attempts.get(id)
  return attempt ? publicAttempt(attempt) : undefined
}

export function getLoginForProfile(profileDir: string): LoginAttempt | undefined {
  const resolved = path.resolve(profileDir)
  const inMemory = [...attempts.values()].find(
    (attempt) => attempt.profileDir === resolved && UNSETTLED.has(attempt.status),
  )
  if (inMemory) return publicAttempt(inMemory)
  const parsed = readDurableAttempt(resolved)
  if (parsed.kind !== 'valid') return undefined
  const durable = parsed.attempt
  return {
    id: durable.attemptId,
    provider: durable.provider,
    status: 'settling',
    error: 'The interrupted sign-in attempt requires recovery.',
  }
}

export function cancelLogin(id: string): LoginAttempt | undefined {
  const attempt = attempts.get(id)
  if (!attempt) return undefined
  finish(attempt, 'cancelled', `${PROVIDER_LABEL[attempt.provider]} sign-in was cancelled.`)
  return publicAttempt(attempt)
}

export async function settleLoginsForRestart(
  timeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS,
): Promise<LoginDrainResult> {
  loginAdmissionOpen = false
  const active = [...attempts.values()].filter((attempt) => UNSETTLED.has(attempt.status))
  for (const attempt of active) {
    if (ACTIVE.has(attempt.status)) {
      finish(
        attempt,
        'cancelled',
        'SYSTEM RESTART interrupted sign-in before completion; this is not a user cancellation or preference.',
      )
    }
  }
  const outcomes = await Promise.all(
    active.map(async (attempt) => {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<'unknown'>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), timeoutMs)
      })
      const settled = attempt.finalizedPromise.then(() => 'settled' as const)
      const result = await Promise.race([settled, timeout])
      if (timer) clearTimeout(timer)
      return result
    }),
  )
  return {
    settled: outcomes.filter((outcome) => outcome === 'settled').length,
    outcomeUnknown: outcomes.filter((outcome) => outcome === 'unknown').length,
  }
}

function readDurableAttempt(profileDir: string): DurableLoginAttemptRead {
  const stateFile = attemptStateFile(profileDir)
  let dirStat: fs.BigIntStats
  let stateStat: fs.BigIntStats
  try {
    dirStat = fs.lstatSync(profileDir, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return {
      kind: 'unverifiable',
      error: `profile directory could not be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
  try {
    stateStat = fs.lstatSync(stateFile, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return {
      kind: 'unverifiable',
      error: `durable sign-in state could not be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    !stateStat.isFile() ||
    stateStat.isSymbolicLink()
  ) {
    return {
      kind: 'unverifiable',
      error: 'durable sign-in state is not a regular file in a regular managed profile directory',
    }
  }

  let fd: number
  try {
    fd = fs.openSync(stateFile, 'r')
  } catch (error) {
    return {
      kind: 'unverifiable',
      error: `durable sign-in state could not be opened: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
  try {
    const openedState = fs.fstatSync(fd, { bigint: true })
    if (
      !sameFileIdentity(stateStat, openedState)
    ) {
      return { kind: 'unverifiable', error: 'durable sign-in state changed while opening' }
    }
    let raw: Partial<DurableLoginAttempt>
    try {
      raw = JSON.parse(fs.readFileSync(fd, 'utf8')) as Partial<DurableLoginAttempt>
    } catch (error) {
      return {
        kind: 'unverifiable',
        error: `durable sign-in state is unreadable or malformed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
    const resolved = path.resolve(profileDir)
    const expectedCredential = path.join(resolved, CRED_FILE[raw.provider as Provider])
    const expectedArchive =
      typeof raw.attemptId === 'string'
        ? `${expectedCredential}.signed-out-${raw.attemptId}`
        : undefined
    if (
      raw.format !== ATTEMPT_FORMAT ||
      typeof raw.attemptId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        raw.attemptId,
      ) ||
      (raw.requestKey !== undefined &&
        (typeof raw.requestKey !== 'string' ||
          !/^[a-zA-Z0-9._:-]{1,128}$/.test(raw.requestKey))) ||
      (raw.provider !== 'claude' && raw.provider !== 'codex') ||
      typeof raw.profileId !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(raw.profileId) ||
      raw.profileId !== path.basename(resolved) ||
      path.resolve(String(raw.profileDir)) !== resolved ||
      path.resolve(String(raw.credentialPath)) !== expectedCredential ||
      (raw.archivePath !== undefined &&
        path.resolve(String(raw.archivePath)) !== expectedArchive) ||
      (raw.archivePath === undefined) !== (raw.priorSha256 === undefined) ||
      (raw.priorSha256 !== undefined && !/^[a-f0-9]{64}$/.test(raw.priorSha256)) ||
      typeof raw.ownerEpoch !== 'string' ||
      !raw.ownerEpoch ||
      raw.ownerEpoch.length > 128 ||
      typeof raw.ownerId !== 'string' ||
      !raw.ownerId ||
      raw.ownerId.length > 128 ||
      typeof raw.publicEpoch !== 'number' ||
      !Number.isSafeInteger(raw.publicEpoch) ||
      raw.publicEpoch < 0 ||
      typeof raw.generationId !== 'string' ||
      !raw.generationId ||
      raw.generationId.length > 128 ||
      typeof raw.leaseId !== 'string' ||
      !raw.leaseId ||
      raw.leaseId.length > 128 ||
      !['prepared', 'archived', 'spawned', 'waiting'].includes(String(raw.phase)) ||
      typeof raw.createdAt !== 'string' ||
      typeof raw.updatedAt !== 'string'
    ) {
      return {
        kind: 'unverifiable',
        error: 'durable sign-in state is malformed or is not bound to this managed profile',
      }
    }
    let stateAfter: fs.BigIntStats
    try {
      stateAfter = fs.lstatSync(stateFile, { bigint: true })
    } catch (error) {
      return {
        kind: 'unverifiable',
        error: `durable sign-in state changed after opening: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
    if (!sameFileIdentity(openedState, stateAfter)) {
      return { kind: 'unverifiable', error: 'durable sign-in state path changed while reading' }
    }
    return { kind: 'valid', attempt: raw as DurableLoginAttempt }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Credential scanning cannot see a profile between archive and rollback. A valid durable attempt is
 * therefore a second, narrowly authenticated discovery source: exact managed directory, exact provider
 * credential/archive names, and an exact profile id. Invalid or foreign metadata never invents a profile.
 */
export function discoverInterruptedLoginProfiles(profilesDir: string): InterruptedLoginDiscovery {
  let entries: string[]
  try {
    entries = fs.readdirSync(profilesDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: [], notices: [] }
    return {
      profiles: [],
      notices: [
        {
          profileDir: path.resolve(profilesDir),
          error: `Managed profile recovery state could not be enumerated: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    }
  }
  const profiles: Profile[] = []
  const notices: InterruptedLoginRecoveryNotice[] = []
  for (const entry of entries) {
    const profileDir = path.join(profilesDir, entry)
    try {
      const stat = fs.lstatSync(profileDir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    } catch {
      continue
    }
    const parsed = readDurableAttempt(profileDir)
    if (parsed.kind === 'absent') continue
    if (parsed.kind === 'unverifiable') {
      notices.push({
        profileDir,
        ...(/^[a-zA-Z0-9_-]+$/.test(entry) ? { profileId: entry } : {}),
        error: parsed.error,
      })
      continue
    }
    const durable = parsed.attempt
    profiles.push({
      id: durable.profileId,
      provider: durable.provider,
      dir: profileDir,
      authStatus: 'signed_out',
      authError: 'Sign-in was interrupted and is being reconciled.',
    })
  }
  return { profiles, notices }
}

export function reconcileInterruptedLogins(
  profilesDir: string,
  acquireLease: (
    profileId: string,
    profileDir: string,
    operation: string,
  ) => ProfileRefreshLease,
  options: { failpoint?: (edge: 'before-archive-link') => void } = {},
): LoginReconcileResult[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(profilesDir)
  } catch {
    return []
  }
  const results: LoginReconcileResult[] = []
  for (const entry of entries) {
    const profileDir = path.join(profilesDir, entry)
    try {
      const stat = fs.lstatSync(profileDir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    } catch {
      continue
    }
    const parsed = readDurableAttempt(profileDir)
    if (parsed.kind === 'absent') continue
    if (parsed.kind === 'unverifiable') {
      results.push({
        profileId: /^[a-zA-Z0-9_-]+$/.test(entry) ? entry : 'unknown-profile',
        outcome: 'conflict',
        error: `Interrupted sign-in state could not be verified safely: ${parsed.error}`,
      })
      continue
    }
    const durable = parsed.attempt
    let authority: ProfileRefreshLease
    try {
      authority = acquireLease(durable.profileId, profileDir, 'reconcile interrupted sign-in')
    } catch (error) {
      results.push({
        profileId: durable.profileId,
        attemptId: durable.attemptId,
        outcome: 'busy',
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    try {
      if (!authority.isCurrent()) {
        results.push({
          profileId: durable.profileId,
          attemptId: durable.attemptId,
          outcome: 'busy',
          error: 'Credential reconciliation authority is no longer current.',
        })
        continue
      }
      const sameSupervisorHandoff =
        authority.ownerId === durable.ownerId &&
        authority.ownerEpoch === durable.ownerEpoch &&
        authority.publicEpoch > durable.publicEpoch &&
        authority.generationId !== durable.generationId
      const takeover = authority.takeover
      const deadPredecessorHandoff =
        takeover?.reason === 'dead-predecessor' &&
        takeover.predecessorOwnerId === durable.ownerId &&
        takeover.predecessorOwnerEpoch === durable.ownerEpoch &&
        takeover.successorOwnerId === authority.ownerId &&
        takeover.successorOwnerEpoch === authority.ownerEpoch
      if (!sameSupervisorHandoff && !deadPredecessorHandoff) {
        results.push({
          profileId: durable.profileId,
          attemptId: durable.attemptId,
          outcome: 'conflict',
          error:
            'Interrupted sign-in authority does not match a permitted newer public-generation handoff.',
        })
        continue
      }
      if (durableCredentialReady(durable.provider, profileDir)) {
        if (!authority.isCurrent()) {
          results.push({
            profileId: durable.profileId,
            attemptId: durable.attemptId,
            outcome: 'busy',
            error: 'Credential reconciliation authority changed before publication.',
          })
          continue
        }
        fs.rmSync(attemptStateFile(profileDir), { force: true })
        fsyncParentDirectory(attemptStateFile(profileDir))
        results.push({
          profileId: durable.profileId,
          attemptId: durable.attemptId,
          outcome: 'accepted-new',
        })
        continue
      }
      if (durable.archivePath && durable.priorSha256) {
        if (!authority.isCurrent()) {
          results.push({
            profileId: durable.profileId,
            attemptId: durable.attemptId,
            outcome: 'busy',
            error: 'Credential reconciliation authority changed before restore.',
          })
          continue
        }
        try {
          restoreArchiveNoReplace(
            durable.archivePath,
            durable.credentialPath,
            durable.priorSha256,
            () => options.failpoint?.('before-archive-link'),
          )
        } catch (error) {
          const state = attemptStateFile(profileDir)
          try {
            fs.renameSync(state, `${state}.conflict-${durable.attemptId}`)
            fsyncParentDirectory(state)
          } catch {
            /* retaining the active name is safer than deleting an unresolved saga */
          }
          results.push({
            profileId: durable.profileId,
            attemptId: durable.attemptId,
            outcome: 'conflict',
            error: `Interrupted sign-in archive could not be restored safely: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
          continue
        }
        if (!authority.isCurrent()) {
          results.push({
            profileId: durable.profileId,
            attemptId: durable.attemptId,
            outcome: 'busy',
            error: 'Credential reconciliation authority changed before publication.',
          })
          continue
        }
        fs.rmSync(attemptStateFile(profileDir), { force: true })
        fsyncParentDirectory(attemptStateFile(profileDir))
        results.push({
          profileId: durable.profileId,
          attemptId: durable.attemptId,
          outcome: 'restored-prior',
        })
        continue
      }
      const state = attemptStateFile(profileDir)
      try {
        fs.renameSync(state, `${state}.conflict-${durable.attemptId}`)
        fsyncParentDirectory(state)
      } catch {
        /* retaining the active name is safer than deleting an unresolved saga */
      }
      results.push({
        profileId: durable.profileId,
        attemptId: durable.attemptId,
        outcome: 'conflict',
        error: 'Interrupted sign-in has conflicting credential/archive state; no file was overwritten.',
      })
    } finally {
      authority.release()
    }
  }
  return results
}

export function awaitLogin(
  provider: Provider,
  profileDir: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? 2_000
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = (): void => {
      if (durableCredentialReady(provider, profileDir)) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(tick, intervalMs)
    }
    setTimeout(tick, intervalMs)
  })
}
