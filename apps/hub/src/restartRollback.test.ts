import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  abandonLiveForRevival,
  FlipRecoveryTracker,
  rollbackToBlue,
} from './restartRollback.js'
import { RestartController, type RestartControllerDeps } from './restartController.js'
import type { SupervisorMsg } from './restartHandshake.js'

const servers: http.Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (!server.listening) continue
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function listen(server: http.Server, port = 0): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test listener did not bind')
  return address.port
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly sent: SupervisorMsg[] = []
  onSend?: (message: SupervisorMsg) => void

  send(
    message: SupervisorMsg,
    callback?: (error: Error | null) => void
  ): boolean {
    this.sent.push(message)
    this.onSend?.(message)
    callback?.(null)
    return true
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess
  }

  finish(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.signalCode = signal
    this.emit('exit', null, signal)
  }
}

function makeBlueController(
  server: http.Server,
  publicPort: number,
  blue: FakeChild
): { controller: RestartController; deps: RestartControllerDeps } {
  const deps = {
    server,
    publicPort,
    state: {
      booted: true,
      draining: false,
      promoting: false,
      rollbackRebinding: false,
      sockets: new Set(),
      journalBackup: { status: 'active' },
      journalBackupRequired: true,
    },
    send: (message: unknown) => queueMicrotask(() => blue.emit('message', message)),
    onPromoted: () => {},
    stopJournalBackups: async () => {},
    profileRuntime: {
      prepareRestart: async () => ({ settled: 0, outcomeUnknown: 0 }),
      deactivatePublicGeneration: () => {},
      activatePublicGeneration: () => {},
      resumeLoginAdmission: () => {},
    },
    journal: { append: () => {} },
    questions: {
      deactivatePublicOwner: () => 0,
      deactivatePublicOwnerForRestart: () => [],
      recordRestartBoundaries: () => 0,
      activatePublicOwner: () => 0,
    },
    sessions: {
      reconcileStale: () => {},
      shutdown: async () => {},
      setRestartTurnAdmissionFrozen: () => {},
    },
    executor: {},
  } as unknown as RestartControllerDeps
  const controller = new RestartController(deps)
  blue.onSend = (message) => {
    if (message.type === 'restart-aborted') void controller.abort(message.error)
  }
  return { controller, deps }
}

describe('hubctl rollback orchestration', () => {
  it('does not tell blue to rebind when green bound the public port but its promoted ACK was lost', async () => {
    const blueServer = http.createServer()
    const publicPort = await listen(blueServer)
    const blue = new FakeChild()
    const green = new FakeChild()
    const { controller } = makeBlueController(blueServer, publicPort, blue)
    await controller.drain()

    const greenServer = http.createServer()
    await listen(greenServer, publicPort)
    const killed = deferred()
    const order: string[] = []
    const rollingBack = rollbackToBlue({
      blue: blue.asChild(),
      green: green.asChild(),
      publicPort,
      reason: 'green promoted acknowledgement timed out',
      greenMayOwnPublicListener: true,
      killGreen: () => {
        order.push('green-kill-requested')
        killed.resolve()
      },
      waitForGreenExit: async () => {
        await new Promise<void>((resolve) => green.once('exit', () => resolve()))
        order.push('green-exited')
      },
      resumeBlue: async () => {
        order.push('blue-backup-resumed')
      },
      resumeRetryMs: [],
    })

    await killed.promise
    await Promise.resolve()
    expect(blue.sent).toEqual([])
    expect(blueServer.listening).toBe(false)

    await new Promise<void>((resolve) => greenServer.close(() => resolve()))
    green.finish()
    await rollingBack

    expect(order).toEqual([
      'green-kill-requested',
      'green-exited',
      'blue-backup-resumed',
    ])
    expect(blue.sent).toContainEqual({
      type: 'restart-aborted',
      error: 'green promoted acknowledgement timed out',
    })
    expect(blueServer.listening).toBe(true)
    expect((blueServer.address() as { port: number }).port).toBe(publicPort)
  })

  it('surfaces typed rollback failure when the fixed port is reserved and never resumes backup ownership', async () => {
    const blueServer = http.createServer()
    const publicPort = await listen(blueServer)
    const blue = new FakeChild()
    const green = new FakeChild()
    const { controller } = makeBlueController(blueServer, publicPort, blue)
    await controller.drain()

    const reservation = http.createServer()
    await listen(reservation, publicPort)
    let resumed = false

    await expect(
      rollbackToBlue({
        blue: blue.asChild(),
        green: green.asChild(),
        publicPort,
        reason: 'test rollback collision',
        greenMayOwnPublicListener: false,
        killGreen: () => green.finish(),
        waitForGreenExit: async () => {},
        resumeBlue: async () => {
          resumed = true
        },
        resumeRetryMs: [],
      })
    ).rejects.toMatchObject({
      phase: 'blue-rebind',
    })
    expect(resumed).toBe(false)
    expect(blueServer.listening).toBe(false)

    let live: FakeChild | null = blue
    const tracker = new FlipRecoveryTracker()
    const revived: string[] = []
    await abandonLiveForRevival({
      child: blue.asChild(),
      reason: 'typed rollback failure',
      clearLive: () => {
        live = null
      },
      markRetired: () => {},
      requestDeferredRecovery: () => tracker.requestDeferredRecovery(),
      kill: () => blue.finish(),
      waitForExit: async () => {},
      log: () => {},
    })
    expect(live).toBeNull()
    if (tracker.finishFlip(live !== null)) revived.push('revive')
    expect(revived).toEqual(['revive'])
  })

  it('keeps rebound blue degraded during a dropped resume, retries, and becomes healthy only after recovery', async () => {
    const blueServer = http.createServer()
    const publicPort = await listen(blueServer)
    const blue = new FakeChild()
    const green = new FakeChild()
    const { controller, deps } = makeBlueController(blueServer, publicPort, blue)
    await controller.drain()
    // Parent-side pause completed before drain, so this public rollback starts unprotected.
    deps.state.journalBackup = { status: 'inactive' }
    const retryGate = deferred()
    let attempts = 0

    const rollingBack = rollbackToBlue({
      blue: blue.asChild(),
      green: green.asChild(),
      publicPort,
      reason: 'resume acknowledgement dropped',
      greenMayOwnPublicListener: false,
      killGreen: () => green.finish(),
      waitForGreenExit: async () => {},
      resumeBlue: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('resume timed out')
        deps.state.journalBackup = { status: 'active' }
      },
      resumeRetryMs: [1],
      delay: () => retryGate.promise,
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(attempts).toBe(1)
    expect(deps.state.journalBackupRequired).toBe(true)
    expect(deps.state.journalBackup).toMatchObject({
      status: 'degraded',
      error: expect.stringMatching(/rollback/i),
    })

    retryGate.resolve()
    await rollingBack
    expect(attempts).toBe(2)
    expect(deps.state.journalBackup).toEqual({ status: 'active' })
  })

  it('cancels deferred revival when a healthy green was committed before the flip ended', () => {
    const tracker = new FlipRecoveryTracker()
    expect(tracker.noteUnexpectedLiveExit(true)).toBe('deferred')
    tracker.adoptLiveReplacement()
    expect(tracker.finishFlip(true)).toBe(false)
  })
})
