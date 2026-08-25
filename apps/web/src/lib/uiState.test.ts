import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadLastLayout,
  saveLastLayout,
  loadCollapsedFolders,
  saveCollapsedFolders,
  loadQueues,
  loadThreadSidePanel,
  saveQueues,
  saveThreadSidePanel,
  type PersistedLayout,
} from './uiState'

// The persistence layer is pure load/save over jsdom's localStorage — no store, no network. Every
// reader must be robust to malformed/absent values (try/catch → defaults) and never throw.

const LAYOUT_KEY = 'allmyagents.ui.lastLayout'
const FOLDERS_KEY = 'allmyagents.ui.collapsedFolders'

beforeEach(() => {
  localStorage.clear()
})

describe('last layout persistence', () => {
  it('round-trips a saved layout (save → load)', () => {
    const layout: PersistedLayout = {
      selectedId: 's1',
      splitPanes: [['s1', 's2'], ['s3']],
      title: 'my chat',
      paneCount: 3,
    }
    saveLastLayout(layout)
    expect(loadLastLayout()).toEqual(layout)
  })

  it('round-trips a single-pane layout with empty splitPanes', () => {
    saveLastLayout({ selectedId: 's1', splitPanes: [], title: 'solo', paneCount: 1 })
    expect(loadLastLayout()).toEqual({ selectedId: 's1', splitPanes: [], title: 'solo', paneCount: 1 })
  })

  it('returns null when nothing is stored', () => {
    expect(loadLastLayout()).toBeNull()
  })

  it('falls back to null on malformed JSON (never throws)', () => {
    localStorage.setItem(LAYOUT_KEY, '{ not valid json')
    expect(loadLastLayout()).toBeNull()
  })

  it('falls back to null when splitPanes has the wrong shape', () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ selectedId: 's1', splitPanes: 'nope' }))
    // selectedId still valid, splitPanes coerced to [] → a valid single-pane offer.
    expect(loadLastLayout()).toEqual({ selectedId: 's1', splitPanes: [], title: undefined, paneCount: undefined })
  })

  it('treats an empty (home) layout as nothing to offer', () => {
    saveLastLayout({ selectedId: null, splitPanes: [] })
    expect(loadLastLayout()).toBeNull()
  })

  it('drops non-string entries inside splitPanes (malformed matrix → null)', () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ selectedId: null, splitPanes: [[1, 2]] }))
    // matrix rejected (not all strings) → splitPanes [] and no selection → null.
    expect(loadLastLayout()).toBeNull()
  })
})

describe('collapsed-folder persistence', () => {
  it('round-trips the collapsed ids (save → load)', () => {
    saveCollapsedFolders(['proj-a', '__none__'])
    expect(loadCollapsedFolders()).toEqual(['proj-a', '__none__'])
  })

  it('returns [] when nothing is stored', () => {
    expect(loadCollapsedFolders()).toEqual([])
  })

  it('falls back to [] on malformed JSON (never throws)', () => {
    localStorage.setItem(FOLDERS_KEY, 'not json at all')
    expect(loadCollapsedFolders()).toEqual([])
  })

  it('filters out non-string entries', () => {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(['ok', 42, null, 'fine']))
    expect(loadCollapsedFolders()).toEqual(['ok', 'fine'])
  })

  it('falls back to [] when the stored value is not an array', () => {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify({ collapsed: true }))
    expect(loadCollapsedFolders()).toEqual([])
  })
})

describe('queued-message persistence', () => {
  it('round-trips attachment metadata while retaining legacy string entries', () => {
    const attachment = {
      id: 'att-1',
      name: 'queued.png',
      mime: 'image/png',
      size: 123,
      kind: 'image' as const,
    }
    saveQueues({
      s1: [
        'plain',
        { text: 'with file', attachments: [attachment] },
        { text: 'steer after startup', delivery: 'when-active' },
      ],
    })

    expect(loadQueues()).toEqual({
      s1: [
        'plain',
        { text: 'with file', attachments: [attachment] },
        { text: 'steer after startup', delivery: 'when-active' },
      ],
    })
  })
})

describe('thread side-panel persistence', () => {
  it('keeps Browser and Agents mutually exclusive per chat and clears cleanly', () => {
    saveThreadSidePanel('s1', 'browser')
    expect(loadThreadSidePanel('s1')).toBe('browser')

    saveThreadSidePanel('s1', 'agents')
    expect(loadThreadSidePanel('s1')).toBe('agents')

    saveThreadSidePanel('s1', null)
    expect(loadThreadSidePanel('s1')).toBeNull()
  })
})
