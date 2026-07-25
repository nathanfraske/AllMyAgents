/**
 * Hub-side half of the blue-green restart handshake (docs/agent-detachment-impl.md §1.5-1.6). Keeps
 * index.ts thin: it dispatches SupervisorMsgs to these methods. Only ever constructed under
 * supervision (HUB_SUPERVISED=1 with an IPC channel).
 *
 * Flip roles: a retiring BLUE runs drain() → retire(); a promoted GREEN runs promote(); abort() runs
 * on BLUE when green failed its health-check (blue was never disturbed).
 */
import type http from 'node:http'
import type { Socket } from 'node:net'
import type { Journal } from './journal.js'
import type { SessionManager } from './sessions.js'

/** Shared by reference with server.ts, which reads it for /api/health + the draining 503 guard and
 *  tracks live sockets so drain() can free the port. */
export interface RestartState {
  booted: boolean
  draining: boolean
  promoting: boolean
  sockets: Set<Socket>
}

export interface RestartControllerDeps {
  server: http.Server
  sessions: SessionManager
  journal: Journal
  state: RestartState
  publicPort: number //           the fixed public port (7777) — green promotes to it; blue re-claims it on rollback
  send: (msg: unknown) => void // process.send, bound
  onPromoted: () => void //       start deferred services (usage polling + mesh) once we own the port
}

export class RestartController {
  constructor(private readonly deps: RestartControllerDeps) {}

  /**
   * BLUE: stop taking new sessions (server.ts returns 503 while draining), DESTROY live sockets so the
   * fixed port frees promptly — WS connections are long-lived and would otherwise keep the listener
   * open forever; the clients auto-reconnect to green — then close the listener and signal `released`.
   */
  async drain(): Promise<void> {
    const { server, journal, state, send } = this.deps
    state.draining = true
    journal.append(null, 'hub/draining', {})
    for (const s of state.sockets) {
      try {
        s.destroy()
      } catch {
        /* already gone */
      }
    }
    state.sockets.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    send({ type: 'released' })
  }

  /**
   * GREEN: (re-)listen on the fixed public port. On success, reconcile crash-stale sessions (safe now
   * that we own the port), start deferred services, and signal `promoted`. On EADDRINUSE (a stray
   * grabbed the port in the gap) signal `promote-failed` so the supervisor rolls back to blue.
   * server.ts's global error handler defers to us while `state.promoting` is set.
   */
  promote(port: number): void {
    const { server, sessions, state, send, onPromoted } = this.deps
    state.promoting = true
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      state.promoting = false
      send({ type: 'promote-failed', error: err.message })
    }
    const onListening = (): void => {
      server.off('error', onError)
      state.promoting = false
      state.draining = false
      sessions.reconcileStale()
      onPromoted()
      send({ type: 'promoted' })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    // Green is ALREADY listening on its ephemeral boot port — close that listener first (destroying the
    // health-check sockets so close() completes promptly) before binding the fixed public port. Calling
    // listen() while already listening throws ERR_SERVER_ALREADY_LISTEN.
    for (const s of state.sockets) {
      try {
        s.destroy()
      } catch {
        /* gone */
      }
    }
    state.sockets.clear()
    server.close(() => server.listen(port, '127.0.0.1'))
  }

  /**
   * BLUE: planned retire after green owns the port. Journal it, graceful-shutdown vendor children
   * (the `graceful` flag suppresses the codex-exit "crashed" mislabel), then exit. Phase 1 still loses
   * blue's live turn here; Phase 2's supervised worker removes that.
   */
  async retire(): Promise<void> {
    const { journal, sessions } = this.deps
    journal.append(null, 'hub/retiring', {})
    await sessions.shutdown({ graceful: true })
    process.exit(0)
  }

  /**
   * BLUE: green failed. Journal the abort. If we had ALREADY drained (released the port) when green
   * failed, re-claim the fixed port so the hub isn't left dark — green never bound it (it failed at
   * health-check or its own listen), so the port is free for us again. If green failed BEFORE our
   * drain, state.draining is false and we were never disturbed.
   */
  abort(error: string): void {
    const { server, journal, state, publicPort } = this.deps
    journal.append(null, 'hub/restart-aborted', { error })
    if (state.draining) {
      state.draining = false
      server.once('error', (e: NodeJS.ErrnoException) => console.error(`[hub] rollback re-listen failed: ${e.message}`))
      server.listen(publicPort, '127.0.0.1')
    }
  }
}
