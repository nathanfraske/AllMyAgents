import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RestartController, type RestartControllerDeps } from './restartController.js'

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
      sockets: new Set(),
      journalBackup: { status: 'active' },
    },
    send: (message: unknown) => {
      sent.push(message)
    },
    onPromoted: () => {},
    stopJournalBackups: async () => {},
    journal: { append: () => {} },
    sessions: { reconcileStale: () => {}, shutdown: async () => {} },
    executor: {},
  } as unknown as RestartControllerDeps
}

describe('RestartController journal backup ownership', () => {
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

  it('waits through rollback re-listen before resuming orphaned blue ownership', async () => {
    const server = http.createServer()
    const publicPort = await listenEphemeral(server)
    const deps = controllerDeps(server, publicPort)
    const controller = new RestartController(deps)

    await controller.drain()
    controller.abort('test rollback')

    expect(await controller.resolveOrphanedListenerOwnership()).toBe(true)
    expect((server.address() as { port: number }).port).toBe(publicPort)
  })
})
