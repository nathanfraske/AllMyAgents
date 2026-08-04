import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealLocalFile } from './localFile'

afterEach(() => {
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('local transcript file reveal', () => {
  it('uses the native reveal command in the desktop app', async () => {
    const invoke = vi.fn(async () => undefined)
    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } }

    await expect(revealLocalFile('C:\\work\\report.pdf')).resolves.toBe('revealed')
    expect(invoke).toHaveBeenCalledWith('reveal_local_path', { path: 'C:\\work\\report.pdf' })
  })

  it('copies the path in a plain browser without asking the hub to open it', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await expect(revealLocalFile('/workspace/report.md')).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalledWith('/workspace/report.md')
  })

  it('rejects empty and NUL-containing values before invoking native code', async () => {
    const invoke = vi.fn(async () => undefined)
    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } }

    await expect(revealLocalFile('  ')).rejects.toThrow('Invalid local path')
    await expect(revealLocalFile('/tmp/a\0b')).rejects.toThrow('Invalid local path')
    expect(invoke).not.toHaveBeenCalled()
  })
})
