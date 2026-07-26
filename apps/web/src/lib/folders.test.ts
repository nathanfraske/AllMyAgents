import { beforeEach, describe, expect, it } from 'vitest'
import {
  createFolder,
  deleteFolder,
  emptyFolderState,
  folderOf,
  foldersFor,
  isFolderId,
  loadFolderState,
  moveChatToFolder,
  newFolderId,
  parseFolderState,
  partitionByFolder,
  renameFolder,
  saveFolderState,
  type FolderState,
} from './folders'
import { loadCollapsedFolders, saveCollapsedFolders } from './uiState'

// Folders are a CLIENT-ONLY grouping layer (see the header of folders.ts), so everything worth
// testing is pure state math over jsdom's localStorage — no store, no hub, no component.
//
// The load-bearing invariant, and the reason most of these exist: a chat must be REACHABLE no matter
// what the persisted state says. A folder can be lost to corruption; a chat never can.

const FOLDERS_KEY = 'allmyagents.ui.chatFolders'
const COLLAPSED_KEY = 'allmyagents.ui.collapsedFolders'

beforeEach(() => {
  localStorage.clear()
})

/** A chat, reduced to the only thing the partition cares about. */
interface Chat {
  id: string
}
const chats = (...ids: string[]): Chat[] => ids.map((id) => ({ id }))
const idOf = (c: Chat): string => c.id

/** Build a state with one folder in `groupId`, returning both so tests stay readable. */
function withFolder(groupId = 'proj-a', name = 'Docs'): { state: FolderState; id: string } {
  const made = createFolder(emptyFolderState(), groupId, name)
  return { state: made.state, id: made.folder.id }
}

describe('folder ids', () => {
  it('namespaces ids so they cannot collide with a project id or the Unfiled sentinel', () => {
    const id = newFolderId()
    expect(isFolderId(id)).toBe(true)
    expect(isFolderId('__none__')).toBe(false)
    // A project id is a bare UUID from the hub — it must not read as a folder.
    expect(isFolderId('3f2a1c88-0f0b-4a3e-9d1f-1f2b3c4d5e6f')).toBe(false)
  })

  it('mints a distinct id per folder', () => {
    expect(newFolderId()).not.toBe(newFolderId())
  })
})

describe('collapse state (shared with project groups)', () => {
  it('round-trips a collapsed FOLDER id alongside project ids', () => {
    const fid = newFolderId()
    saveCollapsedFolders(['proj-a', '__none__', fid])
    const back = loadCollapsedFolders()
    expect(back).toContain(fid)
    // The two kinds share one key; neither may swallow the other.
    expect(back).toEqual(['proj-a', '__none__', fid])
  })

  it('survives a restart: a folder collapsed in one session is still collapsed in the next', () => {
    const fid = newFolderId()
    // Session 1 — the operator collapses the folder.
    const session1 = new Set(loadCollapsedFolders())
    session1.add(fid)
    saveCollapsedFolders([...session1])
    // Session 2 — a fresh load of the same device storage (what a relaunch does).
    expect(new Set(loadCollapsedFolders()).has(fid)).toBe(true)
  })

  it('keeps a collapsed id whose folder is gone, rather than dropping it on load', () => {
    // Projects and folders both load AFTER this does, so "forget ids I do not recognise" would wipe
    // the state on every cold start. Unknown ids are inert, so keeping them is the safe direction.
    saveCollapsedFolders(['folder:vanished'])
    expect(loadCollapsedFolders()).toEqual(['folder:vanished'])
  })
})

describe('creating folders', () => {
  it('adds a folder to its group and leaves other groups alone', () => {
    const { state, id } = withFolder('proj-a')
    expect(foldersFor(state, 'proj-a').map((f) => f.id)).toEqual([id])
    expect(foldersFor(state, 'proj-b')).toEqual([])
  })

  it('does not mutate the state it was given', () => {
    const before = emptyFolderState()
    createFolder(before, 'proj-a')
    expect(before.folders).toEqual([])
  })

  it('falls back to the default name when handed blank whitespace', () => {
    const made = createFolder(emptyFolderState(), 'proj-a', '   ')
    expect(made.folder.name).toBe('New folder')
  })
})

describe('renaming a folder', () => {
  it('renames in place, trimming the input', () => {
    const { state, id } = withFolder('proj-a', 'Docs')
    const next = renameFolder(state, id, '  Specs  ')
    expect(foldersFor(next, 'proj-a')[0]!.name).toBe('Specs')
  })

  it('treats an empty/whitespace commit as a cancel — the old name survives', () => {
    const { state, id } = withFolder('proj-a', 'Docs')
    const next = renameFolder(state, id, '   ')
    expect(next).toBe(state) // unchanged reference: nothing to persist
    expect(foldersFor(state, 'proj-a')[0]!.name).toBe('Docs')
  })

  it('is a no-op for an id that is not a folder', () => {
    const { state } = withFolder('proj-a', 'Docs')
    expect(renameFolder(state, 'folder:gone', 'Specs')).toBe(state)
  })

  it('renames only the targeted folder', () => {
    const first = createFolder(emptyFolderState(), 'proj-a', 'Docs')
    const second = createFolder(first.state, 'proj-a', 'Specs')
    const next = renameFolder(second.state, second.folder.id, 'Plans')
    expect(foldersFor(next, 'proj-a').map((f) => f.name)).toEqual(['Docs', 'Plans'])
  })

  it('keeps the chats filed under a folder through a rename', () => {
    const { state, id } = withFolder('proj-a', 'Docs')
    const filed = moveChatToFolder(state, 'c1', id)
    const renamed = renameFolder(filed, id, 'Specs')
    expect(folderOf(renamed, 'c1')).toBe(id)
  })
})

describe('moving a chat into a folder', () => {
  it('files the chat and takes it out of the ungrouped list', () => {
    const { state, id } = withFolder('proj-a')
    const next = moveChatToFolder(state, 'c2', id)
    const part = partitionByFolder(next, 'proj-a', chats('c1', 'c2', 'c3'), idOf)
    expect(part.folders[0]!.items.map(idOf)).toEqual(['c2'])
    expect(part.loose.map(idOf)).toEqual(['c1', 'c3'])
  })

  it('preserves the incoming (persisted) chat order inside a folder', () => {
    const { state, id } = withFolder('proj-a')
    let next = moveChatToFolder(state, 'c3', id)
    next = moveChatToFolder(next, 'c1', id)
    const part = partitionByFolder(next, 'proj-a', chats('c1', 'c2', 'c3'), idOf)
    expect(part.folders[0]!.items.map(idOf)).toEqual(['c1', 'c3'])
  })

  it('moves a chat between folders instead of filing it in both', () => {
    const a = createFolder(emptyFolderState(), 'proj-a', 'A')
    const b = createFolder(a.state, 'proj-a', 'B')
    let next = moveChatToFolder(b.state, 'c1', a.folder.id)
    next = moveChatToFolder(next, 'c1', b.folder.id)
    const part = partitionByFolder(next, 'proj-a', chats('c1'), idOf)
    expect(part.folders.map((x) => x.items.map(idOf))).toEqual([[], ['c1']])
    expect(part.loose).toEqual([])
  })

  it('refuses to file a chat into a folder that does not exist', () => {
    // Recording membership of nothing would render the chat ungrouped while the state claimed it was
    // filed — the "silently dropped a chat" failure this whole feature must not have.
    const { state } = withFolder('proj-a')
    expect(moveChatToFolder(state, 'c1', 'folder:gone')).toBe(state)
  })
})

describe('moving a chat back out of a folder', () => {
  it('returns it to the ungrouped list rather than orphaning it', () => {
    const { state, id } = withFolder('proj-a')
    const filed = moveChatToFolder(state, 'c2', id)
    const out = moveChatToFolder(filed, 'c2', null)
    expect(folderOf(out, 'c2')).toBeNull()
    const part = partitionByFolder(out, 'proj-a', chats('c1', 'c2', 'c3'), idOf)
    expect(part.folders[0]!.items).toEqual([])
    expect(part.loose.map(idOf)).toEqual(['c1', 'c2', 'c3'])
  })

  it('drops the assignment entirely (no tombstone left behind)', () => {
    const { state, id } = withFolder('proj-a')
    const out = moveChatToFolder(moveChatToFolder(state, 'c1', id), 'c1', null)
    expect(Object.keys(out.assignments)).toEqual([])
  })

  it('is a no-op for a chat that was never in a folder', () => {
    const { state } = withFolder('proj-a')
    expect(moveChatToFolder(state, 'c1', null)).toBe(state)
  })
})

describe('deleting a folder', () => {
  it('returns its chats to the ungrouped list instead of deleting them', () => {
    const { state, id } = withFolder('proj-a')
    const filed = moveChatToFolder(state, 'c2', id)
    const gone = deleteFolder(filed, id)
    expect(foldersFor(gone, 'proj-a')).toEqual([])
    const part = partitionByFolder(gone, 'proj-a', chats('c1', 'c2'), idOf)
    expect(part.loose.map(idOf)).toEqual(['c1', 'c2'])
  })

  it('leaves the other folders and their chats untouched', () => {
    const a = createFolder(emptyFolderState(), 'proj-a', 'A')
    const b = createFolder(a.state, 'proj-a', 'B')
    let next = moveChatToFolder(b.state, 'c1', a.folder.id)
    next = moveChatToFolder(next, 'c2', b.folder.id)
    const gone = deleteFolder(next, a.folder.id)
    expect(folderOf(gone, 'c2')).toBe(b.folder.id)
    expect(folderOf(gone, 'c1')).toBeNull()
  })

  it('is a no-op for an unknown id', () => {
    const { state } = withFolder('proj-a')
    expect(deleteFolder(state, 'folder:gone')).toBe(state)
  })
})

describe('stale persisted state degrades gracefully', () => {
  it('shows a chat whose folder no longer exists in the ungrouped list', () => {
    // Hand-built to mimic storage written by an older/other session: the assignment survived, the
    // folder did not. The chat MUST still be on screen.
    const state: FolderState = { folders: [], assignments: { c2: 'folder:vanished' } }
    const part = partitionByFolder(state, 'proj-a', chats('c1', 'c2', 'c3'), idOf)
    expect(part.folders).toEqual([])
    expect(part.loose.map(idOf)).toEqual(['c1', 'c2', 'c3'])
  })

  it('shows a chat assigned to ANOTHER group\'s folder in this group\'s ungrouped list', () => {
    const other = createFolder(emptyFolderState(), 'proj-b', 'Elsewhere')
    const state = moveChatToFolder(other.state, 'c1', other.folder.id)
    const part = partitionByFolder(state, 'proj-a', chats('c1'), idOf)
    expect(part.folders).toEqual([]) // proj-b's folder must not render inside proj-a
    expect(part.loose.map(idOf)).toEqual(['c1'])
  })

  it('never loses a chat: folders + loose always re-covers the input, whatever the state says', () => {
    const { state, id } = withFolder('proj-a')
    const messy: FolderState = {
      ...moveChatToFolder(state, 'c1', id),
      assignments: { c1: id, c2: 'folder:vanished', c4: id },
    }
    const input = chats('c1', 'c2', 'c3')
    const part = partitionByFolder(messy, 'proj-a', input, idOf)
    const seen = [...part.folders.flatMap((b) => b.items), ...part.loose].map(idOf).sort()
    expect(seen).toEqual(['c1', 'c2', 'c3'])
  })

  it('keeps an EMPTY folder in the partition so it stays visible and droppable', () => {
    const { state, id } = withFolder('proj-a')
    const part = partitionByFolder(state, 'proj-a', chats('c1'), idOf)
    expect(part.folders.map((b) => b.folder.id)).toEqual([id])
    expect(part.folders[0]!.items).toEqual([])
  })
})

describe('parsing persisted state (never throws, never hides chats)', () => {
  it('round-trips through localStorage', () => {
    const { state, id } = withFolder('proj-a', 'Docs')
    const filed = moveChatToFolder(state, 'c1', id)
    saveFolderState(filed)
    expect(loadFolderState()).toEqual(filed)
  })

  it('returns an empty state when nothing is stored', () => {
    expect(loadFolderState()).toEqual({ folders: [], assignments: {} })
  })

  it('falls back to an empty state on malformed JSON', () => {
    localStorage.setItem(FOLDERS_KEY, '{ not json')
    expect(loadFolderState()).toEqual({ folders: [], assignments: {} })
  })

  it('drops folder entries with missing or wrong-typed fields', () => {
    const parsed = parseFolderState({
      folders: [
        { id: 'folder:a', groupId: 'proj-a', name: 'Keep' },
        { id: 'folder:b', groupId: 'proj-a' }, // no name
        { id: 42, groupId: 'proj-a', name: 'Bad id' },
        null,
        'nope',
      ],
      assignments: {},
    })
    expect(parsed.folders.map((f) => f.id)).toEqual(['folder:a'])
  })

  it('drops a duplicate folder id (two headers that renamed as one)', () => {
    const parsed = parseFolderState({
      folders: [
        { id: 'folder:a', groupId: 'proj-a', name: 'First' },
        { id: 'folder:a', groupId: 'proj-a', name: 'Second' },
      ],
      assignments: {},
    })
    expect(parsed.folders).toEqual([{ id: 'folder:a', groupId: 'proj-a', name: 'First' }])
  })

  it('drops non-string assignment values', () => {
    const parsed = parseFolderState({ folders: [], assignments: { c1: 'folder:a', c2: 7, c3: null } })
    expect(parsed.assignments).toEqual({ c1: 'folder:a' })
  })

  it('KEEPS an assignment whose folder is missing from the list', () => {
    // Dropping it would permanently erase the membership of every chat in a folder whose single
    // record happened to be malformed. partitionByFolder already renders such a chat ungrouped.
    const parsed = parseFolderState({ folders: [], assignments: { c1: 'folder:a' } })
    expect(parsed.assignments).toEqual({ c1: 'folder:a' })
  })

  it('falls back to an empty state for an array or a primitive', () => {
    expect(parseFolderState([1, 2, 3])).toEqual({ folders: [], assignments: {} })
    expect(parseFolderState('folders!')).toEqual({ folders: [], assignments: {} })
    expect(parseFolderState(null)).toEqual({ folders: [], assignments: {} })
  })

  it('does not confuse the collapsed-id key with the folder-state key', () => {
    saveCollapsedFolders(['folder:a'])
    expect(localStorage.getItem(FOLDERS_KEY)).toBeNull()
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe(JSON.stringify(['folder:a']))
  })
})
