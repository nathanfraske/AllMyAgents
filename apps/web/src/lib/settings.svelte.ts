import { api, type UiPreferences } from './api'

interface Settings extends UiPreferences {
  // On the first send in a new chat, switch the active pane to the freshly-spawned session (so you land
  // on the chat you just started instead of staying on the previous one). Default on.
  autoSwitchToNewChat: boolean
  // On launch/reload, reopen the chat(s) and split layout that were open last time. Default OFF: the
  // home screen's "reopen" banner is the normal way back, and jumping straight into a chat on every
  // start is presumptuous. Turn it on to skip the banner.
  autoReopenLastChats: boolean
  // Check the GitHub release endpoint for a newer signed build on launch. Never installs anything on
  // its own — an available update only raises a banner the operator has to accept. Default on.
  autoCheckUpdates: boolean
  // A paste of at least this many characters is promoted to a "pasted text" chip in the composer instead
  // of dumping a wall into the box (and then the transcript). 0 disables promotion. Default is well above
  // an ordinary message/snippet so normal pasting is unaffected; lower it to catch smaller dumps.
  pasteAsTextThreshold: number
}

const KEY = 'allmyagents.settings'
const LEGACY_KEY = 'aiagentapp.settings' // migrate settings saved under the pre-rename key
const DEFAULTS: Settings = {
  showSpend: false,
  planBudgetUsd: null,
  showTokenEstimate: true,
  combineQueued: true,
  defaultAccount: '',
  defaultPermissionMode: 'safe',
  defaultClaudeModel: '',
  defaultCodexModel: '',
  defaultUseWorktree: true,
  ownerName: '',
  detachedDefaultProjectId: null,
  detachedDefaultMode: 'safe',
  autoSwitchToNewChat: true,
  autoReopenLastChats: false,
  autoCheckUpdates: true,
  pasteAsTextThreshold: 10000,
}

/**
 * Bump when a DEFAULT changes in a way that should reach existing installs.
 *
 * Changing a default only affects people who have never saved settings — everyone else keeps the value
 * persisted under the OLD default forever, silently. That is not academic: `autoReopenLastChats` shipped
 * default-ON, was changed to default-OFF on request, and existing installs kept auto-reopening (the app
 * would show home, then jump into the last chat a moment later) because `true` was already in storage.
 */
const SETTINGS_VERSION = 2
/** Keys whose persisted value is discarded when migrating TO that version, so the new default applies. */
const RESET_ON_VERSION: Record<number, (keyof Settings)[]> = {
  2: ['autoReopenLastChats'],
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Settings> & { _v?: number }
      const from = typeof stored._v === 'number' ? stored._v : 1
      if (from < SETTINGS_VERSION) {
        for (let v = from + 1; v <= SETTINGS_VERSION; v++) {
          for (const key of RESET_ON_VERSION[v] ?? []) delete stored[key]
        }
      }
      return { ...DEFAULTS, ...stored }
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS }
}

class SettingsStore {
  showSpend = $state(false)
  planBudgetUsd = $state<number | null>(null)
  showTokenEstimate = $state(true)
  combineQueued = $state(true)
  defaultAccount = $state('')
  defaultPermissionMode = $state<'safe' | 'edits' | 'full'>('safe')
  defaultClaudeModel = $state('')
  defaultCodexModel = $state('')
  defaultUseWorktree = $state(true)
  ownerName = $state('')
  detachedDefaultProjectId = $state<string | null>(null)
  detachedDefaultMode = $state<'safe' | 'edits' | 'full'>('safe')
  autoSwitchToNewChat = $state(true)
  autoReopenLastChats = $state(false)
  autoCheckUpdates = $state(true)
  pasteAsTextThreshold = $state(10000)
  /** Visible save truth: local cache is immediate; hub sync is the update/restart durability boundary. */
  syncState = $state<'local' | 'saving' | 'saved' | 'error'>('local')
  syncError = $state('')
  private hubReady = false
  private dirtyBeforeHub = false
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private syncGeneration = 0

  constructor() {
    const s = load()
    this.showSpend = s.showSpend
    this.planBudgetUsd = s.planBudgetUsd
    this.showTokenEstimate = s.showTokenEstimate
    this.combineQueued = s.combineQueued
    this.defaultAccount = s.defaultAccount
    this.defaultPermissionMode = s.defaultPermissionMode
    this.defaultClaudeModel = s.defaultClaudeModel
    this.defaultCodexModel = s.defaultCodexModel
    this.defaultUseWorktree = s.defaultUseWorktree
    this.ownerName = s.ownerName
    this.detachedDefaultProjectId = s.detachedDefaultProjectId
    this.detachedDefaultMode = s.detachedDefaultMode
    this.autoSwitchToNewChat = s.autoSwitchToNewChat
    this.autoReopenLastChats = s.autoReopenLastChats
    this.autoCheckUpdates = s.autoCheckUpdates
    this.pasteAsTextThreshold = s.pasteAsTextThreshold
  }

  private snapshot(): UiPreferences {
    return {
      showSpend: this.showSpend,
      planBudgetUsd: this.planBudgetUsd,
      showTokenEstimate: this.showTokenEstimate,
      combineQueued: this.combineQueued,
      defaultAccount: this.defaultAccount,
      defaultPermissionMode: this.defaultPermissionMode,
      defaultClaudeModel: this.defaultClaudeModel,
      defaultCodexModel: this.defaultCodexModel,
      defaultUseWorktree: this.defaultUseWorktree,
      ownerName: this.ownerName,
      detachedDefaultProjectId: this.detachedDefaultProjectId,
      detachedDefaultMode: this.detachedDefaultMode,
      autoSwitchToNewChat: this.autoSwitchToNewChat,
      autoReopenLastChats: this.autoReopenLastChats,
      autoCheckUpdates: this.autoCheckUpdates,
      pasteAsTextThreshold: this.pasteAsTextThreshold,
    }
  }

  private apply(value: UiPreferences): void {
    this.showSpend = value.showSpend
    this.planBudgetUsd = value.planBudgetUsd
    this.showTokenEstimate = value.showTokenEstimate
    this.combineQueued = value.combineQueued
    this.defaultAccount = value.defaultAccount
    this.defaultPermissionMode = value.defaultPermissionMode
    this.defaultClaudeModel = value.defaultClaudeModel
    this.defaultCodexModel = value.defaultCodexModel
    this.defaultUseWorktree = value.defaultUseWorktree
    this.ownerName = value.ownerName
    this.detachedDefaultProjectId = value.detachedDefaultProjectId
    this.detachedDefaultMode = value.detachedDefaultMode
    this.autoSwitchToNewChat = value.autoSwitchToNewChat
    this.autoReopenLastChats = value.autoReopenLastChats
    this.autoCheckUpdates = value.autoCheckUpdates
    this.pasteAsTextThreshold = value.pasteAsTextThreshold
  }

  private saveLocal(): boolean {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          ...this.snapshot(),
          _v: SETTINGS_VERSION, // so a future default change can migrate this install (see load)
        })
      )
      return true
    } catch {
      this.syncState = 'error'
      this.syncError = 'Settings could not be cached on this device.'
      return false
    }
  }

  private async pushToHub(): Promise<void> {
    const generation = ++this.syncGeneration
    this.syncState = 'saving'
    this.syncError = ''
    try {
      const result = await api.setPrefs({ ui: this.snapshot() })
      if (generation !== this.syncGeneration) return
      if ('error' in result) throw new Error(result.error)
      if (!result.ui) throw new Error('The connected hub did not accept durable UI settings.')
      this.apply(result.ui)
      if (!this.saveLocal()) return
      this.syncState = 'saved'
      this.dirtyBeforeHub = false
    } catch (error) {
      if (generation !== this.syncGeneration) return
      this.syncState = 'error'
      this.syncError = error instanceof Error ? error.message : String(error)
      this.dirtyBeforeHub = true
    }
  }

  private queueHubSave(): void {
    this.dirtyBeforeHub = true
    if (!this.hubReady) {
      this.syncState = 'local'
      return
    }
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncState = 'saving'
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.pushToHub()
    }, 180)
  }

  save(): void {
    if (!this.saveLocal()) return
    this.queueHubSave()
  }

  /**
   * Reconcile the durable hub copy with the renderer cache once bootstrap connects.
   * Existing installs migrate local -> hub exactly once; later installs/restarts load hub -> local.
   * A setting changed while disconnected wins over the older hub copy rather than being erased.
   */
  async syncWithHub(remote?: UiPreferences): Promise<void> {
    this.hubReady = true
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    if (this.dirtyBeforeHub || !remote) {
      await this.pushToHub()
      return
    }
    this.apply(remote)
    if (!this.saveLocal()) return
    this.syncState = 'saved'
    this.syncError = ''
  }

  toggleSpend(): void {
    this.showSpend = !this.showSpend
    this.save()
  }

  toggleTokenEstimate(): void {
    this.showTokenEstimate = !this.showTokenEstimate
    this.save()
  }

  toggleCombineQueued(): void {
    this.combineQueued = !this.combineQueued
    this.save()
  }

  setBudget(v: number | null): void {
    this.planBudgetUsd = v
    this.save()
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    ;(this as unknown as Settings)[key] = value
    this.save()
  }
}

export const settings = new SettingsStore()
