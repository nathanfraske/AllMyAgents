// --- Approval decision outcome ------------------------------------------------------------------
//
// POST /api/approvals/:id used to have its result IGNORED: the handler cleared the prompt whatever
// happened. So a 404 (the approval already resolved elsewhere, or timed out) and a 401 (unauthorized)
// both looked exactly like an accepted decision — the operator denies a tool call, the UI says it was
// handled, and the agent's approval was never actually resolved (or was resolved the other way by a
// timeout). That is a safety bug, not a cosmetic one.
//
// The hub answers a missing approval with `404 {ok:false}` and a resolved one with `200 {ok:true}`, but
// the POST transport (jpost) discards the HTTP status and hands back only `{error}`. Rather than
// string-match "HTTP 404" (fragile — a future hub could attach a message body instead), we ask the
// AUTHORITATIVE source: after the write, re-read the approvals roster. If this approval is no longer
// pending it is genuinely GONE; if it is still there, the write did not take.

export type DecideOutcome =
  | { kind: 'resolved' } // the write succeeded — the prompt should clear
  | { kind: 'gone' } // the write failed, but the approval is no longer pending: already resolved / timed out
  | { kind: 'failed'; error: string } // the write failed and the approval is STILL pending: the click did not take

/**
 * Classify what a decision POST actually accomplished.
 *
 * @param res           the transport result — `{error}` present means the POST was not a 2xx
 * @param stillPending  whether the approval is STILL in the freshly re-read roster
 *
 * - no error                → `resolved` (clear the prompt; the roster refresh already dropped it)
 * - error + still pending    → `failed`  (keep the prompt up so the operator can decide again, and say why)
 * - error + no longer present → `gone`    (already resolved/timed out — clearing is honest; asking the
 *                                          operator to retry a thing that no longer exists would be a lie)
 */
export function classifyDecideOutcome(
  res: { ok?: boolean; error?: string } | null | undefined,
  stillPending: boolean
): DecideOutcome {
  if (!res?.error) return { kind: 'resolved' }
  return stillPending ? { kind: 'failed', error: res.error } : { kind: 'gone' }
}
