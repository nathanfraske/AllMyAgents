import { describe, expect, it } from 'vitest'
import { resolveWorkingContext, truncatePathTail } from './workingContext'

describe('truncatePathTail', () => {
  it('keeps a short path unchanged', () => {
    expect(truncatePathTail('C:\\src\\AllMyAgents', 40)).toBe('C:\\src\\AllMyAgents')
  })

  it('spends the available width on the identifying tail of a Windows path', () => {
    const path = 'C:\\Users\\Admin\\AppData\\Roaming\\AllMyAgents\\data\\worktrees\\37fa1798'
    const shown = truncatePathTail(path, 28)

    expect(shown).toHaveLength(28)
    expect(shown.startsWith('…')).toBe(true)
    expect(path.endsWith(shown.slice(1))).toBe(true)
    expect(shown.endsWith('\\worktrees\\37fa1798')).toBe(true)
  })

  it('handles extremely narrow slots without overflowing their character budget', () => {
    expect(truncatePathTail('C:\\long\\path', 1)).toBe('…')
    expect(truncatePathTail('C:\\long\\path', 0)).toBe('')
  })
})

describe('resolveWorkingContext', () => {
  const projects = [
    { id: 'ama', name: 'AllMyAgents', path: 'C:\\src\\AllMyAgents' },
  ]

  it('names the project and prefers the actual worktree as the working directory', () => {
    expect(
      resolveWorkingContext(
        {
          projectId: 'ama',
          cwd: 'C:\\src\\AllMyAgents',
          worktree: 'C:\\src\\AllMyAgents\\.worktrees\\lane-c',
        },
        projects
      )
    ).toEqual({
      projectName: 'AllMyAgents',
      workingDirectory: 'C:\\src\\AllMyAgents\\.worktrees\\lane-c',
    })
  })

  it('uses the project directory for a not-yet-materialized draft', () => {
    expect(resolveWorkingContext({ projectId: 'ama', cwd: '' }, projects)).toEqual({
      projectName: 'AllMyAgents',
      workingDirectory: 'C:\\src\\AllMyAgents',
    })
  })

  it('names the sidebar destination for an unfiled chat instead of leaving an unexplained blank', () => {
    expect(resolveWorkingContext({ cwd: 'D:\\scratch' }, projects)).toEqual({
      projectName: 'Unfiled',
      workingDirectory: 'D:\\scratch',
    })
  })
})
