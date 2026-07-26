import { describe, expect, it, afterEach } from 'vitest'
import path from 'node:path'
import { defaultWorkerSocket } from './workerTransport.js'

/**
 * REGRESSION — two hubs with different data dirs must never share one agent worker.
 *
 * On Windows the endpoint was the fixed named pipe `\\.\pipe\allmyagents-worker`, and `dataDir` was
 * ignored. Named pipes live in a GLOBAL namespace rather than the filesystem, so every hub on the machine
 * resolved to the same endpoint however carefully its port and database were isolated. A test harness, an
 * acceptance run, or a second checkout would attach to the operator's LIVE worker and drive their real
 * agents — and nothing would look wrong, because both sides connect happily and report healthy.
 *
 * POSIX never had the bug: its socket is a real file under the data dir, so isolation was free. That
 * asymmetry is precisely why it survived — the mechanism that made one platform safe hid that the other
 * was not, and the acceptance harness had been "isolated" on Windows for weeks without being isolated.
 */
describe('defaultWorkerSocket — isolation is by data dir, on every platform', () => {
  const saved = process.env.HUB_WORKER_SOCKET
  afterEach(() => {
    if (saved === undefined) delete process.env.HUB_WORKER_SOCKET
    else process.env.HUB_WORKER_SOCKET = saved
  })

  it('gives different data dirs different endpoints', () => {
    delete process.env.HUB_WORKER_SOCKET
    const live = defaultWorkerSocket(path.resolve('/somewhere/live/data'))
    const sandbox = defaultWorkerSocket(path.resolve('/somewhere/sandbox/data'))
    expect(live).not.toBe(sandbox)
  })

  /** The hub and the worker compute this independently in separate processes; drift means no connection. */
  it('is deterministic for the same data dir', () => {
    delete process.env.HUB_WORKER_SOCKET
    const dir = path.resolve('/somewhere/live/data')
    expect(defaultWorkerSocket(dir)).toBe(defaultWorkerSocket(dir))
  })

  it('still honours an explicit override', () => {
    process.env.HUB_WORKER_SOCKET = '/tmp/explicit.sock'
    expect(defaultWorkerSocket(path.resolve('/anything'))).toBe('/tmp/explicit.sock')
  })

  it('produces a usable endpoint shape for this platform', () => {
    delete process.env.HUB_WORKER_SOCKET
    const s = defaultWorkerSocket(path.resolve('/somewhere/live/data'))
    if (process.platform === 'win32') expect(s.startsWith('\\\\.\\pipe\\')).toBe(true)
    else expect(path.isAbsolute(s)).toBe(true)
  })
})
