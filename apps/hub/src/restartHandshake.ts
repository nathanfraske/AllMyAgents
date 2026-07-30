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

/** Bump when a hub change is incompatible with an older on-disk schema (Phase 3 migration guard). */
export const SCHEMA_VERSION = 1
export const ASK_RESTART_TURN_GRACE_MS = 10_000
export const ASK_RESTART_INTERRUPT_MARGIN_MS = 250
// Worst case: three SQLite writes may each wait the configured 5s busy_timeout, followed by the Ask
// grace, interrupt dispatch, and listener-close margin. Keep this single-sourced with hubctl.
export const HUB_DRAIN_RELEASE_TIMEOUT_MS = 30_000

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

/** Supervisor -> hub. */
export type SupervisorMsg =
  | { type: 'drain' } //   stop accepting new sessions (503), close the listener, keep the process alive
  | { type: 'promote'; port: number } // re-listen on the fixed public port (green taking over)
  | { type: 'retire' } //  finish in-flight, close WS, graceful shutdown, exit(0)
  | { type: 'restart-aborted'; error: string } // runs on BLUE when green failed → journal it for the operator
  | JournalBackupControlCommand

/** Hub -> supervisor. */
export type HubMsg =
  | { type: 'ready'; port: number; restored: number; schemaVersion: number } // after boot() + listening
  | {
      type: 'released'
      questionTurns: { settled: number; outcomeUnknown: number }
    } // drain done: listener closed, port free
  | { type: 'drain-failed'; error: string } // blue kept the listener because pre-drain durability failed
  | { type: 'promoted' } //      now listening on the fixed port
  | { type: 'promote-failed'; error: string } // could not bind the fixed port (EADDRINUSE) → supervisor rolls back
  | { type: 'rollback-rebound' } // blue has successfully reclaimed the fixed public listener
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
  | { type: 'preflight-failed'; code: string; message: string; recovery: string }
  | { type: 'restart-request'; reason: string; bySession?: string } // hub asks the supervisor to flip

export function sendToHub(child: ChildProcess, msg: SupervisorMsg): void {
  child.send?.(msg)
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
          const counts = (m as { questionTurns?: { settled?: unknown; outcomeUnknown?: unknown } })
            .questionTurns
          if (
            !counts ||
            !Number.isSafeInteger(counts.settled) ||
            (counts.settled as number) < 0 ||
            !Number.isSafeInteger(counts.outcomeUnknown) ||
            (counts.outcomeUnknown as number) < 0
          ) {
            cleanup()
            reject(new Error("invalid hub 'released' question-turn counts"))
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
        const p = m as { code?: string; message?: string; recovery?: string }
        reject(new Error(`preflight refused to boot [${p.code ?? 'unknown'}]: ${p.message ?? ''} — ${p.recovery ?? ''}`))
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
  timeoutMs: number
): Promise<Extract<HubMsg, { type: 'rollback-rebound' }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out after ${timeoutMs}ms waiting for blue rollback rebind`))
    }, timeoutMs)
    const onMsg = (message: HubMsg): void => {
      if (message?.type === 'rollback-rebound') {
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
      child.send({ type: 'restart-aborted', error }, (sendError) => {
        if (!sendError) return
        cleanup()
        reject(sendError)
      })
    } catch (sendError) {
      cleanup()
      reject(sendError)
    }
  })
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
