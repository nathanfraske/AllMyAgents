import { describe, expect, it } from 'vitest'
import { builtinsForProvider, builtinNeedsArg, matchModel, parseSlash, resolveSlash } from './commands'

describe('parseSlash', () => {
  it('splits a slash command into name + args, lowercasing the name', () => {
    expect(parseSlash('/model Opus 5')).toEqual({ name: 'model', args: 'Opus 5' })
    expect(parseSlash('/usage')).toEqual({ name: 'usage', args: '' })
    expect(parseSlash('  /approvals full  ')).toEqual({ name: 'approvals', args: 'full' })
  })

  it('keeps namespaced custom-command names intact', () => {
    expect(parseSlash('/git:commit some msg')).toEqual({ name: 'git:commit', args: 'some msg' })
  })

  it('returns null for non-slash text', () => {
    expect(parseSlash('hello world')).toBeNull()
    expect(parseSlash('')).toBeNull()
    expect(parseSlash('a /model in the middle')).toBeNull()
  })
})

describe('resolveSlash — built-in → action mapping', () => {
  it('passes through non-slash text and unknown/custom commands', () => {
    expect(resolveSlash('just a message', 'claude')).toEqual({ kind: 'passthrough' })
    expect(resolveSlash('/ping', 'claude')).toEqual({ kind: 'passthrough' }) // custom command → SDK expands it
    expect(resolveSlash('/git:commit', 'claude')).toEqual({ kind: 'passthrough' })
  })

  it('/model <x> resolves to a model action with the matched slug', () => {
    expect(resolveSlash('/model opus 5', 'claude')).toEqual({ kind: 'model', model: 'claude-opus-5', label: 'Claude Opus 5' })
    expect(resolveSlash('/model sonnet', 'claude')).toEqual({ kind: 'model', model: 'claude-sonnet-5', label: 'Claude Sonnet 5' })
    expect(resolveSlash('/model 5.6-sol', 'codex')).toMatchObject({ kind: 'model', model: 'gpt-5.6-sol' })
  })

  it('/model with no arg returns inline help; an unknown model returns an error message', () => {
    expect(resolveSlash('/model', 'claude')).toMatchObject({ kind: 'message', tone: 'info' })
    expect(resolveSlash('/model nonesuch-9000', 'claude')).toMatchObject({ kind: 'message', tone: 'error' })
  })

  it('/approvals and its /mode alias resolve to a mode action', () => {
    expect(resolveSlash('/approvals safe', 'claude')).toEqual({ kind: 'mode', mode: 'safe' })
    expect(resolveSlash('/approvals edits', 'claude')).toEqual({ kind: 'mode', mode: 'edits' })
    expect(resolveSlash('/mode full', 'codex')).toEqual({ kind: 'mode', mode: 'full' })
  })

  it('/approvals accepts a few synonyms and rejects garbage', () => {
    expect(resolveSlash('/approvals bypass', 'claude')).toEqual({ kind: 'mode', mode: 'full' })
    expect(resolveSlash('/approvals ask', 'claude')).toEqual({ kind: 'mode', mode: 'safe' })
    expect(resolveSlash('/approvals sideways', 'claude')).toMatchObject({ kind: 'message', tone: 'error' })
    expect(resolveSlash('/approvals', 'claude')).toMatchObject({ kind: 'message', tone: 'info' })
  })

  it('/usage and /cost map to a usage action for both providers', () => {
    expect(resolveSlash('/usage', 'claude')).toEqual({ kind: 'usage' })
    expect(resolveSlash('/cost', 'codex')).toEqual({ kind: 'usage' })
  })

  it('/clear and /new map to a new-chat action for both providers', () => {
    expect(resolveSlash('/clear', 'claude')).toEqual({ kind: 'new' })
    expect(resolveSlash('/new', 'codex')).toEqual({ kind: 'new' })
  })

  it('/compact maps to compact for Claude, but is not a built-in for Codex (passes through)', () => {
    expect(resolveSlash('/compact', 'claude')).toEqual({ kind: 'compact' })
    expect(resolveSlash('/compact', 'codex')).toEqual({ kind: 'passthrough' })
  })
})

describe('matchModel', () => {
  it('matches by exact slug, name, shortName, and substring (shortest slug wins)', () => {
    expect(matchModel('claude-opus-5', 'claude')?.slug).toBe('claude-opus-5')
    expect(matchModel('Claude Sonnet 5', 'claude')?.slug).toBe('claude-sonnet-5')
    expect(matchModel('opus', 'claude')?.slug).toBe('claude-opus-5') // shortest of the two opus slugs
    expect(matchModel('haiku', 'claude')?.slug).toBe('claude-haiku-4-5')
  })

  it('is provider-scoped and returns undefined for no match', () => {
    expect(matchModel('opus', 'codex')).toBeUndefined() // opus is a Claude model
    expect(matchModel('5.6-terra', 'codex')?.slug).toBe('gpt-5.6-terra')
    expect(matchModel('', 'claude')).toBeUndefined()
  })
})

describe('builtins metadata', () => {
  it('offers compact only for Claude', () => {
    expect(builtinsForProvider('claude').map((b) => b.name)).toContain('compact')
    expect(builtinsForProvider('codex').map((b) => b.name)).not.toContain('compact')
  })

  it('offers model/approvals/usage/clear for both providers', () => {
    for (const p of ['claude', 'codex'] as const) {
      const names = builtinsForProvider(p).map((b) => b.name)
      expect(names).toEqual(expect.arrayContaining(['model', 'approvals', 'usage', 'clear']))
    }
  })

  it('marks model + approvals as arg-taking', () => {
    expect(builtinNeedsArg('model')).toBe(true)
    expect(builtinNeedsArg('approvals')).toBe(true)
    expect(builtinNeedsArg('usage')).toBe(false)
    expect(builtinNeedsArg('compact')).toBe(false)
  })
})
