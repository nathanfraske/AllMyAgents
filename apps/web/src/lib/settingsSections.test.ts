import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  isSettingsTabId,
  loadSettingsTab,
  saveSettingsTab,
  settingsTabHasSection,
  sectionsForSettingsTab,
} from './settingsSections'

beforeEach(() => {
  localStorage.clear()
})

describe('settings area tabs', () => {
  it('groups controls by operator task rather than their former scroll order', () => {
    expect(sectionsForSettingsTab('general')).toEqual([
      'Defaults for new chats',
      'Unfiled / detached chats',
      'Composer',
      'File-write display',
      'Usage',
    ])
    expect(sectionsForSettingsTab('accounts')).toEqual(['Accounts'])
    expect(sectionsForSettingsTab('overseer')).toEqual([
      'Overseer',
      'Notifications',
      'Operator profile & instructions',
    ])
    expect(sectionsForSettingsTab('remote')).toEqual(['Remote access'])
    expect(sectionsForSettingsTab('advanced')).toEqual([
      'Updates',
      'Maintenance',
      'Privileged operations',
      'Danger Zone',
      'Agent-authored practices',
      'Getting started',
    ])
    expect(settingsTabHasSection('advanced', 'Agent-authored practices')).toBe(true)
    expect(settingsTabHasSection('accounts', 'Maintenance')).toBe(false)
  })

  it('defines unique, validated tab ids with General as the first-run default', () => {
    const ids = SETTINGS_TABS.map((tab) => tab.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(DEFAULT_SETTINGS_TAB).toBe('general')
    expect(isSettingsTabId('advanced')).toBe(true)
    expect(isSettingsTabId('made-up')).toBe(false)
  })

  it('restores the last valid tab and rejects malformed persisted state', () => {
    saveSettingsTab('remote')
    expect(loadSettingsTab()).toBe('remote')

    localStorage.setItem('allmyagents.ui.settingsTab', JSON.stringify('made-up'))
    expect(loadSettingsTab()).toBe(DEFAULT_SETTINGS_TAB)

    localStorage.setItem('allmyagents.ui.settingsTab', '{broken')
    expect(loadSettingsTab()).toBe(DEFAULT_SETTINGS_TAB)
  })

  it('migrates former settings tabs to their consolidated destination', () => {
    localStorage.setItem('allmyagents.ui.settingsTab', JSON.stringify('chats'))
    expect(loadSettingsTab()).toBe('general')
    localStorage.setItem('allmyagents.ui.settingsTab', JSON.stringify('instructions'))
    expect(loadSettingsTab()).toBe('overseer')
    localStorage.setItem('allmyagents.ui.settingsTab', JSON.stringify('system'))
    expect(loadSettingsTab()).toBe('advanced')
  })
})
