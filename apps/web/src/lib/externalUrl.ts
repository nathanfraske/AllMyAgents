import { inTauri } from './window'

interface TauriBridge {
  shell?: { open?: (url: string) => Promise<void> }
}

export interface PreparedExternalTarget {
  popup: Window | null
}

function safeHttpsUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Plain browsers commonly block a new tab after an awaited HTTP request. Reserve it synchronously
 * inside the operator's click; the desktop shell does not need this because its native opener is not
 * subject to popup blocking.
 */
export function prepareExternalTarget(): PreparedExternalTarget {
  if (inTauri || typeof window === 'undefined') return { popup: null }
  try {
    const popup = window.open('about:blank', '_blank')
    if (popup) popup.opener = null
    return { popup }
  } catch {
    return { popup: null }
  }
}

export function closePreparedTarget(target: PreparedExternalTarget): void {
  try {
    if (target.popup && !target.popup.closed) target.popup.close()
  } catch {
    // Cross-origin/window lifecycle races are harmless here.
  }
}

/** Open an HTTPS URL without invoking `start`, `open`, a terminal, or any hub-side GUI facility. */
export async function openExternalUrl(raw: string, target: PreparedExternalTarget): Promise<boolean> {
  const url = safeHttpsUrl(raw)
  if (!url) return false

  const bridge = (globalThis as { __TAURI__?: TauriBridge }).__TAURI__
  const nativeOpen = bridge?.shell?.open
  if (nativeOpen) {
    try {
      await nativeOpen(url)
      closePreparedTarget(target)
      return true
    } catch {
      // Keep the prepared browser target/link fallback available below.
    }
  }

  try {
    if (target.popup && !target.popup.closed) {
      target.popup.location.replace(url)
      return true
    }
    return window.open(url, '_blank', 'noopener,noreferrer') !== null
  } catch {
    return false
  }
}
