<script lang="ts">
  import { api } from './api'
  import { store } from './store.svelte'
  import ItemCard from './ItemCard.svelte'
  import CodexActivityGroup from './CodexActivityGroup.svelte'
  import { groupCodexItems, type CodexRenderNode } from './codexGroup'
  import { classifyDecideOutcome } from './approvals'
  import { approvalBlurb } from './approvalBlurb'
  import { distanceFromBottom, shouldShowJumpToBottom, newItemsBelow } from './transcriptScroll'
  import PastedTextChip from './PastedTextChip.svelte'
  import { shouldPromotePaste, composeWithPastes, type PastedText } from './pastePromote'
  import AttachmentPreview from './AttachmentPreview.svelte'
  import {
    classifyKind,
    validateIncoming,
    vendorSupport,
    type AttachmentMeta,
  } from './attachments'
  import ContextMeter from './ContextMeter.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import TraitsControl from './TraitsControl.svelte'
  import PermissionPicker from './PermissionPicker.svelte'
  import RemoteDevicePicker from './RemoteDevicePicker.svelte'
  import WorktreePicker from './WorktreePicker.svelte'
  import AccountPicker from './AccountPicker.svelte'
  import ProviderLogo from './ProviderLogo.svelte'
  import FirstChatGuide from './FirstChatGuide.svelte'
  import Icon from './Icon.svelte'
  import AgentPanel from './AgentPanel.svelte'
  import BrowserPanel from './BrowserPanel.svelte'
  import TaskStrip from './TaskStrip.svelte'
  import QuestionCard from './QuestionCard.svelte'
  import { findModel, defaultModelFor } from './catalog'
  import { settings } from './settings.svelte'
  import { onDestroy, tick, untrack } from 'svelte'
  import { composerAutoGrow } from './composerAutoGrow'
  import {
    loadComposerDrafts,
    loadThreadSidePanel,
    saveComposerDrafts,
    saveThreadSidePanel,
    type ThreadSidePanel,
  } from './uiState'
  import { profileLabel } from './profileLabel'
  import { apiEquivalentCostLabel } from './usageDisplay'
  import { resolveSlash, builtinsForProvider, builtinNeedsArg, loadProfileCommands, type SlashResult } from './commands'
  import { resolveWorkingContext, truncatePathTail } from './workingContext'
  import type { AttachmentRef, CommandInfo } from './api'

  let {
    sessionId,
    paneIndex = 0,
    multiPane = false,
    embedded = false,
    composerOnly = false,
    peekItems = 0,
    composerLabel,
    onpanedragstart,
    onpanedragend,
  }: {
    sessionId?: string
    paneIndex?: number
    multiPane?: boolean
    embedded?: boolean
    composerOnly?: boolean
    peekItems?: number
    composerLabel?: string
    onpanedragstart?: (event: DragEvent) => void
    onpanedragend?: (event: DragEvent) => void
  } = $props()

  let text = $state('')
  type ComposerAttachment = AttachmentMeta & {
    file: File
    previewUrl?: string
    uploaded?: AttachmentRef
    uploadedFor?: string
  }
  let attachments = $state<ComposerAttachment[]>([])
  let attachmentInput = $state<HTMLInputElement | null>(null)
  let draggingFiles = $state(false)
  let paneDragDepth = 0
  let sending = $state(false)

  function stageFiles(files: Iterable<File>): void {
    // The staging action owns the current attachment feedback. Do not leave an upload/send failure
    // beside a newly-added item's policy warning; if this batch is invalid, its validation error below
    // replaces the old one.
    sendErr = ''
    let next = [...attachments]
    for (const file of files) {
      const error = validateIncoming(file, next.length)
      if (error) {
        sendErr = error
        continue
      }
      const previewUrl =
        classifyKind(file.type) === 'image' && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(file)
          : undefined
      next.push({
        id: `staged:${crypto.randomUUID?.() ?? `${Date.now()}-${next.length}`}`,
        name: file.name,
        mime: file.type,
        size: file.size,
        kind: classifyKind(file.type),
        file,
        previewUrl,
      })
    }
    attachments = next
  }

  function removeAttachment(id: string): void {
    const item = attachments.find((a) => a.id === id)
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
    attachments = attachments.filter((a) => a.id !== id)
    sendErr = ''
  }

  function clearAttachments(): void {
    for (const item of attachments) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
    attachments = []
    if (attachmentInput) attachmentInput.value = ''
    sendErr = ''
  }

  function onAttachmentPick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement
    if (input.files) stageFiles(input.files)
    // Selecting the same file after removing it must still fire `change`.
    input.value = ''
  }

  function hasDraggedFiles(e: DragEvent): boolean {
    return (
      Array.from(e.dataTransfer?.types ?? []).includes('Files') ||
      (e.dataTransfer?.files?.length ?? 0) > 0
    )
  }

  function isDroppedPlainText(file: File): boolean {
    return file.type === 'text/plain' || file.type === 'text/markdown' || /\.(txt|md|markdown)$/i.test(file.name)
  }

  async function stageDroppedFiles(files: Iterable<File>): Promise<void> {
    const dropped = Array.from(files)
    const plainText = dropped.filter(isDroppedPlainText)
    const attachmentsToStage = dropped.filter((file) => !isDroppedPlainText(file))

    // Images and documents use the picker/composer's one staging seam, including its validation and
    // single current error. Explicit .txt/.md drops are the deliberate exception: like promoted pastes,
    // they stay visible as a chip but travel in the provider-neutral TEXT payload, never the attachment
    // path that has historically dropped non-image Codex input.
    if (attachmentsToStage.length) stageFiles(attachmentsToStage)
    else sendErr = ''

    let currentError = sendErr
    let nextPastes = [...pastes]
    for (const file of plainText) {
      const validationError = validateIncoming(file, attachments.length + nextPastes.length)
      if (validationError) {
        currentError = validationError
        continue
      }
      try {
        const content = await file.text()
        nextPastes.push({
          id: `drop:${crypto.randomUUID?.() ?? `${Date.now()}-${nextPastes.length}`}`,
          name: file.name,
          content,
        })
      } catch {
        currentError = `Could not read “${file.name}” as text.`
      }
    }
    pastes = nextPastes
    sendErr = currentError
  }

  function onPaneDragEnter(e: DragEvent): void {
    // Prevent the webview from treating any pane drop as a navigation, even when the payload is not a
    // stageable file. File drags additionally turn on the pane-wide affordance.
    e.preventDefault()
    if (!hasDraggedFiles(e)) return
    paneDragDepth += 1
    draggingFiles = true
  }

  function onPaneDragOver(e: DragEvent): void {
    e.preventDefault()
    if (!hasDraggedFiles(e)) return
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    draggingFiles = true
  }

  function onPaneDragLeave(e: DragEvent): void {
    e.preventDefault()
    if (!hasDraggedFiles(e)) return
    paneDragDepth = Math.max(0, paneDragDepth - 1)
    if (paneDragDepth === 0) draggingFiles = false
  }

  function onPaneDrop(e: DragEvent): void {
    // This is the sole drop handler for the pane, including the composer. Keeping it above both targets
    // makes a composer drop bubble exactly once instead of being staged by nested handlers.
    e.preventDefault()
    draggingFiles = false
    paneDragDepth = 0
    if (hasDraggedFiles(e) && e.dataTransfer?.files) {
      void stageDroppedFiles(e.dataTransfer.files)
    }
  }

  // Large pastes promoted to chips (see pastePromote.ts). Content is held here and inlined into the
  // prompt on send — it is TEXT, so it reaches both vendors via the normal text path, never the
  // image/file attachment path (which would silently drop it on Codex).
  let pastes = $state<PastedText[]>([])
  function onPaste(e: ClipboardEvent): void {
    const pastedImages = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (pastedImages.length) stageFiles(pastedImages)
    const t = e.clipboardData?.getData('text/plain') ?? ''
    if (shouldPromotePaste(t, settings.pasteAsTextThreshold)) {
      e.preventDefault()
      const id = `paste:${crypto.randomUUID?.() ?? `${Date.now()}-${pastes.length}`}`
      pastes = [...pastes, { id, name: `pasted-${pastes.length + 1}.txt`, content: t }]
    } else if (pastedImages.length && !t) {
      // A screenshot clipboard has no useful textarea default. Prevent the browser from trying to insert
      // an image object, while preserving normal small-text paste when the clipboard contains both.
      e.preventDefault()
    }
  }
  function removePaste(id: string): void {
    pastes = pastes.filter((p) => p.id !== id)
  }
  // "as text" — the user actually wanted it inline; drop it back into the box and un-chip it.
  function inlinePaste(id: string): void {
    const p = pastes.find((x) => x.id === id)
    if (!p) return
    text = text.trim() ? `${text}\n\n${p.content}` : p.content
    pastes = pastes.filter((x) => x.id !== id)
    queueMicrotask(() => taRef?.focus())
  }
  // A message may consist solely of attachments. `sending` closes the double-click/Enter race while the
  // files upload; a second send must never mint duplicate attachment records.
  const canSend = $derived(!sending && (!!text.trim() || pastes.length > 0 || attachments.length > 0))
  // Unsent composer text lives with the CHAT, not this component: switching panes, tabbing away, or
  // reloading keeps whatever you were mid-way through writing. `drafts` is a plain cache (never $state)
  // so writing it from an effect cannot feed back into reactivity.
  let drafts = loadComposerDrafts()
  let draftFor = $state('')
  // A draft changes ids after its first send. Keep that transition explicit so text the operator starts
  // typing while spawn/upload is still in flight follows the composer to the real chat instead of being
  // replaced by the (usually empty) saved draft for the new id.
  let materializingDraftFor = $state('')
  let preserveComposerResetFor = $state('')

  function adoptMaterializedComposer(draftId: string, realId: string): void {
    const { [draftId]: _materialized, ...withoutDraft } = drafts
    drafts = text ? { ...withoutDraft, [realId]: text } : withoutDraft
    saveComposerDrafts(drafts)
    draftFor = realId
    materializingDraftFor = ''
    preserveComposerResetFor = realId
  }

  // Swap the composer's contents when the pane points at a different chat: stash the outgoing text,
  // restore the incoming one. untrack() so reading/writing `text` here never re-triggers this effect.
  $effect(() => {
    const id = sid
    untrack(() => {
      if (id === draftFor) return
      if (
        materializingDraftFor &&
        id !== materializingDraftFor &&
        (!draftFor || materializingDraftFor === draftFor)
      ) {
        adoptMaterializedComposer(materializingDraftFor, id)
        return
      }
      if (draftFor) {
        drafts = { ...drafts, [draftFor]: text }
        saveComposerDrafts(drafts)
      }
      text = drafts[id] ?? ''
      draftFor = id
    })
  })

  // Persist while typing, debounced. Sending clears `text`, which prunes the entry on the next tick.
  $effect(() => {
    const t = text
    const id = draftFor
    if (!id) return
    const timer = setTimeout(() => {
      drafts = { ...drafts, [id]: t }
      saveComposerDrafts(drafts)
    }, 300)
    return () => clearTimeout(timer)
  })
  // Pane moves can remount ThreadView when crossing rows. Flush the live textarea value synchronously
  // so even text typed inside the 300ms debounce window follows the session to its new pane.
  onDestroy(() => {
    if (!draftFor) return
    drafts = { ...drafts, [draftFor]: text }
    saveComposerDrafts(drafts)
  })
  let sendErr = $state('')
  let scroller = $state<HTMLDivElement | null>(null)
  let stick = $state(true)
  // Jump-to-bottom affordance: `jumpAway` is whether the reader has scrolled meaningfully off the live
  // end (a larger gate than `stick` — see transcriptScroll.ts); `anchorKey` is the last item present at
  // the moment they scrolled away, so "N new" counts only what arrived below since (and survives older-
  // history prepends and rollbacks). Both reset when the pane switches chats.
  let jumpAway = $state(false)
  let anchorKey = $state<string | null>(null)
  let olderLoadRetryAt = 0
  let olderLoadInFlight = false
  // `/` command picker: the textarea (for refocus after completion), the profile's on-disk custom
  // commands, the highlighted row, and an Escape-dismissal latch.
  let taRef = $state<HTMLTextAreaElement | null>(null)
  let customCommands = $state<CommandInfo[]>([])
  let cmdIndex = $state(0)
  let cmdDismissed = $state(false)

  const activeId = $derived(sessionId ?? store.selectedId ?? null)
  const view = $derived(activeId ? (store.sessions[activeId] ?? null) : null)
  const sid = $derived(view?.record.id ?? '')
  const browserAgentLabel = $derived.by(() => {
    if (!view) return 'this agent'
    if (view.record.title) return view.record.title
    const profile = store.profiles.find((candidate) => candidate.id === view.record.profileId)
    return profile ? profileLabel(profile) : view.record.profileId
  })
  function accountName(profileId: string): string {
    const profile = store.profiles.find((candidate) => candidate.id === profileId)
    return profile ? profileLabel(profile) : profileId
  }
  let sidePanelFor = $state('')
  let sidePanel = $state<ThreadSidePanel | null>(null)
  $effect(() => {
    if (!sid || sid === sidePanelFor) return
    sidePanelFor = sid
    sidePanel = loadThreadSidePanel(sid)
  })
  function setSidePanel(panel: ThreadSidePanel | null): void {
    sidePanel = panel
    if (sid) saveThreadSidePanel(sid, panel)
  }
  const permissionBoundary = $derived.by(() => {
    if (!view) return null
    if (view.record.isProjectManager) {
      return {
        scope: 'manager' as const,
        ceiling: view.record.managerPermissionModeCeiling ?? 'safe' as const,
        managedBy: 'the operator',
      }
    }
    if (!view.record.parentSessionId) return null
    const parent = store.sessions[view.record.parentSessionId]
    return {
      scope: 'child' as const,
      ceiling: parent?.record.isProjectManager
        ? (parent.record.managerMaxChildPermissionMode ?? 'safe')
        : 'safe',
      managedBy: parent
        ? store.sessionLabel(parent.record.id)
        : 'The unavailable parent manager',
    }
  })
  // Both drafts and real sessions now source their picks from the RECORD — a draft's live on the local
  // draft record, a real session's are persisted hub-side (setModel/setOption write through). One source
  // of truth means the pills always show what the next turn will actually use, for either vendor.
  const isDraft = $derived(!!view?.draft)
  // The main transcript shows only the MAIN thread; sub-agent output lives in the agent panel.
  const mainItems = $derived((view?.items ?? []).filter((i) => !i.agentId && !i.taskBoardOnly))
  // Codex turns emit long reasoning→command→reasoning churn before they say anything; fold consecutive
  // activity into a single live group the way the Codex app does (see codexGroup.ts). Claude renders its
  // own way (tool cards, sub-agent panel), so its transcript stays item-per-item, untouched.
  const renderNodes = $derived<CodexRenderNode[]>(
    view?.record.provider === 'codex'
      ? groupCodexItems(mainItems)
      : mainItems.map((item) => ({ type: 'item', id: item.key, item }))
  )
  function tailRenderNodes(nodes: CodexRenderNode[], limit: number): CodexRenderNode[] {
    let remaining = Math.max(0, limit)
    const tail: CodexRenderNode[] = []
    for (let index = nodes.length - 1; index >= 0 && remaining > 0; index--) {
      const node = nodes[index] as CodexRenderNode
      if (node.type === 'item') {
        tail.unshift(node)
        remaining--
        continue
      }
      const items = node.items.slice(-remaining)
      if (items.length) {
        tail.unshift({
          type: 'group',
          id: `${node.id}:peek:${items[0]?.key ?? ''}`,
          items,
        })
        remaining -= items.length
      }
    }
    return tail
  }
  const displayedRenderNodes = $derived(
    composerOnly && peekItems > 0
      ? tailRenderNodes(renderNodes, peekItems)
      : view?.historyViewingOlder
        // Older pages are fetched only when the operator reaches them, and the store retains exactly
        // those fetched pages. Keep that reached history CONTIGUOUS with the live tail. Rendering only
        // the first 120 nodes here made the bottom of the scrollbox an artificial cutoff: after one
        // upward history load, scrolling back down could never reach the latest reply. The normal
        // unopened-chat path remains a bounded 120-node tail; only explicitly reached history expands.
        ? renderNodes
        : tailRenderNodes(renderNodes, 120),
  )
  const model = $derived(view?.record.model ?? '')
  const options = $derived<Record<string, string>>({
    ...(view?.record.effort ? { effort: view.record.effort } : {}),
    ...(view?.record.serviceTier ? { serviceTier: view.record.serviceTier } : {}),
  })
  const modelDef = $derived(
    view ? (findModel(model) ?? defaultModelFor(view.record.provider)) : undefined
  )
  const active = $derived(view?.record.status === 'active' || view?.record.status === 'starting')
  // A stopped chat is otherwise a dead end — stop() had no inverse, so the composer bounced every send
  // off the hub's 'stopped' guard forever. Surface a Reopen affordance instead of interrupt/stop so the
  // operator can revive it in one click (api.reopen → hub setStatus idle → journaled status un-sticks it).
  const stopped = $derived(view?.record.status === 'stopped')
  // Intent and outcome are deliberately separate. A draft says what WILL happen; a spawned chat reports
  // what IS true from the returned record. A persisted reason makes disagreement visible, never a guess.
  const draftWorkMode = $derived(view?.draftUseWorktree ? 'worktree' : 'project')
  const actualWorkMode = $derived(view?.record.worktree ? 'worktree' : 'project')
  const projectPath = $derived(
    store.projects.find((project) => project.id === view?.record.projectId)?.path
      ?? (!view?.record.worktree ? view?.record.cwd : undefined)
  )
  const worktreeMismatch = $derived(
    !isDraft && view?.record.worktreeRequested === true && !view?.record.worktree
  )
  function formatWorkspaceBytes(bytes: number): string {
    const gib = bytes / (1024 ** 3)
    return gib >= 1
      ? `${gib >= 10 ? gib.toFixed(1) : gib.toFixed(2)} GiB`
      : `${Math.max(0, Math.round(bytes / (1024 ** 2)))} MiB`
  }
  const workspacePressureDetail = $derived.by(() => {
    const pressure = view?.record.workspacePressure
    if (!pressure) return ''
    const groups = pressure.artifactGroups
      .slice(0, 3)
      .map((group) => `${group.name} ${formatWorkspaceBytes(group.bytes)}`)
      .join(', ')
    const free = pressure.freeBytes === undefined
      ? ''
      : ` ${formatWorkspaceBytes(pressure.freeBytes)} remains free on the volume.`
    return (
      `${pressure.partial ? 'At least ' : ''}${formatWorkspaceBytes(pressure.totalBytes)} is in this managed checkout; ` +
      `${formatWorkspaceBytes(pressure.artifactBytes)} is recognized build/dependency output${groups ? ` (${groups})` : ''}.${free}`
    )
  })
  // Draft-only inline permission picker (the real PermissionPicker posts to the hub, which a draft
  // has no session for). Mirrors the real picker's modes; writes the choice into the draft record.
  const PERM_MODES = [
    { id: 'safe', icon: 'lock', label: 'Safe', desc: 'ask before every tool' },
    { id: 'edits', icon: 'pencil', label: 'Edits', desc: 'auto-approve file edits' },
    { id: 'full', icon: 'zap', label: 'Full access', desc: 'ordinary tools auto-approved · host access (OS elevation still applies)' },
  ]
  let permOpen = $state(false)
  const draftMode = $derived(view?.record.permissionMode ?? 'safe')
  const draftModeDef = $derived(PERM_MODES.find((m) => m.id === draftMode) ?? PERM_MODES[0])
  // The hub's input route handles provider-neutral mid-turn steering at the next tool boundary. Keep
  // queuing only as the explicit preference fallback; the composer must not silently treat Claude as
  // less steerable than Codex when the same transport supports both.
  // `starting` means the hub accepted a turn but the vendor stream is not ready for steering yet. Treating
  // it as steerable raced the startup handshake: Enter posted a steer that could fail and leave the text
  // behind. Queue during that short phase; switch to direct steering only after the live `active` state.
  const steerable = $derived(
    view?.record.status === 'active' && store.prefs.steerMessagesAtToolBoundary,
  )
  const st = $derived(view ? store.status(view) : { key: 'idle', label: '' })
  const approvals = $derived(view ? store.approvals.filter((a) => a.sessionId === view.record.id) : [])
  const questions = $derived(view ? store.questions.filter((q) => q.sessionId === view.record.id) : [])
  let questionArrival = $state('')
  let questionArrivalSession: string | undefined
  let previousQuestionIds: string[] = []
  let questionArrivalTimer: ReturnType<typeof setTimeout> | undefined
  let questionArrivalGeneration = $state(0)

  function clearQuestionArrival(): void {
    questionArrivalGeneration += 1
    if (questionArrivalTimer) clearTimeout(questionArrivalTimer)
    questionArrivalTimer = undefined
    questionArrival = ''
  }

  function announceQuestionArrival(message: string): void {
    if (questionArrivalTimer) clearTimeout(questionArrivalTimer)
    const generation = ++questionArrivalGeneration
    questionArrival = message
    questionArrivalTimer = setTimeout(() => {
      if (questionArrivalGeneration !== generation) return
      questionArrival = ''
      questionArrivalTimer = undefined
    }, 1_500)
  }

  onDestroy(clearQuestionArrival)
  $effect(() => {
    const currentSession = view?.record.id
    const currentIds = questions.map((question) => question.id)
    if (currentSession !== questionArrivalSession) {
      questionArrivalSession = currentSession
      if (currentIds.length === 0) {
        clearQuestionArrival()
      } else {
        announceQuestionArrival(
          currentIds.length === 1
            ? 'One pending question from Claude.'
            : `${currentIds.length} pending questions from Claude.`
        )
      }
    } else {
      const previous = new Set(previousQuestionIds)
      const arrived = currentIds.reduce(
        (count, id) => count + (previous.has(id) ? 0 : 1),
        0
      )
      if (arrived > 0) {
        announceQuestionArrival(
          arrived === 1
            ? `New question from Claude. ${currentIds.length} pending.`
            : `${arrived} new questions from Claude. ${currentIds.length} pending.`
        )
      } else if (currentIds.length < previousQuestionIds.length) {
        // Removal is not an arrival. Clear stale count text without replacing it with another message.
        clearQuestionArrival()
      }
    }
    // The service permits at most four pending questions per session. Keep only the current snapshot:
    // removal/reorder is silent, and memory never grows with historical ids.
    previousQuestionIds = currentIds.slice(0, 4)
  })
  const queue = $derived(sid ? store.queueFor(sid) : [])
  const workingContext = $derived.by(() => {
    const resolved = view
      ? resolveWorkingContext(view.record, store.projects)
      : { projectName: 'Unfiled', workingDirectory: 'Working directory not set' }
    // An Unfiled draft does not have a session id yet, so the hub cannot name its eventual private
    // workspace. "Working directory not set" read like a broken setting and the guide repeated it.
    // State the timing honestly until materialization returns the concrete cwd.
    return isDraft && resolved.workingDirectory === 'Working directory not set'
      ? { ...resolved, workingDirectory: 'Assigned when this chat starts' }
      : resolved
  })
  // First-run means the hub has no materialized chats yet. The current draft is intentionally excluded
  // by sessionList; as soon as the user starts one real chat, every later draft gets the normal empty
  // state instead of permanent onboarding furniture.
  const showFirstChatGuide = $derived(isDraft && store.sessionList.length === 0)
  // Keep the identifying end before CSS has to squeeze it further. Split panes get a tighter character
  // budget; the path span also uses start-side ellipsis as a final guard for exceptionally narrow panes.
  const shownWorkingDirectory = $derived(
    truncatePathTail(workingContext.workingDirectory, multiPane ? 32 : 58)
  )

  // --- `/` command picker ------------------------------------------------------------------------
  type PickItem = { name: string; description: string; kind: 'builtin' | 'custom'; argHint?: string }
  // Shown while typing a command NAME: a leading "/" then a partial token with no space yet. Once a
  // space is typed (→ arguments) or the text goes multiline, the query is null and the picker closes.
  const cmdQuery = $derived.by<string | null>(() => {
    const m = /^\/(\S*)$/.exec(text)
    return m ? (m[1] as string).toLowerCase() : null
  })
  const allCommands = $derived.by<PickItem[]>(() => {
    const provider = view?.record.provider ?? 'claude'
    const builtins = builtinsForProvider(provider).map(
      (b): PickItem => ({ name: b.name, description: b.description, kind: 'builtin', argHint: b.argHint })
    )
    const custom = customCommands.map((c): PickItem => ({ name: c.name, description: c.description, kind: 'custom' }))
    return [...builtins, ...custom]
  })
  const cmdShown = $derived.by<PickItem[]>(() => {
    if (cmdQuery === null) return []
    const q = cmdQuery
    return allCommands
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const sa = a.name.toLowerCase().startsWith(q) ? 0 : 1
        const sb = b.name.toLowerCase().startsWith(q) ? 0 : 1
        return sa !== sb ? sa - sb : a.name.localeCompare(b.name)
      })
      .slice(0, 8)
  })
  // Open while typing a command name, unless Escape-dismissed or the query already exactly names the
  // sole remaining command (nothing left to complete — just press Enter to run it).
  const cmdOpen = $derived(
    cmdQuery !== null &&
      !cmdDismissed &&
      cmdShown.length > 0 &&
      !(cmdShown.length === 1 && cmdShown[0]?.name.toLowerCase() === cmdQuery)
  )

  // Load the profile's custom commands for the picker (memoized in the commands module).
  $effect(() => {
    const pid = view?.record.profileId
    if (!pid) {
      customCommands = []
      return
    }
    let cancelled = false
    void loadProfileCommands(pid).then((list) => {
      if (!cancelled) customCommands = list
    })
    return () => {
      cancelled = true
    }
  })
  // Reset the highlighted row + any Escape-dismissal whenever the query changes.
  $effect(() => {
    cmdQuery // track
    cmdIndex = 0
    cmdDismissed = false
  })

  function fmtTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
  }
  const estTokens = $derived.by(() => {
    if (!view) return 0
    const ctx = view.contextUsed ?? 0
    const pending = queue.join('\n\n')
    const draft = text + (pending ? '\n\n' + pending : '')
    return ctx + Math.ceil(draft.length / 4)
  })

  // "Received / thinking" indicator: a turn is in flight while turnStartedAt is set. A ticking
  // clock drives the elapsed readout; it only runs while thinking (torn down otherwise).
  // In flight while we have a start time OR the record itself says active/starting. The status check is
  // the safety net for a turn this client never watched BEGIN — one kicked off by a teammate's bus
  // message rather than by you typing, or one already running when the app loaded — where no optimistic
  // start time was ever set locally. Status is hub-owned and replayed, so it is the honest signal.
  const thinking = $derived(
    !!view && (view.turnStartedAt != null || view.record.status === 'active' || view.record.status === 'starting')
  )
  const liveTok = $derived(view?.liveTokens)
  let now = $state(Date.now())
  $effect(() => {
    if (!thinking) return
    const iv = setInterval(() => (now = Date.now()), 250)
    return () => clearInterval(iv)
  })
  const elapsedMs = $derived(thinking && view?.turnStartedAt ? Math.max(0, now - view.turnStartedAt) : 0)
  // Blank rather than a fake "0s" when we are thinking but never learned when the turn began.
  const elapsedLabel = $derived(view?.turnStartedAt != null ? fmtElapsed(elapsedMs) : '')
  function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  $effect(() => {
    view?.items.length
    void thinking // also keep pinned to bottom when the thinking row appears
    if (stick && scroller) {
      // A fresh draft contains the first-chat guide, whose beginning is the useful part. The normal
      // transcript rule (open at the live end) would mount this taller-than-a-short-pane guide halfway
      // down and hide its explanation above the viewport.
      scroller.scrollTop = isDraft && view?.items.length === 0 ? 0 : scroller.scrollHeight
    }
  })

  async function loadOlderAtTop(force = false): Promise<void> {
    if (
      !scroller ||
      !view ||
      composerOnly ||
      olderLoadInFlight ||
      view.loadingHistory ||
      (view.journalHistoryOlderCursor == null && view.historyOlderCursor == null) ||
      (!force && Date.now() < olderLoadRetryAt)
    ) return
    olderLoadInFlight = true
    const priorHeight = scroller.scrollHeight
    const priorTop = scroller.scrollTop
    try {
      const loaded = await store.loadOlderHistory(view.record.id)
      await tick()
      if (loaded && scroller) {
        // Every older page prepends; keep the first previously-visible row under the cursor.
        scroller.scrollTop = priorTop + Math.max(0, scroller.scrollHeight - priorHeight)
        olderLoadRetryAt = 0
      } else {
        // An index-building/transport failure remains visibly retryable without hammering the hub on
        // every scroll event while the scrollbar rests at zero.
        olderLoadRetryAt = Date.now() + 2_000
      }
    } finally {
      olderLoadInFlight = false
    }
  }

  $effect(() => {
    const currentId = sid
    const hasOlder =
      view?.journalHistoryOlderCursor != null || view?.historyOlderCursor != null
    const loading = view?.loadingHistory === true
    // Track rendered content as well as cursors. A latest page can be shorter than the viewport, in
    // which case there is no scrollbar and therefore no scroll event to request the next page. Fill only
    // until the pane gains real scroll range; ordinary top-scroll loading takes over from there.
    mainItems.length
    if (!currentId || !hasOlder || loading || composerOnly) return
    void tick().then(() => {
      if (
        sid !== currentId ||
        !scroller ||
        scroller.clientHeight <= 0 ||
        scroller.scrollHeight > scroller.clientHeight + 1 ||
        scroller.scrollTop > 96
      ) return
      void loadOlderAtTop()
    })
  })

  function onScroll(): void {
    if (!scroller) return
    const m = { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }
    stick = distanceFromBottom(m) < 60 // unchanged 60px autoscroll gate
    const away = shouldShowJumpToBottom(m)
    jumpAway = away
    // Anchor the "new" count to the last item the moment you scroll away; clear it once you're back down.
    if (!away) anchorKey = null
    else if (anchorKey === null) anchorKey = mainItems[mainItems.length - 1]?.key ?? null
    if (m.scrollTop <= 96) void loadOlderAtTop()
  }
  const newBelow = $derived(newItemsBelow(mainItems.map((i) => i.key), anchorKey))
  function jumpToBottom(): void {
    if (!scroller) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
    stick = true
    jumpAway = false
    anchorKey = null
  }

  // --- Per-control action errors ----------------------------------------------------------------
  // A hub write that fails must say so AT ITS CONTROL, not as a global toast a reader learns to ignore —
  // a model pill that didn't persist is a different problem from a stop that didn't take. One keyed map
  // (not five ad-hoc strings that drift): 'settings' renders under the model/effort/tier pills, 'session'
  // under the interrupt/stop/reopen buttons. `runAction` runs the write and — because jpost resolves a
  // non-2xx as {error} rather than throwing — records `${label} failed: …` when it did not take, else
  // clears the slot. Returns whether it took, so an optimistic caller can roll back.
  let actionErr = $state<Record<string, string>>({})
  async function runAction(key: string, label: string, fn: () => Promise<unknown>): Promise<boolean> {
    const out = (await fn()) as { error?: string } | null | undefined
    actionErr = { ...actionErr, [key]: out?.error ? `${label} failed: ${out.error}` : '' }
    return !out?.error
  }
  // Switching the pane to another chat resets per-chat scroll/error UI: drop stale action errors, hide
  // the jump affordance, and re-pin to the bottom so the incoming chat opens at its live end rather than
  // inheriting the previous chat's scroll position.
  $effect(() => {
    const currentSid = sid
    actionErr = {}
    jumpAway = false
    anchorKey = null
    olderLoadRetryAt = 0
    olderLoadInFlight = false
    stick = true
    // draft id → real id is the same composer. Keep text chips/files the operator staged while the
    // first-turn request was pending; ordinary chat navigation still resets those chat-local controls.
    if (preserveComposerResetFor === currentSid) {
      preserveComposerResetFor = ''
      return
    }
    pastes = [] // promoted pastes belong to the chat they were pasted into
    untrack(clearAttachments) // staged files belong to the chat they were attached to
    return () => untrack(clearAttachments)
  })

  // Model / thinking-effort / tier picks WRITE THROUGH to the hub immediately for a real session, so the
  // choice belongs to the record and survives switching panes, reloading, and a hub restart (it used to
  // live in this component's state and silently reverted). Optimistic locally, then confirmed by the
  // hub's `session/settings` event. A draft has no hub session yet, so its picks stay on the draft record.
  //
  // On a FAILED write we roll the pill BACK to the previous value rather than leave it showing a pick the
  // hub never persisted: the record is the source of truth the next turn is built from, so a pill that
  // disagrees with the hub is the UI being confidently wrong — the same silent divergence we've been
  // killing all day. Reverting keeps pill and hub in agreement (the change simply didn't happen).
  async function setModel(slug: string): Promise<boolean> {
    const v = view
    const s = sid
    if (!s || !v) return false
    if (v.draft) {
      store.updateDraft(s, { model: slug || undefined }) // draft picks live on the record
      return true
    }
    const prev = v.record.model
    v.record.model = slug || undefined // optimistic
    const ok = await runAction('settings', 'model change', () => api.setSettings(s, { model: slug }))
    if (!ok) v.record.model = prev
    return ok
  }
  async function setOption(id: string, value: string): Promise<void> {
    const v = view
    const s = sid
    if (!s || !v) return
    if (v.draft) {
      if (id === 'effort') store.updateDraft(s, { effort: value || undefined })
      else if (id === 'serviceTier') store.updateDraft(s, { serviceTier: value || undefined })
      return
    }
    const prevEffort = v.record.effort
    const prevTier = v.record.serviceTier
    if (id === 'effort') v.record.effort = value || undefined
    else if (id === 'serviceTier') v.record.serviceTier = value || undefined
    const label = id === 'effort' ? 'thinking effort change' : 'service tier change'
    const ok = await runAction('settings', label, () => api.setSettings(s, { [id]: value }))
    if (!ok) {
      v.record.effort = prevEffort
      v.record.serviceTier = prevTier
    }
  }

  // Accept the highlighted picker row. `runIfComplete` (Enter/click) runs a no-arg command straight
  // away; an arg-taking command (or Tab) just completes the name and waits for the argument.
  function acceptCmd(i: number, runIfComplete: boolean): void {
    const c = cmdShown[i]
    if (!c) return
    const needsArg = c.kind === 'builtin' && builtinNeedsArg(c.name)
    if (runIfComplete && !needsArg) {
      text = `/${c.name}`
      void send()
      return
    }
    text = `/${c.name}${needsArg ? ' ' : ''}`
    cmdDismissed = true
    queueMicrotask(() => taRef?.focus())
  }

  // Inline `/usage` (and `/cost`) summary from the account snapshot + this session's live counters.
  function usageSummary(): string {
    if (!view) return 'no usage data yet'
    const u = store.usage.find((x) => x.profileId === view.record.profileId)
    const parts: string[] = []
    if (u?.claudeUsage?.length) {
      for (const l of u.claudeUsage) parts.push(`${l.label} ${l.percent}%`)
    } else if (u?.codex?.usedPercent != null) {
      parts.push(`weekly ${u.codex.usedPercent}% used`)
    }
    if (view.contextUsed && view.contextWindow) {
      parts.push(`context ${Math.round((view.contextUsed / view.contextWindow) * 100)}% (${fmtTokens(view.contextUsed)}/${fmtTokens(view.contextWindow)})`)
    }
    if (view.costUsd) parts.push(apiEquivalentCostLabel(view.costUsd, 'this session'))
    else if (typeof u?.totalCostUsd === 'number') parts.push(apiEquivalentCostLabel(u.totalCostUsd))
    return parts.length ? `usage · ${parts.join(' · ')}` : 'no usage data yet'
  }

  // Execute a resolved built-in against the hub / store (the composer's side of the mapping). Draft
  // vs. real session is handled here: a draft has no hub session, so model/mode write to the draft
  // record; a real session posts to the hub. Feedback lands as a local note in the thread.
  async function runSlash(res: SlashResult, sid0: string): Promise<void> {
    if (!view) return
    switch (res.kind) {
      case 'model': {
        const ok = await setModel(res.model) // same write-through the pill uses (draft → record, real → hub)
        // A slash command's feedback lives in the transcript. Only claim it applied if the write took.
        store.pushLocalNote(
          sid0,
          ok
            ? `model → ${res.label} · applies to your next message`
            : `⚠ model change didn't save — kept ${view.record.model ?? 'the previous model'}`
        )
        break
      }
      case 'mode':
        if (view.draft) {
          store.updateDraft(sid0, { permissionMode: res.mode })
          store.pushLocalNote(sid0, `permission mode → ${res.mode}`)
        } else {
          // On success the hub journals session/mode and renders its own note; on failure say so in the
          // transcript (where the /mode command was) rather than letting a failed change look applied.
          const out = (await api.setMode(sid0, res.mode)) as { error?: string }
          if (out?.error) store.pushLocalNote(sid0, `⚠ permission mode change failed: ${out.error}`)
        }
        break
      case 'usage':
        store.pushLocalNote(sid0, usageSummary())
        break
      case 'new':
        // Claude-focused: /clear starts a fresh chat (Codex doesn't reset context this way, but a new
        // chat is the shared analog — a new thread). Reuses the "new chat" path.
        await store.newSession(view.record.profileId, view.record.projectId)
        break
      case 'compact': {
        if (view.draft) {
          store.pushLocalNote(sid0, 'compaction needs a started chat — send a first message, then /compact')
          break
        }
        const out = await api.compact(sid0)
        store.pushLocalNote(
          sid0,
          out?.reason ?? out?.error ?? (out?.supported ? 'compaction requested' : 'compaction not yet supported by the driver')
        )
        break
      }
      case 'message':
        store.pushLocalNote(sid0, res.tone === 'error' ? `⚠ ${res.text}` : res.text)
        break
      case 'passthrough':
        break
    }
  }

  async function uploadStaged(
    sessionId: string,
    staged: ComposerAttachment[],
  ): Promise<{ ids: string[]; meta: AttachmentMeta[] } | { error: string }> {
    const uploaded: AttachmentRef[] = []
    for (const item of staged) {
      let ref = item.uploadedFor === sessionId ? item.uploaded : undefined
      if (!ref) {
        const out = await api.uploadAttachment(sessionId, item.file)
        if ('error' in out) return { error: `Couldn’t attach “${item.name}”: ${out.error}` }
        ref = out
        // The submitted batch is detached from the live composer while this awaits. Keep successful
        // upload ids on that batch so a failed send can restore retryable chips without re-uploading.
        item.uploaded = ref
        item.uploadedFor = sessionId
      }
      uploaded.push(ref)
    }
    return {
      ids: uploaded.map((a) => a.id),
      meta: uploaded.map((a) => ({ ...a, kind: classifyKind(a.mime) })),
    }
  }

  interface ComposerSubmission {
    composerId: string
    text: string
    pastes: PastedText[]
    attachments: ComposerAttachment[]
  }

  function beginSubmission(composerId: string): ComposerSubmission {
    const submission = {
      composerId,
      text,
      pastes: [...pastes],
      attachments: [...attachments],
    }
    // Accept the keystroke now, not whenever the network returns. Detaching the submitted batch
    // immediately makes room for the operator's next thought and prevents a late success callback from
    // clearing newer text.
    text = ''
    pastes = []
    attachments = []
    if (attachmentInput) attachmentInput.value = ''
    sendErr = ''
    return submission
  }

  function completeSubmission(submission: ComposerSubmission): void {
    for (const item of submission.attachments) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
  }

  function restoreSubmission(submission: ComposerSubmission, error: string): void {
    // Never put one chat's failed payload into another chat if navigation happened while awaiting.
    if (draftFor === submission.composerId || sid === submission.composerId) {
      text = submission.text
        ? text
          ? `${submission.text}\n\n${text}`
          : submission.text
        : text
      pastes = [...submission.pastes, ...pastes]
      attachments = [...submission.attachments, ...attachments]
    } else if (submission.text) {
      drafts = { ...drafts, [submission.composerId]: submission.text }
      saveComposerDrafts(drafts)
    }
    sendErr = error
  }

  async function send(): Promise<void> {
    if (!view || !canSend) return
    const sid0 = view.record.id
    const promoted = [...pastes]
    const staged = [...attachments]
    const body = composeWithPastes(text, promoted)
    const unsupported = staged.find((a) => !vendorSupport(a, view.record.provider).ok)
    if (unsupported) {
      sendErr =
        vendorSupport(unsupported, view.record.provider).reason ??
        `“${unsupported.name}” is not supported here`
      return
    }
    const submission = beginSubmission(sid0)
    sending = true
    let settled = false
    const succeed = (): void => {
      if (settled) return
      settled = true
      completeSubmission(submission)
    }
    const fail = (error: string): void => {
      if (settled) return
      settled = true
      restoreSubmission(submission, error)
    }
    try {
      // A message carrying a paste chip or real file is never intercepted as a slash command.
      if (promoted.length === 0 && staged.length === 0 && body.trim().startsWith('/')) {
        const res = resolveSlash(body.trim(), view.record.provider)
        if (res.kind !== 'passthrough') {
          await runSlash(res, sid0)
          succeed()
          return
        }
      }

      // Preserve the existing single-request first-turn path when there are no files.
      if (view.draft && staged.length === 0) {
        stick = true
        materializingDraftFor = sid0
        const out = await store.materializeDraft(sid0, body)
        if (out.error) {
          materializingDraftFor = ''
          fail(out.error)
        } else {
          if (out.sessionId) adoptMaterializedComposer(sid0, out.sessionId)
          succeed()
        }
        return
      }
      if (view.draft) {
        stick = true
        materializingDraftFor = sid0
        // Upload ids can only be minted after a session exists. The store keeps the draft visible while
        // this spawn-empty → upload → send transaction runs, and rolls the empty session back on failure.
        const out = await store.materializeDraft(sid0, '', async (realId) => {
          const upload = await uploadStaged(realId, staged)
          if ('error' in upload) return upload
          const sent = await api.send(realId, body, {
            model: model || undefined,
            effort: options.effort ?? undefined,
            serviceTier: options.serviceTier ?? undefined,
            attachments: upload.ids,
          })
          return sent.error ? { error: sent.error } : { ok: true }
        })
        if (out.error) {
          materializingDraftFor = ''
          fail(out.error)
        } else {
          if (out.sessionId) adoptMaterializedComposer(sid0, out.sessionId)
          succeed()
        }
        return
      }

      const upload = await uploadStaged(sid0, staged)
      if ('error' in upload) {
        fail(upload.error)
        return
      }
      // Busy? The normal input route performs provider-neutral steering and journals the operator input.
      // When the operator disabled mid-turn steering, retain the local queue behavior and uploaded ids.
      if (active) {
        if (steerable) {
          const out = await api.send(sid0, body, {
            attachments: upload.ids.length ? upload.ids : undefined,
          })
          if (out.error) fail(out.error)
          else succeed()
        } else {
          store.enqueue(sid0, body, upload.meta)
          succeed()
        }
        return
      }
      stick = true
      store.noteSent(sid0)
      const key = store.pushUserEcho(sid0, body, upload.meta)
      const out = await api.send(sid0, body, {
        model: model || undefined,
        effort: options.effort ?? undefined,
        serviceTier: options.serviceTier ?? undefined,
        attachments: upload.ids.length ? upload.ids : undefined,
      })
      if (out.error) {
        store.removeItem(sid0, key)
        fail(out.error)
      } else {
        succeed()
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The message could not be sent.')
    } finally {
      sending = false
    }
  }

  // The three session-lifecycle buttons. Each reports a failure at the footer ('session' slot) instead of
  // doing nothing silently — a button that appears dead is how an operator learns to distrust the controls.
  async function interruptTurn(): Promise<void> {
    const id = view?.record.id
    if (id) await runAction('session', 'interrupt', () => api.interrupt(id))
  }
  async function stopSession(): Promise<void> {
    const id = view?.record.id
    if (id) await runAction('session', 'stop', () => api.stop(id))
  }
  async function reopenSession(): Promise<void> {
    const id = view?.record.id
    if (id) await runAction('session', 'reopen', () => api.reopen(id))
  }

  // Per-approval decision error (keyed by approval id so it renders on the right card). Cleared on the
  // next attempt. See classifyDecideOutcome for why we consult the refreshed roster instead of the status.
  let decideError = $state<{ id: string; msg: string } | null>(null)
  async function decide(id: string, approve: boolean): Promise<void> {
    decideError = null
    // jpost RESOLVES with {error} on a non-2xx rather than throwing, so the OLD code — which ignored the
    // result and always cleared the prompt — treated a 404 (already resolved / timed out) or a 401
    // (unauthorized) as an accepted decision. Read the result, then re-read the authoritative roster.
    const res = (await api.decide(id, approve)) as { ok?: boolean; error?: string }
    await store.refreshSideData().catch(() => {}) // authoritative on success AND the honest test on failure
    const outcome = classifyDecideOutcome(res, store.approvals.some((a) => a.id === id))
    if (outcome.kind === 'failed') {
      // Still pending → the click did not take. Keep the prompt up so the operator can decide again.
      decideError = { id, msg: `decision didn't go through (${outcome.error}) — the request is still pending; decide again.` }
    } else if (outcome.kind === 'gone') {
      // No longer pending → resolved elsewhere or timed out. The prompt is already gone; don't pretend the
      // click decided it (it may have been auto-resolved the other way), but don't tell them to retry either.
      store.pushLocalNote(view?.record.id ?? '', '⚠ that approval was already resolved or timed out — your response did not decide it')
    }
    // resolved → the refresh has already dropped the prompt; nothing to surface.
  }

  let questionError = $state<{ id: string; msg: string } | null>(null)
  async function answerQuestion(id: string, answers: Record<string, string>): Promise<void> {
    questionError = null
    const result = await api.answerQuestion(id, answers)
    if (result.ok) {
      // Do not depend on a WebSocket edge to remove a successfully settled card.
      store.questions = store.questions.filter((question) => question.id !== id)
      return
    }
    await store.refreshSideData().catch(() => {})
    if (store.questions.some((question) => question.id === id)) {
      questionError = { id, msg: result.error ?? 'The answers were not accepted; try again.' }
    } else {
      store.pushLocalNote(
        view?.record.id ?? '',
        'That question was already resolved elsewhere; your response was not submitted.'
      )
    }
  }

  async function cancelQuestion(id: string): Promise<void> {
    questionError = null
    const result = await api.cancelQuestion(id)
    if (result.ok) {
      store.questions = store.questions.filter((question) => question.id !== id)
      return
    }
    await store.refreshSideData().catch(() => {})
    if (store.questions.some((question) => question.id === id)) {
      questionError = { id, msg: result.error ?? 'The cancellation was not accepted; try again.' }
    }
  }

  /** "Always allow" — grant the tool for this chat FIRST, then approve the request that prompted it, so
   *  the operator is not asked again for the same tool. The grant is hub-side, so it applies immediately. */
  let grantError = $state<string | null>(null)
  async function allowAlways(id: string, toolName: string): Promise<void> {
    if (!view) return
    grantError = null
    // jpost RESOLVES with {error} rather than throwing, so an unchecked await here looked like success.
    // Approving anyway would have quietly downgraded "always allow" to "approve once" — the operator gets
    // prompted again later with no idea the grant never took.
    const res = (await api.allowTool(view.record.id, toolName)) as { error?: string }
    if (res?.error) {
      grantError = `could not always-allow ${toolName}: ${res.error}`
      return
    }
    await decide(id, true)
  }

  /** The normalized tool a pending Claude/Codex approval is about (agent-tool gates have no grant). */
  function approvalTool(payload: unknown): string | null {
    const name = (payload as { toolName?: unknown } | null)?.toolName
    return typeof name === 'string' && name ? name : null
  }

  function onKey(e: KeyboardEvent): void {
    // The command picker owns the arrow/Tab/Enter/Escape keys while it is open.
    if (cmdOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        cmdIndex = (cmdIndex + 1) % cmdShown.length
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        cmdIndex = (cmdIndex - 1 + cmdShown.length) % cmdShown.length
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        acceptCmd(cmdIndex, false)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        cmdDismissed = true
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        acceptCmd(cmdIndex, true)
        return
      }
    }
    // Don't send mid-IME-composition (e.g. selecting a candidate with Enter in CJK input).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void send()
    }
  }

</script>

{#if !view}
  <div class="empty dim">select a session, or press + to spawn one</div>
{:else}
  <div
    class="chat-drop-target"
    class:composer-only={composerOnly}
    class:dragging-files={draggingFiles}
    ondragenter={onPaneDragEnter}
    ondragover={onPaneDragOver}
    ondragleave={onPaneDragLeave}
    ondrop={onPaneDrop}
    role="presentation"
  >
  {#if draggingFiles}
    <div class="pane-drop-feedback" role="status">Drop files to attach</div>
  {/if}
  {#if !embedded && !composerOnly}
  <div
    class="head"
    role="group"
    aria-label="Chat pane header"
    class:reorderable={multiPane}
    title={multiPane ? 'Drag this header to rearrange the pane' : undefined}
    draggable={multiPane}
    ondragstart={onpanedragstart}
    ondragend={onpanedragend}
  >
    <ProviderLogo provider={view.record.provider} size={16} />
    <div class="headmain">
      <div class="headtop">
        {#if isDraft}
          <span class="title draftpill" title="new chat — not on the hub until you send the first message">New chat <span class="draftbadge">draft</span></span>
        {:else if multiPane}
          <select class="paneselect" value={view.record.id} onchange={(e) => store.setPaneSession(paneIndex, (e.target as HTMLSelectElement).value)}>
            {#each store.sessionList as s (s.record.id)}
              <option value={s.record.id}>{s.record.title ?? `${accountName(s.record.profileId)} · ${(s.record.worktree ?? s.record.cwd).split(/[\\/]/).pop()}`}</option>
            {/each}
          </select>
        {:else}
          <span class="title">{view.record.title ?? accountName(view.record.profileId)}</span>
        {/if}
        <span class="statuschip {st.key}" title={st.label}>
          <span class="dot {st.key}"></span><span class="statuslabel">{st.label}</span>
        </span>
        <span class="sub model dim">{view.record.model ?? view.record.provider}</span>
      </div>
      <div
        class="where dim"
        title="{isDraft ? `Will go to ${workingContext.projectName} / No folder` : workingContext.projectName} — working directory: {workingContext.workingDirectory}"
      >
        {#if isDraft}<span class="prospective">Will go to</span>{/if}
        <span class="project">{workingContext.projectName}</span>
        {#if isDraft}
          <span class="folder-sep" aria-hidden="true">/</span>
          <span class="folder">No folder</span>
        {/if}
        <span class="where-sep" aria-hidden="true">·</span>
        <span class="where-icon" aria-hidden="true"><Icon name={(isDraft ? draftWorkMode : actualWorkMode) === 'worktree' ? 'git-branch' : 'folder'} size={11} /></span>
        <span class="path">{shownWorkingDirectory}</span>
      </div>
    </div>
    <button class="hicon" title="split view" onclick={() => store.startSplit()}><Icon name="columns" size={15} /></button>
    <button class="hicon" title="close (keeps the chat)" onclick={() => store.closePane(paneIndex)}><Icon name="x" size={15} /></button>
  </div>
  {/if}

  {#if worktreeMismatch && !composerOnly}
    <div class="wtwarning" role="alert">
      <Icon name="alert-triangle" size={14} />
      <span><strong>Worktree was requested, but this chat is working directly in the project folder.</strong>
        {view.record.worktreeFallbackReason ?? 'The hub did not report why the isolated checkout was not created.'}</span>
    </div>
  {/if}

  {#if view.record.workspacePressure && !composerOnly}
    <div class="workspace-pressure {view.record.workspacePressure.level}" role="alert">
      <Icon name="hard-drive" size={14} />
      <span><strong>{view.record.workspacePressure.level === 'critical' ? 'Workspace cleanup needed.' : 'Workspace is getting large.'}</strong>
        {workspacePressureDetail} The agent has been notified; remove only regenerable artifacts, never source or uncommitted work.</span>
    </div>
  {/if}

  <div class="thread-container" class:composer-only={composerOnly}>
    <div class="thread-body">
      <div class="conversation" data-composer-height-container>
  {#if !composerOnly || peekItems > 0}
  <div
    class="stream scroll"
    data-overseer-anchor="history"
    class:peek-stream={composerOnly}
    class:replay-rebuild={store.replayPresentationActive}
    bind:this={scroller}
    onscroll={onScroll}
  >
    {#if !composerOnly && (view.journalHistoryOlderCursor != null || view.historyOlderCursor != null)}
      <button
        class="history-page"
        disabled={view.loadingHistory}
        onclick={() => void loadOlderAtTop(true)}
      >
        {view.loadingHistory ? 'Loading history…' : 'Load older history'}
      </button>
    {:else if !composerOnly && view.historyViewingOlder}
      <button class="history-page" onclick={() => { store.showLatestHistory(view.record.id); jumpToBottom() }}>
        Back to latest
      </button>
    {/if}
    {#if !composerOnly && view.historyLoadError}
      <span class="history-error" role="alert">{view.historyLoadError}</span>
    {/if}
    <!-- Items produced INSIDE a spawned sub-agent are excluded here and rendered in the agent panel
         instead: a background agent's tool spam would otherwise bury the conversation you are actually
         having. `agentId` is set only for sub-agent output, so the main thread is unaffected. -->
    {#each displayedRenderNodes as node, i (node.id)}
      {#if node.type === 'group'}
        <!-- Only the LAST group of the trailing run is "live" while the turn is in flight — that is the
             one still accumulating, so it is the one whose elapsed clock should tick. -->
        <div class="stream-node" class:animate-in={node.items.some((item) => !item.replayed)}>
          <CodexActivityGroup items={node.items} {now} live={thinking && i === displayedRenderNodes.length - 1} />
        </div>
      {:else}
        <div class="stream-node" class:animate-in={!node.item.replayed}>
          <ItemCard item={node.item} sessionId={view.record.id} />
        </div>
      {/if}
    {/each}
    {#if mainItems.length === 0 && !thinking}
      {#if showFirstChatGuide}
        <FirstChatGuide
          provider={view.record.provider}
          projectName={workingContext.projectName}
          workingDirectory={workingContext.workingDirectory}
          permissionMode={draftMode}
        />
      {:else if isDraft}
        <div class="dim pad">describe a task below to start this chat</div>
      {:else}
        <div class="dim pad">no activity yet — send a message below</div>
      {/if}
    {/if}
    {#if thinking}
      <div class="thinking">
        <span class="dots"><i></i><i></i><i></i></span>
        <span class="tlabel">thinking</span>
        <span class="tmeta">{elapsedLabel}{#if liveTok?.total}{elapsedLabel ? ' · ' : ''}{fmtTokens(liveTok.total)} tokens{/if}</span>
      </div>
    {/if}
  </div>
  {/if}

  <div class="composer-wrap" data-overseer-anchor="composer">
    <!-- Jump-to-bottom: floats just above the composer (never over it or the action-error slot). Shows
         "N new" when a turn has streamed content below while you read history; a plain arrow otherwise. -->
    {#if jumpAway && !composerOnly}
      <button
        class="jumpbtn"
        onclick={jumpToBottom}
        title="Jump to the latest messages"
        aria-label={newBelow > 0 ? `Jump to latest — ${newBelow} new below` : 'Jump to latest'}
      >
        <Icon name="chevron-down" size={14} />
        {#if newBelow > 0}<span class="jumpcount">{newBelow > 99 ? '99+' : newBelow} new</span>{/if}
      </button>
    {/if}
    <!-- The agent's task board, directly above the chatbar. -->
    {#if !composerOnly}<TaskStrip items={view.items} />{/if}

    {#if questions.length > 0}
      <div class="question-stack" role="region" aria-label="Pending questions">
        <span class="question-arrival" role="status" aria-live="polite" aria-atomic="true">
          {#key questionArrivalGeneration}
            <span>{questionArrival}</span>
          {/key}
        </span>
        {#each questions as question, questionIndex (question.id)}
          <QuestionCard
            record={question}
            ordinal={questionIndex + 1}
            total={questions.length}
            error={questionError?.id === question.id ? questionError.msg : undefined}
            onsubmit={(answers) => answerQuestion(question.id, answers)}
            oncancel={() => cancelQuestion(question.id)}
          />
        {/each}
      </div>
    {/if}

    {#each approvals as a (a.id)}
      {@const blurb = approvalBlurb(a.kind, a.payload)}
      <div class="approval-card" data-testid="approval-{a.id}">
        <div class="atop">
          <span class="alabel">PENDING APPROVAL</span>
          <span class="dim">{blurb.toolName}</span>
        </div>
        <div class="asummary" title={blurb.title ?? blurb.label}>{blurb.label}</div>
        {#if blurb.detail}<pre class="abody">{blurb.detail}</pre>{/if}
        <div class="aacts">
          <button class="abtn ok" onclick={() => decide(a.id, true)}>Approve once</button>
          {#if approvalTool(a.payload)}
            <!-- The answer this prompt never offered. Without it, a long task re-asks for the SAME tool
                 indefinitely, and any prompt the operator misses fails closed after the timeout. -->
            <button
              class="abtn"
              title="Stop asking about this tool in this chat. Revoke it in the permission menu."
              onclick={() => allowAlways(a.id, approvalTool(a.payload) as string)}
            >
              Always allow {approvalTool(a.payload)}
            </button>
          {/if}
          <button class="abtn" onclick={() => decide(a.id, false)}>Decline</button>
        </div>
        {#if grantError}<div class="aerr">{grantError}</div>{/if}
        {#if decideError?.id === a.id}<div class="aerr" role="alert">{decideError.msg}</div>{/if}
      </div>
    {/each}

    {#if queue.length}
      <div class="queue">
        <div class="qhead dim">queued · {queue.length}{#if settings.combineQueued && queue.length > 1} · will combine into one{/if} · sends when the turn finishes</div>
        {#each queue as q, i (i)}
          <div class="qrow">
            <input class="qedit" value={q} onchange={(e) => store.editQueued(view.record.id, i, (e.target as HTMLInputElement).value)} />
            <button class="qx" title="recall" onclick={() => store.removeQueued(view.record.id, i)}>✕</button>
          </div>
        {/each}
      </div>
    {/if}

    {#if sendErr}<div class="senderr" role="alert">⚠ {sendErr} — your message was kept in the box.</div>{/if}
    <div
      class="composer"
      class:dragging-files={draggingFiles}
      role="presentation"
    >
      {#if cmdOpen}
        <div class="cmdmenu">
          <div class="cmdhint dim">Commands · type to filter · Enter runs or completes · Tab completes · Esc dismisses</div>
          {#each cmdShown as c, i (c.kind + ':' + c.name)}
            <button class="cmdrow" class:sel={i === cmdIndex} onmouseenter={() => (cmdIndex = i)} onclick={() => acceptCmd(i, true)}>
              <span class="cmdname">/{c.name}{#if c.argHint}&nbsp;<span class="cmdarg dim">{c.argHint}</span>{/if}</span>
              <span class="cmddesc dim">{c.description}</span>
              <span class="cmdtag {c.kind}">{c.kind === 'builtin' ? 'hub' : 'custom'}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#each pastes as p (p.id)}
        <PastedTextChip paste={p} onremove={removePaste} oninline={inlinePaste} />
      {/each}
      <AttachmentPreview
        {attachments}
        vendor={view.record.provider}
        onremove={removeAttachment}
      />
      <textarea rows="2" wrap="soft" aria-label={composerLabel} use:composerAutoGrow={text}
        placeholder={isDraft ? 'Describe the first task… (Enter to start the chat, Shift+Enter for newline)' : steerable ? 'Steer the running turn… (delivered at the next tool boundary)' : active ? 'Queue a message… (sends when the current turn finishes)' : 'Ask for follow-up changes…  (Enter to send, Shift+Enter for newline)'}
        bind:this={taRef} bind:value={text} onkeydown={onKey} onpaste={onPaste}></textarea>
      <div class="cfoot">
        <input
          class="attachment-input"
          type="file"
          multiple
          bind:this={attachmentInput}
          onchange={onAttachmentPick}
          aria-label="Choose files to attach"
        />
        <button
          class="attach-btn"
          title="Attach files"
          aria-label="Attach files"
          onclick={() => attachmentInput?.click()}
        ><Icon name="paperclip" size={15} /></button>
        <div class="ccontrol c-account" title={`Account: ${view.record.profileId}`}><AccountPicker {view} /></div>
        <div class="ccontrol c-model" title={`Model: ${modelDef?.name ?? model ?? view.record.provider}`}><ModelPicker provider={view.record.provider} {model} onselect={setModel} /></div>
        {#if modelDef}<div class="ccontrol c-traits" title="Model effort and options"><TraitsControl descriptors={modelDef.descriptors} values={options} onchange={setOption} /></div>{/if}
        {#if isDraft}
          <div class="dperm ccontrol" data-overseer-anchor="permissions" title={`Permission mode: ${draftModeDef.label}`}>
            <button class="pill-btn" class:full={draftMode === 'full'} class:open={permOpen} title="permission mode for this chat" onclick={() => (permOpen = !permOpen)}>
              <span class="dlead"><Icon name={draftModeDef.icon} size={13} /></span><span class="control-label">{draftModeDef.label}</span><span class="dchev"><Icon name="chevron-down" size={12} /></span>
            </button>
            {#if permOpen}
              <button class="dscrim" onclick={() => (permOpen = false)} aria-label="close"></button>
              <div class="dmenu">
                {#each PERM_MODES as m (m.id)}
                  <button class="dopt" class:sel={m.id === draftMode} onclick={() => { store.updateDraft(view.record.id, { permissionMode: m.id }); permOpen = false }}>
                    <span class="dic"><Icon name={m.icon} size={15} /></span>
                    <span class="dtxt"><span class="dl">{m.label}</span><span class="dd dim">{m.desc}</span></span>
                    {#if m.id === draftMode}<span class="dtick"><Icon name="check" size={13} /></span>{/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <div class="ccontrol c-permission" data-overseer-anchor="permissions" title={`Permission mode: ${view.record.permissionMode ?? 'safe'}`}>
            <PermissionPicker
              sessionId={view.record.id}
              mode={view.record.permissionMode ?? 'safe'}
              allowedTools={view.record.allowedTools ?? []}
              ceiling={permissionBoundary?.ceiling}
              managedScope={permissionBoundary?.scope}
              managedBy={permissionBoundary?.managedBy}
              operatorOverrideActive={view.record.permissionModeOperatorOverride === true}
              operatorOverrideCeiling={view.record.permissionModeOperatorOverrideCeiling}
              onchange={(next, operatorOverride) => {
                view.record.permissionMode = next
                view.record.permissionModeOperatorOverride = operatorOverride || undefined
                view.record.permissionModeOperatorOverrideCeiling = operatorOverride ? next : undefined
              }}
            />
          </div>
          <div class="ccontrol c-devices" title="Remote testbed access">
            <RemoteDevicePicker
              sessionId={view.record.id}
              grants={view.record.remoteDeviceGrants ?? []}
              onchange={(record) => (view.record.remoteDeviceGrants = record.remoteDeviceGrants)}
            />
          </div>
        {/if}
        {#if view.record.projectId}
          <div class="ccontrol c-worktree" title="Working location">
            <WorktreePicker
              draft={isDraft}
              selected={isDraft ? draftWorkMode : actualWorkMode}
              worktreePath={view.record.worktree}
              {projectPath}
              onselect={(mode) => store.setDraftWorktree(view.record.id, mode === 'worktree')}
            />
          </div>
        {/if}
        <div class="cactions">
          {#if !isDraft}
            {#if stopped}
              <button class="foot-act" onclick={reopenSession} title="reopen this stopped chat so you can use it again"><Icon name="rotate-ccw" size={13} /><span class="control-label">reopen</span></button>
            {:else}
              <!-- Status is display state, not proof that the executor has no live turn. An idle/error row can
                   be stale while a vendor command is still running, so it must not remove the emergency brake. -->
              <button class="foot-act" onclick={interruptTurn} title="interrupt current turn"><Icon name="square" size={12} /><span class="control-label">interrupt</span></button>
              <button class="foot-act" onclick={stopSession} title="stop session"><Icon name="x" size={13} /><span class="control-label">stop</span></button>
            {/if}
          {/if}
          <button class="send-btn" class:queue={active} title={isDraft ? 'start this chat' : steerable ? 'steer into the running turn' : active ? 'queue message' : 'send'} onclick={send} disabled={!canSend}><Icon name={sending ? 'timer' : steerable ? 'corner-down-right' : active ? 'timer' : 'arrow-up'} size={16} /></button>
        </div>
      </div>
      <!-- Action failures sit under their own control cluster: settings under the pills (left), session
           lifecycle under the interrupt/stop/reopen buttons (right) — never a global toast. -->
      {#if actionErr.settings || actionErr.session}
        <div class="actionerrs" role="alert">
          <span class="ae">{actionErr.settings}</span>
          <span class="spacer"></span>
          <span class="ae">{actionErr.session}</span>
        </div>
      {/if}
    </div>
    <div class="checkout dim">
      <ContextMeter {view} />
      {#if settings.showTokenEstimate && estTokens > 0}
        <span class="est" title="rough estimate of the next call's input tokens (re-read context + your draft), ≈ chars/4">~{fmtTokens(estTokens)} tokens next call</span>
      {/if}
      <span class="spacer"></span>
      <span>{#if isDraft}draft · not started yet{:else}{view.record.worktree ? '▣ worktree' : '▣ project'} · {view.record.id.slice(0, 8)}{/if}</span>
    </div>
  </div>
      </div>
      <!-- Open panels are an in-flow sibling: they consume layout space instead of covering the
           transcript. The narrow-pane container query stacks the panel below this conversation. -->
       {#if !composerOnly}
         <AgentPanel
           items={view.items}
           sessionId={view.record.id}
           provider={view.record.provider}
           open={sidePanel === 'agents'}
           onopen={() => setSidePanel('agents')}
           onclose={() => setSidePanel(null)}
         />
         {#if !isDraft}
           <BrowserPanel
             sessionId={view.record.id}
             agentLabel={browserAgentLabel}
             initialEnabled={view.record.browserEnabled === true}
             open={sidePanel === 'browser'}
             onopen={() => setSidePanel('browser')}
             onclose={() => setSidePanel(null)}
           />
         {/if}
       {/if}
    </div>
  </div>
  </div>
{/if}

<style>
  .empty { display: grid; place-items: center; height: 100%; }
  .chat-drop-target {
    position: relative; flex: 1; display: flex; flex-direction: column;
    width: 100%; min-width: 0; min-height: 0;
  }
  .chat-drop-target.composer-only { flex: none; min-height: auto; }
  .chat-drop-target.dragging-files {
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 70%, transparent);
  }
  .pane-drop-feedback {
    position: absolute; inset: 0.55rem; z-index: 50; pointer-events: none;
    display: grid; place-items: center; border: 2px dashed var(--accent); border-radius: 12px;
    color: var(--text); background: color-mix(in srgb, var(--accent) 12%, var(--surface) 82%);
    font-size: 0.86rem; font-weight: 600; letter-spacing: 0.01em;
    box-shadow: var(--shadow-2);
  }
  .head {
    display: flex; align-items: center; gap: 0.5rem; min-width: 0; padding: 0.45rem 0.75rem;
    border-bottom: 1px solid var(--border); container: thread-head / inline-size;
  }
  .head.reorderable { cursor: grab; }
  .head.reorderable:active { cursor: grabbing; }
  .headmain { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; gap: 0.12rem; }
  .headtop { display: flex; align-items: center; gap: 0.45rem; min-width: 0; height: 1.45rem; }
  .title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .paneselect { flex: 0 1 15rem; min-width: 0; max-width: 15rem; font-size: 0.82rem; padding: 0.2rem 0.4rem; }
  .where { display: flex; align-items: center; min-width: 0; gap: 0.28rem; font-size: 0.7rem; line-height: 1rem; }
  .prospective { flex: none; color: var(--accent); font-weight: 600; }
  .project { flex: 0 1 auto; max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
  .folder { flex: none; color: var(--text); }
  .folder-sep, .where-sep, .where-icon { flex: none; }
  /* RTL makes text-overflow place its fallback ellipsis at the START, so the working directory's
     identifying tail survives even below the pure helper's compact split-pane budget. */
  .path {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl;
    text-align: left; font-family: var(--mono);
  }
  .wtwarning { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-2) 1rem;
    color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, var(--surface));
    border-bottom: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border)); font-size: var(--text-sm); }
  .wtwarning strong { color: var(--text); margin-right: var(--space-1); }
  .workspace-pressure { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-2) 1rem;
    color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, var(--surface));
    border-bottom: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border)); font-size: var(--text-sm); }
  .workspace-pressure.critical { color: var(--bad-text); background: color-mix(in srgb, var(--bad) 9%, var(--surface));
    border-bottom-color: color-mix(in srgb, var(--bad) 45%, var(--border)); }
  .workspace-pressure strong { color: var(--text); margin-right: var(--space-1); }
  .thread-container {
    flex: 1; min-width: 0; min-height: 0;
    container-type: inline-size; container-name: thread-body;
  }
  .thread-container.composer-only { flex: none; min-height: auto; }
  .composer-only .thread-body, .composer-only .conversation { height: auto; min-height: 0; }
  .composer-only .composer-wrap { max-width: none; padding: 0; }
  .composer-only .peek-stream { flex: none; max-width: none; max-height: 15rem; margin: 0;
    padding: .7rem .8rem; overflow: hidden auto; border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-2); }
  .thread-body { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; }
  .conversation { flex: 1 1 0; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  /* Beside the transcript above this width, below it beneath: a 240px useful panel plus a 380px useful
     transcript is the smallest honest side-by-side split. It never overlays the conversation. */
  @container thread-body (max-width: 620px) {
    .thread-body { flex-direction: column; overflow-x: hidden; overflow-y: auto; }
    /* At short phone/split heights the composer alone can be ~230px. Refuse to crush the conversation
       below a usable 270px; the body scrolls internally to the in-flow drawer instead of either surface
       painting over the other. */
    .conversation { flex: 1 0 270px; min-height: 270px; }
  }
  @container thread-body (max-width: 360px) {
    .thread-body .composer-wrap { padding-inline: 0.25rem; }
    .thread-body .composer { padding-inline: 0.4rem; }
    .thread-body .checkout { padding-inline: 0; }
  }
  .hicon { display: grid; place-items: center; color: var(--muted); width: 26px; height: 24px; border-radius: 6px; }
  .hicon:hover { background: var(--surface-2); color: var(--text); }
  .statuschip { display: inline-flex; flex: none; align-items: center; gap: 0.3rem; font-size: 0.72rem; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.45rem; }
  .statuschip.working { color: var(--working); border-color: var(--working); }
  .statuschip.completed { color: var(--ok); border-color: var(--ok); }
  .statuschip.approval { color: var(--warn); border-color: var(--warn); }
  .statuschip.question { color: var(--secondary); border-color: var(--secondary); }
  .statuschip.error { color: var(--bad-text); border-color: var(--bad); }
  .sub { flex: none; font-size: 0.78rem; }
  .spacer { flex: 1; }
  @container thread-head (max-width: 440px) {
    .model { display: none; }
  }
  @container thread-head (max-width: 310px) {
    .statuschip { gap: 0; padding-inline: 0.28rem; }
    .statuslabel { display: none; }
    .prospective { font-size: 0; }
    .prospective::after { content: '→'; font-size: 0.7rem; }
    .project { max-width: 35%; }
    .folder { font-size: 0; }
    .folder::after { content: 'none'; font-size: 0.7rem; }
  }
  .hbtn { font-size: 0.76rem; color: var(--muted); border: 1px solid var(--border); border-radius: 7px; padding: 0.22rem 0.5rem; }
  .hbtn:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text); }
  .hbtn:disabled { opacity: 0.4; cursor: default; }
  .stream { flex: 1; display: flex; flex-direction: column; gap: 0.55rem; padding: 1rem 1.1rem; max-width: 900px; width: 100%; margin: 0 auto; container-type: inline-size; }
  .history-page { align-self: center; max-width: 18rem; }
  .history-error { align-self: center; max-width: 34rem; color: var(--danger); font-size: 0.78rem; text-align: center; }
  .stream.replay-rebuild { visibility: hidden; }
  .stream-node { min-width: 0; }
  @media (prefers-reduced-motion: no-preference) {
    .stream > :global(*:not(.stream-node)), .stream > .stream-node.animate-in { animation: fade-in 0.22s var(--ease); }
  }
  .pad { padding: 1rem 0; }
  .thinking { display: flex; align-items: center; gap: 0.5rem; padding: 0.2rem 0.15rem; }
  .thinking .dots { display: inline-flex; gap: 3px; }
  .thinking .dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--working); }
  .tlabel { color: var(--working); font-size: 0.84rem; }
  .tmeta { color: var(--dim); font-family: var(--mono); font-size: 0.74rem; }
  @media (prefers-reduced-motion: no-preference) {
    .thinking .dots i { animation: tbounce 1.1s var(--ease) infinite; }
    .thinking .dots i:nth-child(2) { animation-delay: 0.15s; }
    .thinking .dots i:nth-child(3) { animation-delay: 0.3s; }
    @keyframes tbounce { 0%, 60%, 100% { opacity: 0.35; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
  }
  .composer-wrap { position: relative; padding: 0.5rem 1rem 0.7rem; max-width: 900px; width: 100%; margin: 0 auto; }
  /* Floats just above the composer-wrap's top edge (= the transcript's lower edge), centered — clear of
     the composer and the action-error slot, both of which live lower inside this wrap. */
  .jumpbtn { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 8px; z-index: 12;
    display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.28rem 0.6rem; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--border-strong); color: var(--text);
    box-shadow: var(--shadow-3), var(--edge-hi); font-size: 0.74rem; }
  .jumpbtn:hover { border-color: var(--accent); color: var(--text); }
  .jumpcount { font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: no-preference) { .jumpbtn { animation: pop-in var(--dur-fast) var(--ease); } }
  .approval-card { background: var(--surface); border: 1px solid var(--warn); border-radius: 10px; padding: 0.5rem 0.7rem; margin-bottom: 0.5rem; }
  .question-stack {
    display: grid;
    gap: 0.5rem;
    max-height: min(42dvh, 30rem);
    margin-bottom: 0.5rem;
    padding-right: 0.2rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .question-arrival {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @media (max-height: 650px) {
    .question-stack { max-height: 34dvh; }
  }
  .atop { display: flex; gap: 0.5rem; align-items: center; }
  .alabel { font-size: 0.66rem; letter-spacing: 0.08em; color: var(--warn); }
  .asummary { margin-top: 0.3rem; font-size: var(--text-sm); color: var(--text); font-weight: var(--fw-medium); }
  /* Human field lines and full commands/paths stay readable without shattering identifiers mid-token.
     Still capped and scrollable so a large question cannot push out the composer. */
  .abody { margin: 0.35rem 0; font-size: 0.74rem; color: var(--muted); max-height: 14rem; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); }
  .aacts { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .aerr { margin-top: 0.35rem; font-size: 0.74rem; color: var(--bad-text); }
  .abtn { font-size: 0.76rem; border: 1px solid var(--border-strong); border-radius: 7px; padding: 0.25rem 0.6rem; color: var(--muted); }
  .abtn.ok { border-color: var(--ok); color: var(--ok); }
  .abtn:hover { color: var(--text); }
  .queue { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.5rem; background: var(--surface); border: 1px dashed var(--border-strong); border-radius: 10px; padding: 0.45rem 0.55rem; }
  .qhead { font-size: 0.68rem; }
  .qrow { display: flex; gap: 0.35rem; align-items: center; }
  .qedit { flex: 1; background: var(--surface-2); font-size: 0.8rem; }
  .qx { color: var(--dim); width: 22px; height: 22px; border-radius: 5px; flex: none; }
  .qx:hover { background: var(--surface-3); color: var(--bad-text); }
  .send-btn.queue { background: var(--warn); color: #1a1206; }
  .est { color: var(--muted); }
  .senderr { color: var(--bad-text); font-size: 0.76rem; margin-bottom: 0.45rem; }
  .actionerrs { display: flex; gap: 0.5rem; margin-top: 0.35rem; padding: 0 0.2rem; }
  .ae { color: var(--bad-text); font-size: 0.72rem; }
  .tmeta, .est { font-variant-numeric: tabular-nums; }
  .composer { position: relative; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 14px; padding: 0.6rem 0.7rem 0.5rem; }
  .composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
  .composer.dragging-files { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, var(--surface)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
  @media (prefers-reduced-motion: no-preference) { .composer { transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); } }
  .composer textarea {
    width: 100%; background: none; border: none; resize: none; padding: 0.1rem 0.2rem;
    overflow-x: hidden; overflow-y: hidden; overscroll-behavior: contain; scrollbar-gutter: stable;
  }
  .cfoot {
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.4rem; margin-top: 0.35rem;
    min-width: 0; container-type: inline-size; container-name: composer-footer;
  }
  .ccontrol { flex: 0 1 auto; min-width: 1.9rem; max-width: 100%; }
  .ccontrol:not(button) { overflow: visible; }
  .ccontrol :global(.wrap) { min-width: 0; max-width: 100%; }
  .c-worktree { overflow: hidden !important; }
  .c-worktree :global(.workmode) { max-width: 100%; }
  .ccontrol :global(.pill-btn) {
    max-width: 100%; min-width: 0; overflow: hidden; white-space: nowrap;
  }
  .control-label, .ccontrol :global(.pill-label) {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cactions {
    margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem;
    flex: 0 1 auto; min-width: 0; max-width: 100%;
  }

  /* First cap long labels so they ellipsize; only at genuinely icon-sized pane widths hide labels and
     chevrons. Every resulting icon button keeps its descriptive title. */
  @container composer-footer (max-width: 520px) {
    .ccontrol { max-width: 9rem; }
  }
  @container composer-footer (max-width: 360px) {
    .ccontrol { max-width: 6rem; }
  }
  @container composer-footer (max-width: 260px) {
    .ccontrol { flex: 0 0 1.9rem; width: 1.9rem; max-width: 1.9rem; }
    .ccontrol :global(.pill-btn) {
      width: 1.9rem; padding-inline: 0.4rem; gap: 0; justify-content: flex-start;
    }
    .control-label, .ccontrol :global(.pill-label),
    .ccontrol :global(.chev), .dchev { display: none; }
    .foot-act { width: 1.9rem; padding-inline: 0; justify-content: center; }
    .foot-act .control-label { display: none; }
    .cactions { margin-left: 0; }
    .c-worktree { flex-basis: 3.25rem; width: 3.25rem; max-width: 3.25rem; }
    .c-worktree :global(.segment span) { display: none; }
    .c-worktree :global(.segments) { gap: 0; }
    .c-worktree :global(.segment) { padding-inline: 0.25rem; }
  }
  .attachment-input { display: none; }
  .attach-btn { display: inline-grid; place-items: center; width: 28px; height: 26px; flex: none; border: 1px solid var(--border); border-radius: 7px; color: var(--muted); }
  .attach-btn:hover { border-color: var(--border-strong); color: var(--text); background: var(--surface-2); }

  /* `/` command picker — floats above the composer, type-ahead filtered. */
  .cmdmenu { position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; z-index: 11; max-height: 320px; overflow-y: auto;
    background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--space-1);
    box-shadow: var(--shadow-3), var(--edge-hi); }
  @media (prefers-reduced-motion: no-preference) { .cmdmenu { animation: pop-in var(--dur-fast) var(--ease); } }
  .cmdhint { font-size: 0.64rem; padding: 0.15rem 0.45rem 0.3rem; }
  .cmdrow { display: flex; align-items: baseline; gap: 0.55rem; width: 100%; text-align: left; padding: var(--space-2) var(--space-3); border-radius: var(--r-md); }
  .cmdrow:hover, .cmdrow.sel { background: var(--surface-3); }
  .cmdname { font-family: var(--mono); font-size: 0.8rem; flex: none; white-space: nowrap; }
  .cmdarg { font-weight: 400; }
  .cmddesc { flex: 1; font-size: 0.74rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmdtag { flex: none; font-size: 0.58rem; letter-spacing: 0.05em; text-transform: uppercase; border-radius: var(--r-xs);
    padding: 0 0.32rem; border: 1px solid var(--border-strong); color: var(--muted); }
  .cmdtag.builtin { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
  .foot-act { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.75rem; color: var(--muted); border: 1px solid var(--border); border-radius: 7px; padding: 0.22rem 0.5rem; }
  .foot-act:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text); }
  .foot-act:disabled { opacity: 0.35; cursor: default; }
  .mode { cursor: default; }
  .checkout { display: flex; gap: 0.5rem; font-size: 0.72rem; padding: 0.35rem 0.4rem 0; }

  /* Draft chat: title badge in the head. */
  .draftpill { display: inline-flex; align-items: center; gap: 0.4rem; }
  .draftbadge { font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase; font-weight: var(--fw-semibold);
    color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: var(--r-pill); padding: 0.05rem 0.4rem; }

  /* Draft-only inline permission picker — mirrors PermissionPicker (which can't target a draft,
     since it posts to the hub and a draft has no session there). */
  .dperm { position: relative; }
  .pill-btn.full { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
  .pill-btn.full .dlead { color: var(--warn); }
  .dlead { display: inline-grid; color: var(--muted); }
  .dchev { display: inline-grid; opacity: 0.6; }
  .dscrim { position: fixed; inset: 0; background: transparent; border: none; z-index: 10; }
  .dmenu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 11; min-width: 210px; background: var(--surface-2);
    border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--space-1); box-shadow: var(--shadow-3), var(--edge-hi); }
  @media (prefers-reduced-motion: no-preference) { .dmenu { animation: pop-in var(--dur-fast) var(--ease); } }
  .dopt { display: flex; align-items: center; gap: var(--space-3); width: 100%; text-align: left; padding: var(--space-3); border-radius: var(--r-md); }
  .dopt:hover, .dopt.sel { background: var(--surface-3); }
  .dic { display: inline-grid; place-items: center; width: 1.2rem; color: var(--muted); }
  .dopt.sel .dic { color: var(--accent); }
  .dtxt { display: flex; flex-direction: column; }
  .dopt.sel .dl { font-weight: var(--fw-medium); }
  .dl { font-size: var(--text-sm); }
  .dd { font-size: var(--text-xs); }
  .dtick { margin-left: auto; display: inline-grid; color: var(--accent); flex: none; }
</style>
