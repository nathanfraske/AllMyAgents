import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
    remoteDeviceGrants: [{ siteId: 'site-a', rootIds: ['root-a'], capabilities: ['terminal'] }],
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
  sessions.setTestbedRunStore(runs)
  const previousIsolated = process.env.HUB_ISOLATED_PROFILES
  process.env.HUB_ISOLATED_PROFILES = '1'
  sessions.boot()
  if (previousIsolated === undefined) delete process.env.HUB_ISOLATED_PROFILES
  else process.env.HUB_ISOLATED_PROFILES = previousIsolated
  cleanups.push(() => {
    journal.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { journal, project, projects, replica, runs, sessions }
}

describe('remote testbed attribution', () => {
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
    expect(hub.journal.eventsForSession('agent-a').events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['testbed-run/started', 'testbed-run/completed']),
    )
  })
})
