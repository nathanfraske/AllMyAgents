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
})
