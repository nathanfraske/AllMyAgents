// Cross-restart UI-state persistence (per-device webview localStorage — survives Tauri app
// restarts). Mirrors the order/settings persistence already in the app: namespaced `allmyagents.*`
// keys, JSON values, and every read wrapped in try/catch → defaults so a malformed or absent value
// can never throw or wedge startup (same shape as `loadOrder`/`saveOrder` in store.svelte.ts and
// `load()` in settings.svelte.ts).
//
// Two things are remembered across a restart:
//   1. the LAST-OPEN LAYOUT — the selected chat id + the 2D split-pane arrangement — so the home
//      screen can OFFER to reopen it. We deliberately do NOT auto-apply it (no auto-jump into the
//      last chat); the store loads it into a passive `restorableLayout` offer instead (see store).
//   2. each sidebar folder/group's OPEN-vs-COLLAPSED state — restored immediately on load so the
//      sidebar looks exactly as the operator left it.
//
// NB: keys sit under `allmyagents.ui.*` to match the app's persisted-state convention (settings,
// sidebarWidth, order.*, import.dismissed all use the `allmyagents.` prefix). The `ama:*` prefix in
// the codebase is used only for the dev-only `ama:verbose` debug flag, not persisted user state.

export interface PersistedLayout {
  // The primary/selected chat id (null when only split panes define the layout).
  selectedId: string | null
  // The 2D split layout: rows of columns of session ids ([] when a single chat is open).
  splitPanes: string[][]
  // Captured at save time so the restore offer can NAME the session(s) even before the roster has
  // streamed in on a cold start. `title` is the primary pane's label; `paneCount` the total panes.
  title?: string
  paneCount?: number
}

const LAYOUT_KEY = 'allmyagents.ui.lastLayout'
const FOLDERS_KEY = 'allmyagents.ui.collapsedFolders'
/** Chats whose agent side panel is popped out — so it is still open after a reload or a hub restart. */
const AGENT_PANELS_KEY = 'allmyagents.ui.openAgentPanels'

function isStringMatrix(v: unknown): v is string[][] {
  return Array.isArray(v) && v.every((row) => Array.isArray(row) && row.every((x) => typeof x === 'string'))
}

// Load the persisted last-open layout, or null when absent/malformed/empty. A layout with neither
// a selection nor any pane is "home" — there is nothing to offer, so we treat it as null too.
export function loadLastLayout(): PersistedLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    const selectedId = typeof o.selectedId === 'string' ? o.selectedId : null
    const splitPanes = isStringMatrix(o.splitPanes) ? (o.splitPanes as string[][]) : []
    if (!selectedId && splitPanes.length === 0) return null
    return {
      selectedId,
      splitPanes,
      title: typeof o.title === 'string' ? o.title : undefined,
      paneCount: typeof o.paneCount === 'number' ? o.paneCount : undefined,
    }
  } catch {
    return null
  }
}

export function saveLastLayout(layout: PersistedLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    /* ignore */
  }
}

// Load the set of COLLAPSED folder/group ids (anything not listed is expanded — the default).
// Returns [] on absent/malformed, filtering to strings so a corrupt entry can't poison the Set.
export function loadCollapsedFolders(): string[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY)
    if (raw) {
      const v = JSON.parse(raw) as unknown
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    /* ignore */
  }
  return []
}

export function saveCollapsedFolders(ids: string[]): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

// Session ids whose agent side panel is popped out. Per-chat rather than global: you open it for the
// chat that is running agents, and it should still be open when you come back to that chat — including
// after an app reload or a hub restart. Same defensive parse as the folder state.
export function loadOpenAgentPanels(): string[] {
  try {
    const raw = localStorage.getItem(AGENT_PANELS_KEY)
    if (raw) {
      const v = JSON.parse(raw) as unknown
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    /* ignore */
  }
  return []
}

export function saveOpenAgentPanels(ids: string[]): void {
  try {
    localStorage.setItem(AGENT_PANELS_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}
