import type { DiffLine, FileDiff } from './diff'
import type { FileWriteDiffDensity } from './api'

export type FlatDiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'line'; line: DiffLine }

export interface DiffDisplay {
  rows: FlatDiffRow[]
  hidden: {
    changed: number
    context: number
    total: number
  }
  canToggle: boolean
}

const SUMMARY_ROWS = 14

function flatten(diff: FileDiff): FlatDiffRow[] {
  const rows: FlatDiffRow[] = []
  diff.hunks.forEach((hunk, index) => {
    if (hunk.header) rows.push({ kind: 'hunk', text: hunk.header })
    else if (index > 0) rows.push({ kind: 'hunk', text: '⋯' })
    for (const line of hunk.lines) rows.push({ kind: 'line', line })
  })
  return rows
}

function hiddenCounts(all: FlatDiffRow[], visible: FlatDiffRow[]): DiffDisplay['hidden'] {
  const visibleSet = new Set(visible)
  let changed = 0
  let context = 0
  for (const row of all) {
    if (visibleSet.has(row) || row.kind === 'hunk') continue
    if (row.line.type === 'context') context++
    else changed++
  }
  return { changed, context, total: all.length - visible.length }
}

export function initialDiffExpanded(density: FileWriteDiffDensity): boolean {
  return density === 'verbose'
}

/**
 * Applies the density DEFAULT to one diff. `expanded` is deliberately separate: a user can always
 * override the default in place, and expanding always returns every row without filtering.
 */
export function diffDisplay(
  diff: FileDiff,
  density: FileWriteDiffDensity,
  expanded: boolean
): DiffDisplay {
  const all = flatten(diff)
  // Minimal is a true one-line summary: the header is the whole collapsed representation. Summary is
  // the bounded excerpt, while verbose starts with every row visible.
  const collapsed = density === 'minimal' ? [] : all.slice(0, SUMMARY_ROWS)
  const rows = expanded ? all : collapsed
  const hidden = hiddenCounts(all, rows)
  const collapsedHidden = hiddenCounts(all, collapsed)
  return {
    rows,
    hidden,
    // Verbose starts expanded but large diffs can still be collapsed to the summary preview.
    canToggle: expanded ? collapsedHidden.total > 0 : hidden.total > 0,
  }
}
