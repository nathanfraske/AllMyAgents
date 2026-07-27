import { describe, expect, it } from 'vitest'
import type { FileDiff } from './diff'
import { diffDisplay, initialDiffExpanded } from './diffDisplay'

function makeDiff(types: Array<'add' | 'del' | 'context'>, withHeader = true): FileDiff {
  return {
    path: 'src/example.ts',
    language: 'typescript',
    status: 'modified',
    hunks: [{
      header: withHeader ? '@@ example' : undefined,
      lines: types.map((type, i) => ({
        type,
        text: `${type} ${i}`,
        oldNo: type === 'add' ? undefined : i + 1,
        newNo: type === 'del' ? undefined : i + 1,
      })),
    }],
    additions: types.filter((type) => type === 'add').length,
    deletions: types.filter((type) => type === 'del').length,
    addedText: '',
  }
}

describe('file-write diff density', () => {
  it('minimal renders no diff rows until expanded', () => {
    const display = diffDisplay(makeDiff(['context', 'del', 'add', 'context']), 'minimal', false)

    expect(display.rows).toEqual([])
    expect(display.hidden).toEqual({ changed: 2, context: 2, total: 5 })
    expect(display.canToggle).toBe(true)
  })

  it('minimal hides an entire new-file body and reports it', () => {
    const display = diffDisplay(makeDiff(Array(9).fill('add'), false), 'minimal', false)

    expect(display.rows).toHaveLength(0)
    expect(display.hidden).toEqual({ changed: 9, context: 0, total: 9 })
  })

  it('summary is the existing first-14-row preview, including context and hunk markers', () => {
    const display = diffDisplay(makeDiff(Array(16).fill('context')), 'summary', false)

    expect(display.rows).toHaveLength(14)
    expect(display.hidden).toEqual({ changed: 0, context: 3, total: 3 })
  })

  it('verbose defaults expanded, while every density can reveal the complete diff', () => {
    const diff = makeDiff(['context', 'del', 'add', 'context'])

    expect(initialDiffExpanded('minimal')).toBe(false)
    expect(initialDiffExpanded('summary')).toBe(false)
    expect(initialDiffExpanded('verbose')).toBe(true)
    expect(diffDisplay(diff, 'minimal', true).rows).toHaveLength(5)
  })
})
