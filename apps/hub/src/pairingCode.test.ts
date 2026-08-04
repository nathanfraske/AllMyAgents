import { describe, expect, it } from 'vitest'
import { normalizePairingCode, PairingCodeBroker } from './pairingCode.js'

describe('PairingCodeBroker', () => {
  it('issues a typo-resistant XXXX-XXXX code and exchanges it once', () => {
    const broker = new PairingCodeBroker('long-lived-device-token', 60_000)
    const issued = broker.issue(1_000)
    expect(issued.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u)
    expect(broker.redeem(issued.code.toLowerCase(), 2_000)).toEqual({
      ok: true,
      token: 'long-lived-device-token',
    })
    expect(broker.redeem(issued.code, 2_001)).toEqual({ ok: false })
  })

  it('accepts spaces or a missing separator but rejects ambiguous characters', () => {
    expect(normalizePairingCode('ABCD EFGH')).toBe('ABCDEFGH')
    expect(normalizePairingCode('ABCD-EFGH')).toBe('ABCDEFGH')
    expect(normalizePairingCode('ABCD0FGH')).toBeUndefined()
    expect(normalizePairingCode('ABCDIFGH')).toBeUndefined()
  })

  it('expires and rate-limits the short capability', () => {
    const expired = new PairingCodeBroker('token', 100, 2)
    const first = expired.issue(1_000)
    expect(expired.redeem(first.code, 1_100)).toEqual({ ok: false })

    const bounded = new PairingCodeBroker('token', 60_000, 2)
    const second = bounded.issue(2_000)
    expect(bounded.redeem('AAAA-AAAA', 2_001)).toEqual({ ok: false })
    expect(bounded.redeem('BBBB-BBBB', 2_002)).toEqual({ ok: false })
    expect(bounded.redeem(second.code, 2_003)).toEqual({ ok: false })
  })
})
