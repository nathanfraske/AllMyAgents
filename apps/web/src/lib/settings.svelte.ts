interface Settings {
  showSpend: boolean
  planBudgetUsd: number | null
}

const KEY = 'aiagentapp.settings'

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { showSpend: false, planBudgetUsd: null, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    /* ignore */
  }
  return { showSpend: false, planBudgetUsd: null }
}

class SettingsStore {
  showSpend = $state(false)
  planBudgetUsd = $state<number | null>(null)

  constructor() {
    const s = load()
    this.showSpend = s.showSpend
    this.planBudgetUsd = s.planBudgetUsd
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ showSpend: this.showSpend, planBudgetUsd: this.planBudgetUsd }))
    } catch {
      /* ignore */
    }
  }

  toggleSpend(): void {
    this.showSpend = !this.showSpend
    this.save()
  }

  setBudget(v: number | null): void {
    this.planBudgetUsd = v
    this.save()
  }
}

export const settings = new SettingsStore()
