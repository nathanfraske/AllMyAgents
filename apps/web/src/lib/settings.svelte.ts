interface Settings {
  showSpend: boolean
  planBudgetUsd: number | null
  showTokenEstimate: boolean
  combineQueued: boolean
  defaultAccount: string
  defaultPermissionMode: string
  defaultClaudeModel: string
  defaultCodexModel: string
  defaultUseWorktree: boolean
  ownerName: string
  detachedDefaultProjectId: string | null
  detachedDefaultMode: 'safe' | 'edits' | 'full'
  // On the first send in a new chat, switch the active pane to the freshly-spawned session (so you land
  // on the chat you just started instead of staying on the previous one). Default on.
  autoSwitchToNewChat: boolean
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
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
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
  defaultPermissionMode = $state('safe')
  defaultClaudeModel = $state('')
  defaultCodexModel = $state('')
  defaultUseWorktree = $state(true)
  ownerName = $state('')
  detachedDefaultProjectId = $state<string | null>(null)
  detachedDefaultMode = $state<'safe' | 'edits' | 'full'>('safe')
  autoSwitchToNewChat = $state(true)

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
  }

  save(): void {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
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
        })
      )
    } catch {
      /* ignore */
    }
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
