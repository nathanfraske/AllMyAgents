import fs from 'node:fs'
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
    executor
  )
  sessions.execAgentTool = async () => 'bridge-ok'
  const record = await sessions.create(profile.id, { cwd: root, useWorktree: false })
  const deviceToken = 'test-device-token-at-least-thirty-two-characters'
  const server = startServer({
    port: 0,
    defaultCwd: root,
    profilesDir: root,
    journal,
    sessions,
    profiles: [profile],
    approvals,
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
    restartState: { booted: true, sockets: new Set(), draining: false, promoting: false } as never,
    executor,
    workspace,
    configPath: path.join(root, 'config.json'),
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
  }
}

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}

describe('device-authenticated control plane', () => {
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

  it('accepts an authenticated WebSocket bearer header for the trusted dev proxy', async () => {
    const { base, deviceToken } = await build()
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?since=0`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })
    await once(socket, 'open')
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
    await once(socket, 'close')
  })

  it('sends a replay boundary after the backlog and before subsequently journaled events', async () => {
    const { base, deviceToken, journal, record } = await build()
    journal.append(record.id, 'test/replayed', { value: 'history' })
    const messages: Array<Record<string, unknown>> = []
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?since=0`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })
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
})
