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
    const err = await api.sessionsFrom('http://localhost:1234').then(
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
