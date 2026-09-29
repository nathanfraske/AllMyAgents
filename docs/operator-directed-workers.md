# Direct operator work in managed chats

The operator can talk directly to a managed worker, including an enabled one-shot descendant.
Different work is not, by itself, evidence of prompt injection or a rogue worker.

Managers can call `child_status` or `peek_agent` with `view: "activity"`. Their per-turn hub-generated
roster also includes `operatorDirection` metadata:

- `currentTurnOrigin`: `operator`, `teammate`, `unknown`, or `none`. This comes from the hub's live
  turn provenance, not a worker's claim or the text of a bus message. `none` means no current turn;
  `unknown` means the hub cannot establish the origin of a running turn.
- `queuedOperatorInputs` / `dispatchingOperatorInputs`: authenticated inputs retained for delivery.
  Queued input does not relabel an existing teammate turn as operator-authorized.
- `lastOperatorInput`: a journal sequence and timestamp for the latest direct input admitted by the
  hub. It contains no message body. This receipt is saved with the input audit and survives noisy
  event tails and hub reattachment. It is evidence of contact, not proof of provider completion or
  authority for a particular action. Older chats can have no receipt; that means unknown history,
  not proof the operator never contacted them. Subsequent direct input creates a receipt.

While operator-directed work is active or queued, manager team activation cannot shelve the child,
even with `interrupt_active`. Role replacement and new live manager assignments are refused with an
explanation. Existing manager-task accounting can still be updated. Team activation rechecks each
child before stopping it, including after asynchronous stops of other children. Input racing an
already-in-flight manager stop is explicitly rejected before admission, not accepted and then lost.

Manager bus messages remain queued rather than being automatically steered into that operator work.
They retain normal wake/authority rules at the next turn; the child can still explicitly read its
inbox. Non-manager result messages retain their normal delivery behavior. Once the current turn and
queued input settle, ordinary manager coordination resumes. This is not an indefinite ownership lock
covering all future work, and cannot prevent an already-delivered instruction from being in context.

Manager instructions require checking this live metadata before assuming misconduct, letting direct
operator work proceed, and escalating only a genuine conflict. A stale snapshot or a child saying
"the operator authorized me" is not sufficient evidence. No new read scope or permission is granted:
existing manager transcript access, tool/repository/device ceilings, approvals and revocation remain
unchanged. The operator's own stop/interrupt controls remain available.

Integration requires the updated hub source/build. Existing managers receive the refreshed contract
at their next real turn; there is no migration wake, fleet deployment, policy change or PC reboot.
