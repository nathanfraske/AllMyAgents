export const SETTINGS_TABS = [
  { id: 'chats', label: 'Chats', sections: ['Defaults for new chats', 'Unfiled / detached chats', 'Composer', 'File-write display'] },
  { id: 'accounts', label: 'Accounts & usage', sections: ['Accounts', 'Usage'] },
  { id: 'instructions', label: 'Instructions', sections: ['Operator profile & instructions'] },
  { id: 'remote', label: 'Remote access', sections: ['Remote access'] },
  { id: 'safety', label: 'Safety', sections: ['Danger Zone', 'Agent-authored practices'] },
  { id: 'system', label: 'System', sections: ['Getting started', 'Updates', 'Maintenance'] },
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']
export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'chats'
const SETTINGS_TAB_KEY = 'allmyagents.ui.settingsTab'

export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return typeof value === 'string' && SETTINGS_TABS.some((tab) => tab.id === value)
}

export function sectionsForSettingsTab(tabId: SettingsTabId): readonly string[] {
  return SETTINGS_TABS.find((tab) => tab.id === tabId)?.sections ?? []
}

export function settingsTabHasSection(tabId: SettingsTabId, section: string): boolean {
  return sectionsForSettingsTab(tabId).some((candidate) => candidate === section)
}

/** Same defensive localStorage pattern as the sidebar's collapsed folders in uiState.ts. */
export function loadSettingsTab(): SettingsTabId {
  try {
    const raw = localStorage.getItem(SETTINGS_TAB_KEY)
    if (raw) {
      const value = JSON.parse(raw) as unknown
      if (isSettingsTabId(value)) return value
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS_TAB
}

export function saveSettingsTab(tabId: SettingsTabId): void {
  try {
    localStorage.setItem(SETTINGS_TAB_KEY, JSON.stringify(tabId))
  } catch {
    /* ignore */
  }
}
