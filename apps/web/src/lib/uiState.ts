import type { AttachmentMeta } from './attachments'

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
const PROJECT_VIEW_MODES_KEY = 'allmyagents.ui.projectViewModes'
const PROJECT_PEEK_KEY = 'allmyagents.ui.projectTranscriptPeek'

export type ProjectViewMode = 'overview' | 'manager'

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
//
// ONE set holds two kinds of id: a sidebar PROJECT group ('__none__' for Unfiled) and a chat FOLDER
// inside one (`folder:<uuid>` — see folders.ts, which prefixes ids precisely so the two can share this
// key without an ambiguous entry collapsing the wrong thing). Ids for things that no longer exist are
// kept rather than pruned: projects and folders both load after this does, so "forget what I don't
// recognise" would throw the state away on every cold start.
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

// The project screen is a repeated working loop, not navigation history: remember whether each project
// was last left on the operational overview or the manager conversation.
export function loadProjectViewMode(projectId: string): ProjectViewMode {
  try {
    const raw = localStorage.getItem(PROJECT_VIEW_MODES_KEY)
    if (!raw) return 'overview'
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'overview'
    return (value as Record<string, unknown>)[projectId] === 'manager' ? 'manager' : 'overview'
  } catch {
    return 'overview'
  }
}

export function saveProjectViewMode(projectId: string, mode: ProjectViewMode): void {
  try {
    const raw = localStorage.getItem(PROJECT_VIEW_MODES_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    const modes =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    localStorage.setItem(PROJECT_VIEW_MODES_KEY, JSON.stringify({ ...modes, [projectId]: mode }))
  } catch {
    // A malformed old value must not prevent replacing it with valid state.
    try {
      localStorage.setItem(PROJECT_VIEW_MODES_KEY, JSON.stringify({ [projectId]: mode }))
    } catch {
      /* ignore */
    }
  }
}

export function loadProjectTranscriptPeek(projectId: string): boolean {
  try {
    const raw = localStorage.getItem(PROJECT_PEEK_KEY)
    if (!raw) return true
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true
    // Open is the default. Only a deliberate persisted false collapses it.
    return (value as Record<string, unknown>)[projectId] !== false
  } catch {
    return true
  }
}

export function saveProjectTranscriptPeek(projectId: string, open: boolean): void {
  try {
    const raw = localStorage.getItem(PROJECT_PEEK_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    const states =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    localStorage.setItem(PROJECT_PEEK_KEY, JSON.stringify({ ...states, [projectId]: open }))
  } catch {
    try {
      localStorage.setItem(PROJECT_PEEK_KEY, JSON.stringify({ [projectId]: open }))
    } catch {
      /* ignore */
    }
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

// Messages you typed while a turn was running, per session. Attachment-bearing entries also persist the
// already-uploaded hub metadata/ids, so a reload before the queue flushes cannot silently strip the files.
const QUEUES_KEY = 'allmyagents.ui.queuedMessages'

export interface QueuedMessage {
  text: string
  attachments?: AttachmentMeta[]
}
export type QueuedEntry = string | QueuedMessage

function queuedEntry(value: unknown): QueuedEntry | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as { text?: unknown; attachments?: unknown }
  if (typeof raw.text !== 'string') return null
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.filter((a): a is AttachmentMeta => {
        if (!a || typeof a !== 'object') return false
        const item = a as Partial<AttachmentMeta>
        return (
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          typeof item.mime === 'string' &&
          typeof item.size === 'number' &&
          (item.kind === 'image' || item.kind === 'file')
        )
      })
    : undefined
  return { text: raw.text, ...(attachments?.length ? { attachments } : {}) }
}

export function loadQueues(): Record<string, QueuedEntry[]> {
  try {
    const raw = localStorage.getItem(QUEUES_KEY)
    if (raw) {
      const v = JSON.parse(raw) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const out: Record<string, QueuedEntry[]> = {}
        for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
          if (Array.isArray(list)) {
            const entries = list.map(queuedEntry).filter((x): x is QueuedEntry => x !== null)
            if (entries.length) out[k] = entries
          }
        }
        return out
      }
    }
  } catch {
    /* ignore */
  }
  return {}
}

export function saveQueues(queues: Record<string, QueuedEntry[]>): void {
  try {
    // Drop empty lists so the entry does not grow forever as chats come and go.
    const trimmed = Object.fromEntries(Object.entries(queues).filter(([, v]) => v.length > 0))
    localStorage.setItem(QUEUES_KEY, JSON.stringify(trimmed))
  } catch {
    /* ignore */
  }
}

// Unsent composer text, per chat. Switching panes or reloading must not throw away something you were
// halfway through writing — and it belongs to the CHAT, not to the pane you happened to be looking at.
const COMPOSER_KEY = 'allmyagents.ui.composerDrafts'

export function loadComposerDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(COMPOSER_KEY)
    if (raw) {
      const v = JSON.parse(raw) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const out: Record<string, string> = {}
        for (const [k, text] of Object.entries(v as Record<string, unknown>)) {
          if (typeof text === 'string' && text !== '') out[k] = text
        }
        return out
      }
    }
  } catch {
    /* ignore */
  }
  return {}
}

export function saveComposerDrafts(drafts: Record<string, string>): void {
  try {
    // Prune empties (a sent message clears its draft) so the entry cannot grow without bound.
    const trimmed = Object.fromEntries(Object.entries(drafts).filter(([, v]) => v !== ''))
    localStorage.setItem(COMPOSER_KEY, JSON.stringify(trimmed))
  } catch {
    /* ignore */
  }
}

export function saveOpenAgentPanels(ids: string[]): void {
  try {
    localStorage.setItem(AGENT_PANELS_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}
