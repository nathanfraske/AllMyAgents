/**
 * The typed supervisor <-> hub IPC contract for the blue-green restart (see
 * docs/agent-detachment-impl.md §1.3-1.5). Lives in one place so `hubctl.ts` (supervisor) and
 * `index.ts`/`restartController.ts` (hub) agree on every message shape, plus the health-check helpers
 * the supervisor runs against a booting "green" hub BEFORE any port handoff.
 *
 * Transport: `child_process.spawn(cmd, args, { stdio: ['ignore','inherit','inherit','ipc'] })` — the
 * 4th `ipc` slot gives `child.send()` / `process.on('message')` even for a plain (non-fork) node child,
 * so the hub still runs standalone AND speaks this handshake when launched by hubctl.
 */
import http from 'node:http'
import type { ChildProcess } from 'node:child_process'
import type { AutomaticRecoveryCause } from './journalRecovery.js'
import type { PreflightFailure } from './preflight.js'

/** Bump when a hub change is incompatible with an older on-disk schema (Phase 3 migration guard). */
export const SCHEMA_VERSION = 1
export const ASK_RESTART_TURN_GRACE_MS = 10_000
export const ASK_RESTART_INTERRUPT_MARGIN_MS = 250
// Worst case: profile-login settlement (4s), then three SQLite writes at the configured 5s
// busy_timeout, followed by the Ask grace, interrupt dispatch, and listener-close margin.
export const HUB_DRAIN_RELEASE_TIMEOUT_MS = 30_000
export const HUB_PREFLIGHT_START_TIMEOUT_MS = 10_000
export const HUB_PREFLIGHT_LIVENESS_TIMEOUT_MS = 10_000
export const HUB_PREFLIGHT_ABSOLUTE_TIMEOUT_MS = 5 * 60_000
export const HUB_PREFLIGHT_STATUS_INTERVAL_MS = 10_000

export interface ProfileGenerationAuthority {
  readonly generationId: string
  readonly publicEpoch: number
  readonly active: boolean
}

export class ProfilePublicEpochSequence {
  constructor(private value = 0) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid initial profile public epoch: ${value}`)
    }
  }

  get current(): number {
    return this.value
  }

  next(): number {
    if (this.value >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Profile public epoch sequence is exhausted')
    }
    this.value += 1
    return this.value
  }
}

export function profileGenerationEnvironment(
  authority: ProfileGenerationAuthority,
): Record<string, string> {
  requireProfileGenerationId(authority.generationId)
  requireProfilePublicEpoch(authority.publicEpoch)
  return {
    HUB_PROFILE_GENERATION_ID: authority.generationId,
    HUB_PROFILE_PUBLIC_EPOCH: String(authority.publicEpoch),
    HUB_PROFILE_PUBLIC_ACTIVE: authority.active ? '1' : '0',
  }
}

export function parseProfileGenerationEnvironment(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ProfileGenerationAuthority {
  const generationId = env.HUB_PROFILE_GENERATION_ID
  requireProfileGenerationId(generationId)
  const rawEpoch = env.HUB_PROFILE_PUBLIC_EPOCH
  if (typeof rawEpoch !== 'string' || !/^[1-9][0-9]*$/.test(rawEpoch)) {
    throw new Error('Profile public epoch environment value is not canonical')
  }
  const publicEpoch = Number(rawEpoch)
  requireProfilePublicEpoch(publicEpoch)
  if (String(publicEpoch) !== rawEpoch) {
    throw new Error('Profile public epoch environment value is not lossless')
  }
  const rawActive = env.HUB_PROFILE_PUBLIC_ACTIVE
  if (rawActive !== '0' && rawActive !== '1') {
    throw new Error('Profile public active environment value must be exactly 0 or 1')
  }
  return { generationId, publicEpoch, active: rawActive === '1' }
}

function requireProfileGenerationId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw new Error('Profile generation id must be a canonical UUID')
  }
}

function requireProfilePublicEpoch(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Profile public epoch must be a positive safe integer; got ${String(value)}`)
  }
}

export interface JournalBackupControlCommand {
  type: 'journal-backup-control'
  requestId: string
  epoch: number
  active: boolean
}

export interface JournalBackupControlResult {
  type: 'journal-backup-control-result'
  requestId: string
  epoch: number
  active: boolean
  applied: boolean
  error?: string
}

export type PreflightLiveness = {
  type: 'preflight-liveness'
  attemptId: string
  phase: 'starting' | 'integrity-check' | 'booting'
  sequence: number
}

/** Supervisor -> hub. */
export type SupervisorMsg =
  | { type: 'drain' } //   stop accepting new sessions (503), close the listener, keep the process alive
  | { type: 'promote'; port: number; profilePublicEpoch: number } // re-listen on the fixed public port (green taking over)
  | { type: 'retire' } //  finish in-flight, close WS, graceful shutdown, exit(0)
  | { type: 'restart-aborted'; error: string; profilePublicEpoch: number } // runs on BLUE when green failed → journal it for the operator
  | JournalBackupControlCommand

/** Hub -> supervisor. */
export type HubMsg =
  | {
      type: 'ready'
      attemptId: string
      port: number
      restored: number
      schemaVersion: number
    } // after boot() + listening
  | PreflightLiveness
  | {
      type: 'preflight-cacheable'
      attemptId: string
      identity: string
    }
  | {
      type: 'released'
      questionTurns: { settled: number; outcomeUnknown: number }
      loginAttempts: { settled: number; outcomeUnknown: number }
    } // drain done: listener closed, port free
  | { type: 'drain-failed'; error: string } // blue kept the listener because pre-drain durability failed
  | { type: 'promoted'; profilePublicEpoch: number } // now listening on the fixed port
  | { type: 'promote-failed'; error: string } // could not bind the fixed port (EADDRINUSE) → supervisor rolls back
  | { type: 'rollback-rebound'; profilePublicEpoch: number } // blue has successfully reclaimed the fixed public listener
  | { type: 'rollback-failed'; error: string } // blue could not reclaim the fixed listener; supervisor must revive
  | JournalBackupControlResult
  /**
   * Preflight refused to boot: a positively-detected fatal condition (a corrupt database, a data
   * directory that cannot be written, a schema written by a NEWER hub), found before the hub commits to
   * starting. See preflight.ts.
   *
   * The point is that this is NOT a crash, and the supervisor must be able to tell the difference. A
   * crash is worth retrying — the cause may be transient, or an agent may repair it on disk while the
   * supervisor waits. A preflight refusal is deterministic by construction: retrying identically will
   * fail identically until a human or an agent changes something. Both still retry (never give up is the
   * whole point), but only this one can say WHAT is wrong and WHAT would fix it, instead of surfacing a
   * stack trace to someone staring at a window that will not load.
   *
   * `recovery` is operator-facing guidance, not a log line — it is the sentence the desktop shell shows.
   */
  | {
      type: 'preflight-failed'
      attemptId: string
      code: string
      message: string
      recovery: string
      recoveryCause?: NonNullable<PreflightFailure['recoveryCause']>
    }
  | { type: 'restart-request'; reason: string; bySession?: string } // hub asks the supervisor to flip

export type PreflightRefusal = Extract<HubMsg, { type: 'preflight-failed' }>

export function validatedAutomaticRecoveryCause(
  refusal: PreflightRefusal
): AutomaticRecoveryCause | undefined {
  if (refusal.code === 'database-corrupt' && refusal.recoveryCause === 'sqlite-corruption') {
    return refusal.recoveryCause
  }
  if (
    refusal.code === 'database-orphan-family' &&
    refusal.recoveryCause === 'orphan-family'
  ) {
    return refusal.recoveryCause
  }
  return undefined
}

export class PreflightRefusalError extends Error {
  readonly refusal: PreflightRefusal
  readonly automaticRecoveryCause: AutomaticRecoveryCause | undefined

  constructor(refusal: PreflightRefusal) {
    super(`preflight refused to boot [${refusal.code}]: ${refusal.message} — ${refusal.recovery}`)
    this.name = 'PreflightRefusalError'
    this.refusal = refusal
    this.automaticRecoveryCause = validatedAutomaticRecoveryCause(refusal)
  }
}

export class MalformedPreflightRefusalError extends Error {
  constructor() {
    super('hub sent a malformed preflight refusal')
    this.name = 'MalformedPreflightRefusalError'
  }
}

export class MalformedPreflightLivenessError extends Error {
  constructor(detail = 'hub sent malformed preflight liveness') {
    super(detail)
    this.name = 'MalformedPreflightLivenessError'
  }
}

function boundedIpcText(
  value: unknown,
  label: string,
  maxLength: number,
  allowNewline: boolean
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes('\0') ||
    (allowNewline ? /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(
      value
    )
  ) {
    throw new MalformedPreflightRefusalError()
  }
  return value
}

function parsePreflightRefusal(value: unknown): PreflightRefusal {
  const raw =
    value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined
  if (!raw || raw.type !== 'preflight-failed') throw new MalformedPreflightRefusalError()
  if (
    typeof raw.attemptId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      raw.attemptId
    )
  ) {
    throw new MalformedPreflightRefusalError()
  }
  const code = boundedIpcText(raw.code, 'code', 128, false)
  const message = boundedIpcText(raw.message, 'message', 4096, true)
  const recovery = boundedIpcText(raw.recovery, 'recovery', 4096, true)
  const cause = raw.recoveryCause
  if (
    cause !== undefined &&
    cause !== 'sqlite-corruption' &&
    cause !== 'orphan-family' &&
    cause !== 'lineage-rollback'
  ) {
    throw new MalformedPreflightRefusalError()
  }
  const expectedKeys =
    cause === undefined
      ? 'attemptId,code,message,recovery,type'
      : 'attemptId,code,message,recovery,recoveryCause,type'
  if (Object.keys(raw).sort().join(',') !== expectedKeys) {
    throw new MalformedPreflightRefusalError()
  }
  return {
    type: 'preflight-failed',
    attemptId: raw.attemptId,
    code,
    message,
    recovery,
    ...(cause !== undefined ? { recoveryCause: cause } : {}),
  }
}

function parsePreflightLiveness(value: unknown): PreflightLiveness {
  const raw =
    value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined
  if (
    !raw ||
    raw.type !== 'preflight-liveness' ||
    Object.keys(raw).sort().join(',') !== 'attemptId,phase,sequence,type' ||
    typeof raw.attemptId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      raw.attemptId
    ) ||
    (raw.phase !== 'starting' && raw.phase !== 'integrity-check' && raw.phase !== 'booting') ||
    !Number.isSafeInteger(raw.sequence) ||
    Number(raw.sequence) < 0
  ) {
    throw new MalformedPreflightLivenessError()
  }
  return raw as PreflightLiveness
}

export function sendToHub(child: ChildProcess, msg: SupervisorMsg): void {
  child.send?.(msg)
}

export function waitForHubReady(
  child: ChildProcess,
  attemptId: string,
  deadlines: {
    startTimeoutMs: number
    livenessTimeoutMs: number
    absoluteTimeoutMs: number
  } = {
    startTimeoutMs: HUB_PREFLIGHT_START_TIMEOUT_MS,
    livenessTimeoutMs: HUB_PREFLIGHT_LIVENESS_TIMEOUT_MS,
    absoluteTimeoutMs: HUB_PREFLIGHT_ABSOLUTE_TIMEOUT_MS,
  },
  onStatus?: (phase: PreflightLiveness['phase'], elapsedMs: number) => void
): Promise<Extract<HubMsg, { type: 'ready' }>> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      attemptId
    ) ||
    !Number.isSafeInteger(deadlines.startTimeoutMs) ||
    deadlines.startTimeoutMs < 1 ||
    !Number.isSafeInteger(deadlines.livenessTimeoutMs) ||
    deadlines.livenessTimeoutMs < 1 ||
    !Number.isSafeInteger(deadlines.absoluteTimeoutMs) ||
    deadlines.absoluteTimeoutMs <= deadlines.startTimeoutMs ||
    deadlines.absoluteTimeoutMs <= deadlines.livenessTimeoutMs
  ) {
    return Promise.reject(new Error('invalid preflight readiness contract'))
  }
  return new Promise((resolve, reject) => {
    let lastSequence = -1
    let phase: PreflightLiveness['phase'] | undefined
    const startedAt = Date.now()
    let lastStatusAt = Number.NEGATIVE_INFINITY
    let livenessTimer: ReturnType<typeof setTimeout> | undefined
    const startTimer = setTimeout(() => {
      fail(new Error('timed out waiting for validated preflight start'))
    }, deadlines.startTimeoutMs)
    const absoluteTimer = setTimeout(() => {
      fail(new Error('preflight exceeded its absolute readiness ceiling'))
    }, deadlines.absoluteTimeoutMs)
    const armLivenessDeadline = (): void => {
      if (livenessTimer) clearTimeout(livenessTimer)
      livenessTimer = setTimeout(() => {
        fail(new Error('timed out waiting for preflight liveness'))
      }, deadlines.livenessTimeoutMs)
    }
    const onMsg = (message: unknown): void => {
      const raw =
        message !== null && typeof message === 'object'
          ? (message as Record<string, unknown>)
          : undefined
      if (raw?.type === 'preflight-liveness') {
        let liveness: PreflightLiveness
        try {
          liveness = parsePreflightLiveness(message)
        } catch (error) {
          fail(error)
          return
        }
        if (liveness.attemptId !== attemptId) {
          fail(new MalformedPreflightLivenessError('preflight liveness attempt binding is invalid'))
          return
        }
        const invalidInitial =
          lastSequence === -1 && (liveness.sequence !== 0 || liveness.phase !== 'starting')
        const invalidContinuation =
          lastSequence >= 0 &&
          (liveness.sequence !== lastSequence + 1 ||
            liveness.phase === 'starting' ||
            (phase === 'starting' && liveness.phase !== 'integrity-check') ||
            (phase === 'booting' && liveness.phase !== 'booting'))
        if (invalidInitial || invalidContinuation) {
          fail(new MalformedPreflightLivenessError('preflight liveness ordering is invalid'))
          return
        }
        lastSequence = liveness.sequence
        const phaseChanged = phase !== liveness.phase
        phase = liveness.phase
        const elapsedMs = Date.now() - startedAt
        if (phaseChanged || elapsedMs - lastStatusAt >= HUB_PREFLIGHT_STATUS_INTERVAL_MS) {
          lastStatusAt = elapsedMs
          onStatus?.(phase, elapsedMs)
        }
        if (lastSequence === 0) clearTimeout(startTimer)
        armLivenessDeadline()
        return
      }
      if (raw?.type === 'ready') {
        if (phase !== 'booting') {
          fail(new Error('hub reported ready before validated preflight booting phase'))
          return
        }
        const ready = raw as Record<string, unknown>
        if (
          Object.keys(ready).sort().join(',') !==
            'attemptId,port,restored,schemaVersion,type' ||
          ready.attemptId !== attemptId ||
          !Number.isSafeInteger(ready.port) ||
          Number(ready.port) < 1 ||
          Number(ready.port) > 65_535 ||
          !Number.isSafeInteger(ready.restored) ||
          Number(ready.restored) < 0 ||
          !Number.isSafeInteger(ready.schemaVersion) ||
          Number(ready.schemaVersion) < 0
        ) {
          fail(new Error('hub reported malformed readiness'))
          return
        }
        cleanup()
        resolve(ready as Extract<HubMsg, { type: 'ready' }>)
        return
      }
      if (raw?.type === 'preflight-failed') {
        cleanup()
        try {
          const refusal = parsePreflightRefusal(message)
          if (refusal.attemptId !== attemptId) throw new MalformedPreflightRefusalError()
          reject(new PreflightRefusalError(refusal))
        } catch (error) {
          reject(error)
        }
      }
    }
    const onExit = (): void => {
      fail(new Error("hub exited while waiting for 'ready'"))
    }
    function fail(error: unknown): void {
      cleanup()
      reject(error)
    }
    function cleanup(): void {
      clearTimeout(startTimer)
      clearTimeout(absoluteTimer)
      if (livenessTimer) clearTimeout(livenessTimer)
      child.off('message', onMsg)
      child.off('exit', onExit)
    }
    child.on('message', onMsg)
    child.on('exit', onExit)
  })
}

/**
 * Wait for a specific HubMsg `type` from a child, rejecting on timeout or premature exit. Used by the
 * supervisor to await `ready` / `released` / `promoted` at each step of the flip.
 */
export function waitForHubMsg<T extends HubMsg['type']>(
  child: ChildProcess,
  type: T,
  timeoutMs: number
): Promise<Extract<HubMsg, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out after ${timeoutMs}ms waiting for hub '${type}'`))
    }, timeoutMs)
    const onMsg = (m: HubMsg): void => {
      if (m && typeof m === 'object' && m.type === type) {
        if (type === 'released') {
          const released = m as {
            questionTurns?: { settled?: unknown; outcomeUnknown?: unknown }
            loginAttempts?: { settled?: unknown; outcomeUnknown?: unknown }
          }
          if (
            !validReleasedCounts(released.questionTurns) ||
            !validReleasedCounts(released.loginAttempts)
          ) {
            cleanup()
            reject(new Error("invalid hub 'released' settlement counts"))
            return
          }
        }
        cleanup()
        resolve(m as Extract<HubMsg, { type: T }>)
      } else if (m && typeof m === 'object' && m.type === 'drain-failed' && type === 'released') {
        cleanup()
        reject(new Error(`drain failed: ${m.error}`))
      } else if (m && typeof m === 'object' && m.type === 'promote-failed' && type === 'promoted') {
        cleanup()
        reject(new Error(`promote failed: ${(m as { error?: string }).error ?? 'unknown'}`))
      } else if (
        m &&
        typeof m === 'object' &&
        m.type === 'rollback-failed' &&
        type === 'rollback-rebound'
      ) {
        cleanup()
        reject(new Error(`rollback rebind failed: ${m.error}`))
      } else if (m && typeof m === 'object' && m.type === 'preflight-failed') {
        // Preflight found a positively-fatal condition and refused to boot. Without this the child simply
        // exits and the caller reports "hub exited while waiting for 'ready'" — true, useless, and the
        // exact log line the operator saw while a corrupt database sat undiagnosed. The hub already knows
        // both what is wrong and what would fix it; carry that instead of throwing it away.
        cleanup()
        try {
          reject(new PreflightRefusalError(parsePreflightRefusal(m)))
        } catch (error) {
          reject(error)
        }
      }
    }
    const onExit = (): void => {
      cleanup()
      reject(new Error(`hub exited while waiting for '${type}'`))
    }
    function cleanup(): void {
      clearTimeout(timer)
      child.off('message', onMsg as (m: unknown) => void)
      child.off('exit', onExit)
    }
    child.on('message', onMsg as (m: unknown) => void)
    child.on('exit', onExit)
  })
}

/**
 * Tell blue to roll back and wait for the listener transition itself, not merely IPC delivery.
 * The response listener is installed before send so a local test peer or very fast child cannot race it.
 */
export function requestRestartAbort(
  child: ChildProcess,
  error: string,
  timeoutMs: number,
  profilePublicEpoch?: number,
): Promise<Extract<HubMsg, { type: 'rollback-rebound' }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out after ${timeoutMs}ms waiting for blue rollback rebind`))
    }, timeoutMs)
    const onMsg = (message: HubMsg): void => {
      if (message?.type === 'rollback-rebound') {
        if (
          profilePublicEpoch !== undefined &&
          message.profilePublicEpoch !== profilePublicEpoch
        ) {
          cleanup()
          reject(new Error('blue acknowledged an unexpected profile public epoch'))
          return
        }
        cleanup()
        resolve(message)
      } else if (message?.type === 'rollback-failed') {
        cleanup()
        reject(new Error(`rollback rebind failed: ${message.error}`))
      } else if (message?.type === 'preflight-failed') {
        cleanup()
        reject(new Error(`hub refused rollback rebind: ${message.message}`))
      }
    }
    const onExit = (): void => {
      cleanup()
      reject(new Error('blue exited while reclaiming the public listener'))
    }
    function cleanup(): void {
      clearTimeout(timer)
      child.off('message', onMsg as (message: unknown) => void)
      child.off('exit', onExit)
    }
    child.on('message', onMsg as (message: unknown) => void)
    child.once('exit', onExit)
    try {
      if (!child.send) throw new Error('hub IPC channel is unavailable')
      child.send(
        {
          type: 'restart-aborted',
          error,
          ...(profilePublicEpoch === undefined ? {} : { profilePublicEpoch }),
        },
        (sendError) => {
          if (!sendError) return
          cleanup()
          reject(sendError)
        },
      )
    } catch (sendError) {
      cleanup()
      reject(sendError)
    }
  })
}

function validReleasedCounts(
  counts: { settled?: unknown; outcomeUnknown?: unknown } | undefined,
): boolean {
  return (
    !!counts &&
    Number.isSafeInteger(counts.settled) &&
    Number(counts.settled) >= 0 &&
    Number.isSafeInteger(counts.outcomeUnknown) &&
    Number(counts.outcomeUnknown) >= 0
  )
}

/**
 * Send one ownership command and wait for its exact acknowledgement.
 *
 * The waiter is installed before send so an immediate peer cannot win the race. Synchronous and callback
 * send failures tear the waiter down immediately instead of leaking a listener until the control timeout.
 */
export function requestJournalBackupControl(
  child: ChildProcess,
  command: JournalBackupControlCommand,
  timeoutMs: number
): Promise<JournalBackupControlResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out after ${timeoutMs}ms waiting for journal backup control ${command.requestId}`))
    }, timeoutMs)
    const onMsg = (message: HubMsg): void => {
      if (
        message &&
        typeof message === 'object' &&
        message.type === 'journal-backup-control-result' &&
        message.requestId === command.requestId
      ) {
        cleanup()
        resolve(message)
      } else if (message && typeof message === 'object' && message.type === 'preflight-failed') {
        cleanup()
        reject(new Error(`hub refused backup ownership control: ${message.message}`))
      }
    }
    const onExit = (): void => {
      cleanup()
      reject(new Error(`hub exited while applying journal backup control ${command.requestId}`))
    }
    function cleanup(): void {
      clearTimeout(timer)
      child.off('message', onMsg as (message: unknown) => void)
      child.off('exit', onExit)
    }
    child.on('message', onMsg as (message: unknown) => void)
    child.on('exit', onExit)
    try {
      if (!child.send) throw new Error('hub IPC channel is unavailable')
      child.send(command, (error) => {
        if (!error) return
        cleanup()
        reject(error)
      })
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

/**
 * Health-check a booting green hub on its EPHEMERAL http port, before any port handoff — so a failure
 * is a pure rollback (blue never disturbed). Proves routing + guards + DB are live and the roster matches.
 */
export async function healthCheck(port: number, opts: { expectRestored: number }): Promise<void> {
  const health = await getJson(port, '/api/health', 4000)
  if (health?.boot !== 'complete') throw new Error(`health: boot=${health?.boot}`)
  // Guard against LOSING sessions in the flip: green must restore AT LEAST as many as expected. Sessions
  // created during blue's life legitimately make green's count HIGHER (expectRestored is blue's boot-time
  // count, frozen at boot), which is not a loss — so only a SHORTFALL aborts. A prior exact `!==` here
  // false-aborted a perfectly healthy flip whenever any session was created between blue's boot and the
  // restart. (Follow-up for full robustness against DELETIONS during blue's life: pass blue's LIVE
  // /api/health count as expectRestored instead of the frozen blue.restored — see hubctl.ts restart().)
  if (typeof health.restoredSessions === 'number' && health.restoredSessions < opts.expectRestored) {
    throw new Error(`health: green restored ${health.restoredSessions} < expected ${opts.expectRestored} — sessions would be lost, aborting flip`)
  }
  const authStatus = await getStatus(port, '/api/auth', 4000)
  if (authStatus !== 200) throw new Error(`health: /api/auth returned ${authStatus}`)
}

function getJson(port: number, path: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as Record<string, unknown>)
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`GET ${path} timed out`)))
    req.on('error', reject)
  })
}

function getStatus(port: number, path: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('timeout', () => req.destroy(new Error(`GET ${path} timed out`)))
    req.on('error', reject)
  })
}
