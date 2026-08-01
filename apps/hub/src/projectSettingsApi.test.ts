import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore } from './projects.js'
import { startServer, type ServerOptions } from './server.js'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

describe('project settings API', () => {
  it('renames one authenticated project and journals the exact change', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-project-settings-api-'))
    const projectDir = path.join(root, 'project')
    fs.mkdirSync(projectDir)
    const db = new Database(path.join(root, 'hub.db'))
    const projects = new ProjectStore(db)
    const project = projects.create('Before', projectDir)
    const append = vi.fn()
    const deviceToken = 'project-settings-test-device-token-at-least-32-characters'
    const server = startServer({
      port: 0,
      defaultCwd: root,
      profilesDir: root,
      journal: { append } as never,
      sessions: { list: () => [], listProfiles: () => [] } as never,
      profiles: [],
      approvals: {} as never,
      questions: {} as never,
      usage: {} as never,
      projects,
      workspace: {} as never,
      instructions: {} as never,
      bus: {} as never,
      memory: {} as never,
      practices: {} as never,
      danger: { busCanUseRiskyTools: false, autoApprovePractices: false },
      prefs: { chatNamePool: 'everyone', steerMessagesAtToolBoundary: true },
      rescanProfiles: () => [],
      mesh: {} as never,
      deviceToken,
      requireToken: true,
      restartState: { booted: true, sockets: new Set(), draining: false, promoting: false } as never,
      executor: {} as never,
      configPath: path.join(root, 'config.json'),
    } satisfies ServerOptions)
    if (!server.listening) await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    cleanups.push(async () => {
      if (server.listening) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()))
        server.closeAllConnections()
        await closed
      }
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    })

    const response = await fetch(
      `http://127.0.0.1:${port}/api/projects/${project.id}/settings`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deviceToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'After' }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...project, name: 'After' })
    expect(projects.get(project.id)).toEqual({ ...project, name: 'After' })
    expect(append).toHaveBeenCalledWith(null, 'project/updated', {
      projectId: project.id,
      changes: { name: { from: 'Before', to: 'After' } },
    })
  })
})
