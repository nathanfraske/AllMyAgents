import path from 'node:path'

export const HUB_DATA_ROOT_EXPECTATION_ENV = 'HUB_DATA_ROOT_EXPECTATION'
export const HUB_EXPECTED_RESTORED_SESSIONS_ENV = 'HUB_EXPECTED_RESTORED_SESSIONS'

export type HubDataRootExpectation = 'first-run' | 'existing' | 'development'

export interface HubDataRootFailure {
  code:
    | 'data-root-required'
    | 'data-root-expectation-required'
    | 'data-root-expectation-invalid'
    | 'restored-session-expectation-invalid'
  message: string
  recovery: string
}

export type HubDataRootResolution =
  | {
      ok: true
      dataDir: string
      expectation: HubDataRootExpectation
      expectedRestoredSessions: number
      explicit: boolean
    }
  | { ok: false; failure: HubDataRootFailure }

function failure(
  code: HubDataRootFailure['code'],
  message: string,
  recovery: string
): HubDataRootResolution {
  return { ok: false, failure: { code, message, recovery } }
}

function parseExpectedRestoredSessions(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return 0
  if (!/^\d+$/.test(raw.trim())) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Resolve the hub data root without touching the filesystem.
 *
 * A compiled hub is an installed/runtime artifact and must receive both an explicit path and an explicit
 * first-run/existing contract. Only a source-mode developer launch retains the historical repo `data/`
 * default. This makes loss of the desktop -> hubctl -> hub environment handover fatal instead of silently
 * opening a second journal beside the shipped code.
 */
export function resolveHubDataRoot(options: {
  env: NodeJS.ProcessEnv
  repoRoot: string
  sourceMode: boolean
}): HubDataRootResolution {
  const rawDataDir = options.env.HUB_DATA_DIR?.trim()
  const rawExpectation = options.env[HUB_DATA_ROOT_EXPECTATION_ENV]?.trim()
  const rawExpectedRestored = options.env[HUB_EXPECTED_RESTORED_SESSIONS_ENV]

  if (!rawDataDir) {
    if (!options.sourceMode) {
      return failure(
        'data-root-required',
        'A compiled hub was started without HUB_DATA_DIR; refusing to fall back to the bundled repo data directory.',
        'Restore the desktop-to-hub data-root handover and restart. Do not copy or create hub.db beside the installed hub.'
      )
    }
    if (rawExpectation || (rawExpectedRestored !== undefined && rawExpectedRestored.trim() !== '')) {
      return failure(
        'data-root-required',
        'A data-root expectation was provided without HUB_DATA_DIR; refusing to apply it to a guessed directory.',
        'Set HUB_DATA_DIR to the exact intended development data root, or remove the expectation variables.'
      )
    }
    return {
      ok: true,
      dataDir: path.join(options.repoRoot, 'data'),
      expectation: 'development',
      expectedRestoredSessions: 0,
      explicit: false,
    }
  }

  let expectation: HubDataRootExpectation
  if (rawExpectation === 'first-run' || rawExpectation === 'existing') {
    expectation = rawExpectation
  } else if (!rawExpectation && options.sourceMode) {
    // Existing test/dev harnesses already pass isolated HUB_DATA_DIR values. They are explicit and cannot
    // fall back to production, so keep them compatible while installed compiled launches remain strict.
    expectation = 'development'
  } else if (!rawExpectation) {
    return failure(
      'data-root-expectation-required',
      `HUB_DATA_DIR was provided, but ${HUB_DATA_ROOT_EXPECTATION_ENV} did not say whether this is an explicit first run or an existing journal.`,
      `Set ${HUB_DATA_ROOT_EXPECTATION_ENV}=existing for an established data root, or =first-run only after confirming no prior journal should exist.`
    )
  } else {
    return failure(
      'data-root-expectation-invalid',
      `${HUB_DATA_ROOT_EXPECTATION_ENV} must be "existing" or "first-run", not ${JSON.stringify(rawExpectation)}.`,
      'Correct the desktop/supervisor handover. Do not let the hub choose another directory.'
    )
  }

  const expectedRestoredSessions = parseExpectedRestoredSessions(rawExpectedRestored)
  if (expectedRestoredSessions === undefined) {
    return failure(
      'restored-session-expectation-invalid',
      `${HUB_EXPECTED_RESTORED_SESSIONS_ENV} must be a non-negative safe integer.`,
      'Correct the supervisor handover before restarting; do not discard the existing journal.'
    )
  }
  if (expectation === 'first-run' && expectedRestoredSessions !== 0) {
    return failure(
      'data-root-expectation-invalid',
      `A first-run data root cannot also expect ${expectedRestoredSessions} restored session(s).`,
      `Use ${HUB_DATA_ROOT_EXPECTATION_ENV}=existing for a populated journal, or explicitly expect zero for a genuine first run.`
    )
  }

  return {
    ok: true,
    dataDir: path.resolve(rawDataDir),
    expectation,
    expectedRestoredSessions,
    explicit: true,
  }
}
