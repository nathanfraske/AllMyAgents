import { describe, expect, it } from 'vitest'
import { countLiveUpdateTurns, updateInstallBlock } from './updateSafety'

describe('update live-turn safety', () => {
  it('counts both starting and active turns as work an update would interrupt', () => {
    expect(
      countLiveUpdateTurns({
        a: { record: { status: 'starting' } },
        b: { record: { status: 'active' } },
        c: { record: { status: 'idle' } },
        d: { record: { status: 'error' } },
      })
    ).toBe(2)
  })

  it('blocks the default install path while a turn is live', () => {
    expect(updateInstallBlock(2, false)).toBe(
      '2 chats are mid-turn. Choose Update when idle, or explicitly choose Update anyway.'
    )
  })

  it('allows only an explicit override to interrupt live turns', () => {
    expect(updateInstallBlock(1, true)).toBeNull()
    expect(updateInstallBlock(0, false)).toBeNull()
  })
})
