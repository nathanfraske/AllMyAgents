// Promise-based confirm/alert that works inside the Tauri desktop webview (WebView2 on Windows,
// WKWebView on macOS), where the native window.confirm() / alert() / prompt() are unreliable: the
// embedded webview suppresses them, so confirm() returns a falsy value with NO dialog shown. That
// made `if (!confirm(...)) return` bail every time — the "delete does nothing" bug. Call sites now
// await confirmDialog()/alertDialog(), which drive an in-app modal (ConfirmDialog.svelte, mounted
// once at the app root) and resolve on the user's choice.

export type DialogKind = 'confirm' | 'alert'

export interface DialogRequest {
  id: number
  kind: DialogKind
  message: string
  confirmLabel: string
  cancelLabel: string
  // Style the confirm button as destructive (red) — for delete / irreversible actions.
  danger: boolean
  // Settles the awaiting promise: true = confirm/OK, false = cancel/Esc/backdrop.
  resolve: (ok: boolean) => void
}

export interface ConfirmOptions {
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

class DialogController {
  // The dialog currently on screen (null = none). ConfirmDialog.svelte renders from this.
  current = $state<DialogRequest | null>(null)
  // Requests raised while one is already open, shown one at a time (FIFO) — a second confirm()
  // waits its turn instead of clobbering the first, so no awaiting promise is ever dropped.
  private queue: DialogRequest[] = []
  private seq = 0

  private open(req: Omit<DialogRequest, 'id'>): void {
    const full: DialogRequest = { ...req, id: ++this.seq }
    if (this.current) this.queue.push(full)
    else this.current = full
  }

  confirm(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.open({
        kind: 'confirm',
        message,
        confirmLabel: opts.confirmLabel ?? 'Confirm',
        cancelLabel: opts.cancelLabel ?? 'Cancel',
        danger: opts.danger ?? false,
        resolve,
      })
    })
  }

  alert(message: string, confirmLabel = 'OK'): Promise<void> {
    return new Promise<void>((resolve) => {
      this.open({
        kind: 'alert',
        message,
        confirmLabel,
        cancelLabel: '',
        danger: false,
        resolve: () => resolve(),
      })
    })
  }

  // Resolve the on-screen dialog and surface the next queued one (if any). current is advanced
  // BEFORE resolving so any `.then`/awaiting code already sees the next state.
  private settle(ok: boolean): void {
    const cur = this.current
    if (!cur) return
    this.current = this.queue.shift() ?? null
    cur.resolve(ok)
  }

  accept(): void {
    this.settle(true)
  }
  cancel(): void {
    this.settle(false)
  }
}

export const dialog = new DialogController()

// Public helpers — drop-in replacements for native confirm()/alert() used across the app.
export const confirmDialog = (message: string, opts?: ConfirmOptions): Promise<boolean> =>
  dialog.confirm(message, opts)
export const alertDialog = (message: string): Promise<void> => dialog.alert(message)
