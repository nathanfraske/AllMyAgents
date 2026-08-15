export interface DesktopStartupStatus {
  phase: string
  detail: string
  elapsedMs: number
}

interface TauriInvokeBridge {
  invoke?<T>(command: string, args?: Record<string, unknown>): Promise<T>
}

function nativeInvoke(): TauriInvokeBridge['invoke'] | undefined {
  const bridge = globalThis as {
    __TAURI__?: { core?: TauriInvokeBridge }
    __TAURI_INTERNALS__?: TauriInvokeBridge
  }
  return bridge.__TAURI__?.core?.invoke ?? bridge.__TAURI_INTERNALS__?.invoke
}

export async function readDesktopStartupStatus(): Promise<DesktopStartupStatus | undefined> {
  const invoke = nativeInvoke()
  if (!invoke) return undefined
  try {
    return await invoke<DesktopStartupStatus>('desktop_startup_status')
  } catch {
    return undefined
  }
}

export function reportRendererFirstPaint(webElapsedMs: number): void {
  const invoke = nativeInvoke()
  if (!invoke) return
  void invoke<void>('renderer_first_paint', { webElapsedMs }).catch(() => undefined)
}
