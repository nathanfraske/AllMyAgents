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
    expect(sectionsForSettingsTab('accounts')).toEqual(['Accounts', 'Usage'])
    expect(sectionsForSettingsTab('chats')).toEqual([
      'Defaults for new chats',
      'Unfiled / detached chats',
      'Composer',
      'File-write display',
    ])
    expect(sectionsForSettingsTab('instructions')).toEqual(['Operator profile & instructions'])
    expect(sectionsForSettingsTab('remote')).toEqual(['Remote access'])
    expect(sectionsForSettingsTab('safety')).toEqual(['Danger Zone', 'Agent-authored practices'])
    expect(sectionsForSettingsTab('system')).toEqual(['Updates', 'Maintenance'])
    expect(settingsTabHasSection('safety', 'Agent-authored practices')).toBe(true)
    expect(settingsTabHasSection('accounts', 'Maintenance')).toBe(false)
  })

  it('defines unique, validated tab ids with Chats as the first-run default', () => {
    const ids = SETTINGS_TABS.map((tab) => tab.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(DEFAULT_SETTINGS_TAB).toBe('chats')
    expect(isSettingsTabId('safety')).toBe(true)
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
})
