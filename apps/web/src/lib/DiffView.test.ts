import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'
import DiffView from './DiffView.svelte'
import type { FileDiff } from './diff'
import { store } from './store.svelte'

const diff: FileDiff = {
  path: 'src/already-rendered.ts',
  language: 'typescript',
  status: 'modified',
  hunks: [{
    header: '@@ existing diff',
    lines: Array.from({ length: 10 }, (_, i) => [
      { type: 'context' as const, text: `context ${i}`, oldNo: i + 1, newNo: i + 1 },
      { type: 'add' as const, text: `changed ${i}`, newNo: i + 2 },
    ]).flat(),
  }],
  additions: 10,
  deletions: 0,
  addedText: Array.from({ length: 10 }, (_, i) => `changed ${i}`).join('\n'),
}

function setDensity(fileWriteDiffDensity: 'minimal' | 'summary' | 'verbose'): void {
  store.prefs = {
    chatNamePool: 'everyone',
    steerMessagesAtToolBoundary: true,
    fileWriteDiffDensity,
  }
}

beforeEach(() => setDensity('summary'))
afterEach(() => cleanup())

describe('live file-write diff density', () => {
  it('retroactively updates a diff that is already rendered', async () => {
    const { container } = render(DiffView, { props: { diff } })
    expect(container.querySelectorAll('.line.context')).toHaveLength(7)

    setDensity('minimal')
    await tick()
    expect(container.querySelectorAll('.line.context')).toHaveLength(0)
    expect(container.querySelectorAll('.line.add')).toHaveLength(6)

    setDensity('verbose')
    await tick()
    expect(container.querySelectorAll('.line')).toHaveLength(20)
  })

  it('keeps a deliberate per-diff expansion when the default changes', async () => {
    setDensity('minimal')
    const { container } = render(DiffView, { props: { diff } })

    await fireEvent.click(screen.getByRole('button', { name: /Show full diff/ }))
    expect(container.querySelectorAll('.line')).toHaveLength(20)

    setDensity('summary')
    await tick()
    expect(container.querySelectorAll('.line')).toHaveLength(20)
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()
  })
})
