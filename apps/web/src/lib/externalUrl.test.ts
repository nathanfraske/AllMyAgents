import { afterEach, describe, expect, it, vi } from 'vitest'
import { openExternalUrl } from './externalUrl'

afterEach(() => {
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__
  vi.restoreAllMocks()
})

describe('external login URL opener', () => {
  it('uses the desktop native shell for an HTTPS URL', async () => {
    const open = vi.fn(async () => undefined)
    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = { shell: { open } }

    await expect(openExternalUrl('https://auth.openai.com/codex/device', { popup: null })).resolves.toBe(true)
    expect(open).toHaveBeenCalledWith('https://auth.openai.com/codex/device')
  })

  it('refuses a non-HTTPS URL without invoking the native shell', async () => {
    const open = vi.fn(async () => undefined)
    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = { shell: { open } }

    await expect(openExternalUrl('http://localhost:1455/auth/callback', { popup: null })).resolves.toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
