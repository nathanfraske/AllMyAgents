import assert from 'node:assert/strict'
import test from 'node:test'

import { assessVerificationRuns } from './wait-release-verification.mjs'

const required = ['macos-p0-verification.yml', 'windows-p0-verification.yml']

test('publishing is allowed only when both durability runs succeed', () => {
  assert.deepEqual(
    assessVerificationRuns(
      {
        'macos-p0-verification.yml': {
          id: 10,
          status: 'completed',
          conclusion: 'success',
        },
        'windows-p0-verification.yml': {
          id: 11,
          status: 'completed',
          conclusion: 'success',
        },
      },
      required,
    ),
    { ready: true, pending: [] },
  )
})

test('a deliberately red startup verification blocks publishing', () => {
  assert.throws(
    () =>
      assessVerificationRuns(
        {
          'macos-p0-verification.yml': {
            id: 12,
            status: 'completed',
            conclusion: 'success',
          },
          'windows-p0-verification.yml': {
            id: 13,
            status: 'completed',
            conclusion: 'failure',
          },
        },
        required,
      ),
    /Windows P0 verification|windows-p0-verification\.yml.*failure.*publishing is blocked/i,
  )
})

test('a missing or still-running verification keeps publishing unreachable', () => {
  assert.deepEqual(
    assessVerificationRuns(
      {
        'macos-p0-verification.yml': {
          id: 14,
          status: 'in_progress',
          conclusion: null,
        },
      },
      required,
    ),
    {
      ready: false,
      pending: ['macos-p0-verification.yml', 'windows-p0-verification.yml'],
    },
  )
})
