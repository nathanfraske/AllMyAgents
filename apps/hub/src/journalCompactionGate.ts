export type CompactionSnapshotEvidence = {
  rootId: string
  journalId: string
  generation: string
  snapshotMaxSeq: string
  snapshotEventHighWater: string
  verifiedAt: string
}

export type CompactionSnapshotGate =
  | { ok: true; evidence: CompactionSnapshotEvidence }
  | { ok: false; reason: string }

export type RecoveryOwnedSnapshotVerifier = (
  backupDirectory: string,
  requiredThroughSeq: number,
  nowMs: number
) => CompactionSnapshotGate

/**
 * Legacy flat `hub-*.db` snapshots are intentionally ineligible: filename, mtime, quick_check, and an
 * events table do not prove root/journal ownership or that the snapshot covers the rows about to be
 * deleted. The recovery candidate supplies the strong owned-generation verifier at integration time.
 * Until then production fails closed and bounded replay remains fast without destructive maintenance.
 */
export function verifyRecentCompactionSnapshot(
  backupDirectory: string,
  requiredThroughSeq: number,
  nowMs = Date.now(),
  verifyOwnedGeneration?: RecoveryOwnedSnapshotVerifier
): CompactionSnapshotGate {
  if (
    !Number.isSafeInteger(requiredThroughSeq) ||
    requiredThroughSeq < 0 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    return { ok: false, reason: 'snapshot verification bounds are invalid' }
  }
  if (!verifyOwnedGeneration) {
    return {
      ok: false,
      reason: 'strong recovery-owned snapshot verification is not available',
    }
  }
  const result = verifyOwnedGeneration(backupDirectory, requiredThroughSeq, nowMs)
  if (!result.ok) return result
  const evidence = result.evidence
  const canonicalOrdinal = /^[1-9][0-9]*$/
  const canonicalHighWater = /^(0|[1-9][0-9]*)$/
  if (
    !evidence.rootId ||
    evidence.rootId.length > 128 ||
    !evidence.journalId ||
    evidence.journalId.length > 128 ||
    !canonicalOrdinal.test(evidence.generation) ||
    !canonicalHighWater.test(evidence.snapshotMaxSeq) ||
    !canonicalHighWater.test(evidence.snapshotEventHighWater) ||
    BigInt(evidence.snapshotMaxSeq) < BigInt(requiredThroughSeq) ||
    BigInt(evidence.snapshotEventHighWater) < BigInt(requiredThroughSeq) ||
    Number.isNaN(Date.parse(evidence.verifiedAt)) ||
    new Date(evidence.verifiedAt).toISOString() !== evidence.verifiedAt
  ) {
    return { ok: false, reason: 'recovery-owned snapshot evidence is invalid or stale' }
  }
  return result
}
