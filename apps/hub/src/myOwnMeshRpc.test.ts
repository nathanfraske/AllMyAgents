import { describe, expect, it } from 'vitest'
import { selectFleetNetwork, type MyOwnMeshNetworkCandidate } from './myOwnMeshRpc.js'

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
})
