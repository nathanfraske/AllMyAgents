// @vitest-environment node
//
// api.ts computes HUB_HTTP / HUB_WS *once at module load* from an `inTauri` probe of the
// global `window` (`__TAURI_INTERNALS__` / `__TAURI__`). To exercise both branches we stub
// `window` first, then re-import the module fresh (vi.resetModules) so the top-level code
// re-runs against the stub. Node environment: `window` is undefined unless we stub it, which
// is exactly the packaged-vs-browser distinction the code keys off.
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function loadApi(): Promise<typeof import('./api')> {
  vi.resetModules()
  return import('./api')
}

describe('HUB base URL derivation (inTauri)', () => {
  it('browser (no tauri globals present) -> empty base, so Vite proxies /api and /ws', async () => {
    vi.stubGlobal('window', {}) // a window with no Tauri internals = the dev browser
    const { HUB_HTTP, HUB_WS } = await loadApi()
    expect(HUB_HTTP).toBe('')
    expect(HUB_WS).toBe('')
  })

  it('no window at all (SSR-like) -> empty base', async () => {
    // window intentionally left undefined
    const { HUB_HTTP, HUB_WS } = await loadApi()
    expect(HUB_HTTP).toBe('')
    expect(HUB_WS).toBe('')
  })

  it('desktop via __TAURI_INTERNALS__ -> loopback hub on 127.0.0.1:7777', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const { HUB_HTTP, HUB_WS } = await loadApi()
    expect(HUB_HTTP).toBe('http://127.0.0.1:7777')
    expect(HUB_WS).toBe('ws://127.0.0.1:7777')
  })

  it('desktop via legacy __TAURI__ -> loopback hub on 127.0.0.1:7777', async () => {
    vi.stubGlobal('window', { __TAURI__: {} })
    const { HUB_HTTP, HUB_WS } = await loadApi()
    expect(HUB_HTTP).toBe('http://127.0.0.1:7777')
    expect(HUB_WS).toBe('ws://127.0.0.1:7777')
  })

  it('desktop obtains the device token through native IPC before authenticated HTTP', async () => {
    const token = 'desktop-native-device-token-at-least-32-characters'
    const invoke = vi.fn(async () => token)
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => '', setItem })
    vi.stubGlobal('window', { __TAURI__: { core: { invoke } } })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ requireToken: true, authed: true }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { api, bootstrapDesktopHubToken, getHubToken } = await loadApi()
    await expect(bootstrapDesktopHubToken()).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('hub_device_token')
    expect(getHubToken()).toBe(token)
    expect(setItem).toHaveBeenCalledWith('hub.token', token)

    await api.auth()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7777/api/auth',
      expect.objectContaining({
        headers: { authorization: `Bearer ${token}` },
      }),
    )
  })
})

// The transport contract: a response that is not usable data must never be handed back AS data. GET
// throws so the store's existing per-call `.catch()` guards fire (a token-gated peer's 401 used to be
// iterated as an array); POST returns `{error}` in the shape its callers already render (a 404 on an
// approval used to be parsed as an accepted write).
describe('transport (res.ok respected; errors are not data)', () => {
  // A fetch stub carrying BOTH json() and text(): the old transport read json(), the new one reads
  // text(), so providing both makes these tests fail against the OLD code for the RIGHT reason (it
  // resolved the error body as data) rather than because a method was missing.
  function stubFetch(status: number, body: unknown, opts: { nonJson?: boolean } = {}): void {
    const text = opts.nonJson ? String(body) : JSON.stringify(body)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
        json: async () => JSON.parse(text),
      }))
    )
  }

  it('jget RETURNS parsed data on 200', async () => {
    stubFetch(200, [{ id: 'p1', provider: 'claude' }])
    const { api } = await loadApi()
    await expect(api.profiles()).resolves.toEqual([{ id: 'p1', provider: 'claude' }])
  })

  it('jget THROWS HubHttpError on a 401 error body, so a token-gated peer cannot be iterated as data', async () => {
    stubFetch(401, { error: 'device token required' })
    const { api, HubHttpError } = await loadApi()
    const err = await api.sessionsFrom({
      siteId: 'peer', label: 'Peer', local: false, baseUrl: 'http://localhost:1234', online: true,
    }).then(
      () => null,
      (e) => e
    )
    expect(err).toBeInstanceOf(HubHttpError)
    expect((err as InstanceType<typeof HubHttpError>).status).toBe(401)
  })

  it('jget THROWS on a 200 whose body is not JSON (a proxy/HTML page), rather than returning garbage', async () => {
    stubFetch(200, '<!doctype html>proxy error', { nonJson: true })
    const { api, HubHttpError } = await loadApi()
    await expect(api.profiles()).rejects.toBeInstanceOf(HubHttpError)
  })

  it('jpost RETURNS {error} on a 404 (approval already gone) instead of reporting the write accepted', async () => {
    stubFetch(404, { ok: false })
    const { api } = await loadApi()
    const res = await api.decide('missing-id', false)
    expect(res.ok).toBeUndefined()
    expect(res.error).toBeDefined()
  })

  it('jpost RETURNS {error} on a network failure rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    const { api } = await loadApi()
    const res = (await api.spawn({ profileId: 'p1' })) as { error?: string }
    expect(res.error).toContain('ECONNREFUSED')
  })

  it('jpost RETURNS parsed data on 200', async () => {
    stubFetch(200, { id: 's1', status: 'idle' })
    const { api } = await loadApi()
    const res = (await api.spawn({ profileId: 'p1' })) as { id?: string }
    expect(res.id).toBe('s1')
  })

  it('exchanges a short pairing code without replaying a saved device capability', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'saved-local-device-token',
      setItem: vi.fn(),
    })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ token: 'exchanged-device-token' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await loadApi()

    await expect(api.exchangePairingCode('ABCD-EFGH', 'http://localhost:45678')).resolves.toEqual({
      token: 'exchanged-device-token',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:45678/api/pair',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'ABCD-EFGH' }),
      }),
    )
  })

  it('integration check preserves the typed 409 gate result, including exact stale files and commits', async () => {
    stubFetch(409, {
      ok: false,
      disabled: false,
      baseCommit: 'base',
      mainCommit: 'main',
      baseRef: 'refs/heads/main',
      commitsBehind: 2,
      diverged: false,
      staleFiles: [
        {
          file: 'apps/hub/src/sessions.ts',
          kind: 'uncommitted',
          commits: [{ commit: 'main', subject: 'change session lifecycle' }],
        },
      ],
    })
    const { api } = await loadApi()
    await expect(api.checkIntegration('s1')).resolves.toMatchObject({
      ok: false,
      commitsBehind: 2,
      staleFiles: [{ file: 'apps/hub/src/sessions.ts' }],
    })
  })
})

describe('remote fleet routing', () => {
  it('uses the owning hub base, strips only its registered namespace, and sends its own token', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { api, configureFleetSites, setFleetSiteToken } = await loadApi()
    configureFleetSites([{ siteId: 'peer:node', label: 'Remote', local: false, baseUrl: 'http://localhost:45678', online: true }])
    setFleetSiteToken('peer:node', 'remote-secret')

    await api.send('peer:node:session-1', 'hello')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:45678/api/sessions/session-1/input',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer remote-secret' }),
      }),
    )
  })

  it('namespaces a session record returned by a remote mutation so follow-up actions stay remote', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'session-1', profileId: 'claude-a', provider: 'claude', projectId: 'project-1',
        status: 'idle', cwd: 'C:/work', createdAt: '2026-08-01T00:00:00.000Z',
      }),
    })))
    const { api, configureFleetSites, setFleetSiteToken } = await loadApi()
    configureFleetSites([{ siteId: 'peer', label: 'Remote', local: false, baseUrl: 'http://localhost:45678', online: true }])
    setFleetSiteToken('peer', 'remote-secret')

    const result = await api.setSettings('peer:session-1', { model: 'opus' })

    expect(result).toMatchObject({
      id: 'peer:session-1',
      profileId: 'peer:claude-a',
      projectId: 'peer:project-1',
      siteId: 'peer',
      siteLabel: 'Remote',
    })
  })

  it('loads and saves device grants on the chat-owning hub without namespacing opaque target device ids', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => init?.method === 'POST'
        ? JSON.stringify({
            id: 'session-1', profileId: 'codex-a', provider: 'codex', status: 'idle', cwd: '/work',
            createdAt: '2026-08-01T00:00:00.000Z',
            remoteDeviceGrants: [{ siteId: 'target-device', rootIds: ['root-a'], capabilities: ['read'] }],
          })
        : JSON.stringify([{ siteId: 'target-device', label: 'Lab', paired: true, connected: true }]),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { api, configureFleetSites, setFleetSiteToken } = await loadApi()
    configureFleetSites([{ siteId: 'owner', label: 'Owner', local: false, baseUrl: 'http://localhost:45678', online: true }])
    setFleetSiteToken('owner', 'owner-secret')

    await api.remoteDeviceCatalog('owner:session-1')
    const record = await api.setRemoteDeviceGrants('owner:session-1', [
      { siteId: 'target-device', rootIds: ['root-a'], capabilities: ['read'] },
    ])

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://localhost:45678/api/sessions/session-1/remote-devices',
      'http://localhost:45678/api/sessions/session-1/remote-devices',
    ])
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer owner-secret')
    expect(record).toMatchObject({
      id: 'owner:session-1',
      remoteDeviceGrants: [{ siteId: 'target-device', rootIds: ['root-a'], capabilities: ['read'] }],
    })
  })

  it('routes a remote spawn to the project owner and translates account ids in both directions', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'session-2', profileId: 'claude-a', provider: 'claude', projectId: 'project-1',
        status: 'idle', cwd: 'C:/remote-work', createdAt: '2026-08-01T00:00:00.000Z',
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { api, configureFleetSites, setFleetSiteToken } = await loadApi()
    configureFleetSites([{ siteId: 'peer', label: 'Remote', local: false, baseUrl: 'http://localhost:45678', online: true }])
    setFleetSiteToken('peer', 'remote-secret')

    const result = await api.spawn({ projectId: 'peer:project-1', profileId: 'peer:claude-a' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:45678/api/sessions')
    expect(JSON.parse(String(init.body))).toMatchObject({ projectId: 'project-1', profileId: 'claude-a' })
    expect(init.headers).toMatchObject({ authorization: 'Bearer remote-secret' })
    expect(result).toMatchObject({
      id: 'peer:session-2',
      profileId: 'peer:claude-a',
      projectId: 'peer:project-1',
      siteId: 'peer',
    })
  })

  it('retains a last-known remote target so an offline namespaced id cannot fall through locally', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => '{"ok":true}',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { api, configureFleetSites, setFleetSiteToken } = await loadApi()
    configureFleetSites([{ siteId: 'peer', label: 'Remote', local: false, baseUrl: 'http://localhost:45678', online: true }])
    setFleetSiteToken('peer', 'remote-secret')
    configureFleetSites([{ siteId: 'local', label: 'Here', local: true, baseUrl: '', online: true }])

    await api.send('peer:session-1', 'still remote')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:45678/api/sessions/session-1/input')
  })

  it('runs project transcript discovery and import on the owner, then namespaces imported chats', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => url.endsWith('/scan')
        ? JSON.stringify({ chats: [], byProfile: {}, config: { mcpServers: [], hooks: [], memoryFiles: [] }, warnings: [] })
        : JSON.stringify({
            imported: [{
              id: 'imported-1', profileId: 'codex-a', provider: 'codex', projectId: 'project-1',
              status: 'idle', cwd: 'C:/remote-work', createdAt: '2026-08-01T00:00:00.000Z',
            }],
            skipped: 0,
            notFound: [],
          }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { api, configureFleetSites, setFleetSiteToken } = await loadApi()
    configureFleetSites([{ siteId: 'peer', label: 'Remote', local: false, baseUrl: 'http://localhost:45678', online: true }])
    setFleetSiteToken('peer', 'remote-secret')

    await api.scanProject('C:/remote-work', 'peer:project-1')
    const imported = await api.importChats('peer:project-1', ['vendor-1'])

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://localhost:45678/api/projects/scan',
      'http://localhost:45678/api/projects/project-1/import',
    ])
    expect(imported).toMatchObject({
      imported: [{
        id: 'peer:imported-1',
        profileId: 'peer:codex-a',
        projectId: 'peer:project-1',
        siteId: 'peer',
      }],
    })
  })
})

describe('bounded profile-login transport', () => {
  it('posts the stable idempotency key and accepts a capturing response without a URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return {
          ok: true,
          status: 202,
          text: async () =>
            JSON.stringify({
              ok: true,
              loginId: 'public-1',
              profileId: 'claude-a',
              provider: 'claude',
              status: 'capturing',
            }),
        }
      }),
    )
    const { api } = await loadApi()

    await expect(
      api.login('claude', 'claude-a', true, 'request-1'),
    ).resolves.toMatchObject({
      ok: true,
      loginId: 'public-1',
      status: 'capturing',
    })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      provider: 'claude',
      name: 'claude-a',
      reauth: true,
      idempotencyKey: 'request-1',
    })
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('aborts a login request that never receives an HTTP response', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
          }),
      ),
    )
    const { api, LOGIN_HTTP_TIMEOUT_MS } = await loadApi()

    const pending = api.login('claude', 'claude-a', true, 'request-timeout')
    await vi.advanceTimersByTimeAsync(LOGIN_HTTP_TIMEOUT_MS)
    await expect(pending).resolves.toMatchObject({ error: expect.any(String) })
    vi.useRealTimers()
  })

  it('recovers only the same profile and idempotency key', async () => {
    let requested = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested = url
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              loginId: 'public-recovered',
              status: 'settling',
            }),
        }
      }),
    )
    const { api } = await loadApi()

    await expect(
      api.loginForProfile('claude-a', 'request:recover'),
    ).resolves.toMatchObject({
      loginId: 'public-recovered',
      status: 'settling',
    })
    expect(requested).toContain(
      '/api/accounts/login/profile/claude-a?key=request%3Arecover',
    )
  })
})

// The attachment upload contract (raw bytes, not JSON). A failed upload must SURFACE as { error } at the
// composer — a file that silently fails to attach is the same class of bug as one that silently fails to
// reach the vendor — never throw, never be mistaken for a stored ref.
describe('uploadAttachment (raw-bytes POST; failure surfaces, never throws)', () => {
  const fakeFile = (name: string, type: string) =>
    ({ name, type, arrayBuffer: async () => new ArrayBuffer(3) }) as unknown as File

  it('POSTs raw bytes with content-type=mime and x-filename, and returns the stored ref on 200', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'a1', name: 'x.png', mime: 'image/png', size: 3 }) }
      })
    )
    const { api } = await loadApi()
    const res = await api.uploadAttachment('sess1', fakeFile('x.png', 'image/png'))
    expect(res).toEqual({ id: 'a1', name: 'x.png', mime: 'image/png', size: 3 })
    // raw bytes, not JSON: the File itself is the body; headers carry mime + name; method POST.
    expect(calls[0]!.url).toContain('/api/sessions/sess1/attachments')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('image/png')
    expect(headers['x-filename']).toBe('x.png')
    expect(calls[0]!.init.body).not.toBeTypeOf('string') // NOT JSON.stringify'd
  })

  it('RETURNS { error } on a hub rejection (e.g. 413 too large), not a thrown error or a fake ref', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 413, text: async () => JSON.stringify({ error: 'attachment exceeds the 5 MB limit' }) })))
    const { api } = await loadApi()
    const res = (await api.uploadAttachment('sess1', fakeFile('big.png', 'image/png'))) as { error?: string }
    expect(res.error).toContain('5 MB')
  })

  it('RETURNS { error } on a network failure rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const { api } = await loadApi()
    const res = (await api.uploadAttachment('sess1', fakeFile('x.png', 'image/png'))) as { error?: string }
    expect(res.error).toContain('ECONNREFUSED')
  })

  it('defaults an empty mime to application/octet-stream', async () => {
    let sentType = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sentType = (init.headers as Record<string, string>)['content-type']!
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'a', name: 'f', mime: 'application/octet-stream', size: 3 }) }
    }))
    const { api } = await loadApi()
    await api.uploadAttachment('s', fakeFile('f', ''))
    expect(sentType).toBe('application/octet-stream')
  })
})
