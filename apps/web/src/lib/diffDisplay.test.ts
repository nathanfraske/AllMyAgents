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
  it('minimal keeps hunk markers and changed lines while making hidden context explicit', () => {
    const display = diffDisplay(makeDiff(['context', 'del', 'add', 'context']), 'minimal', false)

    expect(display.rows.map((row) => row.kind === 'hunk' ? 'hunk' : row.line.type)).toEqual([
      'hunk',
      'del',
      'add',
    ])
    expect(display.hidden).toEqual({ changed: 0, context: 2, total: 2 })
    expect(display.canToggle).toBe(true)
  })

  it('minimal caps a new-file body at six changed lines and reports the rest', () => {
    const display = diffDisplay(makeDiff(Array(9).fill('add'), false), 'minimal', false)

    expect(display.rows).toHaveLength(6)
    expect(display.hidden).toEqual({ changed: 3, context: 0, total: 3 })
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
