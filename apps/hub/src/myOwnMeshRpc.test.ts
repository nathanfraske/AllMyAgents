import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  mergeFleetPeers,
  MyOwnMeshRpcBridge,
  selectFleetNetwork,
  selectFleetNetworks,
  selectPeerNetwork,
  type MyOwnMeshControlRequest,
  type MyOwnMeshNetworkCandidate,
} from './myOwnMeshRpc.js'

const allMyStuffPeer = (device_id: string, status = 'active') => ({
  device_id,
  status,
  capabilities: { tags: ['allmystuff', 'sites'] },
})

describe('site-free MyOwnMesh RPC network selection', () => {
  it('selects the active AllMyStuff fleet instead of claim and support networks', () => {
    const candidates: MyOwnMeshNetworkCandidate[] = [
      { config_id: 'claim', label: 'Local claiming (this LAN)', phase: 'active', peers: [allMyStuffPeer('claim-peer')] },
      { config_id: 'support', label: 'CEC Support', phase: 'active', peers: [allMyStuffPeer('support-peer')] },
      { config_id: 'fleet', label: "Nathan's Fleet", phase: 'active', peers: [allMyStuffPeer('fleet-peer')] },
    ]
    expect(selectFleetNetwork(candidates)?.config_id).toBe('fleet')
  })

  it('fails closed when no network has an AllMyStuff-capable peer', () => {
    expect(selectFleetNetwork([
      { config_id: 'unrelated', label: 'Unrelated', phase: 'active', peers: [{ device_id: 'x', status: 'active' }] },
    ])).toBeUndefined()
  })

  it('keeps every real mesh, ignores helper networks, and prefers broad active reachability', () => {
    const candidates: MyOwnMeshNetworkCandidate[] = [
      {
        config_id: 'fleet',
        label: "Nathan's Fleet",
        phase: 'active',
        peers: [allMyStuffPeer('laptop', 'pending_approval'), allMyStuffPeer('gdual')],
      },
      {
        config_id: 'claudemesh',
        phase: 'active',
        peers: [allMyStuffPeer('laptop'), allMyStuffPeer('gdual'), allMyStuffPeer('ray')],
      },
      {
        config_id: 'claim',
        label: 'Local claiming (this LAN)',
        phase: 'active',
        peers: [allMyStuffPeer('laptop')],
      },
    ]

    expect(selectFleetNetworks(candidates).map((network) => network.config_id)).toEqual(['claudemesh', 'fleet'])
    expect(selectPeerNetwork(selectFleetNetworks(candidates), 'laptop')?.config_id).toBe('claudemesh')
    expect(mergeFleetPeers(selectFleetNetworks(candidates))).toContainEqual(expect.objectContaining({
      siteId: 'laptop',
      online: true,
      status: 'active',
    }))
  })

  it('routes an outbound call over the network where that specific peer is active', async () => {
    const networks: MyOwnMeshNetworkCandidate[] = [
      { config_id: 'fleet', label: 'Fleet', phase: 'active' },
      { config_id: 'claudemesh', phase: 'active' },
    ]
    const peers = new Map([
      ['fleet', [allMyStuffPeer('laptop', 'pending_approval'), allMyStuffPeer('gdual')]],
      ['claudemesh', [allMyStuffPeer('laptop'), allMyStuffPeer('gdual')]],
    ])
    const calls: Record<string, unknown>[] = []
    const request = (async (input: Record<string, unknown>) => {
      calls.push(input)
      if (input.op === 'networks_list') return { ok: true, data: { networks } }
      if (input.op === 'peers_list') return { ok: true, data: { peers: peers.get(String(input.network)) ?? [] } }
      if (input.op === 'rpc_call') return { ok: true, data: { response: { paired: true } } }
      return { ok: false, error: `unexpected operation ${String(input.op)}` }
    }) as MyOwnMeshControlRequest
    const bridge = new MyOwnMeshRpcBridge(request)

    await expect(bridge.call('laptop-ABC', { kind: 'pair_exchange' })).resolves.toEqual({ paired: true })
    expect(calls.find((call) => call.op === 'rpc_call')).toMatchObject({
      network: 'claudemesh',
      peer: 'laptop',
    })
  })

  it('registers its inbound Hub method on every eligible shared mesh', async () => {
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\allmyagents-mesh-test-${process.pid}-${Date.now()}`
      : path.join(os.tmpdir(), `allmyagents-mesh-test-${process.pid}-${Date.now()}.sock`)
    const sockets = new Set<net.Socket>()
    let nextClient = 0
    const server = net.createServer((socket) => {
      sockets.add(socket)
      let buffered = ''
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8')
        const newline = buffered.indexOf('\n')
        if (newline < 0) return
        const request = JSON.parse(buffered.slice(0, newline)) as { op?: string }
        if (request.op === 'events_subscribe') {
          socket.write(`${JSON.stringify({ ok: true, data: { client_id: `client-${++nextClient}` } })}\n`)
        }
      })
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    const registered: string[] = []
    const request = (async (input: Record<string, unknown>) => {
      if (input.op === 'networks_list') {
        return {
          ok: true,
          data: {
            networks: [
              { config_id: 'fleet', label: 'Fleet', phase: 'active' },
              { config_id: 'claudemesh', phase: 'active' },
            ],
          },
        }
      }
      if (input.op === 'peers_list') return { ok: true, data: { peers: [allMyStuffPeer('peer')] } }
      if (input.op === 'rpc_register') {
        registered.push(String(input.network))
        return { ok: true, data: {} }
      }
      return { ok: false, error: `unexpected operation ${String(input.op)}` }
    }) as MyOwnMeshControlRequest
    const bridge = new MyOwnMeshRpcBridge(request, socketPath)
    bridge.setHandler(async () => ({ ok: true }))

    try {
      await bridge.start()
      expect(registered.sort()).toEqual(['claudemesh', 'fleet'])
      expect(bridge.status()).toMatchObject({
        available: true,
        networkIds: expect.arrayContaining(['claudemesh', 'fleet']),
      })
    } finally {
      bridge.stop()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
