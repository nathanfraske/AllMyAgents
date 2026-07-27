import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import { persistPrefs } from './server.js'
import { asFileWriteDiffDensity } from './types.js'

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
