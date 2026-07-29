import fs from 'node:fs'
import path from 'node:path'

function optionValue(argv, name) {
  const exact = argv.indexOf(name)
  if (exact !== -1) return argv[exact + 1]
  const prefix = `${name}=`
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

/**
 * A relaunch is never a first run. It must be handed the exact live data root explicitly instead of
 * inferring repo/data from this script's location.
 */
export function resolveRelaunchDataRoot({ argv, env }) {
  const fromArg = optionValue(argv, '--data-dir')
  const fromEnv = env.HUB_DATA_DIR
  if (!fromArg && !fromEnv) {
    throw new Error('An explicit --data-dir or HUB_DATA_DIR is required; relaunch will not guess repo/data.')
  }
  if (fromArg && fromEnv && path.resolve(fromArg) !== path.resolve(fromEnv)) {
    throw new Error('--data-dir and HUB_DATA_DIR identify different roots; refusing an ambiguous relaunch.')
  }
  const selected = String(fromArg ?? fromEnv)
  if (!path.isAbsolute(selected)) {
    throw new Error(`The relaunch data root must be absolute, not ${JSON.stringify(selected)}.`)
  }
  return path.normalize(selected)
}

/** Validate only with metadata/read access. Never creates the directory or hub.db. */
export function validateExistingRelaunchRoot(dataDir) {
  let root
  try {
    root = fs.statSync(dataDir)
  } catch {
    throw new Error(`The explicit relaunch data root does not exist: ${dataDir}`)
  }
  if (!root.isDirectory()) throw new Error(`The explicit relaunch data root is not a directory: ${dataDir}`)

  const journalPath = path.join(dataDir, 'hub.db')
  let journal
  try {
    journal = fs.statSync(journalPath)
  } catch {
    throw new Error(`The expected existing hub.db does not exist: ${journalPath}`)
  }
  if (!journal.isFile()) throw new Error(`The expected hub.db is not a regular file: ${journalPath}`)

  const fd = fs.openSync(journalPath, 'r')
  fs.closeSync(fd)
  return journalPath
}

/**
 * Remove only per-child runtime state. The data/profile roots and relaunch settings survive both the
 * worker attempt and the no-worker fallback byte-for-byte.
 */
export function buildRelaunchEnv({ baseEnv, dataDir, withWorker, expectedRestoredSessions }) {
  if (!Number.isSafeInteger(expectedRestoredSessions) || expectedRestoredSessions < 0) {
    throw new Error('expectedRestoredSessions must be a non-negative safe integer')
  }
  const env = { ...baseEnv }
  for (const key of ['HUB_SUPERVISED', 'HUB_PORT', 'HUB_WORKER_SOCKET']) delete env[key]
  env.HUB_DATA_DIR = dataDir
  env.HUB_DATA_ROOT_EXPECTATION = 'existing'
  env.HUB_EXPECTED_RESTORED_SESSIONS = String(expectedRestoredSessions)
  if (withWorker) env.HUB_WORKER = '1'
  else delete env.HUB_WORKER
  return env
}
