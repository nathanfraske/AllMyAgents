// Chat folders — sub-groups INSIDE a sidebar project group.
//
// WHY THIS IS CLIENT-ONLY (and not a hub table):
//   The hub has no folder concept anywhere. `projects` is `(id, name, path, createdAt)` (see
//   apps/hub/src/projects.ts) and `SessionRecord` carries a `projectId` and nothing else — there is
//   no route to move a chat between projects, let alone into a sub-group. Meanwhile EVERY other
//   sidebar arrangement concern is already per-device localStorage under the `allmyagents.*` prefix:
//   project order, per-group chat order, collapsed groups, the import "don't ask again" set. A folder
//   is the same class of thing — how ONE operator likes THIS window arranged, not a fact about the
//   session. Putting it in SQLite would mean a schema migration plus new API surface for something no
//   other client reads.
//   It also has to work for chats that this hub does not own: the fleet merge pulls REMOTE sessions in
//   read-only with `${siteId}:`-namespaced ids, so a local hub table could not hold membership for
//   them at all. Keying on the id the sidebar actually renders covers local and remote identically.
//
// The state is deliberately GROW-ONLY. Nothing here prunes assignments for chat ids it does not
// recognise, because the session roster arrives asynchronously (WS replay, roster fetch, fleet poll):
// a "tidy up unknown chats" pass on load would run against an empty roster and wipe every folder the
// operator had. Stale entries are instead made harmless at read time — see `partitionByFolder`.

const FOLDERS_KEY = 'allmyagents.ui.chatFolders'

/** Name a freshly created folder gets before the operator types over it (rename opens immediately). */
export const DEFAULT_FOLDER_NAME = 'New folder'

export interface ChatFolder {
  id: string
  /** The sidebar group this folder lives in: a project id, or '__none__' for the Unfiled group. */
  groupId: string
  name: string
}

export interface FolderState {
  /** Render order is array order — folders appear above the group's ungrouped chats. */
  folders: ChatFolder[]
  /** chat id → folder id. A chat lives in at most one folder, so membership can never fork. */
  assignments: Record<string, string>
}

export function emptyFolderState(): FolderState {
  return { folders: [], assignments: {} }
}

// Prefixed so a folder id can never collide with a project id (a UUID) or the '__none__' sentinel —
// they share one collapsed-id set in uiState.ts, and one ambiguous id there would collapse the wrong
// thing.
const FOLDER_ID_PREFIX = 'folder:'

export function newFolderId(): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${FOLDER_ID_PREFIX}${rand}`
}

/**
 * Distinguish a folder id from a project/group id, for the code paths that share one id space.
 *
 * The sidebar's collapse toggle is the one that matters: expanding a PROJECT is an "I am opening this
 * project" gesture that kicks off the scan-for-importable-chats prompt, and it feeds the id to
 * `pathFor()` as a project id. Expanding a folder is neither, so it must not take that branch.
 */
export function isFolderId(id: string): boolean {
  return id.startsWith(FOLDER_ID_PREFIX)
}

/**
 * Coerce anything at all into a usable FolderState. Exported so the malformed-input cases are
 * directly testable without going through localStorage.
 *
 * An assignment pointing at a folder that is not in the list is KEPT rather than dropped: a single
 * malformed folder entry would otherwise permanently erase the membership of every chat inside it,
 * and `partitionByFolder` already renders such a chat in the ungrouped list where it stays reachable.
 */
export function parseFolderState(v: unknown): FolderState {
  const out = emptyFolderState()
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  const o = v as Record<string, unknown>
  if (Array.isArray(o.folders)) {
    const seen = new Set<string>()
    for (const raw of o.folders) {
      if (!raw || typeof raw !== 'object') continue
      const f = raw as Record<string, unknown>
      if (typeof f.id !== 'string' || typeof f.groupId !== 'string' || typeof f.name !== 'string') continue
      if (seen.has(f.id)) continue // duplicate ids would give two headers that rename as one
      seen.add(f.id)
      out.folders.push({ id: f.id, groupId: f.groupId, name: f.name })
    }
  }
  if (o.assignments && typeof o.assignments === 'object' && !Array.isArray(o.assignments)) {
    for (const [chatId, folderId] of Object.entries(o.assignments as Record<string, unknown>)) {
      if (typeof folderId === 'string') out.assignments[chatId] = folderId
    }
  }
  return out
}

// Same defensive shape as the rest of uiState.ts: every read is wrapped so a malformed or absent
// value degrades to "no folders" instead of throwing and taking the whole sidebar down with it.
export function loadFolderState(): FolderState {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY)
    if (raw) return parseFolderState(JSON.parse(raw))
  } catch {
    /* ignore */
  }
  return emptyFolderState()
}

export function saveFolderState(state: FolderState): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

// --- Mutations -----------------------------------------------------------------------------------
// All pure: they return a NEW state, and return the SAME reference when the call changes nothing, so
// a caller can skip the persist + reassign (the convention `moveInto` in store.svelte.ts already uses).

export function createFolder(
  state: FolderState,
  groupId: string,
  name: string = DEFAULT_FOLDER_NAME
): { state: FolderState; folder: ChatFolder } {
  const folder: ChatFolder = { id: newFolderId(), groupId, name: name.trim() || DEFAULT_FOLDER_NAME }
  return { state: { ...state, folders: [...state.folders, folder] }, folder }
}

export function renameFolder(state: FolderState, folderId: string, name: string): FolderState {
  const clean = name.trim()
  // An all-whitespace name would leave a header with nothing to click or read, so an empty commit is
  // treated as a cancel — the same rule `store.renameSession` applies to chats.
  if (!clean) return state
  const i = state.folders.findIndex((f) => f.id === folderId)
  if (i < 0 || state.folders[i]!.name === clean) return state
  const folders = state.folders.slice()
  folders[i] = { ...folders[i]!, name: clean }
  return { ...state, folders }
}

/** Removes the folder only. Its chats are NEVER deleted — they fall back to the group's ungrouped list. */
export function deleteFolder(state: FolderState, folderId: string): FolderState {
  if (!state.folders.some((f) => f.id === folderId)) return state
  const assignments: Record<string, string> = {}
  for (const [chatId, fid] of Object.entries(state.assignments)) {
    if (fid !== folderId) assignments[chatId] = fid
  }
  return { folders: state.folders.filter((f) => f.id !== folderId), assignments }
}

/**
 * Move a chat into `folderId`, or back out to the group's ungrouped list with `null`.
 *
 * Moving to a folder that does not exist is a no-op rather than a write: the drop would otherwise
 * record membership of nothing, and the chat would render ungrouped while the state claimed it was
 * filed — the exact "silently dropped a chat" failure this feature must not have.
 */
export function moveChatToFolder(state: FolderState, chatId: string, folderId: string | null): FolderState {
  const current = state.assignments[chatId] ?? null
  if (current === folderId) return state
  if (folderId !== null && !state.folders.some((f) => f.id === folderId)) return state
  const assignments = { ...state.assignments }
  if (folderId === null) delete assignments[chatId]
  else assignments[chatId] = folderId
  return { ...state, assignments }
}

// --- Selectors -----------------------------------------------------------------------------------

export function foldersFor(state: FolderState, groupId: string): ChatFolder[] {
  return state.folders.filter((f) => f.groupId === groupId)
}

/** The folder a chat is filed under, or null when it is ungrouped. */
export function folderOf(state: FolderState, chatId: string): string | null {
  return state.assignments[chatId] ?? null
}

export interface FolderBucket<T> {
  folder: ChatFolder
  items: T[]
}

export interface Partitioned<T> {
  folders: FolderBucket<T>[]
  /** Everything in the group that is not inside one of the group's own folders. */
  loose: T[]
}

/**
 * Split one group's already-ordered chats into its folders plus the ungrouped remainder, preserving
 * the incoming order inside every bucket (so the persisted per-group chat order still governs).
 *
 * THE IMPORTANT PROPERTY: a chat whose assignment points at a folder that has been deleted, or at a
 * folder belonging to a DIFFERENT group, lands in `loose`. Stale persisted state therefore costs the
 * operator a folder, never a chat — `folders.flatMap(items) + loose` always equals `items`.
 */
export function partitionByFolder<T>(
  state: FolderState,
  groupId: string,
  items: T[],
  idOf: (item: T) => string
): Partitioned<T> {
  const mine = foldersFor(state, groupId)
  const buckets = new Map<string, T[]>(mine.map((f) => [f.id, [] as T[]]))
  const loose: T[] = []
  for (const item of items) {
    const fid = state.assignments[idOf(item)]
    const bucket = fid ? buckets.get(fid) : undefined
    if (bucket) bucket.push(item)
    else loose.push(item)
  }
  return { folders: mine.map((f) => ({ folder: f, items: buckets.get(f.id)! })), loose }
}
