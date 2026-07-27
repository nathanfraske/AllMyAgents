import { describe, expect, it } from 'vitest'
import {
  codexToolLabel,
  extractCodexReasoning,
  groupCodexItems,
  isActivityItem,
  summarizeCodexGroup,
  type CodexRenderNode,
} from './codexGroup'
import type { ThreadItem } from './store.svelte'

// This module is NEW, so "the same test passes against the old code and the new code" — the trap this
// codebase keeps hitting — cannot be avoided by writing the test first: there is no old code. Instead
// each assertion here was confirmed to FAIL under a deliberate mutation of the function it covers
// (documented in the report), so it discriminates behaviour rather than merely exercising it.

let n = 0
function item(kind: ThreadItem['kind'], over: Partial<ThreadItem> = {}): ThreadItem {
  return { key: over.key ?? `k${n++}`, kind, ts: '2026-07-26T00:00:00.000Z', ...over }
}
const reasoning = (o: Partial<ThreadItem> = {}) => item('reasoning', o)
const command = (o: Partial<ThreadItem> = {}) => item('tool', { toolName: 'command', ...o })
const assistant = (o: Partial<ThreadItem> = {}) => item('assistant', o)

const ids = (nodes: CodexRenderNode[]): string[] => nodes.map((x) => x.id)
const shapes = (nodes: CodexRenderNode[]): string[] =>
  nodes.map((x) => (x.type === 'group' ? `group(${x.items.length})` : `item:${x.item.kind}`))

describe('extractCodexReasoning', () => {
  it('prefers the human summary array (summary_text parts)', () => {
    expect(
      extractCodexReasoning({
        summary: [{ type: 'summary_text', text: 'Planning the refactor' }],
        content: [{ type: 'reasoning_text', text: 'raw chain of thought' }],
      })
    ).toBe('Planning the refactor')
  })

  it('joins multiple summary parts', () => {
    expect(
      extractCodexReasoning({ summary: [{ text: 'First.' }, { text: 'Second.' }] })
    ).toBe('First.\n\nSecond.')
  })

  it('falls back to content when summary is empty', () => {
    expect(
      extractCodexReasoning({ summary: [], content: [{ type: 'reasoning_text', text: 'deep thoughts' }] })
    ).toBe('deep thoughts')
  })

  it('falls back to a flat text field last', () => {
    expect(extractCodexReasoning({ summary: [], content: [], text: 'flat' })).toBe('flat')
  })

  it('accepts bare-string parts', () => {
    expect(extractCodexReasoning({ summary: ['just a string'] })).toBe('just a string')
  })

  it('returns "" for a real (empty) reasoning row — no "(reasoning)" placeholder', () => {
    expect(extractCodexReasoning({ summary: [], content: [] })).toBe('')
    expect(extractCodexReasoning({})).toBe('')
    expect(extractCodexReasoning(null)).toBe('')
    // whitespace-only parts are not "content"
    expect(extractCodexReasoning({ summary: [{ text: '   ' }] })).toBe('')
  })
})

describe('groupCodexItems', () => {
  it('collapses a run of ≥2 consecutive activity items into one group', () => {
    const items = [reasoning(), command(), reasoning(), command()]
    const nodes = groupCodexItems(items)
    expect(shapes(nodes)).toEqual(['group(4)'])
  })

  it('breaks the group when the agent actually says something', () => {
    const r1 = reasoning({ key: 'r1' })
    const nodes = groupCodexItems([r1, command({ key: 'c1' }), assistant({ key: 'a1' }), reasoning({ key: 'r2' }), command({ key: 'c2' })])
    expect(shapes(nodes)).toEqual(['group(2)', 'item:assistant', 'group(2)'])
  })

  it('keeps a lone activity item standalone (no pointless group wrapper)', () => {
    expect(shapes(groupCodexItems([command()]))).toEqual(['item:tool'])
    expect(shapes(groupCodexItems([assistant(), reasoning(), assistant()]))).toEqual([
      'item:assistant',
      'item:reasoning',
      'item:assistant',
    ])
  })

  it('gives a group a stable id from its FIRST item, so it survives new steps appending', () => {
    const r1 = reasoning({ key: 'first' })
    const two = groupCodexItems([r1, command({ key: 'c1' })])
    const four = groupCodexItems([r1, command({ key: 'c1' }), reasoning({ key: 'r2' }), command({ key: 'c2' })])
    expect(two[0]?.id).toBe('codexgrp:first')
    expect(four[0]?.id).toBe('codexgrp:first') // same id after two more steps arrive
  })

  it('uses the item key as the id for standalone nodes', () => {
    expect(ids(groupCodexItems([assistant({ key: 'a1' })]))).toEqual(['a1'])
  })

  it('preserves order and handles an empty transcript', () => {
    expect(groupCodexItems([])).toEqual([])
  })
})

describe('summarizeCodexGroup', () => {
  it('counts steps split by kind and surfaces the latest command', () => {
    const s = summarizeCodexGroup([
      reasoning(),
      command({ toolInput: 'npm run build' }),
      reasoning(),
      command({ toolInput: 'git status' }),
    ])
    expect(s.steps).toBe(4)
    expect(s.reasoning).toBe(2)
    expect(s.commands).toBe(2)
    expect(s.current).toBe('git status') // the MOST RECENT command, not the first
  })

  it('has no current label for a reasoning-only run', () => {
    expect(summarizeCodexGroup([reasoning(), reasoning()]).current).toBeUndefined()
  })
})

describe('codexToolLabel', () => {
  it('reads a string command', () => {
    expect(codexToolLabel(command({ toolInput: 'ls -la' }))).toBe('ls -la')
  })
  it('joins an argv-array command', () => {
    expect(codexToolLabel(command({ toolInput: ['git', 'commit', '-m', 'x'] }))).toBe('git commit -m x')
  })
  it('reads a nested { command } object', () => {
    expect(codexToolLabel(command({ toolInput: { command: 'echo hi' } }))).toBe('echo hi')
  })
  it('labels a fileChange by path', () => {
    expect(codexToolLabel(item('tool', { toolName: 'fileChange', toolInput: { path: 'src/a.ts' } }))).toBe('edit src/a.ts')
  })
  it('is undefined for non-tool items', () => {
    expect(codexToolLabel(reasoning())).toBeUndefined()
  })
})

describe('isActivityItem', () => {
  it('is true for reasoning and tool, false for the boundaries', () => {
    expect(isActivityItem(reasoning())).toBe(true)
    expect(isActivityItem(command())).toBe(true)
    expect(isActivityItem(assistant())).toBe(false)
    expect(isActivityItem(item('user'))).toBe(false)
    expect(isActivityItem(item('note'))).toBe(false)
  })
})
