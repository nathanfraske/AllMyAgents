import { describe, expect, it } from 'vitest'
import { signDirectHubEnvelope, verifyDirectHubEnvelope } from './directHubProtocol.js'

describe('direct hub protocol authentication', () => {
  it('binds a message to its mesh peer, payload, timestamp, and paired source token', () => {
    const now = new Date('2026-08-04T18:00:00.000Z')
    const envelope = signDirectHubEnvelope(
      'source-token-that-is-long-enough-for-a-device-capability',
      { siteId: 'peerabc', label: 'Workstation' },
      'overseer_message',
      { text: 'hello' },
      now,
    )
    expect(verifyDirectHubEnvelope(envelope, {
      fromPeer: 'peerabc-AB123',
      token: 'source-token-that-is-long-enough-for-a-device-capability',
      now,
    })).toEqual(envelope)
    expect(() => verifyDirectHubEnvelope({ ...envelope, payload: { text: 'changed' } }, {
      fromPeer: 'peerabc',
      token: 'source-token-that-is-long-enough-for-a-device-capability',
      now,
    })).toThrow(/signature/u)
    expect(() => verifyDirectHubEnvelope(envelope, {
      fromPeer: 'peerxyz',
      token: 'source-token-that-is-long-enough-for-a-device-capability',
      now,
    })).toThrow(/authenticated mesh peer/u)
  })

  it('authenticates through a relay that re-serializes every map with sorted keys', () => {
    const now = new Date('2026-08-04T18:00:00.000Z')
    const token = 'source-token-that-is-long-enough-for-a-device-capability'
    const envelope = signDirectHubEnvelope(token, { siteId: 'peerabc', label: 'Workstation' }, 'device_action', {
      action: { op: 'exec', rootId: 'root_1', command: 'echo hi' },
      actor: { sessionId: 'session-1', agentName: 'Overseer' },
    }, now)

    // Only an empty payload was order-free, so this shape — not `device_capabilities` — is what the
    // MyOwnMesh lane actually rejected before signing became canonical.
    expect(verifyDirectHubEnvelope(relayed(envelope), { fromPeer: 'peerabc-AB123', token, now })).toEqual(envelope)
    expect(() => verifyDirectHubEnvelope(
      relayed({ ...envelope, payload: { action: { op: 'exec', rootId: 'root_1', command: 'rm -rf /' } } }),
      { fromPeer: 'peerabc-AB123', token, now },
    )).toThrow(/signature/u)
  })
})

/** Mimic the MyOwnMesh relay, whose map re-serializes with its keys in sorted order. */
function relayed<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().reverse().map((key) => [key, record[key]]))
  })) as T
}
