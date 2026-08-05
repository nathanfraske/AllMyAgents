import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startServer, type ServerOptions } from './server.js'
import { SessionManager } from './sessions.js'
import type { Profile } from './types.js'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

describe('profile account API contract', () => {
  it('returns aliases and renames only the display layer while persisting and journaling it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-profiles-api-'))
    const deviceToken = 'profiles-api-test-device-token-at-least-32-characters'
    const profile: Profile = {
      id: 'codex-expired',
      displayName: 'Work Codex',
      provider: 'codex',
      dir: path.join(root, 'profile'),
      available: false,
      unavailableReason: 'owned by another test hub',
      ownerPort: 7999,
      authStatus: 'signed_out',
      authError: 'test credential expired',
    }
    const sessionState = { profiles: new Map([[profile.id, profile]]) }
    const profileNames: Record<string, string> = { [profile.id]: 'Work Codex' }
    const append = vi.fn()
    const sessions = {
      list: () => [],
      listProfiles: SessionManager.prototype.listProfiles.bind(sessionState as never),
    }
    const server = startServer({
      port: 0,
      defaultCwd: root,
      profilesDir: root,
      journal: { append } as never,
      sessions: sessions as never,
      profiles: [profile],
      profileNames,
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
      displayName: 'Work Codex',
      provider: 'codex',
      available: false,
      unavailableReason: 'owned by another test hub',
      ownerPort: 7999,
      authStatus: 'signed_out',
      authError: 'test credential expired',
    }])

    const originalDir = profile.dir
    const renamed = await fetch(
      `http://127.0.0.1:${address.port}/api/profiles/codex-expired/name`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deviceToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ displayName: 'Personal research' }),
      },
    )

    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({
      id: 'codex-expired',
      displayName: 'Personal research',
    })
    expect(profile).toMatchObject({ id: 'codex-expired', dir: originalDir, displayName: 'Personal research' })
    expect(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))).toMatchObject({
      profileNames: { 'codex-expired': 'Personal research' },
    })
    expect(append).toHaveBeenCalledWith(null, 'profiles/renamed', {
      id: 'codex-expired',
      displayName: 'Personal research',
    })
  })
})

describe('profile login API recovery contract', () => {
  it('returns bounded capturing truth and recovers/cancels the same public attempt by id or profile+key', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-profile-login-api-'))
    const deviceToken = 'profile-login-api-test-device-token-at-least-32-characters'
    const state = {
      started: false,
      status: 'capturing' as
        | 'capturing'
        | 'settling'
        | 'cancelled',
    }
    const view = () => ({
      ok: state.status !== 'cancelled',
      loginId: 'public-attempt-1',
      profileId: 'claude-a',
      provider: 'claude' as const,
      authMode: 'browser' as const,
      status: state.status,
    })
    const start = vi.fn(async () => {
      state.started = true
      return view()
    })
    const get = vi.fn(() => view())
    const getForProfile = vi.fn((profileId: string, key: string) =>
      state.started && profileId === 'claude-a' && key === 'request-1'
        ? view()
        : undefined,
    )
    const cancel = vi.fn(() => {
      state.status = 'settling'
      return view()
    })
    const sessions = { list: () => [], listProfiles: () => [] }
    const server = startServer({
      port: 0,
      defaultCwd: root,
      profilesDir: root,
      journal: {} as never,
      sessions: sessions as never,
      profiles: [],
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
      rescanProfiles: () => [],
      mesh: {} as never,
      deviceToken,
      requireToken: true,
      restartState: {
        booted: true,
        sockets: new Set(),
        draining: false,
        promoting: false,
      } as never,
      executor: {} as never,
      configPath: path.join(root, 'config.json'),
      profileLoginCoordinator: {
        start,
        get,
        getForProfile,
        cancel,
      },
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
    const base = `http://127.0.0.1:${address.port}`
    const headers = {
      authorization: `Bearer ${deviceToken}`,
      'content-type': 'application/json',
    }

    const response = await fetch(`${base}/api/accounts/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'claude',
        name: 'claude-a',
        reauth: true,
        idempotencyKey: 'request-1',
      }),
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      ok: true,
      loginId: 'public-attempt-1',
      status: 'capturing',
    })
    expect(start).toHaveBeenCalledWith({
      provider: 'claude',
      profileId: 'claude-a',
      reauth: true,
      idempotencyKey: 'request-1',
      authMode: 'browser',
    })

    const recovered = await fetch(
      `${base}/api/accounts/login/profile/claude-a?key=request-1`,
      { headers },
    )
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({
      loginId: 'public-attempt-1',
      status: 'capturing',
    })
    expect(getForProfile).toHaveBeenCalledWith('claude-a', 'request-1')

    const wrongKey = await fetch(
      `${base}/api/accounts/login/profile/claude-a?key=wrong`,
      { headers },
    )
    expect(wrongKey.status).toBe(404)

    const cancelling = await fetch(
      `${base}/api/accounts/login/public-attempt-1`,
      { method: 'DELETE', headers },
    )
    expect(cancelling.status).toBe(200)
    expect(await cancelling.json()).toMatchObject({
      ok: true,
      status: 'settling',
    })
    expect(cancel).toHaveBeenCalledWith('public-attempt-1')
  })
})
