interface Settings {
  showSpend: boolean
  planBudgetUsd: number | null
  showTokenEstimate: boolean
  combineQueued: boolean
  defaultAccount: string
  defaultPermissionMode: string
  defaultClaudeModel: string
  defaultCodexModel: string
}

const KEY = 'aiagentapp.settings'
const DEFAULTS: Settings = {
  showSpend: false,
  planBudgetUsd: null,
  showTokenEstimate: true,
  combineQueued: true,
  defaultAccount: '',
  defaultPermissionMode: 'safe',
  defaultClaudeModel: '',
  defaultCodexModel: '',
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
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
