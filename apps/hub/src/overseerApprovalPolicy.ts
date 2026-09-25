import type { OverseerApprovalPolicy, OverseerConfig } from './types.js'

export interface OverseerApprovalPolicyUpdate {
  enabled: boolean
  maxRisk: 'low' | 'medium'
  requesterSessionIds?: string[]
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
  const supplied = input.requesterSessionIds !== undefined
  const hasScope = supplied || Boolean(previous && Object.hasOwn(previous, 'requesterSessionIds'))
  const requesterSessionIds = hasScope
    ? normalizeApprovalRequesterIds(supplied ? input.requesterSessionIds : previous?.requesterSessionIds)
    : undefined
  if (input.enabled && !hasScope) {
    throw new Error('approval_requester_session_ids is required to enable standing decisions; global enablement is not supported')
  }
  const updatedAt = new Date().toISOString()
  return {
    ...current,
    approvalPolicy: {
      enabled: input.enabled, maxRisk: input.maxRisk,
      ...(hasScope ? { requesterSessionIds } : {}), updatedAt,
    },
    updatedAt,
  }
}
