import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RestartController, type RestartControllerDeps } from './restartController.js'
import { ASK_RESTART_TURN_GRACE_MS } from './restartHandshake.js'

const servers: http.Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    if (!server.listening) continue
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function listenEphemeral(server: http.Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test listener did not bind')
  return address.port
}

function controllerDeps(
  server: http.Server,
  publicPort: number,
  sent: unknown[] = []
): RestartControllerDeps {
  return {
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
    send: (message: unknown) => {
      sent.push(message)
    },
    onPromoted: () => {},
    stopJournalBackups: async () => {},
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
}

describe('RestartController journal backup ownership', () => {
  it('terminalizes question callbacks before releasing blue and fails the drain closed on audit failure', async () => {
    const server = http.createServer()
    const publicPort = await listenEphemeral(server)
    const sent: unknown[] = []
    const deps = controllerDeps(server, publicPort, sent)
    const deactivatePublicOwnerForRestart = vi.fn(() => {
      throw new Error('SQLITE_FULL while terminalizing questions')
    })
    deps.questions = {
      ...deps.questions,
      deactivatePublicOwnerForRestart,
    } as never
    const signalDraining = vi.fn()
    deps.executor = { signalDraining } as never

    await expect(new RestartController(deps).drain()).rejects.toThrow(/SQLITE_FULL/)
    expect(deactivatePublicOwnerForRestart).toHaveBeenCalledTimes(1)
    expect(signalDraining).not.toHaveBeenCalled()
    expect(server.listening).toBe(true)
    expect(deps.state.draining).toBe(false)
    expect(sent).toEqual([])
  })

  it('waits on exact question-turn handles and reports typed settled evidence before release', async () => {
    const server = http.createServer()
    const publicPort = await listenEphemeral(server)
    const sent: unknown[] = []
    const deps = controllerDeps(server, publicPort, sent)
    const freeze = vi.fn()
    deps.sessions.setRestartTurnAdmissionFrozen = freeze
    const interrupted = [
      {
        restartGeneration: 'drain-1',
        sessionId: 's1',
        questionCount: 2,
        questionIds: ['q1', 'q2'],
      },
    ]
    const recordRestartBoundaries = vi.fn(() => 1)
    deps.questions.deactivatePublicOwnerForRestart = vi.fn(() => interrupted)
    deps.questions.recordRestartBoundaries = recordRestartBoundaries
    const settleQuestionTurnsForRestart = vi.fn(async () => ({
      settled: ['s1'],
      outcomeUnknown: [],
    }))
    deps.executor = { settleQuestionTurnsForRestart } as never

    await new RestartController(deps).drain()

    expect(freeze).toHaveBeenCalledWith(true)
    expect(settleQuestionTurnsForRestart).toHaveBeenCalledWith(
      ['s1'],
      ASK_RESTART_TURN_GRACE_MS
    )
    expect(recordRestartBoundaries).toHaveBeenCalledWith(
      interrupted,
      new Set(['s1'])
    )
    expect(sent).toEqual([
      {
        type: 'released',
        questionTurns: { settled: 1, outcomeUnknown: 0 },
      },
    ])
  })

  it.each(['signal', 'journal', 'settle', 'record'] as const)(
    'reclaims the still-bound blue after a pre-close %s failure',
    async (phase) => {
      const server = http.createServer()
      const publicPort = await listenEphemeral(server)
      const sent: unknown[] = []
      const deps = controllerDeps(server, publicPort, sent)
      const freeze = vi.fn()
      deps.sessions.setRestartTurnAdmissionFrozen = freeze
      const activatePublicOwner = vi.fn(() => 0)
      deps.questions = {
        ...deps.questions,
        deactivatePublicOwnerForRestart: () => [
          {
            restartGeneration: 'drain-1',
            sessionId: 's1',
            questionCount: 1,
            questionIds: ['q1'],
          },
        ],
        recordRestartBoundaries: () => {
          if (phase === 'record') throw new Error('record failed')
          return 1
        },
        activatePublicOwner,
      } as never
      const signalDraining = vi.fn((draining: boolean) => {
        if (phase === 'signal' && draining) throw new Error('signal failed')
      })
      deps.executor = {
        signalDraining,
        settleQuestionTurnsForRestart: async () => {
          if (phase === 'settle') throw new Error('settle failed')
          return { settled: ['s1'], outcomeUnknown: [] }
        },
      } as never
      const append = deps.journal.append.bind(deps.journal)
      deps.journal.append = (...args: Parameters<typeof append>) => {
        if (phase === 'journal') throw new Error('journal failed')
        return append(...args)
      }

      await expect(new RestartController(deps).drain()).rejects.toThrow(
        new RegExp(`${phase} failed`)
      )

      expect(server.listening).toBe(true)
      expect(deps.state.draining).toBe(false)
      expect(activatePublicOwner).toHaveBeenCalledOnce()
      expect(freeze.mock.calls).toEqual([[true], [false]])
      expect(signalDraining).toHaveBeenLastCalledWith(false)
      expect(sent).toEqual([])
    }
  )

  it('settles and permanently stops backup work before a planned blue retire exits', async () => {
    const order: string[] = []
    vi.spyOn(process, 'exit').mockImplementation((() => {
      order.push('exit')
      return undefined as never
    }) as typeof process.exit)
    const deps = {
      journal: {
        append: () => {
          order.push('journal')
        },
      },
      sessions: {
        shutdown: async () => {
          order.push('sessions')
        },
      },
      stopJournalBackups: async () => {
        order.push('backups')
      },
    } as unknown as RestartControllerDeps
    const controller = new RestartController(deps)

    await controller.retire()

    expect(order).toEqual(['journal', 'backups', 'sessions', 'exit'])
  })

  it('derives orphan ownership from the actual fixed listener, never the blue/green role', async () => {
    const publicServer = http.createServer()
    const publicPort = await listenEphemeral(publicServer)
    const publicController = new RestartController(
      controllerDeps(publicServer, publicPort)
    )
    expect(await publicController.resolveOrphanedListenerOwnership()).toBe(true)

    const ephemeralServer = http.createServer()
    const ephemeralPort = await listenEphemeral(ephemeralServer)
    const nonPublicPort = ephemeralPort === 1 ? 2 : 1
    const ephemeralController = new RestartController(
      controllerDeps(ephemeralServer, nonPublicPort)
    )
    expect(await ephemeralController.resolveOrphanedListenerOwnership()).toBe(false)
  })

  it('waits through disconnect-vs-drain and leaves a released blue inactive', async () => {
    const server = http.createServer()
    const publicPort = await listenEphemeral(server)
    const sent: unknown[] = []
    const controller = new RestartController(controllerDeps(server, publicPort, sent))

    const draining = controller.drain()
    const orphanOwnership = controller.resolveOrphanedListenerOwnership()

    await draining
    expect(await orphanOwnership).toBe(false)
    expect(sent).toEqual([]) // the dead supervisor cannot consume `released`
  })

  it('waits through disconnect-vs-promote and recognizes green only after the fixed bind', async () => {
    const reservation = http.createServer()
    const publicPort = await listenEphemeral(reservation)
    await new Promise<void>((resolve) => reservation.close(() => resolve()))

    const server = http.createServer()
    const ephemeralPort = await listenEphemeral(server)
    expect(ephemeralPort).not.toBe(publicPort)
    const sent: unknown[] = []
    const controller = new RestartController(controllerDeps(server, publicPort, sent))

    controller.promote(publicPort)
    expect(await controller.resolveOrphanedListenerOwnership()).toBe(true)
    expect((server.address() as { port: number }).port).toBe(publicPort)
    expect(sent).toEqual([]) // the dead supervisor cannot consume `promoted`
  })

  it('closes the promoted listener when question ownership activation cannot commit', async () => {
    const reservation = http.createServer()
    const publicPort = await listenEphemeral(reservation)
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const server = http.createServer()
    await listenEphemeral(server)
    const sent: unknown[] = []
    const deps = controllerDeps(server, publicPort, sent)
    deps.questions = {
      ...deps.questions,
      deactivatePublicOwner: () => 0,
      activatePublicOwner: () => {
        throw new Error('SQLITE_IOERR during public claim')
      },
    } as never

    new RestartController(deps).promote(publicPort)
    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        type: 'promote-failed',
        error: expect.stringContaining('SQLITE_IOERR'),
      })
    )
    expect(server.listening).toBe(false)
    expect(deps.state.draining).toBe(true)
  })

  it.each(['reconcile', 'deferred-services'] as const)(
    'closes the promoted listener when the %s post-bind step fails',
    async (phase) => {
      const reservation = http.createServer()
      const publicPort = await listenEphemeral(reservation)
      await new Promise<void>((resolve) => reservation.close(() => resolve()))
      const server = http.createServer()
      await listenEphemeral(server)
      const sent: unknown[] = []
      const deps = controllerDeps(server, publicPort, sent)
      const deactivatePublicOwner = vi.fn(() => 0)
      deps.questions = {
        ...deps.questions,
        activatePublicOwner: () => 0,
        deactivatePublicOwner,
      } as never
      if (phase === 'reconcile') {
        deps.sessions = {
          ...deps.sessions,
          reconcileStale: () => {
            throw new Error('reconcile failed')
          },
        } as never
      } else {
        deps.onPromoted = () => {
          throw new Error('deferred startup failed')
        }
      }

      new RestartController(deps).promote(publicPort)
      await vi.waitFor(() =>
        expect(
          sent.filter(
            (message) =>
              (message as { type?: string }).type === 'promote-failed'
          )
        ).toHaveLength(1)
      )
      expect(server.listening).toBe(false)
      expect(sent).not.toContainEqual({ type: 'promoted' })
      expect(deactivatePublicOwner).toHaveBeenCalledTimes(1)
      expect(deps.state.draining).toBe(true)
    }
  )

  it('waits through rollback re-listen before resuming orphaned blue ownership', async () => {
    const server = http.createServer()
    const publicPort = await listenEphemeral(server)
    const sent: unknown[] = []
    const deps = controllerDeps(server, publicPort, sent)
    const deactivatePublicOwnerForRestart = vi.fn(() => [])
    const activatePublicOwner = vi.fn(() => 0)
    deps.questions = {
      ...deps.questions,
      deactivatePublicOwnerForRestart,
      activatePublicOwner,
    } as never
    const signalDraining = vi.fn()
    deps.executor = { signalDraining } as never
    const controller = new RestartController(deps)

    await controller.drain()
    await controller.abort('test rollback')

    expect(await controller.resolveOrphanedListenerOwnership()).toBe(true)
    expect((server.address() as { port: number }).port).toBe(publicPort)
    expect(sent).toContainEqual({ type: 'rollback-rebound' })
    expect(deps.state.rollbackRebinding).toBe(false)
    expect(deactivatePublicOwnerForRestart).toHaveBeenCalledTimes(1)
    expect(activatePublicOwner).toHaveBeenCalledTimes(1)
    expect(signalDraining.mock.calls).toEqual([[true], [false]])
  })

  it('idempotently reclaims question ownership when abort happens before blue drains', async () => {
    const server = http.createServer()
    const publicPort = await listenEphemeral(server)
    const sent: unknown[] = []
    const deps = controllerDeps(server, publicPort, sent)
    const activatePublicOwner = vi.fn(() => 0)
    deps.questions = {
      ...deps.questions,
      deactivatePublicOwner: vi.fn(() => 0),
      activatePublicOwner,
    } as never
    const signalDraining = vi.fn()
    deps.executor = { signalDraining } as never

    await new RestartController(deps).abort('green failed before drain')

    expect(activatePublicOwner).toHaveBeenCalledOnce()
    expect(signalDraining).toHaveBeenCalledOnce()
    expect(signalDraining).toHaveBeenCalledWith(false)
    expect(sent).toEqual([{ type: 'rollback-rebound' }])
    expect(server.listening).toBe(true)
  })

  it('closes the rollback listener when question ownership cannot be reactivated', async () => {
    const server = http.createServer()
    const publicPort = await listenEphemeral(server)
    const sent: unknown[] = []
    const deps = controllerDeps(server, publicPort, sent)
    deps.questions = {
      ...deps.questions,
      deactivatePublicOwner: vi.fn(() => 0),
      activatePublicOwner: vi.fn(() => {
        throw new Error('SQLITE_FULL during rollback claim')
      }),
    } as never
    const signalDraining = vi.fn()
    deps.executor = { signalDraining } as never
    const controller = new RestartController(deps)

    await controller.drain()
    await controller.abort('rollback ownership failure')

    expect(server.listening).toBe(false)
    expect(deps.state.draining).toBe(true)
    expect(deps.state.rollbackRebinding).toBe(false)
    expect(signalDraining.mock.calls).toEqual([[true], [true]])
    expect(sent).toContainEqual({
      type: 'rollback-failed',
      error: expect.stringContaining('SQLITE_FULL'),
    })
    expect(sent).not.toContainEqual({ type: 'rollback-rebound' })
    expect(deps.state.journalBackup).toMatchObject({
      status: 'degraded',
      error: expect.stringContaining('question ownership'),
    })
  })

  it('serializes rollback rebind behind an existing listener transition', async () => {
    const server = http.createServer()
    const publicPort = await listenEphemeral(server)
    const sent: unknown[] = []
    const deps = controllerDeps(server, publicPort, sent)
    const controller = new RestartController(deps)

    const draining = controller.drain()
    const aborting = controller.abort('overlapping rollback')
    await Promise.all([draining, aborting])

    expect(sent).toEqual([
      {
        type: 'released',
        questionTurns: { settled: 0, outcomeUnknown: 0 },
      },
      { type: 'rollback-rebound' },
    ])
    expect(server.listening).toBe(true)
    expect((server.address() as { port: number }).port).toBe(publicPort)
  })

  it('owns rollback bind errors and reports a typed failure instead of claiming rebound', async () => {
    const server = http.createServer()
    const publicPort = await listenEphemeral(server)
    const sent: unknown[] = []
    const deps = controllerDeps(server, publicPort, sent)
    const controller = new RestartController(deps)

    await controller.drain()
    const reservation = http.createServer()
    servers.push(reservation)
    await new Promise<void>((resolve) => reservation.listen(publicPort, '127.0.0.1', resolve))

    await controller.abort('reserved rollback port')

    expect(sent).toContainEqual({
      type: 'rollback-failed',
      error: expect.stringMatching(/EADDRINUSE|address already in use/i),
    })
    expect(sent).not.toContainEqual({ type: 'rollback-rebound' })
    expect(deps.state.rollbackRebinding).toBe(false)
    expect(deps.state.journalBackupRequired).toBe(true)
    expect(deps.state.journalBackup).toMatchObject({
      status: 'degraded',
      error: expect.stringMatching(/rollback/i),
    })
  })
})
