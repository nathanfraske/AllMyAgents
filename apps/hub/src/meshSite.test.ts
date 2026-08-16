import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeshSite, type MeshControlRequest } from './meshSite.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('MeshSite registration', () => {
  it('keeps an already-correct exposure read-only across repeated registrations', async () => {
    let reads = 0
    let setCalls = 0
    const request: MeshControlRequest = async (cmd) => {
      if (cmd === 'site_exposed') {
        reads += 1
        return { ok: true, result: { 'tcp:7777': 'AllMyAgents' } }
      }
      if (cmd === 'site_set_exposed') {
        setCalls += 1
        return { ok: true, result: { 'tcp:7777': 'AllMyAgents' } }
      }
      throw new Error(`unexpected command ${cmd}`)
    }
    const mesh = new MeshSite({ port: 7777, enable: true, controlRequest: request })

    await expect(mesh.register()).resolves.toMatchObject({ nodePresent: true, exposed: true })
    await expect(mesh.register()).resolves.toMatchObject({ nodePresent: true, exposed: true })

    expect(reads).toBe(2)
    expect(setCalls).toBe(0)
  })

  it('shares one registration attempt across overlapping callers', async () => {
    let releaseRead: ((value: { ok: true; result: Record<string, string> }) => void) | undefined
    const read = new Promise<{ ok: true; result: Record<string, string> }>((resolve) => {
      releaseRead = resolve
    })
    let reads = 0
    let setCalls = 0
    const request: MeshControlRequest = async (cmd, args) => {
      if (cmd === 'site_exposed') {
        reads += 1
        return read
      }
      if (cmd === 'site_set_exposed') {
        setCalls += 1
        return { ok: true, result: (args as { exposed: Record<string, string> }).exposed }
      }
      throw new Error(`unexpected command ${cmd}`)
    }
    const mesh = new MeshSite({ port: 7777, enable: true, controlRequest: request })

    const registrations = [mesh.register(), mesh.register(), mesh.register()]
    releaseRead?.({ ok: true, result: {} })
    const statuses = await Promise.all(registrations)

    expect(statuses).toHaveLength(3)
    expect(statuses.every((status) => status.nodePresent && status.exposed)).toBe(true)
    expect(reads).toBe(1)
    expect(setCalls).toBe(1)
  })

  it('does not restamp a correct exposure during automatic presence checks', async () => {
    vi.useFakeTimers()
    let reads = 0
    let setCalls = 0
    const request: MeshControlRequest = async (cmd) => {
      if (cmd === 'site_exposed') {
        reads += 1
        return { ok: true, result: { 'tcp:7777': 'AllMyAgents' } }
      }
      if (cmd === 'site_set_exposed') {
        setCalls += 1
        return { ok: true, result: { 'tcp:7777': 'AllMyAgents' } }
      }
      if (cmd === 'owned_roster') return { ok: true, result: { members: [] } }
      if (cmd === 'session_snapshot') return { ok: true, result: { peers: [] } }
      throw new Error(`unexpected command ${cmd}`)
    }
    const mesh = new MeshSite({ port: 7777, enable: true, controlRequest: request })

    await mesh.register()
    mesh.startAutoRegister(30_000)
    await vi.advanceTimersByTimeAsync(90_001)
    mesh.stopAutoRegister()

    expect(reads).toBeGreaterThanOrEqual(4)
    expect(setCalls).toBe(0)
  })

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

  it('preserves a control-pipe permission failure for authority-sensitive roster callers', async () => {
    const request: MeshControlRequest = async () => {
      const error = new Error('connect EPERM') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    }
    const mesh = new MeshSite({ port: 7777, enable: true, controlRequest: request })

    await expect(mesh.ownedRoster()).resolves.toEqual([])
    await expect(mesh.ownedRosterRequired()).rejects.toThrow(/interactive console user.*full-duplex/u)
  })
})

describe('MeshSite route recovery', () => {
  it('automatically maps presence-advertised AllMyAgents hubs on owned devices', async () => {
    const mapped: Array<[string, number]> = []
    const request: MeshControlRequest = async (cmd, args) => {
      if (cmd === 'owned_roster') {
        return { ok: true, result: { members: [{ device: 'laptop', label: 'Laptop' }] } }
      }
      if (cmd === 'session_snapshot') {
        return {
          ok: true,
          result: {
            peers: [
              {
                node: 'laptop-AAAA',
                sites: [
                  { id: 'tcp:8123', label: 'AllMyAgents laptop', port: 8123 },
                  { id: 'tcp:9000', label: 'Unrelated service', port: 9000 },
                ],
              },
              {
                node: 'not-owned-BBBB',
                sites: [{ id: 'tcp:7777', label: 'AllMyAgents', port: 7777 }],
              },
            ],
          },
        }
      }
      if (cmd === 'site_map') {
        const route = args as { node: string; port: number }
        mapped.push([route.node, route.port])
        return { ok: true, result: { localPort: 48_000 + mapped.length } }
      }
      throw new Error(`unexpected command ${cmd}`)
    }
    const mesh = new MeshSite({ port: 7777, enable: true, controlRequest: request })

    await expect(mesh.warmPeerHubRoutes()).resolves.toBe(1)
    expect(mapped).toEqual([['laptop-AAAA', 8123]])
  })

  it('invalidates the idempotent stale mapping before asking for a replacement', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const request: MeshControlRequest = async (cmd) => {
      calls.push(cmd)
      if (cmd === 'site_unmap') return { ok: true, result: {} }
      if (cmd === 'site_map') return { ok: true, result: { localPort: 48123 } }
      throw new Error(`unexpected command ${cmd}`)
    }
    const mesh = new MeshSite({ port: 7777, controlRequest: request })

    const pending = mesh.recoverSiteMap('peer-AAAA', 7777)
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBe(48123)
    expect(calls).toEqual(['site_unmap', 'site_map'])
  })

  it('does not churn an actually offline mapping inside the recovery cooldown', async () => {
    vi.useFakeTimers()
    let calls = 0
    const request: MeshControlRequest = async (cmd) => {
      calls += 1
      if (cmd === 'site_unmap') return { ok: true, result: {} }
      if (cmd === 'site_map') return { ok: true, result: { localPort: 48124 } }
      throw new Error(`unexpected command ${cmd}`)
    }
    const mesh = new MeshSite({ port: 7777, controlRequest: request })

    const first = mesh.recoverSiteMap('peer-BBBB', 7777)
    await vi.runAllTimersAsync()
    await first
    await expect(mesh.recoverSiteMap('peer-BBBB', 7777)).resolves.toBeNull()
    expect(calls).toBe(2)
  })
})
