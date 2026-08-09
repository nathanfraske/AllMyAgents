import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore } from './projects.js'
import type { RemoteDeviceController } from './remoteDevices.js'
import { startServer, type ServerOptions } from './server.js'
import { TestbedRunStore } from './testbedRuns.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

describe('project replica API', () => {
  it('attaches only a target-advertised root behind operator authentication and lists its runs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-project-replica-api-'))
    const projectDir = path.join(root, 'project')
    fs.mkdirSync(projectDir)
    const db = new Database(path.join(root, 'hub.db'))
    const projects = new ProjectStore(db)
    const project = projects.create('Fleet project', projectDir)
    const testbedRuns = new TestbedRunStore(db)
    const run = testbedRuns.start({
      projectId: project.id,
      replicaId: 'future-replica',
      sessionId: 'session-a',
      agentId: 'agent-a',
      profileId: 'codex-a',
      command: 'pnpm test',
    })
    testbedRuns.finish(run.id, { ok: true, exitCode: 0 })
    const capabilities = vi.fn(async () => ({
      enabled: true,
      platform: 'linux' as const,
      arch: 'x64',
      hostname: 'laptop',
      environments: [{ id: 'host', kind: 'host' as const, label: 'host', platform: 'linux', shell: '/bin/sh' }],
      roots: [{ id: 'root-a', label: 'Checkout', path: '/srv/project', read: true, write: true, terminal: true }],
    }))
    const remoteDevices = {
      listConnections: vi.fn(() => [{ siteId: 'site-a', label: 'Laptop', paired: true, updatedAt: new Date().toISOString() }]),
      catalog: vi.fn(async () => []),
      capabilities,
    } as unknown as RemoteDeviceController
    const deviceToken = 'project-replica-test-device-token-at-least-32-characters'
    const server = startServer({
      port: 0,
      defaultCwd: root,
      profilesDir: root,
      journal: { append: vi.fn() } as never,
      sessions: { list: () => [], listProfiles: () => [] } as never,
      profiles: [],
      approvals: {} as never,
      questions: {} as never,
      usage: {} as never,
      projects,
      testbedRuns,
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
      remoteDevices,
    } satisfies ServerOptions)
    if (!server.listening) await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`
    cleanups.push(async () => {
      if (server.listening) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()))
        server.closeAllConnections()
        await closed
      }
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    })

    const denied = await fetch(`${base}/api/projects/${project.id}/replicas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: 'site-a', rootId: 'root-a' }),
    })
    expect(denied.status).toBe(401)

    const accepted = await fetch(`${base}/api/projects/${project.id}/replicas`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: 'site-a', rootId: 'root-a' }),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      projectId: project.id,
      kind: 'remote',
      siteId: 'site-a',
      siteLabel: 'Laptop',
      rootId: 'root-a',
      path: '/srv/project',
    })
    expect(capabilities).toHaveBeenCalledWith('site-a')

    const listed = await fetch(`${base}/api/projects/${project.id}/replicas`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })
    expect(await listed.json()).toEqual([
      expect.objectContaining({ kind: 'local', isPrimary: true }),
      expect.objectContaining({ kind: 'remote', siteId: 'site-a', rootId: 'root-a' }),
    ])

    const runs = await fetch(`${base}/api/projects/${project.id}/testbed-runs`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })
    expect(await runs.json()).toEqual([
      expect.objectContaining({ id: run.id, agentId: 'agent-a', state: 'succeeded' }),
    ])
  })
})
