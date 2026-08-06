import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { ApprovalService } from './approvals.js'
import { AgentBus } from './bus.js'
import type { Executor } from './executor.js'
import { InstructionStore } from './instructions.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { ProjectStore } from './projects.js'
import { startServer, type ServerOptions } from './server.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import type { RestartState } from './restartController.js'
import { RestartController } from './restartController.js'
import { QuestionService } from './questions.js'
import { waitForPortRelease } from './restartRollback.js'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

async function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-server-security-'))
  const journal = new Journal(path.join(root, 'hub.db'))
  const projects = new ProjectStore(journal.db)
  const instructions = new InstructionStore(journal.db)
  const bus = new AgentBus(journal.db)
  const memory = new MemoryStore(journal.db)
  const practices = new PracticeStore(journal.db)
  const approvals = new ApprovalService(journal)
  const usage = new UsageMonitor(journal, [], {})
  // Shared between the SessionManager and startServer deliberately: they must agree on where worktrees
  // live, and passing two different managers would let the server answer about checkouts the sessions
  // never made.
  const workspace = new WorkspaceManager(path.join(root, 'worktrees'))
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
  const profile = { id: 'claude-test', provider: 'claude' as const, dir: path.join(root, 'profile') }
  const danger = {
    busCanUseRiskyTools: false,
    autoApprovePractices: false,
    fullAccessAnyOrigin: false,
  }
  const sessions = new SessionManager(
    journal,
    new SessionStore(journal.db),
    new Map([[profile.id, profile]]),
    approvals,
    usage,
    workspace,
    projects,
    instructions,
    bus,
    memory,
    practices,
    danger,
    false,
    root,
    new QuestionService(journal),
    executor
  )
  sessions.execAgentTool = async () => 'bridge-ok'
  const record = await sessions.create(profile.id, { cwd: root, useWorktree: false })
  sessions.questionService.activatePublicOwner()
  const deviceToken = 'test-device-token-at-least-thirty-two-characters'
  const restartState: RestartState = {
    booted: true,
    sockets: new Set(),
    draining: false,
    promoting: false,
    rollbackRebinding: false,
    journalBackup: { status: 'active' },
    journalBackupRequired: true,
  }
  const configPath = path.join(root, 'config.json')
  const overseer: { profileId?: string; sessionId?: string; updatedAt?: string } = {}
  const server = startServer({
    port: 0,
    defaultCwd: root,
    profilesDir: root,
    journal,
    sessions,
    profiles: [profile],
    approvals,
    questions: sessions.questionService,
    usage,
    projects,
    instructions,
    bus,
    memory,
    practices,
    danger,
    prefs: { chatNamePool: 'everyone', steerMessagesAtToolBoundary: true },
    rescanProfiles: () => [profile],
    mesh: {
      status: () => ({
        enabled: false,
        nodePresent: false,
        exposed: false,
        port: 0,
        label: 'test',
        siteId: 'tcp:0',
        socketPath: '',
        peerUrl: '',
      }),
    } as never,
    deviceToken,
    // The old control plane failed open in precisely this configuration.
    requireToken: false,
    agentToolSecret: 'test-agent-bridge-secret-at-least-32-characters',
    restartState,
    executor,
    workspace,
    configPath,
    overseer,
    overseerCwd: root,
  } satisfies ServerOptions)
  if (!server.listening) await once(server, 'listening')
  const address = server.address() as { port: number }
  cleanups.push(async () => {
    if (server.listening) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
    journal.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    base: `http://127.0.0.1:${address.port}`,
    deviceToken,
    danger,
    journal,
    record,
    restartState,
    server,
    sessions,
    executor,
    configPath,
    overseer,
    projects,
    root,
    publicPort: address.port,
  }
}

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}

describe('device-authenticated control plane', () => {
  it('persists GitHub automation only through authenticated project/session policy routes', async () => {
    const { base, deviceToken, projects, record, root, sessions, journal } = await build()
    const project = projects.create('Policy project', root)
    const url = `${base}/api/projects/${project.id}/github-automation`
    const body = JSON.stringify({ capabilities: ['pull_requests', 'workflow_runs'] })

    const unauthenticated = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(unauthenticated.status).toBe(401)
    expect(sessions.githubAutomationPolicy('project', project.id).capabilities).toEqual([])

    const configured = await fetch(url, {
      method: 'POST',
      headers: { ...auth(deviceToken), 'content-type': 'application/json' },
      body,
    })
    expect(configured.status).toBe(200)
    expect(await configured.json()).toMatchObject({
      scope: 'project', targetId: project.id, capabilities: ['pull_requests', 'workflow_runs'],
    })

    const sessionConfigured = await fetch(`${base}/api/sessions/${record.id}/github-automation`, {
      method: 'POST',
      headers: { ...auth(deviceToken), 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: ['pull_request_merges'] }),
    })
    expect(sessionConfigured.status).toBe(200)
    expect(await sessionConfigured.json()).toMatchObject({
      scope: 'session', targetId: record.id, capabilities: ['pull_request_merges'],
    })
    expect(journal.recentEventsForSession(record.id, 20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'github-automation/policy-configured',
        payload: expect.objectContaining({ actor: 'operator' }),
      }),
    ]))
  })

  it('allows the packaged UI to preflight authenticated project deletion', async () => {
    const { base } = await build()

    const response = await fetch(`${base}/api/projects/project-to-delete`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://tauri.localhost',
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'authorization, content-type',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost')
    expect(response.headers.get('access-control-allow-methods')?.split(/,\s*/)).toContain('DELETE')
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  it('makes journal-backup activation failure visible on the public health probe', async () => {
    const { base, restartState } = await build()
    restartState.journalBackup = {
      status: 'degraded',
      error: 'journal backup lease is unavailable',
    }

    const response = await fetch(`${base}/api/health`)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      boot: 'degraded',
      journalBackup: {
        status: 'degraded',
        error: 'journal backup lease is unavailable',
      },
    })
  })

  it('reports a public hub with required but inactive backup ownership as degraded', async () => {
    const { base, restartState } = await build()
    restartState.journalBackupRequired = true
    restartState.journalBackup = { status: 'inactive' }

    const response = await fetch(`${base}/api/health`)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      boot: 'degraded',
      journalBackup: {
        status: 'degraded',
        error: expect.stringMatching(/required.*inactive/i),
      },
    })
  })

  it('lets the rollback controller own EADDRINUSE and report failure without the global handler exiting', async () => {
    const {
      server,
      sessions,
      journal,
      restartState,
      executor,
      publicPort,
    } = await build()
    const sent: unknown[] = []
    const controller = new RestartController({
      server,
      sessions,
      journal,
      questions: sessions.questionService,
      state: restartState,
      publicPort,
      send: (message) => sent.push(message),
      onPromoted: () => {},
      stopJournalBackups: async () => {},
      profileRuntime: {
        prepareRestart: async () => ({ settled: 0, outcomeUnknown: 0 }),
        deactivatePublicGeneration: () => {},
        activatePublicGeneration: () => {},
        resumeLoginAdmission: () => {},
      },
      executor,
    })
    restartState.journalBackup = { status: 'inactive' }
    await controller.drain()
    await waitForPortRelease(publicPort, 2_000)

    const reservation = http.createServer()
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(publicPort, '127.0.0.1', () => {
        reservation.off('error', reject)
        resolve()
      })
    })
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          if (!reservation.listening) {
            resolve()
            return
          }
          reservation.close(() => resolve())
        })
    )
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit)

    await controller.abort('forced rollback collision')

    expect(exit).not.toHaveBeenCalled()
    expect(sent).toContainEqual({
      type: 'rollback-failed',
      error: expect.stringMatching(/EADDRINUSE|address already in use/i),
    })
    expect(restartState.rollbackRebinding).toBe(false)
    exit.mockRestore()
  })

  it('rejects unauthenticated journal reads and mutations even when legacy requireToken is false', async () => {
    const { base, danger, record } = await build()

    const events = await fetch(`${base}/api/events`)
    expect(events.status).toBe(401)

    const mode = await fetch(`${base}/api/sessions/${record.id}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'full' }),
    })
    expect(mode.status).toBe(401)

    const dangerWrite = await fetch(`${base}/api/config/danger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullAccessAnyOrigin: true }),
    })
    expect(dangerWrite.status).toBe(401)
    expect(danger.fullAccessAnyOrigin).toBe(false)
  })

  it('keeps authenticated operator reads and mutations working', async () => {
    const { base, deviceToken, record } = await build()
    const headers = { ...auth(deviceToken), 'content-type': 'application/json' }

    const mode = await fetch(`${base}/api/sessions/${record.id}/mode`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ permissionMode: 'edits' }),
    })
    expect(mode.status).toBe(200)

    const events = await fetch(`${base}/api/events`, { headers: auth(deviceToken) })
    expect(events.status).toBe(200)
  })

  it('mints the Overseer only through its authenticated configuration route', async () => {
    const { base, deviceToken, sessions, configPath, root } = await build()
    const headers = { ...auth(deviceToken), 'content-type': 'application/json' }

    const ordinaryResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profileId: 'claude-test',
        cwd: root,
        useWorktree: false,
        permissionMode: 'full',
        isOverseer: true,
      }),
    })
    expect(ordinaryResponse.status).toBe(200)
    expect(await ordinaryResponse.json()).not.toHaveProperty('isOverseer')

    const response = await fetch(`${base}/api/overseer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ profileId: 'claude-test' }),
    })
    expect(response.status).toBe(200)
    const configured = await response.json() as { sessionId: string }
    expect(sessions.list().find((record) => record.id === configured.sessionId)).toMatchObject({
      isOverseer: true,
      role: 'Application Overseer',
      permissionMode: 'full',
      permissionModeOperatorOverride: true,
    })
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
      overseer: { profileId: 'claude-test', sessionId: configured.sessionId },
    })

    const repeat = await fetch(`${base}/api/overseer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ profileId: 'claude-test' }),
    })
    expect(repeat.status).toBe(200)
    await expect(repeat.json()).resolves.toMatchObject({ sessionId: configured.sessionId })
  })

  it('accepts an authenticated WebSocket bearer header for the trusted dev proxy', async () => {
    const { base, deviceToken } = await build()
    const response = await fetch(`${base}/api/replay-baseline`, { headers: auth(deviceToken) })
    expect(response.status).toBe(200)
    const baseline = (await response.json()) as { highWaterSeq: number; generation: number }
    const socket = new WebSocket(
      `${base.replace('http:', 'ws:')}/ws?since=${baseline.highWaterSeq}&generation=${baseline.generation}`,
      {
      headers: { authorization: `Bearer ${deviceToken}` },
      }
    )
    await once(socket, 'open')
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
    await once(socket, 'close')
  })

  it('sends a replay boundary after the backlog and before subsequently journaled events', async () => {
    const { base, deviceToken, journal, record } = await build()
    const baselineResponse = await fetch(`${base}/api/replay-baseline`, {
      headers: auth(deviceToken),
    })
    expect(baselineResponse.status).toBe(200)
    const baseline = (await baselineResponse.json()) as {
      generation: number
      highWaterSeq: number
      resetFloorSeq: number
      sessions: unknown[]
      journalCompaction: unknown
    }
    expect(baseline.sessions.length).toBeGreaterThan(0)
    expect(baseline.resetFloorSeq).toBe(0)
    journal.append(record.id, 'test/replayed', { value: 'history' })
    const messages: Array<Record<string, unknown>> = []
    const socket = new WebSocket(
      `${base.replace('http:', 'ws:')}/ws?since=${baseline.highWaterSeq}&generation=${baseline.generation}`,
      {
        headers: { authorization: `Bearer ${deviceToken}` },
      }
    )
    try {
      socket.on('message', (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>))
      await once(socket, 'open')

      await vi.waitFor(() => {
        expect(messages.some((message) => message.type === 'replay-complete')).toBe(true)
      })
      journal.append(record.id, 'test/live', { value: 'now' })
      await vi.waitFor(() => {
        expect(messages.some((message) => message.kind === 'test/live')).toBe(true)
      })

      const replayIndex = messages.findIndex((message) => message.kind === 'test/replayed')
      const startIndex = messages.findIndex((message) => message.type === 'replay-start')
      const boundaryIndex = messages.findIndex((message) => message.type === 'replay-complete')
      const liveIndex = messages.findIndex((message) => message.kind === 'test/live')
      expect(startIndex).toBeGreaterThanOrEqual(0)
      expect(replayIndex).toBeGreaterThan(startIndex)
      expect(replayIndex).toBeGreaterThanOrEqual(0)
      expect(boundaryIndex).toBeGreaterThan(replayIndex)
      expect(liveIndex).toBeGreaterThan(boundaryIndex)
      expect(messages[boundaryIndex]?.lastSeq).toBe(messages[replayIndex]?.seq)
    } finally {
      socket.terminate()
    }
  })

  it('keeps the independently authenticated agent bridge working without the device token', async () => {
    const { base } = await build()
    const response = await fetch(`${base}/internal/agent-tool`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-agent-bridge-secret-at-least-32-characters',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        profileId: 'claude-test',
        cwd: 'C:/bounded-worker',
        tool: 'list_agents',
        args: {},
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: 'bridge-ok' })
  })

  it('never discloses the token from mesh status and reveals it only on an authenticated POST', async () => {
    const { base, deviceToken } = await build()

    const statusResponse = await fetch(`${base}/api/mesh`, { headers: auth(deviceToken) })
    expect(statusResponse.status).toBe(200)
    expect(await statusResponse.json()).not.toHaveProperty('token')

    const unauthReveal = await fetch(`${base}/api/device-token/reveal`, { method: 'POST' })
    expect(unauthReveal.status).toBe(401)

    const reveal = await fetch(`${base}/api/device-token/reveal`, {
      method: 'POST',
      headers: auth(deviceToken),
    })
    expect(reveal.status).toBe(200)
    expect(await reveal.json()).toEqual({ token: deviceToken })
  })

  it('exchanges an authenticated, short-lived pairing code for the device token exactly once', async () => {
    const { base, deviceToken } = await build()

    const unauthenticatedIssue = await fetch(`${base}/api/pairing-code`, { method: 'POST' })
    expect(unauthenticatedIssue.status).toBe(401)

    const issue = await fetch(`${base}/api/pairing-code`, {
      method: 'POST',
      headers: auth(deviceToken),
    })
    expect(issue.status).toBe(200)
    const issued = (await issue.json()) as { code: string; expiresAt: string }
    expect(issued.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u)
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now())

    const exchange = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code.toLowerCase() }),
    })
    expect(exchange.status).toBe(200)
    expect(await exchange.json()).toEqual({ token: deviceToken })

    const replay = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code }),
    })
    expect(replay.status).toBe(401)
    await expect(replay.json()).resolves.not.toHaveProperty('token')
  })

  it('authenticates recovery notices and validates idempotent exact-id dismissal', async () => {
    const { base, deviceToken, journal } = await build()
    const unauthenticated = await fetch(`${base}/api/recovery-notices`)
    expect(unauthenticated.status).toBe(401)

    const empty = await fetch(`${base}/api/recovery-notices`, {
      headers: auth(deviceToken),
    })
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual([])

    const planId = '11111111-1111-4111-8111-111111111111'
    journal.db
      .prepare(
        `INSERT INTO journal_recovery_notices (
           plan_id, generation, snapshot_max_seq, snapshot_event_high_water,
           quarantine_dir, recorded_at, dismissed_at
         ) VALUES (?, '7', '420', '425', ?, '2026-07-29T00:00:00.000Z', NULL)`
      )
      .run(planId, `C:\\evidence\\${planId}`)

    const listed = await fetch(`${base}/api/recovery-notices`, {
      headers: auth(deviceToken),
    })
    expect(await listed.json()).toEqual([
      {
        planId,
        generation: '7',
        snapshotMaxSeq: '420',
        snapshotEventHighWater: '425',
        quarantineDir: `C:\\evidence\\${planId}`,
        recordedAt: '2026-07-29T00:00:00.000Z',
      },
    ])

    for (const suffix of ['%zz', 'x'.repeat(129), 'abc', '%2F', '%00', '%E2%98%83']) {
      const malformed = await fetch(`${base}/api/recovery-notices/${suffix}/dismiss`, {
        method: 'POST',
        headers: auth(deviceToken),
      })
      expect(malformed.status).toBe(400)
    }
    const missing = await fetch(
      `${base}/api/recovery-notices/22222222-2222-4222-8222-222222222222/dismiss`,
      { method: 'POST', headers: auth(deviceToken) }
    )
    expect(missing.status).toBe(404)

    for (let attempt = 0; attempt < 2; attempt++) {
      const dismissed = await fetch(`${base}/api/recovery-notices/${planId}/dismiss`, {
        method: 'POST',
        headers: auth(deviceToken),
      })
      expect(dismissed.status).toBe(200)
    }
    const after = await fetch(`${base}/api/recovery-notices`, {
      headers: auth(deviceToken),
    })
    expect(await after.json()).toEqual([])
  })
})
