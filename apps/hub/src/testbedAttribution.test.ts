import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalService } from './approvals.js'
import { AgentBus } from './bus.js'
import type { Executor } from './executor.js'
import { InstructionStore } from './instructions.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { ProjectStore } from './projects.js'
import { QuestionService } from './questions.js'
import type { RemoteDeviceAction, RemoteDeviceActionResult, RemoteDeviceController } from './remoteDevices.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import { TestbedRunStore } from './testbedRuns.js'
import { TestbedReservationStore } from './testbedReservations.js'
import type { Profile, SessionRecord } from './types.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

function build() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ama-testbed-attribution-')))
  const projectDir = path.join(root, 'project')
  const profileDir = path.join(root, 'profile')
  fs.mkdirSync(projectDir)
  fs.mkdirSync(profileDir)
  execFileSync('git', ['-C', projectDir, 'init'])
  execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'test@example.invalid'])
  execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Test'])
  execFileSync('git', ['-C', projectDir, 'checkout', '-b', 'main'])
  execFileSync('git', ['-C', projectDir, 'remote', 'add', 'origin', 'https://github.com/acme/testbed-project.git'])
  fs.writeFileSync(path.join(projectDir, 'tracked.txt'), 'primary')
  execFileSync('git', ['-C', projectDir, 'add', 'tracked.txt'])
  execFileSync('git', ['-C', projectDir, 'commit', '-m', 'fixture'])
  const journal = new Journal(path.join(root, 'hub.db'))
  const projects = new ProjectStore(journal.db, journal)
  const project = projects.create('Testbed project', projectDir)
  const replica = projects.addRemoteReplica({
    projectId: project.id,
    siteId: 'site-a',
    siteLabel: 'Device A',
    rootId: 'root-a',
    path: '/srv/project',
  })
  const profile: Profile = { id: 'codex-a', provider: 'codex', dir: profileDir }
  const record: SessionRecord = {
    id: 'agent-a',
    profileId: profile.id,
    provider: profile.provider,
    projectId: project.id,
    cwd: projectDir,
    baseCommit: 'abc123',
    status: 'idle',
    permissionMode: 'full',
    remoteDeviceGrants: [{ siteId: 'site-a', rootIds: ['root-a'], capabilities: ['write', 'terminal'] }],
    createdAt: new Date().toISOString(),
  }
  const sessionStore = new SessionStore(journal.db)
  sessionStore.upsert(record)
  const executor: Executor = {
    startThread: async () => 'unused',
    runTurn: async () => {},
    steer: async () => {},
    interrupt: async () => {},
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => [],
    attach: async () => {},
    isBusy: () => false,
  }
  const sessions = new SessionManager(
    journal,
    sessionStore,
    new Map([[profile.id, profile]]),
    new ApprovalService(journal),
    new UsageMonitor(journal, [profile], {}),
    new WorkspaceManager(path.join(root, 'worktrees')),
    projects,
    new InstructionStore(journal.db),
    new AgentBus(journal.db),
    new MemoryStore(journal.db),
    new PracticeStore(journal.db),
    { busCanUseRiskyTools: false, autoApprovePractices: false },
    false,
    root,
    new QuestionService(journal),
    executor,
  )
  const runs = new TestbedRunStore(journal.db)
  const reservations = new TestbedReservationStore(journal.db)
  sessions.setTestbedRunStore(runs)
  sessions.setTestbedReservationStore(reservations)
  const previousIsolated = process.env.HUB_ISOLATED_PROFILES
  process.env.HUB_ISOLATED_PROFILES = '1'
  sessions.boot()
  if (previousIsolated === undefined) delete process.env.HUB_ISOLATED_PROFILES
  else process.env.HUB_ISOLATED_PROFILES = previousIsolated
  cleanups.push(() => {
    journal.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { journal, project, projects, replica, reservations, runs, sessions }
}

describe('remote testbed attribution', () => {
  it('lets a granted project agent prepare an attached location without choosing Git inputs', async () => {
    const hub = build()
    const primaryHead = execFileSync('git', ['-C', hub.projects.get(hub.project.id)!.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const execute = vi.fn(async (
      siteId: string,
      action: RemoteDeviceAction,
      actor: Record<string, unknown>,
    ): Promise<RemoteDeviceActionResult> => {
      expect(siteId).toBe('site-a')
      expect(action).toEqual({
        op: 'git_sync',
        rootId: 'root-a',
        repository: 'github.com/acme/testbed-project',
        headRef: 'main',
        headCommit: primaryHead,
      })
      expect(actor).toMatchObject({
        sessionId: 'agent-a', projectId: hub.project.id, replicaId: hub.replica.id, agentId: 'agent-a',
      })
      return {
        ok: true,
        git: {
          status: 'ready', gitAvailable: true, isRepository: true, complete: true, clean: true,
          detached: true, headCommit: primaryHead, repository: 'github.com/acme/testbed-project',
          observedAt: new Date().toISOString(),
        },
      }
    })
    hub.sessions.setRemoteDeviceController({
      capabilities: async () => ({
        enabled: true,
        platform: 'linux',
        arch: 'x64',
        hostname: 'device-a',
        environments: [],
        roots: [{ id: 'root-a', label: 'Project checkout', path: '/srv/project', read: true, write: true, terminal: true }],
      }),
      execute,
    } as unknown as RemoteDeviceController)
    const privateApi = hub.sessions as unknown as {
      remotePrepareProjectLocation(sessionId: string, siteId: string, rootId: string): Promise<RemoteDeviceActionResult>
    }

    const prepared = await privateApi.remotePrepareProjectLocation('agent-a', 'site-a', 'root-a')
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true)
    expect(prepared).toMatchObject({
      ok: true,
      git: { headCommit: primaryHead, detached: true },
    })
    expect(hub.reservations.active(hub.replica.id)).toBeUndefined()
    expect(hub.reservations.listProject(hub.project.id)).toEqual([
      expect.objectContaining({ agentId: 'agent-a', state: 'released', reason: 'project-prepare-finished' }),
    ])
    expect(hub.journal.eventsForSession('agent-a').events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'project/replica-prepare-started',
        'project/replica-prepare-completed',
        'testbed-reservation/released',
      ]),
    )
  })

  it('refuses preparation without an exact terminal grant before reserving or contacting the device', async () => {
    const hub = build()
    const record = hub.sessions.list().find((candidate) => candidate.id === 'agent-a')!
    record.remoteDeviceGrants = [{ siteId: 'site-a', rootIds: ['root-a'], capabilities: ['write'] }]
    const execute = vi.fn()
    hub.sessions.setRemoteDeviceController({ execute } as unknown as RemoteDeviceController)
    const privateApi = hub.sessions as unknown as {
      remotePrepareProjectLocation(sessionId: string, siteId: string, rootId: string): Promise<RemoteDeviceActionResult>
    }

    await expect(privateApi.remotePrepareProjectLocation('agent-a', 'site-a', 'root-a')).resolves.toMatchObject({
      ok: false,
      failure: { stage: 'admission', code: 'GRANT_REQUIRED' },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(hub.reservations.listProject(hub.project.id)).toEqual([])
  })

  it('attaches a granted matching checkout on first preparation without a second operator mutation', async () => {
    const hub = build()
    expect(hub.projects.removeReplica(hub.project.id, hub.replica.id)).toBe(true)
    const primaryHead = execFileSync('git', ['-C', hub.projects.get(hub.project.id)!.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const targetGit = {
      status: 'ready' as const,
      gitAvailable: true,
      isRepository: true,
      complete: true,
      clean: true,
      detached: false,
      headCommit: primaryHead,
      headRef: 'main',
      repository: 'github.com/acme/testbed-project',
      observedAt: new Date().toISOString(),
    }
    const execute = vi.fn(async (_siteId: string, action: RemoteDeviceAction): Promise<RemoteDeviceActionResult> => {
      if (action.op === 'git_inspect') return { ok: true, git: targetGit }
      expect(action).toMatchObject({ op: 'git_sync', rootId: 'root-a', headCommit: primaryHead })
      return { ok: true, git: { ...targetGit, detached: true } }
    })
    hub.sessions.setRemoteDeviceController({
      capabilities: async () => ({
        enabled: true,
        platform: 'linux',
        arch: 'x64',
        hostname: 'device-a',
        environments: [],
        roots: [{ id: 'root-a', label: 'Project checkout', path: '/srv/project', read: true, write: true, terminal: true }],
      }),
      listConnections: () => [{ siteId: 'site-a', label: 'Device A', token: 'redacted', pairedAt: new Date().toISOString() }],
      execute,
    } as unknown as RemoteDeviceController)
    const privateApi = hub.sessions as unknown as {
      remotePrepareProjectLocation(sessionId: string, siteId: string, rootId: string): Promise<RemoteDeviceActionResult>
    }

    const prepared = await privateApi.remotePrepareProjectLocation('agent-a', 'site-a', 'root-a')
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true)
    expect(prepared).toMatchObject({
      ok: true,
      git: { headCommit: primaryHead },
    })
    expect(execute.mock.calls.map((call) => call[1].op)).toEqual(['git_inspect', 'git_sync'])
    expect(hub.projects.findRemoteReplica(hub.project.id, 'site-a', 'root-a')).toMatchObject({ path: '/srv/project' })
    expect(hub.journal.eventsForSession('agent-a').events.map((event) => event.kind)).toContain(
      'project/replica-attached-from-grant',
    )
  })

  it('creates an app-owned project checkout beneath a granted generic machine root', async () => {
    const hub = build()
    expect(hub.projects.removeReplica(hub.project.id, hub.replica.id)).toBe(true)
    const primaryHead = execFileSync('git', ['-C', hub.projects.get(hub.project.id)!.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const checkoutPath = `.allmyagents/projects/Testbed-project-${hub.project.id.slice(0, 8)}`
    const execute = vi.fn(async (_siteId: string, action: RemoteDeviceAction): Promise<RemoteDeviceActionResult> => {
      if (action.op === 'git_inspect') {
        return {
          ok: true,
          git: {
            status: 'not-repository', gitAvailable: true, isRepository: false, complete: true,
            observedAt: new Date().toISOString(),
          },
        }
      }
      expect(action).toMatchObject({
        op: 'git_sync', rootId: 'root-a', checkoutPath, createIfMissing: true,
        repository: 'github.com/acme/testbed-project', headRef: 'main', headCommit: primaryHead,
      })
      return {
        ok: true,
        git: {
          status: 'ready', gitAvailable: true, isRepository: true, complete: true, clean: true,
          detached: true, headCommit: primaryHead, repository: 'github.com/acme/testbed-project',
          observedAt: new Date().toISOString(),
        },
      }
    })
    hub.sessions.setRemoteDeviceController({
      capabilities: async () => ({
        enabled: true,
        platform: 'win32',
        arch: 'x64',
        hostname: 'laptop',
        environments: [],
        roots: [{
          id: 'root-a', label: 'home (Ubuntu-24.04)', path: '/home',
          environment: { kind: 'wsl', distro: 'Ubuntu-24.04' }, read: true, write: true, terminal: true,
        }],
      }),
      listConnections: () => [{ siteId: 'site-a', label: 'Laptop', token: 'redacted', pairedAt: new Date().toISOString() }],
      execute,
    } as unknown as RemoteDeviceController)
    const privateApi = hub.sessions as unknown as {
      remotePrepareProjectLocation(sessionId: string, siteId: string, rootId: string): Promise<RemoteDeviceActionResult>
    }

    const prepared = await privateApi.remotePrepareProjectLocation('agent-a', 'site-a', 'root-a')
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true)
    expect(prepared).toMatchObject({
      ok: true,
      git: { headCommit: primaryHead },
      projectLocation: {
        rootId: 'root-a',
        path: `/home/${checkoutPath}`,
        cwd: checkoutPath,
      },
    })
    expect(hub.projects.findRemoteReplica(hub.project.id, 'site-a', 'root-a')).toMatchObject({
      path: `/home/${checkoutPath}`,
    })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('creates and completes one durable run only for an explicitly attached project root', async () => {
    const hub = build()
    expect(hub.sessions.list().find((record) => record.id === 'agent-a')?.projectReplicaId).toBe(
      hub.projects.primaryReplica(hub.project.id)?.id,
    )
    const execute = vi.fn(async (
      _siteId: string,
      _action: RemoteDeviceAction,
      actor: Record<string, unknown>,
    ): Promise<RemoteDeviceActionResult> => {
      expect(actor).toMatchObject({
        sessionId: 'agent-a',
        profileId: 'codex-a',
        projectId: hub.project.id,
        replicaId: hub.replica.id,
        agentId: 'agent-a',
        baseCommit: 'abc123',
        runId: expect.any(String),
      })
      return { ok: true, exitCode: 0, telemetry: { roundTripMs: 42 } }
    })
    hub.sessions.setRemoteDeviceController({ execute } as unknown as RemoteDeviceController)
    const privateApi = hub.sessions as unknown as {
      remoteDeviceExecute(sessionId: string, siteId: string, action: RemoteDeviceAction): Promise<RemoteDeviceActionResult>
    }

    const result = await privateApi.remoteDeviceExecute('agent-a', 'site-a', {
      op: 'exec',
      rootId: 'root-a',
      command: 'pnpm test',
    })

    expect(result).toMatchObject({ ok: true, exitCode: 0, runId: expect.any(String) })
    expect(hub.runs.listProject(hub.project.id)).toEqual([
      expect.objectContaining({
        id: result.runId,
        projectId: hub.project.id,
        replicaId: hub.replica.id,
        agentId: 'agent-a',
        state: 'succeeded',
        exitCode: 0,
      }),
    ])
    expect(hub.reservations.listProject(hub.project.id)).toEqual([])
    expect(hub.journal.eventsForSession('agent-a').events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'testbed-run/started',
        'testbed-run/completed',
      ]),
    )
  })

  it('lets an exactly granted teammate turn run concurrent commands and mutations on one location', async () => {
    const hub = build()
    let finishFirst!: (value: RemoteDeviceActionResult) => void
    let call = 0
    const execute = vi.fn(() => {
      call += 1
      if (call === 1) return new Promise<RemoteDeviceActionResult>((resolve) => { finishFirst = resolve })
      return Promise.resolve<RemoteDeviceActionResult>({ ok: true, exitCode: 0 })
    })
    hub.sessions.setRemoteDeviceController({
      capabilities: async () => ({
        enabled: true,
        platform: 'linux',
        arch: 'x64',
        hostname: 'device-a',
        environments: [],
        roots: [{ id: 'root-a', label: 'Project checkout', path: '/srv/project', read: true, write: true, terminal: true }],
      }),
      execute,
    } as unknown as RemoteDeviceController)
    const privateApi = hub.sessions as unknown as {
      busTurnSessions: Set<string>
      remoteDeviceExecute(sessionId: string, siteId: string, action: RemoteDeviceAction): Promise<RemoteDeviceActionResult>
    }
    privateApi.busTurnSessions.add('agent-a')
    const action: RemoteDeviceAction = { op: 'exec', rootId: 'root-a', command: 'pnpm test' }

    const first = privateApi.remoteDeviceExecute('agent-a', 'site-a', action)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    const second = await privateApi.remoteDeviceExecute('agent-a', 'site-a', action)
    expect(second).toMatchObject({ ok: true, exitCode: 0, runId: expect.any(String) })
    const mutation = await privateApi.remoteDeviceExecute('agent-a', 'site-a', {
      op: 'write', rootId: 'root-a', path: 'raced.txt', content: 'unsafe',
    })
    expect(mutation).toMatchObject({ ok: true })
    expect(execute).toHaveBeenCalledTimes(3)
    expect(hub.reservations.listProject(hub.project.id)).toEqual([])

    finishFirst({ ok: true, exitCode: 0 })
    await expect(first).resolves.toMatchObject({ ok: true })
  })
})
