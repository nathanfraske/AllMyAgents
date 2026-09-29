// The runner's reviewed resource budget can reduce concurrency, never raise our
// normal cap. These suites also start real compiler/SQLite child processes.
export function testWorkerPool(env = process.env) {
  const value = env.FLEET_TEST_WORKERS
  if (value === undefined) return { minWorkers: 1, maxWorkers: 4 }
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('FLEET_TEST_WORKERS must be a positive integer; refusing to ignore the runner budget')
  }
  return { minWorkers: 1, maxWorkers: Math.min(4, Number(value)) }
}
