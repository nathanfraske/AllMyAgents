export type LocalFileRevealResult = 'revealed' | 'copied'

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

/**
 * Reveal a transcript path only after an operator click. Desktop builds delegate validation and the
 * actual file-manager launch to Rust; remote/plain-browser views can only copy the path locally.
 * Neither branch executes the target.
 */
export async function revealLocalFile(path: string): Promise<LocalFileRevealResult> {
  const value = path.trim()
  if (!value || value.length > 4_096 || value.includes('\0')) {
    throw new Error('Invalid local path')
  }

  const invoke = nativeInvoke()
  if (invoke) {
    await invoke<void>('reveal_local_path', { path: value })
    return 'revealed'
  }

  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (!clipboard?.writeText) {
    throw new Error('File reveal is available in the desktop app; clipboard access is unavailable here')
  }
  await clipboard.writeText(value)
  return 'copied'
}
