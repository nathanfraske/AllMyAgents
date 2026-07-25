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

/** Supervisor -> hub. */
export type SupervisorMsg =
  | { type: 'drain' } //   stop accepting new sessions (503), close the listener, keep the process alive
  | { type: 'promote'; port: number } // re-listen on the fixed public port (green taking over)
  | { type: 'retire' } //  finish in-flight, close WS, graceful shutdown, exit(0)
  | { type: 'restart-aborted'; error: string } // runs on BLUE when green failed → journal it for the operator

/** Hub -> supervisor. */
export type HubMsg =
  | { type: 'ready'; port: number; restored: number; schemaVersion: number } // after boot() + listening
  | { type: 'released' } //      drain done: listener closed, port free
  | { type: 'promoted' } //      now listening on the fixed port
  | { type: 'promote-failed'; error: string } // could not bind the fixed port (EADDRINUSE) → supervisor rolls back
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
        cleanup()
        resolve(m as Extract<HubMsg, { type: T }>)
      } else if (m && typeof m === 'object' && m.type === 'promote-failed' && type === 'promoted') {
        cleanup()
        reject(new Error(`promote failed: ${(m as { error?: string }).error ?? 'unknown'}`))
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
