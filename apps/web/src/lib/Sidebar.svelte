<script lang="ts">
  import { untrack } from 'svelte'
  import { api, type ProjectInfo } from './api'
  import { store, type SessionView } from './store.svelte'
  import { alertDialog, confirmDialog } from './dialog.svelte'
  import { relativeTime } from './time'
  import { shouldBadgeNodes } from './fleetMerge'
  import Usage from './Usage.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import Icon from './Icon.svelte'
  import { unreadMailCount, unreadMailTitle } from './unreadMail'
  import ImportChats from './ImportChats.svelte'
  import GitHubImport from './GitHubImport.svelte'
  import { flip } from 'svelte/animate'
  import { cubicOut } from 'svelte/easing'
  import { loadCollapsedFolders, saveCollapsedFolders } from './uiState'
  import {
    createFolder,
    deleteFolder,
    isFolderId,
    loadFolderState,
    moveChatToFolder,
    partitionByFolder,
    renameFolder,
    saveFolderState,
    type ChatFolder,
    type FolderBucket,
  } from './folders'

  let filter = $state('')
  let showCreate = $state(false)
  let newName = $state('')
  let newPath = $state('')
  let createErr = $state('')
  let showGitHub = $state(false)

  function pathFor(id: string): string {
    return store.projects.find((p) => p.id === id)?.path ?? ''
  }
  function openImport(e: MouseEvent, id: string): void {
    e.stopPropagation()
    store.openImportPanel(id, pathFor(id))
  }
  let showUsage = $state(true)
  // Folder open/collapsed state, restored immediately on load so the sidebar looks exactly as the
  // operator left it across app restarts. The Set holds the COLLAPSED group ids; anything not in it
  // is expanded (the default). `toggleCollapse` reassigns the Set, so the persistence effect below
  // re-runs on every change and mirrors it to localStorage.
  let collapsed = $state(new Set<string>(loadCollapsedFolders()))
  $effect(() => {
    saveCollapsedFolders([...collapsed])
  })

  // Chat FOLDERS live in the same collapsed set (their ids are `folder:`-prefixed so they cannot
  // collide with a project id) — so a collapsed folder survives a restart through the persistence
  // that already existed for project groups, rather than a second parallel mechanism.
  let folders = $state(loadFolderState())
  $effect(() => {
    saveFolderState(folders)
  })

  function toggleCollapse(id: string): void {
    const next = new Set(collapsed)
    const expanding = next.has(id)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    collapsed = next
    // Expanding a project is an "open project" gesture — offer any un-imported chats (once/session).
    // Folder ids are excluded: expanding a folder is not opening a project, and its id is not a path.
    if (expanding && id !== '__none__' && !isFolderId(id)) void store.maybePromptImport(id, pathFor(id))
  }

  // --- Folders ---------------------------------------------------------------------------------
  // A folder is a CLIENT-ONLY sub-group inside a project group (see folders.ts for why it is not a
  // hub table). Creating one drops it in expanded and immediately opens its name for editing —
  // a folder called "New folder" that you then have to hunt for the rename button on is a dead end.
  function addFolder(e: MouseEvent, groupId: string): void {
    e.stopPropagation()
    const made = createFolder(folders, groupId)
    folders = made.state
    // Expand the group directly rather than via toggleCollapse: that path also fires the
    // "you opened a project, want to import its chats?" scan, and adding a folder is not that gesture.
    if (collapsed.has(groupId)) {
      const next = new Set(collapsed)
      next.delete(groupId)
      collapsed = next
    }
    startFolderRename(made.folder)
  }

  async function removeFolder(e: MouseEvent, f: ChatFolder, count: number): Promise<void> {
    e.stopPropagation()
    // Only ask when something is actually inside — and say plainly that the chats survive, because
    // "delete folder" reads like "delete its contents" and this one genuinely does not.
    if (count > 0) {
      const ok = await confirmDialog(
        // The VERB has to agree too, not just the noun — "Its 1 chat move back" is what you get from
        // pluralising only the noun, and a delete confirmation is the last place to look careless.
        `Delete the folder "${f.name}"? Its ${count} ${count === 1 ? 'chat moves' : 'chats move'} back into the project — no chat is deleted.`,
        { confirmLabel: 'Delete folder' }
      )
      if (!ok) return
    }
    folders = deleteFolder(folders, f.id)
  }

  // Inline rename, same shape as the chat rename below it: Enter commits, Esc cancels, blur commits.
  // Native prompt() is not an option — the desktop webview silently suppresses it (see dialog.svelte.ts).
  let editingFolderId = $state<string | null>(null)
  let folderDraft = $state('')
  function startFolderRename(f: ChatFolder, e?: Event): void {
    e?.stopPropagation()
    editingId = null // never leave a chat rename half-open behind a folder rename
    editingFolderId = f.id
    folderDraft = f.name
  }
  function commitFolderRename(): void {
    if (editingFolderId) folders = renameFolder(folders, editingFolderId, folderDraft)
    editingFolderId = null
  }

  // SILENCE is what stalled means — not duration.
  //
  // This measured from turnStartedAt, so ANY turn running longer than three minutes was flagged, however
  // healthily it was streaming. That is fine for a chat that answers in seconds and wrong for the thing
  // this app exists to run: a max-effort agent doing real work takes tens of minutes, and every one of
  // them sat permanently marked. The operator read the warning treatment as "errored" — reasonably, since
  // a warning that is always on carries no information and the tooltip only says otherwise on hover.
  //
  // `lastActivity` already advances on essentially every event of a live turn, so the honest signal was
  // sitting right there: a turn producing output is not stalled by definition, at any duration, and one
  // producing nothing for minutes is suspect at any age.
  //
  // Five minutes of TOTAL SILENCE. Measured gaps within a healthy turn run seconds — the sub-agent work
  // clocked a median of 4-13s and a worst observed 102s — so this is roughly 3x the worst normal gap and
  // still catches a genuinely wedged turn well before an operator would.
  const STALL_MS = 5 * 60 * 1000
  function isStalled(s: SessionView): boolean {
    if (s.record.status !== 'active') return false
    const last = Date.parse(s.lastActivity)
    if (!Number.isFinite(last)) return false // no usable timestamp — never guess "stalled"
    return Date.now() - last > STALL_MS
  }
  function warnOf(s: SessionView, st: { key: string }): boolean {
    return st.key === 'error' || isStalled(s)
  }
  function warnTitle(st: { key: string }): string {
    return st.key === 'error' ? 'errored — needs attention' : 'stalled — no progress for a while'
  }

  // --- Materialize / rename glitch --------------------------------------------------------------
  // The store stamps a chat id into `recentlyChanged` when it MATERIALIZES (draft → real) or is
  // (re)TITLED. We flip a transient `.glitch` class on that row's label for a short window, then
  // clear it so a later change can retrigger. `prefers-reduced-motion` is honoured by the CSS
  // (the keyframes live behind a no-preference media query, so reduced motion just updates instantly).
  let glitching = $state(new Set<string>())
  const glitchSeen = new Map<string, number>()
  $effect(() => {
    const marks = store.recentlyChanged
    for (const id in marks) {
      const ts = marks[id]
      if (ts == null || glitchSeen.get(id) === ts) continue
      glitchSeen.set(id, ts)
      untrack(() => {
        const next = new Set(glitching)
        next.add(id)
        glitching = next
      })
      setTimeout(() => {
        const next = new Set(glitching)
        next.delete(id)
        glitching = next
      }, 760)
    }
  })

  interface Summary {
    providers: ('claude' | 'codex')[]
    done: number
    review: number
    stalled: number
    working: number
  }

  function summarize(sessions: SessionView[]): Summary {
    const providers = new Set<'claude' | 'codex'>()
    let done = 0
    let review = 0
    let stalled = 0
    let working = 0
    for (const s of sessions) {
      providers.add(s.record.provider)
      const k = store.status(s).key
      if (k === 'completed') done++
      else if (k === 'approval' || k === 'question') review++
      else if (k === 'error') stalled++
      else if (k === 'working' || k === 'starting') working++
    }
    return { providers: [...providers], done, review, stalled, working }
  }

  async function browse(): Promise<void> {
    const { path } = await api.pickFolder()
    if (path) {
      newPath = path
      // inherit the project name from the chosen folder
      newName = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    }
  }

  function label(s: SessionView): string {
    if (s.record.title) return s.record.title
    const p = s.record.worktree ?? s.record.repo ?? s.record.cwd
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
  }

  // Inline rename: double-click the label (or the rename action). Enter commits, Esc cancels.
  let editingId = $state<string | null>(null)
  let draft = $state('')
  function startRename(e: Event, s: SessionView): void {
    e.stopPropagation()
    editingFolderId = null // and vice versa — only one inline editor is ever open
    editingId = s.record.id
    draft = label(s)
  }
  function commitRename(): void {
    if (editingId) store.renameSession(editingId, draft)
    editingId = null
  }
  function focusInput(node: HTMLInputElement): void {
    node.focus()
    node.select()
  }

  interface Group {
    id: string
    name: string
    /** Every chat in the group, folders or not — the count + collapsed summary read this. */
    sessions: SessionView[]
    /** The group's folders, each with the chats filed under it (order preserved from `sessions`). */
    foldered: FolderBucket<SessionView>[]
    /** Chats in the group that are in no folder. `foldered` + `loose` always re-covers `sessions`. */
    loose: SessionView[]
    // Set only for a project that lives on a REMOTE fleet machine → renders a small site badge.
    // Absent for this hub's own (local) projects, so the single-machine view is unchanged.
    siteLabel?: string
    // False when that machine did not answer the last roster probe: the rows are the last known state,
    // shown dimmed rather than deleted, so "the box is off" never looks like "my work disappeared".
    siteOnline?: boolean
  }

  // Node badges only matter once the fleet has more than one machine; on a single-machine install they
  // are pure noise, so the sidebar looks exactly as it always has. The local machine's label comes from
  // the roster's `local` entry.
  const multiSite = $derived(shouldBadgeNodes(store.fleetSites.length))
  const localLabel = $derived(store.fleetSites.find((s) => s.local)?.label ?? 'this machine')

  // Bucket the roster into project groups. The ORDER inside a group is `store.orderedChats`, never a
  // sort here: it is a total order over settled recency that deliberately ignores streaming activity,
  // so a running agent cannot drag its row up the list under the cursor (see chatOrder.ts). This
  // derived still re-runs on every event — it just returns the same arrangement, which the keyed
  // {#each} below turns into no DOM movement at all.
  const groups = $derived.by(() => {
    const q = filter.toLowerCase()
    const match = (s: SessionView): boolean =>
      !q || `${s.record.profileId} ${s.record.cwd} ${s.record.model ?? ''}`.toLowerCase().includes(q)
    const byProject = new Map<string, SessionView[]>()
    for (const s of store.sessionList) {
      if (!match(s)) continue
      const key = s.record.projectId ?? '__none__'
      const arr = byProject.get(key) ?? []
      arr.push(s)
      byProject.set(key, arr)
    }
    // Split each group's ordered chats across its folders. Anything whose folder was deleted (or
    // belongs to another group) comes back in `loose`, so stale persisted state costs a folder and
    // never a chat — see partitionByFolder.
    const build = (id: string, name: string, sessions: SessionView[], site?: Partial<Group>): Group => {
      const part = partitionByFolder(folders, id, sessions, (s) => s.record.id)
      // With no search, an EMPTY folder still renders — it has to, or it could never be a drop
      // destination. While searching it is pure noise: you are looking for chats, not for a target.
      const buckets = filter ? part.folders.filter((b) => b.items.length > 0) : part.folders
      return { id, name, sessions, foldered: buckets, loose: part.loose, ...site }
    }
    const out: Group[] = []
    for (const p of store.orderedProjects) {
      const ss = byProject.get(p.id) ?? []
      if (ss.length || !filter) out.push(build(p.id, p.name, store.orderedChats(p.id, ss), { siteLabel: p.siteLabel, siteOnline: p.siteOnline }))
    }
    const none = byProject.get('__none__')
    if (none?.length) out.push(build('__none__', 'Unfiled', store.orderedChats('__none__', none)))
    return out
  })

  // --- Flattened render list -------------------------------------------------------------------
  // One group renders as a FLAT sequence of entries (folder header, chat row, empty-folder drop
  // target) rather than nested lists. That is not cosmetic: `animate:flip` only works on the
  // immediate child of a keyed {#each}, so nesting the folder chats in their own inner each would
  // have split the group into several animation scopes and a chat dragged INTO a folder would jump
  // instead of gliding. Flat + one wrapper element per entry keeps the whole group in one scope.
  //
  // `railId` is the folder whose vertical rail the entry sits inside (null = not in a folder), which
  // is also exactly what a drag needs to know to decide "move into" vs "reorder within".
  type Entry =
    | { key: string; kind: 'folder'; railId: null; railEnd: false; folder: ChatFolder; count: number }
    | { key: string; kind: 'empty'; railId: string; railEnd: true; folder: ChatFolder }
    | {
        key: string
        kind: 'chat'
        railId: string | null
        railEnd: boolean
        s: SessionView
        managerDepth: number
        managerHasChildren: boolean
        managerChildCount: number
        attentionRevealed: boolean
        orphanedManager: boolean
      }

  function entriesFor(g: Group): Entry[] {
    const out: Entry[] = []
    const byId = new Map(g.sessions.map((item) => [item.record.id, item]))
    const children = new Map<string, SessionView[]>()
    const orphaned = new Set<string>()
    for (const item of g.sessions) {
      const parent = item.record.parentSessionId
      if (!parent) continue
      if (!byId.get(parent)?.record.isProjectManager) {
        // A child can outlive a deleted manager (or a revoked manager role). It must remain a root row,
        // but it should not silently lose the context that it was delegated work.
        orphaned.add(item.record.id)
        continue
      }
      const list = children.get(parent) ?? []
      list.push(item)
      children.set(parent, list)
    }
    const linked = new Set([...children.values()].flat().map((item) => item.record.id))
    const pending = store.pendingBySession
    const needsAttention = (item: SessionView): boolean => {
      const status = store.status(item)
      return (pending[item.record.id] ?? 0) > 0 || warnOf(item, status)
    }
    const attentionMemo = new Map<string, boolean>()
    const subtreeNeedsAttention = (item: SessionView, path = new Set<string>()): boolean => {
      const known = attentionMemo.get(item.record.id)
      if (known !== undefined) return known
      if (path.has(item.record.id)) return false
      const nextPath = new Set(path)
      nextPath.add(item.record.id)
      const result = needsAttention(item)
        || (children.get(item.record.id) ?? []).some((child) => subtreeNeedsAttention(child, nextPath))
      attentionMemo.set(item.record.id, result)
      return result
    }
    const emitted = new Set<string>()
    const suppressed = new Set<string>()
    const suppressTree = (item: SessionView): void => {
      if (suppressed.has(item.record.id)) return
      suppressed.add(item.record.id)
      for (const child of children.get(item.record.id) ?? []) suppressTree(child)
    }
    const appendTree = (
      roots: SessionView[],
      railId: string | null
    ): void => {
      const rows: Array<{
        s: SessionView
        depth: number
        nested: SessionView[]
        attentionRevealed: boolean
      }> = []
      const visit = (item: SessionView, depth: number, attentionOnly = false, attentionRevealed = false): void => {
        if (emitted.has(item.record.id) || suppressed.has(item.record.id)) return
        emitted.add(item.record.id)
        const nested = children.get(item.record.id) ?? []
        rows.push({ s: item, depth, nested, attentionRevealed })
        if (attentionOnly || collapsed.has(`manager:${item.record.id}`)) {
          // Collapse hides routine work, not work that needs the operator. Preserve the ancestry path
          // to each approval/error so the urgent row is both findable and still attributable.
          for (const child of nested) {
            if (subtreeNeedsAttention(child)) visit(child, depth + 1, true, true)
            else suppressTree(child)
          }
          return
        }
        for (const child of nested) visit(child, depth + 1)
      }
      for (const root of roots) visit(root, 0)
      rows.forEach(({ s, depth, nested, attentionRevealed }, index) => {
        out.push({
          key: `c:${s.record.id}`,
          kind: 'chat',
          railId,
          railEnd: railId !== null && index === rows.length - 1,
          s,
          managerDepth: depth,
          managerHasChildren: nested.length > 0,
          managerChildCount: nested.length,
          attentionRevealed,
          orphanedManager: orphaned.has(s.record.id),
        })
      })
    }

    for (const b of g.foldered) {
      out.push({ key: `f:${b.folder.id}`, kind: 'folder', railId: null, railEnd: false, folder: b.folder, count: b.items.length })
      const roots = b.items.filter((item) => !linked.has(item.record.id))
      if (collapsed.has(b.folder.id)) {
        for (const root of roots) suppressTree(root)
        continue
      }
      if (b.items.length === 0) {
        out.push({ key: `e:${b.folder.id}`, kind: 'empty', railId: b.folder.id, railEnd: true, folder: b.folder })
        continue
      }
      appendTree(roots, b.folder.id)
    }
    appendTree(g.loose.filter((item) => !linked.has(item.record.id)), null)

    // Broken/cyclic lineage must never make a chat disappear. Children hidden by a deliberate collapsed
    // ancestor are in `suppressed`; every other unrendered row falls back to the loose root level.
    for (const item of g.sessions) {
      if (!emitted.has(item.record.id) && !suppressed.has(item.record.id)) appendTree([item], null)
    }
    return out
  }

  // --- Drag-to-reorder (native HTML5 DnD) ------------------------------------------------------
  // The whole chat ROW and the project group HEADER are the drag affordance — the SAME native drag a
  // chat already used to open/split OUT in the pane area. `dragstart` arms a reorder; then `dragover`
  // fires CONTINUOUSLY on whatever row/header sits under the cursor, so we reorder live in the store
  // and the keyed {#each} items FLIP to open a gap. Because dragover streams, one gesture slides an
  // item past many neighbours (continuous multi-move) and a new drag can start immediately — no
  // pointer-events:none / elementFromPoint / remount fragility.
  //
  // A CHAT drag ALSO sets `store.dragSession`, so dragging it OUT over the panes still opens/splits
  // it (App.svelte drives that off dragSession + cursor position). While the cursor is over the
  // sidebar we keep `store.dropZone` cleared, so the pane drop-ghost never shows: over the sidebar it
  // is a REORDER, over the panes it is an OPEN. A PROJECT drag never sets dragSession — reordering
  // groups is sidebar-local and must never open a pane.
  //
  // FOLDERS ride on the same gesture with one extra rule: while the cursor is over a container the
  // dragged chat is NOT already in (another folder, or the group's ungrouped area), we do NOT reorder
  // — we only PREVIEW a move by setting `folderDrop`, and commit it on the sidebar's own `drop`.
  // Committing live on dragover would suck a chat into every folder it merely passed over; and doing
  // it on `dragend` instead would also fire for a drop over the PANES, silently refiling a chat you
  // only meant to open. Drop is the one event that means "here".
  type DragState = { kind: 'chat'; groupId: string; id: string; folderId: string | null } | { kind: 'project'; id: string }
  let dragging = $state<DragState | null>(null)
  // Where a chat-drop would land: the group + the folder (null = out of any folder, back to ungrouped).
  // Null when the hovered container is the one the chat is already in, so nothing lights up for a no-op.
  let folderDrop = $state<{ groupId: string; folderId: string | null } | null>(null)
  // Last target id we reordered onto — skip repeats so a stationary cursor can't oscillate.
  let lastOverId: string | null = null

  function isDropTarget(groupId: string, folderId: string | null): boolean {
    return folderDrop?.groupId === groupId && folderDrop.folderId === folderId
  }

  const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // FLIP only WHILE dragging (the list otherwise re-sorts by recency as agents work; keeping those
  // instant avoids constant shuffling, so the glide is reserved for a deliberate reorder). Crucially
  // the params know WHICH kind is dragging: a PROJECT drag animates the whole GROUP as one unit
  // (header + its chats glide together) while the per-row flip is turned OFF so the chats ride along
  // instead of double-animating/snapping; a CHAT drag animates the rows to open a gap. Reduced-motion
  // disables both (instant reorder, no glide).
  const dragKind = $derived(dragging?.kind ?? null)
  const groupFlip = $derived({ duration: dragKind === 'project' && !reduceMotion ? 190 : 0, easing: cubicOut })
  const rowFlip = $derived({ duration: dragKind === 'chat' && !reduceMotion ? 190 : 0, easing: cubicOut })

  function isDragging(kind: 'project' | 'chat', id: string): boolean {
    return dragging?.kind === kind && dragging.id === id
  }

  // dragstart on a CHAT row: arm a chat reorder AND set dragSession, so dragging OUT into the panes
  // opens/splits it (the drop-to-open path in App.svelte).
  function startChatDrag(e: DragEvent, groupId: string, id: string, folderId: string | null): void {
    dragging = { kind: 'chat', groupId, id, folderId }
    folderDrop = null
    lastOverId = null
    store.dragSession = id
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  // dragstart on a group HEADER: arm a project reorder. Deliberately does NOT touch dragSession — a
  // project drag reorders groups within the sidebar and never opens a pane.
  function startProjectDrag(e: DragEvent, id: string): void {
    dragging = { kind: 'project', id }
    folderDrop = null
    lastOverId = null
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function endDrag(): void {
    dragging = null
    // Dropped somewhere that is not the sidebar (the panes, or nowhere at all) — discard the preview
    // WITHOUT applying it. `drop` always fires before `dragend`, so a real sidebar drop has already
    // committed by the time we get here.
    folderDrop = null
    lastOverId = null
    store.endDragSession() // clears dragSession + dropZone (a no-op harmless path when a project was dragged)
  }

  // Live reorder driven by a continuous `dragover`. `groupId` is the group under the cursor; `chatId`
  // is the chat row under it (undefined over a header). preventDefault marks a valid drop target (so
  // dragover keeps firing and the move cursor shows); clearing dropZone keeps the pane ghost hidden
  // while we reorder inside the sidebar. The lastOverId guard — reset to null whenever we hover the
  // dragged item itself — stops oscillation yet allows immediate re-entry, so a drag can sweep an
  // item back and forth across the same neighbours fluidly.
  // `folderId` is the container under the cursor: the folder a row/header/placeholder belongs to, or
  // null for the group header and the ungrouped rows (which is what makes dragging a chat OUT work —
  // it is just a move to the null container, never an orphaning).
  function dragOverTarget(e: DragEvent, groupId: string, chatId?: string, folderId: string | null = null): void {
    const cur = dragging
    if (!cur) return
    e.preventDefault()
    store.dropZone = null
    if (cur.kind === 'project') {
      folderDrop = null
      // Hovering a group's header OR any of its rows counts as hovering that whole group.
      if (groupId === cur.id) { lastOverId = null; return }
      if (groupId === lastOverId || groupId === '__none__') return
      store.reorderProjects(cur.id, groupId)
      lastOverId = groupId
    } else {
      // Another project's rows: nothing to offer. The hub owns `projectId` and exposes no route to
      // change it, so a chat can only be filed into a folder of the project it already belongs to.
      if (groupId !== cur.groupId) { folderDrop = null; return }
      if (folderId !== cur.folderId) {
        // Different container → this is a MOVE. Preview only; reordering here as well would shuffle
        // the list underneath a gesture that is on its way somewhere else.
        folderDrop = { groupId, folderId }
        lastOverId = null
        return
      }
      folderDrop = null
      // Same container → the original behaviour: live reorder. A header/placeholder (no chatId) is
      // an inert target.
      const overId = chatId ?? groupId
      if (overId === cur.id) { lastOverId = null; return }
      if (overId === lastOverId) return
      if (chatId) {
        store.reorderChats(cur.groupId, cur.id, chatId)
        lastOverId = overId
      }
    }
  }

  const preventIfDragging = (e: DragEvent): void => { if (dragging) e.preventDefault() }

  // Over sidebar chrome that is not itself a row/header (gaps, empty list space): still a reorder
  // surface, so keep the pane ghost hidden and accept the drop (which just finalises via dragend).
  function onListDragOver(e: DragEvent): void {
    if (!dragging) return
    e.preventDefault()
    store.dropZone = null
  }
  // The ONE place a folder move is committed. Every zone inside the sidebar list lets its `drop`
  // bubble up to here, so there is a single commit point rather than a handler per folder — and a
  // drop over the PANES never reaches it, which is exactly why drag-to-open still just opens.
  function onListDrop(e: DragEvent): void {
    if (!dragging) return
    e.preventDefault()
    const target = folderDrop
    if (dragging.kind === 'chat' && target && target.groupId === dragging.groupId) {
      const next = moveChatToFolder(folders, dragging.id, target.folderId)
      if (next !== folders) folders = next
    }
    folderDrop = null
  }


  async function createProject(): Promise<void> {
    createErr = ''
    const out = await api.createProject(newName, newPath)
    if ('error' in out) {
      createErr = out.error
      return
    }
    newName = ''
    newPath = ''
    showCreate = false
    await store.refreshProjects()
    // Offer to adopt any existing Claude/Codex chats that already live for this folder.
    store.openImportPanel(out.id, out.path)
  }

  async function githubImported(project: ProjectInfo): Promise<void> {
    await store.refreshProjects()
    showGitHub = false
    showCreate = false
    // A selected project draft is the app's normal "new agent" state: no vendor process is started just
    // for opening it, and the first message materializes the agent with this project as its destination.
    await store.newSession(undefined, project.id)
  }

  async function act(e: MouseEvent, id: string, verb: 'interrupt' | 'stop'): Promise<void> {
    e.stopPropagation()
    const out = verb === 'interrupt' ? await api.interrupt(id) : await api.stop(id)
    // These compact controls sit outside ThreadView's inline action-error footer. Preserve the same
    // contract here with an in-app alert: jpost resolves a refusal as `{ error }`, so awaiting it without
    // inspecting the value makes a rejected Stop/Interrupt look successful.
    if (out.error) await alertDialog(`${verb} failed: ${out.error}`)
  }

  async function del(e: MouseEvent, id: string, name: string): Promise<void> {
    e.stopPropagation()
    const ok = await confirmDialog(`Delete "${name}"? This ends the session and removes the chat from the hub.`, {
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    await store.deleteSession(id)
  }
</script>

<div class="sidebar">
  <!-- Connectivity strip (its own row, below the title bar, above search). The title bar owns the ONE
       brand/wordmark now, so this no longer repeats it; it carries the home control (kept as a one-click
       button — deleting the old brand button would have removed the way back to the dashboard) and reads
       out the hub connection in WORDS, not just a colour, from store.connected + store.hubDownSeconds. -->
  <div class="connbar">
    <button class="homebtn" title="home / dashboard" aria-label="home / dashboard" onclick={() => store.goHome()}><Icon name="home" size={15} /></button>
    <span class="conn-label" class:down={!store.connected}>
      {store.connected ? 'Connected' : store.hubDownSeconds > 0 ? `Reconnecting… ${store.hubDownSeconds}s` : 'Reconnecting…'}
    </span>
    <span class="conn-dot" class:on={store.connected}></span>
  </div>

  <div class="search"><span class="sicon"><Icon name="search" size={13} /></span><input placeholder="Search sessions" bind:value={filter} /></div>

  <div class="sec-head">
    <span>PROJECTS</span>
    <span class="sec-actions">
      <button class="manager-entry" title="project managers" onclick={() => store.openManagerSetup()}>
        <Icon name="flag" size={12} /><span>Managers</span>
      </button>
      <button class="icon" class:on={showCreate} title="new project" onclick={() => (showCreate = !showCreate)}><Icon name="folder-plus" size={15} /></button>
      <button class="icon" title="new chat" onclick={() => store.newSession()}><Icon name="square-pen" size={15} /></button>
    </span>
  </div>

  {#if showCreate}
    <div class="panel">
      <input placeholder="project name" bind:value={newName} />
      <div class="path-row">
        <input placeholder="folder path" bind:value={newPath} />
        <button class="browse" title="browse folders" onclick={browse}><Icon name="folder" size={14} /></button>
      </div>
      <button class="mkbtn" onclick={createProject}>create project</button>
      {#if createErr}<div class="err">{createErr}</div>{/if}
      <button class="ghbtn" class:on={showGitHub} onclick={() => (showGitHub = !showGitHub)}>
        <Icon name="git-branch" size={13} />
        Clone from GitHub
      </button>
      {#if showGitHub}
        <GitHubImport onImported={githubImported} onClose={() => (showGitHub = false)} />
      {/if}
    </div>
  {/if}

  {#snippet gripIcon()}
    <svg class="gripicon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="5" r="1.5" /><circle cx="15" cy="5" r="1.5" />
      <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="19" r="1.5" /><circle cx="15" cy="19" r="1.5" />
    </svg>
  {/snippet}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="list scroll" class:reordering={!!dragging} role="presentation" ondragover={onListDragOver} ondrop={onListDrop}>
    {#each groups as g (g.id)}
      {@const isCollapsed = collapsed.has(g.id)}
      {@const reorderable = g.id !== '__none__'}
      <div class="group" class:dragging={isDragging('project', g.id)} animate:flip={groupFlip}>
        <!-- The whole header is the project drag handle; '__none__' (Unfiled) is not reorderable. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="group-head" class:draghandle={reorderable} class:droptarget={isDropTarget(g.id, null)} draggable={reorderable}
          ondragstart={(e) => startProjectDrag(e, g.id)}
          ondragend={endDrag}
          ondragover={(e) => dragOverTarget(e, g.id)}
          ondragenter={preventIfDragging}>
          {#if reorderable}
            <span class="grip" aria-hidden="true">{@render gripIcon()}</span>
          {/if}
          <button class="folder" title={isCollapsed ? 'expand' : 'collapse'} onclick={() => toggleCollapse(g.id)}><Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} /></button>
          <span class="gname">{g.name}</span>
          {#if multiSite}
            <!--
              WHERE this project lives, and whether we can reach it — as an icon, not a word.
              This used to print the machine's NAME in the row ("AllMyAgents"), which cost up to 9rem of a
              narrow sidebar to repeat the same string down the whole list, and squeezed out the thing you
              actually scan for: the chat's own name. The identity belongs in the tooltip, where you go
              when you want it; the row only needs to answer "mine or elsewhere, and is elsewhere up".

              Shape carries local-vs-remote (monitor vs server) and colour carries reachability, so
              neither meaning depends on distinguishing two colours at 11px.
            -->
            <span
              class="sbadge {g.siteLabel == null ? 'here' : g.siteOnline === false ? 'down' : 'up'}"
              title={g.siteLabel
                ? `on ${g.siteLabel} — ${g.siteOnline === false ? 'unreachable, showing the last known state' : 'reachable'}`
                : `on ${localLabel} (this machine)`}
            >
              <Icon name={g.siteLabel == null ? 'monitor' : 'server'} size={11} />
            </span>
          {/if}
          <span class="gcount dim tnum">{g.sessions.length}</span>
          <!-- Unfiled gets this one too: chats land there by default, so it is the group that most
               needs tidying, and a folder there costs the hub nothing (see folders.ts). -->
          <button class="gadd" title="new folder" onclick={(e) => addFolder(e, g.id)}><Icon name="folder-plus" size={13} /></button>
          {#if g.id !== '__none__'}
            <button class="gadd" title="import existing chats" onclick={(e) => openImport(e, g.id)}><Icon name="download" size={13} /></button>
            <button class="gadd" title="new chat here" onclick={() => store.newSession(undefined, g.id)}><Icon name="plus" size={14} /></button>
          {/if}
        </div>
        {#if store.importPanelFor?.projectId === g.id}
          <ImportChats projectId={g.id} path={store.importPanelFor.path} preloaded={store.importPanelFor.preloaded} onClose={() => store.closeImportPanel()} />
        {/if}
        {#if isCollapsed && g.sessions.length}
          {@const sum = summarize(g.sessions)}
          <div class="summary" role="button" tabindex="0" onclick={() => toggleCollapse(g.id)} onkeydown={(e) => { if (e.key === 'Enter') toggleCollapse(g.id) }}>
            <span class="logos">{#each sum.providers as pv (pv)}<ProviderLogo provider={pv} size={12} />{/each}</span>
            {#if sum.working}<span class="sc working" title="working"><Icon name="play" size={10} /><span class="tnum">{sum.working}</span></span>{/if}
            {#if sum.review}<span class="sc review" title="ready for review"><Icon name="flag" size={10} /><span class="tnum">{sum.review}</span></span>{/if}
            {#if sum.done}<span class="sc done" title="completed"><Icon name="check" size={11} /><span class="tnum">{sum.done}</span></span>{/if}
            {#if sum.stalled}<span class="sc stalled" title="stalled / error"><Icon name="x" size={11} /><span class="tnum">{sum.stalled}</span></span>{/if}
          </div>
        {/if}
        {#if !isCollapsed}
        <!-- One flat keyed list per group: folder headers, chat rows and empty-folder drop targets
             share a wrapper element so `animate:flip` stays legal (it must sit on the immediate child
             of a keyed each) and the whole group animates as one scope. `.infolder` draws the
             indent + the vertical rail; adjacent entries' rails join into one continuous line. -->
        {#each entriesFor(g) as en (en.key)}
          <div class="entry" class:infolder={en.railId !== null} class:railend={en.railEnd}
            class:railhot={en.railId !== null && isDropTarget(g.id, en.railId)} animate:flip={rowFlip}>
            {#if en.kind === 'folder'}
              {@const f = en.folder}
              {@const fCollapsed = collapsed.has(f.id)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="folder-head" class:droptarget={isDropTarget(g.id, f.id)}
                ondragover={(e) => dragOverTarget(e, g.id, undefined, f.id)}
                ondragenter={preventIfDragging}>
                <button class="folder" title={fCollapsed ? 'expand folder' : 'collapse folder'} onclick={() => toggleCollapse(f.id)}><Icon name={fCollapsed ? 'chevron-right' : 'chevron-down'} size={12} /></button>
                <span class="ficon" aria-hidden="true"><Icon name="folder" size={12} /></span>
                {#if editingFolderId === f.id}
                  <input class="rename-input" bind:value={folderDraft} use:focusInput
                    onclick={(e) => e.stopPropagation()}
                    onpointerdown={(e) => e.stopPropagation()}
                    onkeydown={(e) => { if (e.key === 'Enter') commitFolderRename(); else if (e.key === 'Escape') editingFolderId = null }}
                    onblur={commitFolderRename} />
                {:else}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <span class="fname" title="double-click to rename" ondblclick={(e) => startFolderRename(f, e)}>{f.name}</span>
                {/if}
                <span class="gcount dim tnum">{en.count}</span>
                <span class="factions">
                  <button class="mini" title="rename folder" onclick={(e) => startFolderRename(f, e)}><Icon name="pencil" size={12} /></button>
                  <button class="mini del" title="delete folder (chats stay)" onclick={(e) => removeFolder(e, f, en.count)}><Icon name="trash" size={12} /></button>
                </span>
              </div>
            {:else if en.kind === 'empty'}
              <!-- An empty folder MUST stay visible and droppable, or it could never become non-empty. -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="fempty dim" class:droptarget={isDropTarget(g.id, en.folder.id)}
                ondragover={(e) => dragOverTarget(e, g.id, undefined, en.folder.id)}
                ondragenter={preventIfDragging}>drag chats here</div>
            {:else}
              {@const s = en.s}
              {@const st = store.status(s)}
              {@const pending = store.pendingBySession[s.record.id] ?? 0}
              {@const unread = unreadMailCount(s.record.unreadFromTeammates)}
              <div
                class="row"
                class:sel={store.selectedId === s.record.id}
                class:dragging={isDragging('chat', s.record.id)}
                class:manager={s.record.isProjectManager}
                class:managedchild={en.managerDepth > 0}
                class:attentionchild={en.attentionRevealed}
                class:orphanedchild={en.orphanedManager}
                style={`--manager-depth:${en.managerDepth}`}
                role="button"
                tabindex="0"
                draggable={editingId !== s.record.id}
                ondragstart={(e) => startChatDrag(e, g.id, s.record.id, en.railId)}
                ondragend={endDrag}
                ondragover={(e) => dragOverTarget(e, g.id, s.record.id, en.railId)}
                ondragenter={preventIfDragging}
                onclick={() => store.select(s.record.id)}
                onkeydown={(e) => { if (e.key === 'Enter') store.select(s.record.id) }}>
                <span class="grip" aria-hidden="true">{@render gripIcon()}</span>
                {#if en.managerHasChildren}
                  <button
                    class="manager-toggle"
                    title={collapsed.has(`manager:${s.record.id}`) ? 'expand child agents' : 'collapse child agents'}
                    onclick={(e) => {
                      e.stopPropagation()
                      toggleCollapse(`manager:${s.record.id}`)
                    }}
                  >
                    <Icon name={collapsed.has(`manager:${s.record.id}`) ? 'chevron-right' : 'chevron-down'} size={11} />
                  </button>
                {:else if en.managerDepth > 0}
                  <span class="manager-branch" aria-hidden="true"><Icon name="corner-down-right" size={10} /></span>
                {:else if en.orphanedManager}
                  <span class="manager-orphan" title="delegated child · manager is no longer available" aria-label="manager is no longer available">
                    <Icon name="flag" size={11} />
                  </span>
                {/if}
                <span class="dot {st.key}" title={st.label}></span>
                <ProviderLogo provider={s.record.provider} size={13} />
                {#if s.record.imported}<span class="ibadge" title="imported from an existing {s.record.provider} chat"><Icon name="download" size={10} /></span>{/if}
                {#if editingId === s.record.id}
                  <input class="rename-input" bind:value={draft} use:focusInput
                    onclick={(e) => e.stopPropagation()}
                    onpointerdown={(e) => e.stopPropagation()}
                    onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') editingId = null }}
                    onblur={commitRename} />
                {:else if s.record.isProjectManager}
                  <span class="manager-identity">
                    <!-- The scientist name stays untouched; the role is a subordinate marker, not a rename. -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span class="rlabel" class:glitch={glitching.has(s.record.id)} ondblclick={(e) => startRename(e, s)}>{label(s)}</span>
                    <button
                      class="manager-role"
                      title="project manager · runs and oversees this team · view scope"
                      aria-label={`View project manager scope for ${label(s)}`}
                      onclick={(event) => {
                        event.stopPropagation()
                        store.openManagerSetup(s.record.id)
                      }}
                    >
                      <Icon name="flag" size={9} />
                      <span>manager · {en.managerChildCount} {en.managerChildCount === 1 ? 'agent' : 'agents'}</span>
                    </button>
                  </span>
                {:else}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <span class="rlabel" class:glitch={glitching.has(s.record.id)} ondblclick={(e) => startRename(e, s)}>{label(s)}</span>
                {/if}
                {#if s.record.worktree}
                  <span class="wtbadge" title={s.record.worktree} aria-label={`Worktree branch ${s.record.branch ?? s.record.worktree.split(/[\\/]/).pop()}`}>
                    <Icon name="git-branch" size={9} />
                    <span>{s.record.branch ?? s.record.worktree.split(/[\\/]/).pop()}</span>
                  </span>
                {/if}
                {#if s.record.siteLabel}<span class="rbadge" title="on {s.record.siteLabel} (remote fleet machine)"><Icon name="server" size={9} /></span>{/if}
                {#if unread > 0}<span class="mbadge" title={unreadMailTitle(unread)} aria-label={unreadMailTitle(unread)}><Icon name="mail" size={10} /><span class="tnum">{unread}</span></span>{/if}
                {#if pending > 0}<span class="pbadge tnum">{pending}</span>{/if}
                {#if warnOf(s, st)}
                  <span class="rwarn" title={warnTitle(st)} aria-label={warnTitle(st)}><Icon name="alert-triangle" size={12} /></span>
                  <span class="rtime dim tnum">{relativeTime(s.lastActivity)}</span>
                {:else if st.key === 'working' || st.key === 'starting'}
                  <span class="rtime rdots" title={st.label} aria-label="working"><i></i><i></i><i></i></span>
                {:else}
                  <span class="rtime dim tnum">{relativeTime(s.lastActivity)}</span>
                {/if}
                <span class="ractions">
                  <button class="mini" title="rename" onclick={(e) => startRename(e, s)}><Icon name="pencil" size={12} /></button>
                  <button class="mini" title="interrupt" onclick={(e) => act(e, s.record.id, 'interrupt')}><Icon name="square" size={12} /></button>
                  <button class="mini" title="stop" onclick={(e) => act(e, s.record.id, 'stop')}><Icon name="x" size={13} /></button>
                  <button class="mini del" title="delete chat" onclick={(e) => del(e, s.record.id, label(s))}><Icon name="trash" size={12} /></button>
                </span>
              </div>
            {/if}
          </div>
        {/each}
        {/if}
      </div>
    {/each}
    {#if groups.length === 0}
      <div class="empty dim">{filter ? 'no matches' : 'create a project (⊞) or start a session (+)'}</div>
    {/if}
  </div>

  <div class="footer">
    <div class="foot-bar">
      <button class="foot-head" onclick={() => (showUsage = !showUsage)}><span>USAGE</span><span class="dim fchev"><Icon name={showUsage ? 'chevron-down' : 'chevron-right'} size={13} /></span></button>
      <button class="gear" title="settings" onclick={() => (store.settingsOpen = true)}><Icon name="settings" size={15} /></button>
    </div>
    {#if showUsage}<Usage />{/if}
  </div>
</div>

<style>
  .sidebar { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--sidebar); border-right: 1px solid var(--border); }
  .connbar { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border-subtle); }
  .homebtn { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--r-sm); color: var(--muted); flex: none; }
  .homebtn:hover { background: var(--surface); color: var(--text); }
  .conn-label { flex: 1; min-width: 0; font-size: var(--text-xs); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .conn-label.down { color: var(--warn, #d08700); }
  .conn-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--bad); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08); }
  .conn-dot.on { background: var(--ok); }
  .search { position: relative; padding: 0 var(--space-4) var(--space-3); }
  .sicon { position: absolute; left: 1.15rem; top: calc(50% - 0.25rem); transform: translateY(-50%); color: var(--dim); display: grid; }
  .search input { width: 100%; padding-left: 1.9rem; }
  .sec-head { display: flex; align-items: center; justify-content: space-between; padding: var(--space-2) var(--space-5); font-size: var(--text-2xs); letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--dim); }
  .sec-actions { display: flex; gap: 0.15rem; }
  .manager-entry { display: flex; align-items: center; gap: .28rem; margin-right: .2rem; padding: .22rem .4rem;
    color: var(--dim); border: 1px solid var(--border); border-radius: var(--r-sm); font-size: .62rem;
    letter-spacing: .03em; text-transform: none; }
  .manager-entry:hover { color: var(--text); border-color: var(--border-accent); background: var(--surface-2); }
  .icon { display: grid; place-items: center; color: var(--muted); width: 26px; height: 24px; border-radius: var(--r-sm); transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .icon:hover { background: var(--surface-2); color: var(--text); }
  .icon.on { background: var(--surface-3); color: var(--accent); }
  .panel { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-2) var(--space-4) var(--space-3); }
  .panel input { width: 100%; }
  .path-row { display: flex; gap: var(--space-2); }
  .path-row input { flex: 1; }
  .browse { flex: none; display: grid; place-items: center; border: 1px solid var(--border-strong); border-radius: var(--r-md); padding: 0 0.5rem; color: var(--muted); }
  .browse:hover { border-color: var(--border-accent); color: var(--text); }
  .mkbtn { background: var(--accent); color: #fff; border-radius: var(--r-md); padding: var(--space-2); font-weight: var(--fw-medium); box-shadow: var(--edge-hi), var(--shadow-1); }
  .mkbtn:hover { filter: brightness(1.08); }
  .ghbtn { display: flex; align-items: center; justify-content: center; gap: var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--r-md); padding: var(--space-2); color: var(--muted); font-size: var(--text-sm); }
  .ghbtn:hover, .ghbtn.on { border-color: var(--border-accent); color: var(--text); background: var(--surface-2); }
  .err { color: var(--bad-text); font-size: var(--text-xs); }
  /* min-height:0 lets flex:1 bound the list below its content so its own `.scroll` overflow engages,
     instead of the list growing to fit every chat and pushing the sidebar (and the window) taller. */
  .list { flex: 1; min-height: 0; padding: 0 var(--space-2); }
  .group { margin-bottom: var(--space-2); }
  .group-head { position: relative; display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-6); font-size: var(--text-sm); color: var(--muted); }
  .folder { display: grid; place-items: center; color: var(--dim); width: 16px; height: 16px; }
  .folder:hover { color: var(--text); }
  .summary { display: flex; align-items: center; gap: var(--space-2); padding: 0.2rem 0.5rem 0.4rem 1.05rem; cursor: pointer; }
  .summary .logos { display: inline-flex; gap: 0.15rem; margin-right: 0.1rem; }
  .sc { display: inline-flex; align-items: center; gap: 0.25rem; font-size: var(--text-2xs); font-weight: var(--fw-medium);
    padding: 0.1rem 0.35rem; border-radius: var(--r-pill); }
  .sc.working { color: var(--working); background: color-mix(in srgb, var(--working) 14%, transparent); }
  .sc.review { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
  .sc.done { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }
  .sc.stalled { color: var(--bad-text); background: color-mix(in srgb, var(--bad-text) 14%, transparent); }
  .gname { font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gcount { margin-left: auto; font-size: var(--text-xs); }
  .gadd { display: grid; place-items: center; color: var(--dim); width: 20px; height: 20px; border-radius: var(--r-xs); opacity: 0; transition: opacity var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .group-head:hover .gadd { opacity: 1; }
  .gadd:hover { background: var(--surface-2); color: var(--accent); }

  /* --- Folders -------------------------------------------------------------------------------
     Every row of a group (folder header, chat, empty-folder target) is wrapped in one `.entry`,
     which is what carries the grouping visual: `.infolder` indents and draws a 1px rail down its
     left edge, and because the entries are adjacent block boxes with no vertical gap, the rails of
     consecutive members join into ONE continuous line under the folder header. `.railend` caps it
     with a short foot so the group reads as enclosed rather than merely started. All of it is
     token-driven (--space-*, --border*, --accent), so it tracks the palette instead of pinning px. */
  .entry { position: relative; }
  .entry.infolder { margin-left: calc(var(--space-6) + var(--space-1)); padding-left: var(--space-2); border-left: 1px solid var(--border); }
  .entry.infolder .row { padding-left: var(--space-3); }
  .entry.railend::after { content: ''; position: absolute; left: 0; bottom: 0; width: var(--space-3); height: 1px; background: var(--border); }
  /* Drop preview: the whole rail lights up, so you can see WHICH folder will take the chat even when
     the cursor is over one of its members rather than its header. */
  .entry.railhot { border-left-color: var(--accent); }
  .entry.railhot.railend::after { background: var(--accent); }

  .folder-head { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3) var(--space-1) var(--space-6);
    font-size: var(--text-sm); color: var(--muted); border-radius: var(--r-sm); }
  .folder-head:hover { background: var(--surface-2); }
  .ficon { display: inline-grid; place-items: center; color: var(--dim); }
  .fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: text; }
  .factions { display: none; gap: 0.15rem; }
  .folder-head:hover .factions { display: flex; }
  /* Empty folders stay on screen precisely so they can be dropped into — the placeholder is the
     hit target, and it says what to do rather than looking like a rendering bug. */
  .fempty { padding: var(--space-2) var(--space-3); font-size: var(--text-xs); font-style: italic;
    border: 1px dashed var(--border); border-radius: var(--r-sm); margin: var(--space-1) 0; text-align: center; }
  /* Shared drop-target highlight for a folder header, an empty folder, and (for a drag back OUT) the
     project header itself. */
  .folder-head.droptarget, .fempty.droptarget, .group-head.droptarget {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    box-shadow: inset 0 0 0 1px var(--border-accent); border-radius: var(--r-sm); }
  .fempty.droptarget { border-style: solid; border-color: transparent; color: var(--text); }

  .row { position: relative; display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-6); border-radius: var(--r-md); cursor: pointer; }
  /* Managers get hierarchy, not another inline badge competing with provider/worktree/mail/approval.
     The second line spends a little vertical space on the one row that runs the team and preserves
     horizontal room for the scientist name and genuine attention signals. */
  .row.manager {
    background: color-mix(in srgb, var(--accent) 7%, transparent);
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 78%, transparent);
  }
  .row.manager:hover { background: color-mix(in srgb, var(--accent) 11%, var(--surface-2)); }
  .row.manager.sel {
    background: color-mix(in srgb, var(--accent) 13%, var(--surface-2));
    box-shadow: inset 3px 0 0 var(--accent), inset 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .row.managedchild { margin-left: calc(var(--manager-depth) * 0.85rem); width: calc(100% - (var(--manager-depth) * 0.85rem)); }
  .manager-toggle, .manager-branch { flex: none; display: grid; place-items: center; width: 12px; color: var(--dim); }
  .manager-toggle { color: var(--accent); }
  .manager-toggle:hover { color: var(--text); }
  .manager-identity { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 0.12rem; }
  .manager-identity .rlabel { flex: none; width: 100%; }
  .manager-role {
    max-width: 100%; display: inline-flex; align-items: center; gap: 0.22rem; color: var(--accent);
    font-size: 0.56rem; line-height: 1; font-weight: var(--fw-semibold); letter-spacing: 0.055em;
    text-transform: uppercase; white-space: nowrap;
  }
  .manager-role:hover { color: var(--text); }
  .manager-orphan { flex: none; display: grid; place-items: center; width: 12px; color: var(--warn); opacity: 0.9; }
  .row.orphanedchild { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--warn) 55%, transparent); }
  .row.attentionchild { background: color-mix(in srgb, var(--warn) 6%, transparent); }
  .row.attentionchild .manager-branch { color: var(--warn); }
  .row:hover { background: var(--surface-2); }
  .row.sel { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent); }
  /* Drag hint: a faint grip rail on the left, revealed on hover, signalling the whole ROW/HEADER is
     draggable. Purely decorative now (aria-hidden, pointer-events:none) — the native drag lives on
     the row/header itself, which both REORDERS (over the sidebar) and OPENS/SPLITS (dragged out over
     the panes). */
  .grip { position: absolute; left: 2px; top: 50%; transform: translateY(-50%); display: grid; place-items: center;
    width: 16px; height: 18px; color: var(--dim); border-radius: var(--r-xs); opacity: 0; pointer-events: none;
    transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .gripicon { display: block; }
  /* The header is primarily a drag handle now; the row's main gesture is still click-to-select, so it
     keeps its pointer cursor and reveals the grip hint on hover. */
  .group-head.draghandle { cursor: grab; }
  .group-head:hover .grip, .row:hover .grip { opacity: 0.55; }
  .row.dragging .grip, .group.dragging .grip { opacity: 1; color: var(--muted); }
  /* Lifted look for the item being dragged. No pointer-events:none needed — native dragover streams
     the row/header under the cursor directly, so the live FLIP reorder tracks it with no hit-testing. */
  .row.dragging { background: var(--surface-3); box-shadow: var(--shadow-1); opacity: 0.9; z-index: 2; }
  .group.dragging { position: relative; z-index: 2; }
  .group.dragging .group-head { background: var(--surface-3); border-radius: var(--r-md); box-shadow: var(--shadow-1); }
  .list.reordering { user-select: none; cursor: grabbing; }
  .ibadge { flex: none; display: inline-grid; place-items: center; color: var(--dim); }
  .wtbadge { flex: none; display: inline-flex; align-items: center; gap: 0.15rem;
    padding: 0.05rem 0.25rem; border: 1px solid var(--border); border-radius: var(--r-sm);
    color: var(--muted); font-family: var(--mono); font-size: var(--text-2xs); }
  .wtbadge span { white-space: nowrap; }
  /* Fleet machine/site tags: a labelled pill on a remote project header, and a compact icon marker on
     a remote chat row (its label rides in the tooltip). Only rendered for REMOTE sites, so the
     single-machine view shows neither. */
  /* Icon only — no text, so no max-width/ellipsis machinery. The machine's name lives in the tooltip;
     repeating it down every row cost sidebar width that the chat names need more. */
  .sbadge { flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 1.15rem; height: 1.15rem; border-radius: var(--r-sm); }
  /* This machine: present but recessive. Your own projects are the common case, so the marker's job here
     is to be available on inspection, not to compete with the chat names for attention. */
  .sbadge.here { color: var(--text-dim, #9a9aa8); }
  /* Another machine, answering. */
  .sbadge.up { color: var(--accent); background: color-mix(in srgb, var(--accent) 13%, transparent); }
  /* Another machine that did NOT answer. Amber rather than red: the rows below are real chats in their
     last known state, not errors — you simply cannot act on them right now. Reduced opacity carries the
     same message a second way, so it survives a viewer who cannot separate amber from the accent. */
  .sbadge.down { color: #d08b3a; background: color-mix(in srgb, #d08b3a 14%, transparent); opacity: 0.85; }
  .rbadge { flex: none; display: inline-grid; place-items: center; color: var(--accent); opacity: 0.75; }
  .rlabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.sel .rlabel { font-weight: var(--fw-medium); }
  /* One-shot glitch when a chat materializes into the list or is renamed. Kept subtle (small
     jitter + clip slices + a quick accent/secondary RGB-split, opacity never below ~0.8 — no
     hard flashing). Behind no-preference so reduced motion updates the label instantly. */
  @media (prefers-reduced-motion: no-preference) {
    .rlabel.glitch { animation: rlabel-glitch 0.72s var(--ease) 1; }
    @keyframes rlabel-glitch {
      0%   { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 1; text-shadow: none; }
      12%  { transform: translate(-1.5px, 0); clip-path: inset(0 0 62% 0); opacity: 0.82; text-shadow: 1.5px 0 var(--accent), -1.5px 0 var(--secondary); }
      24%  { transform: translate(1.5px, 0); clip-path: inset(58% 0 0 0); opacity: 1; text-shadow: none; }
      36%  { transform: translate(-1px, 0); clip-path: inset(30% 0 34% 0); opacity: 0.9; text-shadow: -1.5px 0 var(--accent), 1px 0 var(--secondary); }
      50%  { transform: translate(1px, 0); clip-path: inset(0 0 18% 0); opacity: 0.86; text-shadow: none; }
      64%  { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 1; }
      78%  { transform: translate(-0.5px, 0); opacity: 0.95; text-shadow: 0.5px 0 var(--accent); }
      100% { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 1; text-shadow: none; }
    }
    .rdots i { animation: rdot 1.1s ease-in-out infinite; }
    .rdots i:nth-child(2) { animation-delay: 0.18s; }
    .rdots i:nth-child(3) { animation-delay: 0.36s; }
    @keyframes rdot { 0%, 80%, 100% { opacity: 0.35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-1.5px); } }
  }
  .rename-input { flex: 1; min-width: 0; font: inherit; font-size: var(--text-sm); background: var(--surface-3); border: 1px solid var(--border-accent); border-radius: var(--r-xs); padding: 0 0.3rem; color: var(--text); }
  .rtime { font-size: var(--text-xs); flex: none; }
  /* "working" indicator: three dots that pulse in sequence (falls back to static dots w/ reduced motion). */
  .rdots { display: inline-flex; align-items: center; gap: 3px; flex: none; }
  .rdots i { width: 3px; height: 3px; border-radius: 50%; background: var(--accent); opacity: 0.4; }
  .rwarn { flex: none; display: inline-grid; place-items: center; color: var(--bad-text, #e5484d); }
  .pbadge { background: var(--warn); color: #111; border-radius: var(--r-pill); padding: 0 0.35rem; font-size: var(--text-2xs); font-weight: var(--fw-semibold); }
  /* Unread teammate mail. Same pill family as .pbadge, but the envelope glyph (not colour) carries the
     meaning — so it stays legible for anyone who can't distinguish the accent hue, and reads distinctly
     from the warn approvals pill. Absent at zero (rendered only when unread > 0). */
  .mbadge { flex: none; display: inline-flex; align-items: center; gap: 0.15rem; background: var(--accent); color: #fff; border-radius: var(--r-pill); padding: 0 0.3rem; font-size: var(--text-2xs); font-weight: var(--fw-semibold); }
  .ractions { display: none; gap: 0.15rem; }
  .row:hover .ractions { display: flex; }
  .row:hover .rtime, .row:hover .rdots, .row:hover .rwarn { display: none; }
  .mini { display: grid; place-items: center; color: var(--dim); width: 20px; height: 20px; border-radius: var(--r-xs); }
  .mini:hover { background: var(--surface-3); color: var(--text); }
  .mini.del:hover { background: var(--surface-3); color: var(--bad-text); }
  .empty { padding: 1rem 0.7rem; text-align: center; font-size: var(--text-sm); }
  .footer { border-top: 1px solid var(--border-subtle); padding: var(--space-2) var(--space-4) var(--space-3); max-height: 42vh; overflow-y: auto; }
  .foot-bar { display: flex; align-items: center; }
  .foot-head { display: flex; align-items: center; justify-content: space-between; flex: 1; font-size: var(--text-2xs); letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--dim); padding: var(--space-1) 0; }
  .fchev { display: inline-grid; }
  .gear { display: grid; place-items: center; color: var(--dim); width: 24px; height: 22px; border-radius: var(--r-sm); }
  .gear:hover { color: var(--text); background: var(--surface-2); }
</style>
