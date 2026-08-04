import { describe, expect, it } from 'vitest'
import { codexTurnPolicy } from './adapters/codex.js'

describe('codexTurnPolicy', () => {
  it('gives an explicitly Full turn host access while retaining the hub approval callback', () => {
    expect(
      codexTurnPolicy({ permissionMode: 'full', cwd: 'C:\\repo', worktree: 'C:\\repo\\wt' }),
    ).toEqual({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
  })

  it.each(['safe', 'edits'] as const)('contains %s turns to the session worktree', (permissionMode) => {
    expect(
      codexTurnPolicy({ permissionMode, cwd: 'C:\\repo', worktree: 'C:\\repo\\wt' }),
    ).toEqual({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['C:\\repo\\wt'] },
    })
  })

  it('contains an unset mode to cwd', () => {
    expect(codexTurnPolicy({ cwd: '/repo' })).toEqual({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/repo'] },
    })
  })
})
