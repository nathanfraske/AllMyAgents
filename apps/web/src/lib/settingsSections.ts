export const SETTINGS_TABS = [
  {
    id: 'general',
    label: 'General',
    description: 'Everyday chat, display, and usage defaults.',
    sections: ['Defaults for new chats', 'Unfiled / detached chats', 'Composer', 'File-write display', 'Usage'],
  },
  {
    id: 'accounts',
    label: 'Accounts',
    description: 'Sign in, rename, repair, and choose provider accounts.',
    sections: ['Accounts'],
  },
  {
    id: 'overseer',
    label: 'Overseer & alerts',
    description: 'Configure application help, durable instructions, and attention rules.',
    sections: ['Overseer', 'Notifications', 'Operator profile & instructions'],
  },
  {
    id: 'remote',
    label: 'Devices & remote',
    description: 'Mesh connections, paired hubs, and approved testbeds.',
    sections: ['Remote access'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Updates, maintenance, privileged operations, and safety controls.',
    sections: ['Updates', 'Maintenance', 'Privileged operations', 'Danger Zone', 'Agent-authored practices', 'Getting started'],
  },
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']
export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'general'
const SETTINGS_TAB_KEY = 'allmyagents.ui.settingsTab'
const LEGACY_TABS: Record<string, SettingsTabId> = {
  chats: 'general',
  instructions: 'overseer',
  safety: 'advanced',
  system: 'advanced',
}

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
      if (typeof value === 'string' && LEGACY_TABS[value]) return LEGACY_TABS[value]
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
