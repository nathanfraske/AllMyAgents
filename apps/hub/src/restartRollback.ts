import type { ChildProcess } from 'node:child_process'
import net from 'node:net'
import { requestRestartAbort } from './restartHandshake.js'

export type RollbackPhase =
  | 'green-exit'
  | 'port-release'
  | 'blue-survival'
  | 'blue-rebind'
  | 'backup-resume'

export class RollbackFailure extends Error {
  constructor(
    readonly phase: RollbackPhase,
    cause: unknown
  ) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(`restart rollback failed during ${phase}: ${message}`, { cause })
    this.name = 'RollbackFailure'
  }
}

export interface RollbackToBlueOptions {
  blue: ChildProcess
  green: ChildProcess
  publicPort: number
  reason: string
  /** True once promotion was sent: the ACK may be lost after green has already bound the port. */
  greenMayOwnPublicListener: boolean
  killGreen: (green: ChildProcess) => void
  waitForGreenExit: (green: ChildProcess, timeoutMs: number) => Promise<void>
  resumeBlue: () => Promise<void>
  greenExitTimeoutMs?: number
  portReleaseTimeoutMs?: number
  rollbackRebindTimeoutMs?: number
  resumeRetryMs?: readonly number[]
  delay?: (milliseconds: number) => Promise<void>
  waitForPortRelease?: (port: number, timeoutMs: number) => Promise<void>
  requestBlueRebind?: (
    blue: ChildProcess,
    reason: string,
    timeoutMs: number
  ) => Promise<unknown>
  onResumeFailure?: (error: unknown, nextDelayMs: number | undefined) => void
}

export interface AbandonLiveForRevivalOptions {
  child: ChildProcess
  reason: string
  clearLive: () => void
  markRetired: () => void
  requestDeferredRecovery: () => void
  kill: (child: ChildProcess) => void
  waitForExit: (child: ChildProcess, timeoutMs: number) => Promise<void>
  log: (message: string) => void
  exitTimeoutMs?: number
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function requireLiveBlue(blue: ChildProcess): void {
  if (childExited(blue)) {
    throw new RollbackFailure('blue-survival', 'blue exited before rollback completed')
  }
}

async function probePortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(false)
        return
      }
      reject(error)
    })
    probe.once('listening', () => {
      probe.close((error) => {
        if (error) reject(error)
        else resolve(true)
      })
    })
    probe.listen({ host: '127.0.0.1', port, exclusive: true })
  })
}

/**
 * Confirm that the old public listener is actually gone. Process exit normally implies this, but an
 * explicit bind probe also catches an inherited/stray listener before blue is told to reclaim the port.
 */
export async function waitForPortRelease(
  port: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probePortAvailable(port)) return
    if (Date.now() >= deadline) {
      throw new Error(`public port ${port} was not released within ${timeoutMs}ms`)
    }
    await wait(Math.min(25, Math.max(1, deadline - Date.now())))
  }
}

/**
 * Fail-closed rollback sequence used by hubctl.
 *
 * A promoted green is killed, observed exited, and its public port is probe-confirmed free before blue
 * receives the command that can call listen(). Blue then explicitly acknowledges that bind. Backup
 * ownership is retried with capped delays while blue health remains degraded; exhaustion is returned to
 * hubctl, which clears the dead/unprotected live handle and enters normal revival.
 */
export async function rollbackToBlue(options: RollbackToBlueOptions): Promise<void> {
  const {
    blue,
    green,
    publicPort,
    reason,
    greenMayOwnPublicListener,
    killGreen,
    waitForGreenExit,
    resumeBlue,
  } = options
  const releaseProbe = options.waitForPortRelease ?? waitForPortRelease
  const requestRebind = options.requestBlueRebind ?? requestRestartAbort
  const delay = options.delay ?? wait
  const resumeRetryMs = options.resumeRetryMs ?? [250, 1_000, 5_000]

  killGreen(green)
  if (greenMayOwnPublicListener) {
    try {
      await waitForGreenExit(green, options.greenExitTimeoutMs ?? 5_000)
    } catch (error) {
      throw new RollbackFailure('green-exit', error)
    }
    try {
      await releaseProbe(publicPort, options.portReleaseTimeoutMs ?? 2_000)
    } catch (error) {
      throw new RollbackFailure('port-release', error)
    }
  }

  requireLiveBlue(blue)
  try {
    await requestRebind(blue, reason, options.rollbackRebindTimeoutMs ?? 8_000)
  } catch (error) {
    throw new RollbackFailure('blue-rebind', error)
  }
  requireLiveBlue(blue)

  for (let attempt = 0; ; attempt += 1) {
    try {
      requireLiveBlue(blue)
      await resumeBlue()
      requireLiveBlue(blue)
      return
    } catch (error) {
      if (error instanceof RollbackFailure && error.phase === 'blue-survival') throw error
      const nextDelayMs = resumeRetryMs[attempt]
      options.onResumeFailure?.(error, nextDelayMs)
      if (nextDelayMs === undefined) {
        throw new RollbackFailure('backup-resume', error)
      }
      await delay(nextDelayMs)
    }
  }
}

/**
 * Remove an unprotected/failed public hub from supervisor state before revival. Exit confirmation is
 * best-effort because the fixed-port bind and SQLite lease independently fence the next candidate.
 */
export async function abandonLiveForRevival(
  options: AbandonLiveForRevivalOptions
): Promise<void> {
  options.clearLive()
  options.requestDeferredRecovery()
  options.markRetired()
  options.log(`discarding unrecovered live hub before revival: ${options.reason}`)
  options.kill(options.child)
  try {
    await options.waitForExit(options.child, options.exitTimeoutMs ?? 5_000)
  } catch (error) {
    options.log(`failed live hub did not confirm exit before revival: ${String(error)}`)
  }
}

/**
 * Remembers an unexpected live-hub exit that happened while hubctl intentionally suppresses immediate
 * revival. `finishFlip()` converts that deferred fact into exactly one revive unless green was adopted.
 */
export class FlipRecoveryTracker {
  private pending = false

  noteUnexpectedLiveExit(flipInFlight: boolean): 'deferred' | 'revive-now' {
    if (!flipInFlight) return 'revive-now'
    this.pending = true
    return 'deferred'
  }

  requestDeferredRecovery(): void {
    this.pending = true
  }

  adoptLiveReplacement(): void {
    this.pending = false
  }

  finishFlip(hasLive: boolean): boolean {
    const revive = this.pending && !hasLive
    this.pending = false
    return revive
  }
}
