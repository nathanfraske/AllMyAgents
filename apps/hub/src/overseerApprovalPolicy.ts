import type { OverseerApprovalPolicy, OverseerConfig } from './types.js'
import { approvalFileReviewSchema, type ApprovalFileReview } from './approvalReview.js'

export interface OverseerApprovalPolicyUpdate {
  enabled: boolean
  maxRisk: 'low' | 'medium'
  requesterSessionIds?: string[]
  fileReviews?: ApprovalFileReview[]
  reviewGuidance?: string
}

export function normalizeApprovalRequesterIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(id =>
    typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id),
  )) throw new Error('approval requester scope must be at most 32 exact session ids; no names or wildcards')
  return [...new Set(value as string[])]
}

/** Absent scope retains legacy semantics; a present malformed/empty scope never widens to everyone. */
export function approvalRequesterAllowed(policy: OverseerApprovalPolicy | undefined, requesterId: string): boolean {
  if (policy?.enabled !== true || !['low', 'medium'].includes(policy.maxRisk)) return false
  if (!Object.hasOwn(policy, 'requesterSessionIds')) return true
  try { return normalizeApprovalRequesterIds(policy.requesterSessionIds).includes(requesterId) }
  catch { return false }
}

/** The supported control cannot newly enable a fleet-wide policy through an omitted scope. */
export function applyOverseerApprovalPolicyUpdate(
  current: OverseerConfig,
  input: OverseerApprovalPolicyUpdate,
): OverseerConfig {
  if (typeof input.enabled !== 'boolean' || !['low', 'medium'].includes(input.maxRisk)) {
    throw new Error('approval policy requires enabled and a low/medium risk ceiling')
  }
  const previous = current.approvalPolicy
  if (input.reviewGuidance !== undefined && (typeof input.reviewGuidance !== 'string' || input.reviewGuidance.length > 4000 || input.reviewGuidance.includes('\0'))) {
    throw new Error('approval review guidance must be plain text of at most 4000 characters')
  }
  const supplied = input.requesterSessionIds !== undefined
  const hasScope = supplied || Boolean(previous && Object.hasOwn(previous, 'requesterSessionIds'))
  const requesterSessionIds = hasScope
    ? normalizeApprovalRequesterIds(supplied ? input.requesterSessionIds : previous?.requesterSessionIds)
    : undefined
  if (input.enabled && !hasScope) {
    throw new Error('approval_requester_session_ids is required to enable standing decisions; global enablement is not supported')
  }
  const fileReviews = input.fileReviews ?? previous?.fileReviews?.filter(r => requesterSessionIds?.includes(r.requesterSessionId))
  if (fileReviews !== undefined) {
    if (!Array.isArray(fileReviews) || fileReviews.length > 16) throw new Error('file reviews require at most 16 exact entries')
    for (const raw of fileReviews) {
      const r = approvalFileReviewSchema.parse(raw)
      if (!requesterSessionIds?.includes(r.requesterSessionId)) throw new Error('file review requester must be in the exact requester scope')
      if (input.enabled && input.fileReviews && Date.parse(r.expiresAt) > Date.now() + 24 * 60 * 60 * 1000) {
        throw new Error('new file reviews must expire within 24 hours')
      }
    }
  }
  const updatedAt = new Date().toISOString()
  return {
    ...current,
    approvalPolicy: {
      enabled: input.enabled, maxRisk: input.maxRisk,
      ...(hasScope ? { requesterSessionIds } : {}), updatedAt,
      ...(fileReviews !== undefined ? { fileReviews: structuredClone(fileReviews) } : {}),
      ...((input.reviewGuidance ?? previous?.reviewGuidance) !== undefined ? { reviewGuidance: (input.reviewGuidance ?? previous?.reviewGuidance ?? '').trim() } : {}),
    },
    updatedAt,
  }
}
