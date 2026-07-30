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
import type { Executor } from './executor.js'
import type { JournalBackupRuntimeState } from './journalBackup.js'
import type { Journal } from './journal.js'
import type { QuestionService } from './questions.js'
import type { SessionManager } from './sessions.js'
import { ASK_RESTART_TURN_GRACE_MS } from './restartHandshake.js'

/** Shared by reference with server.ts, which reads it for /api/health + the draining 503 guard and
 *  tracks live sockets so drain() can free the port. */
export interface RestartState {
  booted: boolean
  draining: boolean
  promoting: boolean
  rollbackRebinding: boolean
  sockets: Set<Socket>
  journalBackup: JournalBackupRuntimeState
  /** Sticky once this process owns or is reclaiming the public listener. */
  journalBackupRequired: boolean
}

export interface RestartControllerDeps {
  server: http.Server
  sessions: SessionManager
  journal: Journal
  questions: QuestionService
  state: RestartState
  publicPort: number //           the fixed public port (7777) — green promotes to it; blue re-claims it on rollback
  send: (msg: unknown) => void // process.send, bound
  onPromoted: () => void //       start deferred services (usage polling + mesh) once we own the port
  // Defense in depth for planned retire: the parent protocol pauses blue before drain, but retire itself
  // still settles and terminally disables backup work before process.exit.
  stopJournalBackups: () => Promise<void>
  // The execution seam (docs/agent-worker-impl.md §8.4). Only its `signalDraining?` is used here — to hold
  // worker relays before blue's socket drops (drain) and un-drain a rolled-back flip (abort). WORKER-MODE
  // ONLY: the in-process executor implements no signalDraining, so both calls are a no-op and the flag-off
  // restart path is byte-identical.
  executor: Executor
  /** Test override; production uses the handshake layer's shared grace. */
  questionTurnGraceMs?: number
}

interface DrainOperation {
  abortRequested: boolean
  abortController: AbortController
  promise: Promise<void>
}

export class RestartController {
  private listenerTransition: Promise<void> | undefined
  private drainOperation: DrainOperation | undefined
  private abortOperation: Promise<void> | undefined
  private supervisorDisconnected = false

  constructor(private readonly deps: RestartControllerDeps) {}

  private notifySupervisor(message: unknown): void {
    if (!this.supervisorDisconnected) this.deps.send(message)
  }

  private requireJournalBackupOwnership(error: string): void {
    const { state } = this.deps
    state.journalBackupRequired = true
    if (state.journalBackup.status !== 'active') {
      state.journalBackup = { status: 'degraded', error }
    }
  }

  /**
   * Resolve a parent-death race from observable listener state, never from a stale blue/green label.
   *
   * A disconnect can arrive while close/re-listen is between callbacks. Waiting for that already-started
   * transition is not a delay heuristic: it observes the exact completion event, then grants orphan
   * ownership only to the process demonstrably bound to the fixed public port.
   */
  async resolveOrphanedListenerOwnership(): Promise<boolean> {
    this.supervisorDisconnected = true
    for (;;) {
      const transition = this.listenerTransition
      if (!transition) break
      try {
        await transition
      } catch {
        // A rejected drain can still have successfully reclaimed every public boundary while keeping the
        // fixed listener bound. Transition outcome is not listener ownership; observe the final socket
        // state after this exact transition settles, then loop in case it started a successor transition.
      }
      // Do not re-await the same already-settled (especially rejected) promise. Clear only by identity:
      // a genuinely new close/rebind transition installed while we awaited remains visible to the loop.
      if (this.listenerTransition === transition) this.listenerTransition = undefined
    }
    if (!this.deps.server.listening) return false
    const address = this.deps.server.address()
    return (
      address !== null &&
      typeof address !== 'string' &&
      address.port === this.deps.publicPort
    )
  }

  /**
   * BLUE: stop taking new sessions (server.ts returns 503 while draining), DESTROY live sockets so the
   * fixed port frees promptly — WS connections are long-lived and would otherwise keep the listener
   * open forever; the clients auto-reconnect to green — then close the listener and signal `released`.
   */
  async drain(): Promise<void> {
    if (this.drainOperation) return this.drainOperation.promise
    const operation: DrainOperation = {
      abortRequested: false,
      abortController: new AbortController(),
      promise: undefined as unknown as Promise<void>,
    }
    this.drainOperation = operation
    operation.promise = this.runDrain(operation)
    // The whole drain is one listener-ownership transition, including the Ask grace before close. Parent
    // loss therefore observes the exact final listener state, and abort can cancel/await this operation
    // instead of racing a still-bound blue with a second listen().
    this.listenerTransition = operation.promise
    try {
      await operation.promise
    } finally {
      if (this.drainOperation === operation) this.drainOperation = undefined
      if (this.listenerTransition === operation.promise) this.listenerTransition = undefined
    }
  }

  private async runDrain(operation: DrainOperation): Promise<void> {
    const { server, journal, questions, sessions, state, executor } = this.deps
    state.draining = true
    sessions.setRestartTurnAdmissionFrozen(true)
    // An in-process SDK callback cannot survive process retirement. Close every question durably and
    // settle its callback BEFORE releasing the public listener; if SQLite is BUSY/FULL/I/O-failed this
    // throws and the drain stops here, leaving blue authoritative for the supervisor's rollback.
    let interrupted
    try {
      interrupted = questions.deactivatePublicOwnerForRestart()
    } catch (error) {
      state.draining = false
      sessions.setRestartTurnAdmissionFrozen(false)
      throw error
    }
    // FIRST, before we close anything: tell the worker we're draining so it HOLDS new relays (queues them
    // without racing the about-to-die socket) — a planned flip then has zero failed in-flight sends; green's
    // attach flushes them (§8.4). No-op in-process (no worker to drain), so flag-off is unchanged.
    let boundary: { settled: string[]; outcomeUnknown: string[] }
    try {
      executor.signalDraining?.(true)
      journal.append(null, 'hub/draining', {})
      const sessionIds = interrupted.map((turn) => turn.sessionId)
      if (sessionIds.length === 0) {
        boundary = { settled: [], outcomeUnknown: [] }
      } else if (executor.settleQuestionTurnsForRestart) {
        const settlement = executor.settleQuestionTurnsForRestart(
          sessionIds,
          this.deps.questionTurnGraceMs ?? ASK_RESTART_TURN_GRACE_MS,
          operation.abortController.signal
        )
        let removeAbort: (() => void) | undefined
        const result = await Promise.race([
          settlement.then((value) => ({ kind: 'settled' as const, value })),
          new Promise<{ kind: 'aborted' }>((resolve) => {
            if (operation.abortController.signal.aborted) {
              resolve({ kind: 'aborted' })
              return
            }
            const abort = () => resolve({ kind: 'aborted' })
            operation.abortController.signal.addEventListener('abort', abort, {
              once: true,
            })
            removeAbort = () =>
              operation.abortController.signal.removeEventListener('abort', abort)
          }),
        ])
        removeAbort?.()
        if (result.kind === 'aborted') return
        boundary = result.value
      } else {
        boundary = { settled: [], outcomeUnknown: sessionIds }
      }
      if (operation.abortRequested) return
      questions.recordRestartBoundaries(interrupted, new Set(boundary.settled))
    } catch (error) {
      // The listener is still bound. Reclaim every public mutation boundary before reporting drain-failed;
      // interruption rows remain truthful and activation turns any unfinished notice into outcome-unknown.
      try {
        questions.activatePublicOwner()
        sessions.setRestartTurnAdmissionFrozen(false)
        executor.signalDraining?.(false)
        state.draining = false
      } catch (reclaimError) {
        state.draining = true
        const message = `pre-close drain failed and blue could not reclaim ownership: ${
          reclaimError instanceof Error ? reclaimError.message : String(reclaimError)
        }`
        state.journalBackup = { status: 'degraded', error: message }
        for (const socket of state.sockets) socket.destroy()
        state.sockets.clear()
        await new Promise<void>((resolve) => {
          if (!server.listening) return resolve()
          server.close(() => resolve())
        })
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; ${message}`
        )
      }
      throw error
    }
    if (operation.abortRequested) return
    for (const s of state.sockets) {
      try {
        s.destroy()
      } catch {
        /* already gone */
      }
    }
    state.sockets.clear()
    const transition = new Promise<void>((resolve) => server.close(() => resolve()))
    await transition
    if (operation.abortRequested) return
    this.notifySupervisor({
      type: 'released',
      questionTurns: {
        settled: boundary.settled.length,
        outcomeUnknown: boundary.outcomeUnknown.length,
      },
    })
  }

  /**
   * GREEN: (re-)listen on the fixed public port. On success, reconcile crash-stale sessions (safe now
   * that we own the port), start deferred services, and signal `promoted`. On EADDRINUSE (a stray
   * grabbed the port in the gap) signal `promote-failed` so the supervisor rolls back to blue.
   * server.ts's global error handler defers to us while `state.promoting` is set.
   */
  promote(port: number): void {
    const { server, sessions, state, onPromoted } = this.deps
    state.promoting = true
    let settleTransition!: () => void
    const transition = new Promise<void>((resolve) => {
      settleTransition = resolve
    })
    this.listenerTransition = transition
    const settled = (): void => {
      if (this.listenerTransition === transition) this.listenerTransition = undefined
      settleTransition()
    }
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('error', onError)
      server.off('listening', onListening)
      state.promoting = false
      this.notifySupervisor({ type: 'promote-failed', error: err.message })
      settled()
    }
    const onListening = (): void => {
      server.off('error', onError)
      try {
        // The listener callback runs synchronously before another request can be dispatched. Claiming here
        // closes crash-orphaned summary rows without letting booting green touch live blue callbacks.
        this.deps.questions.activatePublicOwner()
        state.promoting = false
        state.draining = false
        this.requireJournalBackupOwnership(
          'promoted public listener is waiting for journal backup ownership'
        )
        sessions.reconcileStale()
        onPromoted()
      } catch (error) {
        state.promoting = false
        state.draining = true
        let message = error instanceof Error ? error.message : String(error)
        try {
          this.deps.questions.deactivatePublicOwner()
        } catch (deactivationError) {
          message += `; question ownership rollback failed: ${
            deactivationError instanceof Error
              ? deactivationError.message
              : String(deactivationError)
          }`
        }
        server.close(() => {
          this.notifySupervisor({
            type: 'promote-failed',
            error: `post-bind promotion failed: ${message}`,
          })
          settled()
        })
        return
      }
      this.notifySupervisor({ type: 'promoted' })
      settled()
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
    try {
      server.close(() => {
        try {
          server.listen(port, '127.0.0.1')
        } catch (error) {
          onError(error as NodeJS.ErrnoException)
        }
      })
    } catch (error) {
      onError(error as NodeJS.ErrnoException)
    }
  }

  /**
   * BLUE: planned retire after green owns the port. Journal it, graceful-shutdown vendor children
   * (the `graceful` flag suppresses the codex-exit "crashed" mislabel), then exit. Phase 1 still loses
   * blue's live turn here; Phase 2's supervised worker removes that.
   */
  async retire(): Promise<void> {
    const { journal, sessions, stopJournalBackups } = this.deps
    journal.append(null, 'hub/retiring', {})
    await stopJournalBackups()
    await sessions.shutdown({ graceful: true })
    process.exit(0)
  }

  /**
   * BLUE: green failed. Journal the abort. If we had already drained, reclaim the fixed port only after
   * hubctl has confirmed any promoted green is dead and the port bind-probes free. If green failed before
   * drain, state.draining is false and the existing listener is acknowledged without another listen().
   */
  async abort(error: string): Promise<void> {
    if (this.abortOperation) return this.abortOperation
    const operation = this.runAbort(error)
    this.abortOperation = operation
    try {
      await operation
    } finally {
      if (this.abortOperation === operation) this.abortOperation = undefined
    }
  }

  private async runAbort(error: string): Promise<void> {
    const { server, journal, state, publicPort, executor, questions } = this.deps
    const drain = this.drainOperation
    if (drain) {
      // A supervisor timeout cancels this exact drain generation. Fence first so a close callback cannot
      // emit a late `released`, and abort the exact-turn grace so it cannot interrupt a turn after blue
      // has rolled back.
      drain.abortRequested = true
      drain.abortController.abort()
    }
    journal.append(null, 'hub/restart-aborted', { error })
    if (drain) {
      try {
        await drain.promise
      } catch {
        // The drain caller reports genuine drain failures. Rollback still has to reclaim or fail closed.
      }
      if (this.drainOperation === drain) this.drainOperation = undefined
      if (this.listenerTransition === drain.promise) this.listenerTransition = undefined
    }
    // Release the worker drain hold only after blue also reclaims QuestionService ownership. Otherwise a
    // rebound can accept turns while AskUserQuestion still fails closed.
    // Drain, promote, orphan resolution, and rollback all share one server. Never overwrite an
    // already-running close/listen promise: wait for the exact callback, then own the next transition.
    for (;;) {
      const existing = this.listenerTransition
      if (!existing) break
      await existing
    }

    this.requireJournalBackupOwnership(
      'rollback public listener is waiting for journal backup ownership'
    )

    const reclaimQuestionOwner = async (): Promise<void> => {
      try {
        // Idempotent when green failed before blue released ownership; essential after drain terminalized
        // the old callbacks. Do not expose the listener or release worker relays until this durable claim
        // succeeds.
        questions.activatePublicOwner()
        this.deps.sessions.setRestartTurnAdmissionFrozen(false)
        executor.signalDraining?.(false)
        state.draining = false
        this.notifySupervisor({ type: 'rollback-rebound' })
      } catch (activationError) {
        state.draining = true
        let message = `rollback failed to reactivate question ownership: ${
          activationError instanceof Error ? activationError.message : String(activationError)
        }`
        try {
          questions.deactivatePublicOwner()
        } catch (deactivationError) {
          message += `; question ownership release failed: ${
            deactivationError instanceof Error
              ? deactivationError.message
              : String(deactivationError)
          }`
        }
        try {
          executor.signalDraining?.(true)
        } catch (signalError) {
          message += `; worker drain signal failed: ${
            signalError instanceof Error ? signalError.message : String(signalError)
          }`
        }
        state.journalBackup = {
          status: 'degraded',
          error: message,
        }
        console.error(`[hub] ${message}`)
        await new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve()
            return
          }
          try {
            server.close(() => resolve())
          } catch (closeError) {
            message += `; listener close failed: ${
              closeError instanceof Error ? closeError.message : String(closeError)
            }`
            state.journalBackup = { status: 'degraded', error: message }
            resolve()
          }
        })
        this.notifySupervisor({ type: 'rollback-failed', error: message })
      }
    }

    const address = server.address()
    const publicListenerStillBound =
      server.listening &&
      address !== null &&
      typeof address !== 'string' &&
      address.port === publicPort
    if (!state.draining || publicListenerStillBound) {
      await reclaimQuestionOwner()
      return
    }

    state.rollbackRebinding = true
    let settleTransition!: () => void
    const transition = new Promise<void>((resolve) => {
      settleTransition = resolve
    })
    this.listenerTransition = transition
    let settledAlready = false
    const settled = (): void => {
      if (settledAlready) return
      settledAlready = true
      if (this.listenerTransition === transition) this.listenerTransition = undefined
      settleTransition()
    }
    const onError = (bindError: NodeJS.ErrnoException): void => {
      server.off('error', onError)
      server.off('listening', onListening)
      state.draining = true
      executor.signalDraining?.(true)
      const message = bindError.message || bindError.code || String(bindError)
      state.journalBackup = {
        status: 'degraded',
        error: `rollback failed to reclaim the public listener: ${message}`,
      }
      console.error(`[hub] rollback re-listen failed: ${message}`)
      this.notifySupervisor({ type: 'rollback-failed', error: message })
      settled()
    }
    const onListening = (): void => {
      server.off('error', onError)
      void reclaimQuestionOwner().finally(settled)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(publicPort, '127.0.0.1')
    } catch (bindError) {
      onError(bindError as NodeJS.ErrnoException)
    }
    await transition
    // Keep the controller's error-ownership flag set for the entire synchronous EventEmitter dispatch.
    // A platform may also surface a synchronous listen failure and then enqueue the matching error event;
    // drain that event-loop turn before releasing ownership so the global listener still defers.
    await new Promise<void>((resolve) => setImmediate(resolve))
    state.rollbackRebinding = false
  }
}
