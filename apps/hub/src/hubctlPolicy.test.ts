import { describe, expect, it } from 'vitest'
import {
  MAX_REVIVE_FAILURES,
  ReviveFailureGuard,
  revivePreflightIssue,
  supervisorRuntimeIssue,
} from './hubctlPolicy.js'

describe('hub supervisor terminal failure policy', () => {
  it('stops when the already-running supervisor entry has disappeared', () => {
    expect(
      supervisorRuntimeIssue({
        supervisorEntry: 'C:\\gone\\dist\\hubctl.js',
        hubEntry: 'C:\\gone\\dist\\index.js',
        workingDirectory: 'C:\\gone',
        exists: (candidate) => candidate.endsWith('index.js'),
      })
    ).toBe('supervisor entry no longer exists: C:\\gone\\dist\\hubctl.js')
  })

  it('stops when its working directory or selected hub entry has disappeared', () => {
    expect(
      supervisorRuntimeIssue({
        supervisorEntry: '/repo/apps/hub/dist/hubctl.js',
        hubEntry: '/repo/apps/hub/dist/index.js',
        workingDirectory: '/deleted/worktree',
        exists: (candidate) => candidate !== '/deleted/worktree',
      })
    ).toBe('supervisor working directory no longer exists: /deleted/worktree')

    expect(
      supervisorRuntimeIssue({
        supervisorEntry: '/repo/apps/hub/dist/hubctl.js',
        hubEntry: '/repo/apps/hub/dist/index.js',
        workingDirectory: '/repo/apps/hub',
        exists: (candidate) => !candidate.endsWith('index.js'),
      })
    ).toBe('hub entry no longer exists: /repo/apps/hub/dist/index.js')
  })

  it('gives up after the bounded number of identical revive failures', () => {
    const guard = new ReviveFailureGuard(MAX_REVIVE_FAILURES)
    for (let attempt = 1; attempt < MAX_REVIVE_FAILURES; attempt++) {
      expect(guard.record('hub exited before ready (code=1)')).toEqual({
        attempts: attempt,
        repeated: attempt,
        exhausted: false,
      })
    }
    expect(guard.record('hub exited before ready (code=1)')).toEqual({
      attempts: MAX_REVIVE_FAILURES,
      repeated: MAX_REVIVE_FAILURES,
      exhausted: true,
    })
  })

  it('treats an occupied dead-hub port as terminal before another spawn', () => {
    expect(revivePreflightIssue(null, 7812, true)).toBe(
      'fixed port 7812 is still held after the live hub died; another replacement cannot bind it'
    )
    expect(revivePreflightIssue(null, 7812, false)).toBeNull()
  })

  it('counts total attempts even when causes alternate, and resets only after stability', () => {
    const guard = new ReviveFailureGuard(3)
    expect(guard.record('exit 1')).toMatchObject({ attempts: 1, repeated: 1, exhausted: false })
    expect(guard.record('timeout')).toMatchObject({ attempts: 2, repeated: 1, exhausted: false })
    expect(guard.record('exit 1')).toMatchObject({ attempts: 3, repeated: 1, exhausted: true })

    guard.reset()
    expect(guard.record('exit 1')).toEqual({ attempts: 1, repeated: 1, exhausted: false })
  })
})
