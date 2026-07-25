import type { DangerFlags } from './types.js'

/**
 * Danger-zone gate for an agent-initiated hub restart (restart_hub / self_migrate). The twin of
 * decidePracticeGate (practices.ts) — same shape, same Danger Zone overrides, so a restart is gated
 * on exactly the philosophy practice writes already are: a safe default of operator approval, a
 * Settings toggle for the fully-autonomous loop, and a hard-deny on semi-trusted bus turns. Pure and
 * dependency-free (no SDK) so it can be unit-tested directly. The operator's own POST /api/restart
 * path is NOT gated here — an authenticated operator action is its own approval; this gate is only on
 * the agent (MCP) path.
 */
export type RestartGate =
  /** Restart immediately — the owner opted into auto-approval (fully-autonomous loop). */
  | { action: 'allow' }
  /** Block on the operator-approval gate before restarting (the safe default). */
  | { action: 'approve' }
  /** Hard-deny: a semi-trusted bus turn may not restart the hub. */
  | { action: 'deny-bus' }

/**
 * The restart permission gate, and how the Danger Zone toggles override it. Pure so it can be tested
 * directly. Precedence:
 *   1. Bus turn (teammate-message-caused) → deny, UNLESS the owner enabled `busCanUseRiskyTools`.
 *      A restart must never originate from a semi-trusted teammate message by default.
 *   2. Owner enabled `autoApproveRestart` → allow even without a prompt (fully-permissive opt-in).
 *   3. Otherwise → operator approval (the safe default).
 */
export function decideRestartGate(opts: { isBusTurn: boolean; danger: DangerFlags }): RestartGate {
  if (opts.isBusTurn && !opts.danger.busCanUseRiskyTools) return { action: 'deny-bus' } // never from a teammate message
  if (opts.danger.autoApproveRestart) return { action: 'allow' }                          // fully-permissive opt-in
  return { action: 'approve' }                                                             // safe default: ask operator
}
