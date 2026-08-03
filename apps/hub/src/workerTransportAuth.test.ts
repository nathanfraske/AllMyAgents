import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workerWelcomeProof } from './workerProtocol.js'
import { WorkerClient, WorkerServer } from './workerTransport.js'

const SECRET = 'worker-channel-authentication-secret-000000000000000000'
const WRONG_SECRET = 'wrong-worker-channel-secret-0000000000000000000000'
const SAFE = { busCanUseRiskyTools: false, autoApprovePractices: false, autoApproveRestart: false }
const cleanups: Array<() => void | Promise<void>> = []

function uniqueSocket(tmp: string): string {
  const suffix = Math.random().toString(36).slice(2)
  return process.platform === 'win32' ? `\\\\.\\pipe\\ama-worker-auth-${suffix}` : path.join(tmp, `worker-${suffix}.sock`)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('authenticated local hub-worker channel', () => {
  it('rejects a forged higher-epoch client and accepts a mutually authenticated hub', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-worker-auth-'))
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const socketPath = uniqueSocket(tmp)
    let attaches = 0
    let server!: WorkerServer
    server = new WorkerServer(socketPath, {
      onAttach: (info) => {
        attaches += 1
        const generation = 'test-generation'
        server.send({
          t: 'welcome',
          generation,
          authProof: workerWelcomeProof(SECRET, info.authNonce, info.attachEpoch, generation),
        })
      },
    }, SECRET)
    await server.listen()
    cleanups.push(() => server.close())

    const forged = new WorkerClient(socketPath, {
      attachEpoch: Number.MAX_SAFE_INTEGER,
      danger: () => SAFE,
      authSecret: WRONG_SECRET,
    })
    let forgedAttached = false
    forged.on('attached', () => (forgedAttached = true))
    forged.connect()
    await wait(100)
    forged.close()
    expect(forgedAttached).toBe(false)
    expect(attaches).toBe(0)

    const real = new WorkerClient(socketPath, { attachEpoch: 1, danger: () => SAFE, authSecret: SECRET })
    cleanups.push(() => real.close())
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('authenticated attach timed out')), 2_000)
      real.once('attached', () => {
        clearTimeout(timer)
        resolve()
      })
      real.connect()
    })
    expect(real.isAttached()).toBe(true)
    expect(attaches).toBe(1)
  })
})
