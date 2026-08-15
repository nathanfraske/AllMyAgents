import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDesktopStartupStatus, reportRendererFirstPaint } from './desktopStartup'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('desktop startup bridge', () => {
  it('is inert in an ordinary browser', async () => {
    expect(await readDesktopStartupStatus()).toBeUndefined()
    expect(() => reportRendererFirstPaint(12)).not.toThrow()
  })

  it('reads native phase telemetry and reports the first painted frame', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'desktop_startup_status') {
        return { phase: 'integrity-check', detail: 'Checking the journal.', elapsedMs: 10_484 }
      }
      return undefined
    })
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke })

    await expect(readDesktopStartupStatus()).resolves.toEqual({
      phase: 'integrity-check',
      detail: 'Checking the journal.',
      elapsedMs: 10_484,
    })
    reportRendererFirstPaint(16.5)
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('renderer_first_paint', { webElapsedMs: 16.5 })
    })
  })
})
