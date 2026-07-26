import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { persistDanger, persistPrefs } from './server.js'
import { Journal } from './journal.js'
import type { DangerFlags } from './types.js'

/**
 * REGRESSION — Danger Zone toggles did not survive a hub restart, and the UI gave no sign of it.
 *
 * Two independent bugs, both silent:
 *
 * 1. WRONG FILE. This wrote `<repoRoot>/data/config.json` while index.ts read `<dataDir>/config.json`,
 *    where dataDir is `HUB_DATA_DIR ?? <repoRoot>/data`. They agree only when HUB_DATA_DIR is unset —
 *    i.e. in dev. The installed desktop app always sets it, so every toggle went to a file the hub never
 *    reads, and quite possibly to a repo path that does not exist on an end user's machine, where the
 *    best-effort catch swallowed the failure entirely.
 *
 * 2. DROPPED FIELD. The written object listed three flags by hand and omitted `enableClaudeConnectors`,
 *    so that one reverted on every restart even in dev.
 *
 * Both were invisible from the UI: the POST handler mutates the shared in-memory `danger` object and
 * echoes it back, so the checkbox stayed ticked and the setting was genuinely live — until the next
 * restart silently reverted it. These tests pin the two properties that were violated: it writes where it
 * is told, and it writes everything.
 */

const dirs: string[] = []
const opened: Journal[] = []
afterEach(() => {
  for (const j of opened.splice(0)) j.db.close()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-danger-'))
  dirs.push(dir)
  return dir
}

function journalIn(dir: string): Journal {
  const j = new Journal(path.join(dir, 'hub.db'))
  opened.push(j)
  return j
}

const ALL_ON: DangerFlags = {
  busCanUseRiskyTools: true,
  autoApprovePractices: true,
  autoApproveRestart: true,
  enableClaudeConnectors: true,
  fullAccessAnyOrigin: true,
}

/** How index.ts reads the flags back at boot — `config.danger?.<flag> === true`. */
function readBack(configPath: string): Record<string, unknown> {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { danger?: Record<string, unknown> }
  return cfg.danger ?? {}
}

describe('persistDanger', () => {
  /** BUG 1. The path is an argument now precisely because deriving it here is what broke the installed app. */
  it('writes to the config path it is given, not one it derives', () => {
    const dir = tmp()
    const configPath = path.join(dir, 'elsewhere', 'config.json')
    persistDanger(configPath, ALL_ON, journalIn(dir))
    expect(fs.existsSync(configPath)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'data', 'config.json'))).toBe(false)
  })

  /** BUG 2. Every flag round-trips — including the two that a hand-written field list forgot or predates. */
  it('persists every flag, not a hand-picked subset', () => {
    const dir = tmp()
    const configPath = path.join(dir, 'config.json')
    persistDanger(configPath, ALL_ON, journalIn(dir))
    expect(readBack(configPath)).toEqual(ALL_ON)
  })

  it('round-trips the OFF state too, rather than omitting false flags', () => {
    const dir = tmp()
    const configPath = path.join(dir, 'config.json')
    const allOff: DangerFlags = {
      busCanUseRiskyTools: false,
      autoApprovePractices: false,
      autoApproveRestart: false,
      enableClaudeConnectors: false,
      fullAccessAnyOrigin: false,
    }
    persistDanger(configPath, allOff, journalIn(dir))
    expect(readBack(configPath)).toEqual(allOff)
    // …and index.ts's `=== true` reading of each resolves to OFF.
    for (const v of Object.values(readBack(configPath))) expect(v === true).toBe(false)
  })

  it('preserves unrelated config keys instead of truncating the file', () => {
    const dir = tmp()
    const configPath = path.join(dir, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({ overage: { p1: 'pause' }, features: { autoMemoryRecall: false } }))
    persistDanger(configPath, ALL_ON, journalIn(dir))
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(cfg.overage).toEqual({ p1: 'pause' })
    expect(cfg.features).toEqual({ autoMemoryRecall: false })
    expect(cfg.danger).toEqual(ALL_ON)
  })

  it('creates the containing directory when the config file does not exist yet', () => {
    const dir = tmp()
    const configPath = path.join(dir, 'nested', 'deeper', 'config.json')
    persistDanger(configPath, ALL_ON, journalIn(dir))
    expect(readBack(configPath)).toEqual(ALL_ON)
  })

  it('overwrites a previous danger block rather than merging into it', () => {
    const dir = tmp()
    const configPath = path.join(dir, 'config.json')
    persistDanger(configPath, ALL_ON, journalIn(dir))
    const off: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: false }
    persistDanger(configPath, off, journalIn(dir))
    // A merge would have left the other three flags ON — turning a toggle off has to actually turn it off.
    expect(readBack(configPath)).toEqual(off)
  })

  it('starts fresh when the existing config is unparseable, rather than throwing', () => {
    const dir = tmp()
    const configPath = path.join(dir, 'config.json')
    fs.writeFileSync(configPath, '{ this is not json')
    expect(() => persistDanger(configPath, ALL_ON, journalIn(dir))).not.toThrow()
    expect(readBack(configPath)).toEqual(ALL_ON)
  })

  /**
   * Still best-effort — an unwritable config must never fail the operator's request — but no longer
   * silent. A toggle that will not survive a restart is worth a journal row; that is exactly the
   * information the original silent catch withheld while the installed app wrote into the void.
   */
  it('journals a failure instead of swallowing it', () => {
    const dir = tmp()
    const journal = journalIn(dir)
    // A directory where the file should be: open-for-write fails on every platform.
    const configPath = path.join(dir, 'config.json')
    fs.mkdirSync(configPath)
    const before = journal.since(0).length
    expect(() => persistDanger(configPath, ALL_ON, journal)).not.toThrow()
    const added = journal.since(0).slice(before)
    expect(added.map((e) => e.kind)).toContain('config/danger-persist-failed')
  })
})

/**
 * The owner preferences ride the same writer, so they inherit both fixes above — and introduce one new
 * way to break: two settings blocks sharing one read-merge-write can clobber each other.
 */
describe('persistPrefs', () => {
  it('writes to the config path it is given, under its own key', () => {
    const dir = tmp()
    const configPath = path.join(dir, 'elsewhere', 'config.json')
    persistPrefs(configPath, { chatNamePool: 'women' }, journalIn(dir))
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { prefs?: Record<string, unknown> }
    expect(cfg.prefs).toEqual({ chatNamePool: 'women' }) // how index.ts reads it back at boot
    expect(fs.existsSync(path.join(dir, 'data', 'config.json'))).toBe(false)
  })

  it('leaves the danger block alone, and survives it being written afterwards', () => {
    const dir = tmp()
    const configPath = path.join(dir, 'config.json')
    persistDanger(configPath, ALL_ON, journalIn(dir))
    persistPrefs(configPath, { chatNamePool: 'women' }, journalIn(dir))
    persistDanger(configPath, ALL_ON, journalIn(dir))
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(cfg.prefs).toEqual({ chatNamePool: 'women' })
    expect(cfg.danger).toEqual(ALL_ON)
  })
})
