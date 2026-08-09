import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore } from './projects.js'
import type { RemoteDeviceController } from './remoteDevices.js'
import { startServer, type ServerOptions } from './server.js'
import { TestbedRunStore } from './testbedRuns.js'
import { TestbedReservationStore } from './testbedReservations.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

describe('project replica API', () => {
  it('attaches only a target-advertised root behind operator authentication and lists its runs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-project-replica-api-'))
    const projectDir = path.join(root, 'project')
    fs.mkdirSync(projectDir)
    execFileSync('git', ['-C', projectDir, 'init'])
    execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'test@example.invalid'])
    execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Test'])
    execFileSync('git', ['-C', projectDir, 'checkout', '-b', 'main'])
    execFileSync('git', ['-C', projectDir, 'remote', 'add', 'origin', 'https://github.com/acme/fleet-project.git'])
    fs.writeFileSync(path.join(projectDir, 'tracked.txt'), 'primary')
    execFileSync('git', ['-C', projectDir, 'add', 'tracked.txt'])
    execFileSync('git', ['-C', projectDir, 'commit', '-m', 'fixture'])
    const primaryHead = execFileSync('git', ['-C', projectDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const db = new Database(path.join(root, 'hub.db'))
    const projects = new ProjectStore(db)
    const project = projects.create('Fleet project', projectDir)
    const testbedRuns = new TestbedRunStore(db)
    const testbedReservations = new TestbedReservationStore(db)
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
    const execute = vi.fn(async (_siteId: string, action: { op: string; headCommit?: string; repository?: string }) => ({
      ok: true,
      git: {
        status: 'ready' as const,
        gitAvailable: true,
        isRepository: true,
        complete: true,
        clean: true,
        detached: action.op === 'git_sync',
        headCommit: action.headCommit ?? 'a'.repeat(40),
        ...(action.op === 'git_sync' ? {} : { headRef: 'main' }),
        repository: action.repository ?? 'github.com/acme/fleet-project',
        trackedChanges: 0,
        untrackedFiles: 0,
        observedAt: new Date().toISOString(),
      },
    }))
    const remoteDevices = {
      listConnections: vi.fn(() => [{ siteId: 'site-a', label: 'Laptop', paired: true, updatedAt: new Date().toISOString() }]),
      catalog: vi.fn(async () => []),
      capabilities,
      execute,
    } as unknown as RemoteDeviceController
    const deviceToken = 'project-replica-test-device-token-at-least-32-characters'
    const server = startServer({
      port: 0,
      defaultCwd: root,
      profilesDir: root,
      journal: { append: vi.fn(), atomic: <T>(fn: () => T) => fn() } as never,
      sessions: { list: () => [], listProfiles: () => [] } as never,
      profiles: [],
      approvals: {} as never,
      questions: {} as never,
      usage: {} as never,
      projects,
      testbedRuns,
      testbedReservations,
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
    if (!server.address()) await once(server, 'listening')
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
      state: 'ready',
      headCommit: 'a'.repeat(40),
      headRef: 'main',
      readiness: { status: 'ready', clean: true },
    })
    expect(capabilities).toHaveBeenCalledWith('site-a')
    expect(execute).toHaveBeenCalledWith(
      'site-a',
      { op: 'git_inspect', rootId: 'root-a' },
      expect.objectContaining({ projectId: project.id, agentId: 'operator' }),
    )

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

    const remoteReplica = projects.findRemoteReplica(project.id, 'site-a', 'root-a')!
    const reservation = testbedReservations.acquire({
      projectId: project.id,
      replicaId: remoteReplica.id,
      sessionId: 'session-a',
      agentId: 'agent-a',
    }).reservation
    const refreshed = await fetch(`${base}/api/projects/${project.id}/replicas/${remoteReplica.id}/inspect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    })
    expect(await refreshed.json()).toMatchObject({ id: remoteReplica.id, readiness: { status: 'ready' } })

    const reservations = await fetch(`${base}/api/projects/${project.id}/testbed-reservations`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })
    expect(await reservations.json()).toEqual([
      expect.objectContaining({ id: reservation.id, replicaId: remoteReplica.id, state: 'active' }),
    ])

    const removeReserved = await fetch(`${base}/api/projects/${project.id}/replicas/${remoteReplica.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${deviceToken}` },
    })
    expect(removeReserved.status).toBe(409)
    expect(await removeReserved.json()).toMatchObject({ error: expect.stringContaining('reserved by agent') })

    const prepareReserved = await fetch(`${base}/api/projects/${project.id}/replicas/${remoteReplica.id}/prepare`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    })
    expect(prepareReserved.status).toBe(409)
    expect(await prepareReserved.json()).toMatchObject({ error: expect.stringContaining('reserved by agent') })

    testbedReservations.release(reservation.id, 'test-finished')
    const prepared = await fetch(`${base}/api/projects/${project.id}/replicas/${remoteReplica.id}/prepare`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    })
    expect(prepared.status).toBe(200)
    expect(await prepared.json()).toMatchObject({
      id: remoteReplica.id,
      state: 'ready',
      headCommit: primaryHead,
      readiness: {
        status: 'ready',
        clean: true,
        detached: true,
        repository: 'github.com/acme/fleet-project',
      },
    })
    expect(execute).toHaveBeenCalledWith(
      'site-a',
      {
        op: 'git_sync',
        rootId: 'root-a',
        repository: 'github.com/acme/fleet-project',
        headRef: 'main',
        headCommit: primaryHead,
      },
      expect.objectContaining({ projectId: project.id, replicaId: remoteReplica.id, agentId: 'operator' }),
    )
    expect(testbedReservations.active(remoteReplica.id)).toBeUndefined()
  })
})
