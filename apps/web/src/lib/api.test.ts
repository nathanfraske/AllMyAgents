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
