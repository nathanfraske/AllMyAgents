import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer, type ServerOptions } from './server.js'
import { SessionManager } from './sessions.js'
import type { Profile } from './types.js'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

describe('GET /api/profiles contract', () => {
  it('includes the ownership and authentication fields the account UI branches on', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-profiles-api-'))
    const deviceToken = 'profiles-api-test-device-token-at-least-32-characters'
    const profile: Profile = {
      id: 'codex-expired',
      provider: 'codex',
      dir: path.join(root, 'profile'),
      available: false,
      unavailableReason: 'owned by another test hub',
      ownerPort: 7999,
      authStatus: 'signed_out',
      authError: 'test credential expired',
    }
    const sessionState = { profiles: new Map([[profile.id, profile]]) }
    const sessions = {
      list: () => [],
      listProfiles: SessionManager.prototype.listProfiles.bind(sessionState as never),
    }
    const server = startServer({
      port: 0,
      defaultCwd: root,
      profilesDir: root,
      journal: {} as never,
      sessions: sessions as never,
      profiles: [profile],
      approvals: {} as never,
      questions: {} as never,
      usage: {} as never,
      projects: {} as never,
      workspace: {} as never,
      instructions: {} as never,
      bus: {} as never,
      memory: {} as never,
      practices: {} as never,
      danger: { busCanUseRiskyTools: false, autoApprovePractices: false },
      prefs: { chatNamePool: 'everyone', steerMessagesAtToolBoundary: true },
      rescanProfiles: () => [profile],
      mesh: {} as never,
      deviceToken,
      requireToken: true,
      restartState: { booted: true, sockets: new Set(), draining: false, promoting: false } as never,
      executor: {} as never,
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
      fs.rmSync(root, { recursive: true, force: true })
    })

    const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{
      id: 'codex-expired',
      provider: 'codex',
      available: false,
      unavailableReason: 'owned by another test hub',
      ownerPort: 7999,
      authStatus: 'signed_out',
      authError: 'test credential expired',
    }])
  })
})
