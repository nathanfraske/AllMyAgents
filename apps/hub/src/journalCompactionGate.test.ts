import { describe, expect, it, vi } from 'vitest'
import { verifyRecentCompactionSnapshot } from './journalCompactionGate.js'

describe('journal compaction snapshot gate', () => {
  it('never authorizes deletion from a legacy flat backup without recovery-owned identity evidence', () => {
    expect(
      verifyRecentCompactionSnapshot('/backups', 100, Date.parse('2026-07-30T13:00:00.000Z'))
    ).toEqual({
      ok: false,
      reason: 'strong recovery-owned snapshot verification is not available',
    })
  })

  it('requires exact root/journal evidence and a snapshot high-water covering every candidate', () => {
    const verifier = vi.fn(() => ({
      ok: true as const,
      evidence: {
        rootId: 'root-1',
        journalId: 'journal-1',
        generation: '2',
        snapshotMaxSeq: '99',
        snapshotEventHighWater: '99',
        verifiedAt: '2026-07-30T13:00:00.000Z',
      },
    }))
    expect(verifyRecentCompactionSnapshot('/owned', 100, Date.now(), verifier)).toEqual({
      ok: false,
      reason: 'recovery-owned snapshot evidence is invalid or stale',
    })
    expect(verifier).toHaveBeenCalledWith('/owned', 100, expect.any(Number))

    verifier.mockReturnValueOnce({
      ok: true,
      evidence: {
        rootId: '',
        journalId: 'foreign',
        generation: '2',
        snapshotMaxSeq: '100',
        snapshotEventHighWater: '100',
        verifiedAt: '2026-07-30T13:00:00.000Z',
      },
    })
    expect(verifyRecentCompactionSnapshot('/owned', 100, Date.now(), verifier)).toEqual(
      expect.objectContaining({ ok: false })
    )
  })

  it('accepts only closed, identity-bound evidence from the injected recovery verifier', () => {
    const verifiedAt = '2026-07-30T13:00:00.000Z'
    expect(
      verifyRecentCompactionSnapshot('/owned', 100, Date.parse(verifiedAt), () => ({
        ok: true,
        evidence: {
          rootId: 'root-1',
          journalId: 'journal-1',
          generation: '2',
          snapshotMaxSeq: '100',
          snapshotEventHighWater: '100',
          verifiedAt,
        },
      }))
    ).toEqual({
      ok: true,
      evidence: {
        rootId: 'root-1',
        journalId: 'journal-1',
        generation: '2',
        snapshotMaxSeq: '100',
        snapshotEventHighWater: '100',
        verifiedAt,
      },
    })
  })
})
