import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HUB_DATA_ROOT_EXPECTATION_ENV,
  HUB_EXPECTED_RESTORED_SESSIONS_ENV,
  resolveHubDataRoot,
} from './dataRoot.js'

const repoRoot = path.resolve('C:/ama-test-repo')

describe('hub data-root handover', () => {
  it('refuses a compiled hub with no explicit data root instead of falling back to repo data', () => {
    const result = resolveHubDataRoot({ env: {}, repoRoot, sourceMode: false })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('data-root-required')
    expect(result.failure.message).toMatch(/HUB_DATA_DIR/)
  })

  it('refuses a compiled hub whose explicit root has no first-run/existing expectation', () => {
    const result = resolveHubDataRoot({
      env: { HUB_DATA_DIR: path.join(repoRoot, 'operator-data') },
      repoRoot,
      sourceMode: false,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('data-root-expectation-required')
  })

  it('carries an explicit existing-root contract and positive restored-session floor verbatim', () => {
    const dataDir = path.join(repoRoot, 'operator-data')
    const result = resolveHubDataRoot({
      env: {
        HUB_DATA_DIR: dataDir,
        [HUB_DATA_ROOT_EXPECTATION_ENV]: 'existing',
        [HUB_EXPECTED_RESTORED_SESSIONS_ENV]: '7',
      },
      repoRoot,
      sourceMode: false,
    })

    expect(result).toEqual({
      ok: true,
      dataDir: path.resolve(dataDir),
      expectation: 'existing',
      expectedRestoredSessions: 7,
      explicit: true,
    })
  })

  it('allows an explicit first run only with an expectation of zero restored sessions', () => {
    const dataDir = path.join(repoRoot, 'new-operator-data')
    const accepted = resolveHubDataRoot({
      env: {
        HUB_DATA_DIR: dataDir,
        [HUB_DATA_ROOT_EXPECTATION_ENV]: 'first-run',
        [HUB_EXPECTED_RESTORED_SESSIONS_ENV]: '0',
      },
      repoRoot,
      sourceMode: false,
    })
    expect(accepted).toMatchObject({
      ok: true,
      expectation: 'first-run',
      expectedRestoredSessions: 0,
    })

    const rejected = resolveHubDataRoot({
      env: {
        HUB_DATA_DIR: dataDir,
        [HUB_DATA_ROOT_EXPECTATION_ENV]: 'first-run',
        [HUB_EXPECTED_RESTORED_SESSIONS_ENV]: '1',
      },
      repoRoot,
      sourceMode: false,
    })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.failure.code).toBe('data-root-expectation-invalid')
  })

  it('keeps the historical repo-data fallback only for an explicit source/dev runtime', () => {
    const result = resolveHubDataRoot({ env: {}, repoRoot, sourceMode: true })

    expect(result).toEqual({
      ok: true,
      dataDir: path.join(repoRoot, 'data'),
      expectation: 'development',
      expectedRestoredSessions: 0,
      explicit: false,
    })
  })

  it('rejects malformed restored-session expectations before any filesystem work', () => {
    const result = resolveHubDataRoot({
      env: {
        HUB_DATA_DIR: path.join(repoRoot, 'operator-data'),
        [HUB_DATA_ROOT_EXPECTATION_ENV]: 'existing',
        [HUB_EXPECTED_RESTORED_SESSIONS_ENV]: '-1',
      },
      repoRoot,
      sourceMode: false,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('restored-session-expectation-invalid')
  })
})
