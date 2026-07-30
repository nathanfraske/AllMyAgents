import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

type OrphanEdge = 'fixed' | 'ephemeral' | 'drain' | 'promote' | 'rollback'

const children: ChildProcess[] = []
const roots: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function waitForMessage(
  child: ChildProcess,
  type: string,
  timeoutMs = 10_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`orphan fixture timed out waiting for ${type}: ${stderr}`))
    }, timeoutMs)
    const onMessage = (message: unknown): void => {
      if ((message as { type?: string } | undefined)?.type !== type) return
      cleanup()
      resolve()
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(
        new Error(
          `orphan fixture exited before ${type} (code=${String(code)} signal=${String(signal)}): ${stderr}`
        )
      )
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
  })
}

function spawnOrphanFixture(
  edge: OrphanEdge,
  root: string,
  marker: string
): ChildProcess {
  const backupModule = pathToFileURL(
    path.join(import.meta.dirname, 'journalBackup.ts')
  ).href
  const controllerModule = pathToFileURL(
    path.join(import.meta.dirname, 'restartController.ts')
  ).href
  const source = `
    const fs = await import('node:fs')
    const http = await import('node:http')
    const [{ createJournalBackupSupervisor }, { RestartController }] = await Promise.all([
      import(${JSON.stringify(backupModule)}),
      import(${JSON.stringify(controllerModule)})
    ])
    const edge = ${JSON.stringify(edge)}
    const listen = (server) => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
    const close = (server) => new Promise((resolve) => {
      if (!server.listening) return resolve()
      server.close(() => resolve())
    })

    const server = http.createServer((_request, response) => response.end('ok'))
    const initialPort = await listen(server)
    let publicPort = initialPort
    if (edge === 'ephemeral' || edge === 'promote') {
      const reservation = http.createServer()
      publicPort = await listen(reservation)
      await close(reservation)
    }

    const state = {
      booted: true,
      draining: false,
      promoting: false,
      rollbackRebinding: false,
      sockets: new Set(),
      journalBackup: { status: 'inactive' },
      journalBackupRequired: false,
    }
    const backups = createJournalBackupSupervisor(
      {},
      { dir: ${JSON.stringify(path.join(root, 'backups'))}, intervalMs: 60_000 },
      async () => ({ ok: true })
    )
    const controller = new RestartController({
      server,
      publicPort,
      state,
      send: () => {},
      onPromoted: () => {},
      stopJournalBackups: () => backups.stop(),
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
      executor: {}
    })

    if (edge === 'drain') {
      void controller.drain()
    } else if (edge === 'promote') {
      controller.promote(publicPort)
    } else if (edge === 'rollback') {
      await controller.drain()
      controller.abort('fixture rollback')
    }

    process.once('disconnect', () => {
      void (async () => {
        const publish = (result) => {
          const partial = ${JSON.stringify(`${marker}.partial`)}
          fs.writeFileSync(partial, JSON.stringify(result))
          fs.renameSync(partial, ${JSON.stringify(marker)})
        }
        try {
          const ownsPublicListener = await controller.resolveOrphanedListenerOwnership()
          const activation = ownsPublicListener
            ? backups.activateStandalone()
            : undefined
          publish({ ownsPublicListener, activation })
          await backups.stop()
          await close(server)
          process.exit(0)
        } catch (error) {
          publish({ error: String(error) })
          process.exit(1)
        }
      })()
    })
    process.send?.({ type: 'fixture-ready' })
    setInterval(() => {}, 60_000)
  `
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '--eval', source],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  )
  children.push(child)
  return child
}

describe('journal backup orphan ownership after real parent IPC loss', () => {
  it.each([
    ['fixed', true],
    ['ephemeral', false],
    ['drain', false],
    ['promote', true],
    ['rollback', true],
  ] as const)('%s edge resolves public-listener ownership to %s', async (edge, expected) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-backup-orphan-'))
    roots.push(root)
    const marker = path.join(root, 'orphan-result.json')
    const child = spawnOrphanFixture(edge, root, marker)
    await waitForMessage(child, 'fixture-ready')

    // This closes the actual Node IPC channel. The fixture has no synthetic "parent died" command.
    child.disconnect()

    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), {
      timeout: 5_000,
      interval: 10,
    })
    const result = JSON.parse(fs.readFileSync(marker, 'utf8')) as {
      ownsPublicListener?: boolean
      activation?: { ok: boolean }
      error?: string
    }
    expect(result.error).toBeUndefined()
    expect(result.ownsPublicListener).toBe(expected)
    expect(result.activation?.ok ?? false).toBe(expected)
  })
})
