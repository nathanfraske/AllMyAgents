import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildRelaunchEnv,
  resolveRelaunchDataRoot,
  validateExistingRelaunchRoot,
} from './relaunch-worker-config.mjs'

test('relaunch refuses to guess repo/data when no explicit root was handed over', () => {
  assert.throws(
    () => resolveRelaunchDataRoot({ argv: [], env: {} }),
    /explicit.*HUB_DATA_DIR|HUB_DATA_DIR.*required/i
  )
})

test('relaunch rejects a relative data root', () => {
  assert.throws(
    () => resolveRelaunchDataRoot({ argv: ['--data-dir', 'data'], env: {} }),
    /absolute/i
  )
})

test('existing-root validation is read-only and never creates a missing root or journal', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-relaunch-root-'))
  const missing = path.join(parent, 'missing-data')
  try {
    assert.throws(() => validateExistingRelaunchRoot(missing), /does not exist/i)
    assert.equal(fs.existsSync(missing), false)

    fs.mkdirSync(missing)
    assert.throws(() => validateExistingRelaunchRoot(missing), /hub\.db.*does not exist/i)
    assert.equal(fs.existsSync(path.join(missing, 'hub.db')), false)
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('worker and fallback launches preserve the exact production roots and roster floor', () => {
  const dataDir = path.resolve('C:/operator/AllMyAgents/data')
  const profilesDir = path.resolve('C:/operator/AllMyAgents/profiles')
  const base = {
    HUB_DATA_DIR: dataDir,
    HUB_PROFILES_DIR: profilesDir,
    HUB_DATA_ROOT_EXPECTATION: 'existing',
    HUB_EXPECTED_RESTORED_SESSIONS: '3',
    HUB_FIXED_PORT: '9000',
    HUB_RESTART_MAX_DEFER_MS: '4500',
    HUB_SUPERVISED: '1',
    HUB_PORT: '12345',
    HUB_WORKER_SOCKET: 'stale-child-socket',
  }

  for (const withWorker of [true, false]) {
    const env = buildRelaunchEnv({
      baseEnv: base,
      dataDir,
      withWorker,
      expectedRestoredSessions: 11,
    })
    assert.equal(env.HUB_DATA_DIR, dataDir)
    assert.equal(env.HUB_PROFILES_DIR, profilesDir)
    assert.equal(env.HUB_DATA_ROOT_EXPECTATION, 'existing')
    assert.equal(env.HUB_EXPECTED_RESTORED_SESSIONS, '11')
    assert.equal(env.HUB_FIXED_PORT, '9000')
    assert.equal(env.HUB_RESTART_MAX_DEFER_MS, '4500')
    assert.equal('HUB_SUPERVISED' in env, false)
    assert.equal('HUB_PORT' in env, false)
    assert.equal('HUB_WORKER_SOCKET' in env, false)
    assert.equal(env.HUB_WORKER, withWorker ? '1' : undefined)
  }
})
