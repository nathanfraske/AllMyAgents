import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeshSite, type MeshControlRequest } from './meshSite.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('MeshSite registration', () => {
  it('confirms a timed-out set from the authoritative exposed map instead of retrying a write that landed', async () => {
    vi.useFakeTimers()
    let exposed: Record<string, string> = { 'tcp:7777': 'AllMyAgents' }
    let setCalls = 0
    const request: MeshControlRequest = async (cmd, args) => {
      if (cmd === 'site_exposed') return { ok: true, result: { ...exposed } }
      if (cmd === 'site_set_exposed') {
        setCalls += 1
        exposed = { ...((args as { exposed: Record<string, string> }).exposed) }
        // AllMyStuff applies the map before awaiting its inventory/profile restamp. The socket reply
        // can therefore miss our deadline even though the requested state is already authoritative.
        throw new Error('mesh: control-socket timeout')
      }
      throw new Error(`unexpected command ${cmd}`)
    }
    const mesh = new MeshSite({ port: 7804, enable: true, controlRequest: request })

    const pending = mesh.register()
    await vi.runAllTimersAsync()
    const status = await pending

    expect(status).toMatchObject({ nodePresent: true, exposed: true, siteId: 'tcp:7804' })
    expect(setCalls).toBe(1)
    expect(exposed).toEqual({ 'tcp:7777': 'AllMyAgents', 'tcp:7804': 'AllMyAgents' })
  })

  it('merges without clobbering another site and makes a custom label self-identifying', async () => {
    let written: Record<string, string> | undefined
    const request: MeshControlRequest = async (cmd, args) => {
      if (cmd === 'site_exposed') return { ok: true, result: { 'tcp:7777': 'AllMyAgents' } }
      if (cmd === 'site_set_exposed') {
        written = (args as { exposed: Record<string, string> }).exposed
        return { ok: true, result: written }
      }
      throw new Error(`unexpected command ${cmd}`)
    }
    const mesh = new MeshSite({ port: 8123, label: 'Editing rig', enable: true, controlRequest: request })

    const status = await mesh.register()

    expect(status).toMatchObject({ nodePresent: true, exposed: true })
    expect(written).toEqual({
      'tcp:7777': 'AllMyAgents',
      'tcp:8123': 'AllMyAgents — Editing rig',
    })
  })

  it('still treats an absent node as the normal local-only case without retrying', async () => {
    let calls = 0
    const request: MeshControlRequest = async () => {
      calls += 1
      const error = new Error('connect ENOENT') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    const mesh = new MeshSite({ port: 7804, enable: true, controlRequest: request })

    const status = await mesh.register()

    expect(status).toMatchObject({ nodePresent: false, exposed: false })
    expect(status.error).toContain('local-only')
    expect(calls).toBe(1)
  })
})
