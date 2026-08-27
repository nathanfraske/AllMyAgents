import { describe, it, expect } from 'vitest'
import { readBridgeEnv, makeHubExecutor } from './agentBridge.js'

describe('readBridgeEnv', () => {
  it('reads the hub URL / secret / profile from env and the cwd from the process', () => {
    const env = { AMA_HUB_URL: 'http://127.0.0.1:7777', AMA_HUB_SECRET: 's', AMA_PROFILE_ID: 'codex-a' }
    expect(readBridgeEnv(env, '/work/a')).toEqual({
      hubUrl: 'http://127.0.0.1:7777',
      secret: 's',
      profileId: 'codex-a',
      cwd: '/work/a',
    })
  })

  it('carries the hub-issued exact session binding when present', () => {
    const env = {
      AMA_HUB_URL: 'http://127.0.0.1:7777',
      AMA_HUB_SECRET: 's',
      AMA_PROFILE_ID: 'codex-a',
      AMA_SESSION_ID: 'manager-1',
    }
    expect(readBridgeEnv(env, '/work/shared')).toMatchObject({ sessionId: 'manager-1' })
  })
})

describe('makeHubExecutor (the bridge → hub forward)', () => {
  const cfg = { hubUrl: 'http://127.0.0.1:7777', secret: 'sekret', profileId: 'codex-a', cwd: '/work/a' }

  it('POSTs {profileId, cwd, tool, args} with the bearer secret and returns the hub text', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return { ok: true, status: 200, json: async () => ({ text: 'Delivered to 1 agent(s).' }) }
    }) as unknown as typeof fetch
    const exec = makeHubExecutor(cfg, fakeFetch)
    const out = await exec('send_message', { to_session: 'x', body: 'hi' })
    expect(out).toBe('Delivered to 1 agent(s).')
    expect(seen!.url).toBe('http://127.0.0.1:7777/internal/agent-tool')
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer sekret')
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      profileId: 'codex-a',
      cwd: '/work/a',
      tool: 'send_message',
      args: { to_session: 'x', body: 'hi' },
    })
  })

  it('surfaces a hub error body as a model-readable tool error', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) })) as unknown as typeof fetch
    const out = await makeHubExecutor(cfg, fakeFetch)('list_agents', {})
    expect(out).toBe('Tool error: forbidden')
  })

  it('forwards the exact session binding separately from tool arguments', async () => {
    let body: Record<string, unknown> = {}
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>
      return { ok: true, status: 200, json: async () => ({ text: 'ok' }) }
    }) as unknown as typeof fetch
    await makeHubExecutor({ ...cfg, sessionId: 'manager-1' }, fakeFetch)('query_team', {})
    expect(body).toMatchObject({ profileId: 'codex-a', sessionId: 'manager-1', cwd: '/work/a' })
  })

  it('never throws on a transport failure — returns an unreachable-hub message', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const out = await makeHubExecutor(cfg, fakeFetch)('list_agents', {})
    expect(out).toMatch(/could not reach the hub/)
  })

  it('refuses cleanly when unconfigured (no hub URL/secret)', async () => {
    const out = await makeHubExecutor({ hubUrl: '', secret: '', profileId: '', cwd: '/x' })('list_agents', {})
    expect(out).toMatch(/not configured/)
  })
})
