// window.ts — tiny, defensively-typed wrapper over Tauri v2's CORE window controls.
//
// Access strategy: the GLOBAL BRIDGE (`window.__TAURI__`), enabled by `app.withGlobalTauri:
// true` in tauri.conf.json. We use the bridge rather than importing `@tauri-apps/api` because
// that package is NOT a dependency of apps/web (see apps/web/package.json) — the bridge costs
// only a one-line config flag, no new dependency and no install step.
//
// Every function is guarded so it silently no-ops (never throws) in a plain browser — the same
// Titlebar component runs unchanged over the mesh, where there is no OS window to drive.

// Tauri probe, mirrored from apps/web/src/lib/api.ts. That module keeps its `inTauri` const
// private (un-exported), so it can't be imported without editing api.ts — which is off-limits.
// The check here is byte-for-byte identical: `__TAURI_INTERNALS__` is always injected into a
// Tauri webview; `__TAURI__` appears only when withGlobalTauri is on — exactly what the calls
// below need. Keep the two in sync if api.ts ever changes.
export const inTauri =
  typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

// Minimal shape of the Tauri v2 Window object we touch, typed locally so we need no
// @tauri-apps/api types at build time.
interface TauriWindowLike {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
}

interface TauriBridge {
  window?: { getCurrentWindow?: () => TauriWindowLike }
}

// Resolve the current OS window through the global bridge, or null when it isn't there
// (plain browser, or bridge disabled). Never throws.
function currentWindow(): TauriWindowLike | null {
  const bridge = (globalThis as { __TAURI__?: TauriBridge }).__TAURI__
  try {
    return bridge?.window?.getCurrentWindow?.() ?? null
  } catch {
    return null
  }
}

export async function minimizeWindow(): Promise<void> {
  try {
    await currentWindow()?.minimize()
  } catch {
    /* no OS window (plain browser) — no-op */
  }
}

export async function toggleMaximizeWindow(): Promise<void> {
  try {
    await currentWindow()?.toggleMaximize()
  } catch {
    /* no OS window (plain browser) — no-op */
  }
}

export async function closeWindow(): Promise<void> {
  try {
    await currentWindow()?.close()
  } catch {
    /* no OS window (plain browser) — no-op */
  }
}

export async function isMaximized(): Promise<boolean> {
  try {
    return (await currentWindow()?.isMaximized()) ?? false
  } catch {
    return false
  }
}
