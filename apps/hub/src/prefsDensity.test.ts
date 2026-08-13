import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import { persistPrefs } from './server.js'
import { asFileWriteDiffDensity, asUiPreferences, DEFAULT_UI_PREFERENCES } from './types.js'

describe('file-write diff density preference', () => {
  it('resolves absent or invalid config to minimal and accepts all supported values', () => {
    expect(asFileWriteDiffDensity(undefined)).toBe('minimal')
    expect(asFileWriteDiffDensity('invalid')).toBe('minimal')
    expect(asFileWriteDiffDensity('minimal')).toBe('minimal')
    expect(asFileWriteDiffDensity('summary')).toBe('summary')
    expect(asFileWriteDiffDensity('verbose')).toBe('verbose')
  })

  it('persists with the existing prefs writer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-prefs-density-'))
    const configPath = path.join(dir, 'config.json')
    const journal = new Journal(path.join(dir, 'journal'))

    persistPrefs(configPath, {
      chatNamePool: 'women',
      steerMessagesAtToolBoundary: true,
      fileWriteDiffDensity: 'verbose',
    }, journal)

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).prefs).toEqual({
      chatNamePool: 'women',
      steerMessagesAtToolBoundary: true,
      fileWriteDiffDensity: 'verbose',
    })
  })
})

describe('durable renderer preferences', () => {
  it('resolves a bounded complete record without allowing malformed fields to replace defaults', () => {
    expect(asUiPreferences(undefined)).toBeUndefined()
    expect(asUiPreferences({
      ownerName: 'Nathan',
      autoReopenLastChats: true,
      defaultPermissionMode: 'invalid',
      pasteAsTextThreshold: Number.POSITIVE_INFINITY,
      planBudgetUsd: -50,
    })).toMatchObject({
      ownerName: 'Nathan',
      autoReopenLastChats: true,
      defaultPermissionMode: DEFAULT_UI_PREFERENCES.defaultPermissionMode,
      pasteAsTextThreshold: DEFAULT_UI_PREFERENCES.pasteAsTextThreshold,
      planBudgetUsd: 0,
    })
  })

  it('persists the complete UI record beside existing hub preferences', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-ui-prefs-'))
    const configPath = path.join(dir, 'config.json')
    const journal = new Journal(path.join(dir, 'journal'))
    const ui = { ...DEFAULT_UI_PREFERENCES, ownerName: 'Nathan', autoReopenLastChats: true }
    try {
      expect(persistPrefs(configPath, {
        chatNamePool: 'everyone',
        steerMessagesAtToolBoundary: true,
        ui,
      }, journal)).toBeNull()
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).prefs.ui).toEqual(ui)
    } finally {
      journal.db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
