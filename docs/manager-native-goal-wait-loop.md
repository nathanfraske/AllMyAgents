# Manager wait-loop investigation — 2026-09-10

## Finding

This is an AllMyAgents/Codex integration defect, not a free sleep and not evidence of duplicated run-completion mail. AllMyAgents told managers to end their turn when waiting for durable work, but did not account for an active native Codex goal immediately starting another turn. The manager obeyed the yield instruction, then repeatedly inspected the same runs and emitted another “verified wait.” Shrinking the inspection response does not remove those model turns.

The current MoM V4 manager is `ee63e095-2400-4081-bf43-49a6a251fe46`, on `codex-a` (not its older account assignment), native thread `01a0824e-68b1-7230-b22b-7e8d1f98a201`. Read-only, session-indexed inspection of the operator journal established:

- Between **2026-09-11 02:30:20 and 02:32:10 UTC**, seven complete repeated polling cycles issued seven each of `query_team`, `child_status`, and `inspect_runs`, and seven waiting finals. Adjacent native turns started roughly 30 ms after completion, without intervening operator input, delivered bus mail, or a run completion in this window.
- Counter endpoints at `02:30:20.303` (seq 11334172) and `02:32:08.917` (seq 11334831) increased by **2,887,441 input tokens**, including **2,824,122 cached input tokens**. The difference is **63,319 uncached input tokens**. Output increased by **3,032 tokens**, including 211 reasoning tokens. These are observed provider counters across the loop, not a dollar estimate or a claim that all input was uncached/billed equally. Cumulative notifications were not summed.
- A wider sample contained seven terminal run records with seven matching continuation deliveries. Completion delivery itself was working in that sample.
- At `02:35:48.231` (seq 11335400) the existing native goal became `blocked`, after operator intervention. This investigation did not change that goal. The later session record was idle with last activity `02:49:10.968` and no further events at the final read. Do not credit the source patch with stopping the live loop.

The diagnostic is `scripts/inspect-manager-waits.mjs`. It opens SQLite read-only/query-only in a separate process with a 45-second parent deadline, reads at most 20,000 session-indexed rows, excludes payloads above 256 KiB, and never hydrates blobs or instantiates the application journal. Optional time filters apply to that bounded latest-row sample, not an unbounded historical scan. Counter resets/incomplete counters suppress endpoint subtraction. It does not print reasoning bodies or command bodies.

```powershell
node scripts/inspect-manager-waits.mjs <hub.db> <session-id> 4000 <from-ISO> <to-ISO>
```

## Source fix

Extend the existing `control_run` with `operation="wait"`; do not create another scheduler or turn read-only inspections into hidden mutations.

1. Resolve the caller through the existing operational scope and require the run's exact `actorSessionId` to equal the caller. A sibling's run cannot silently park a caller that will not receive its completion mail.
2. If already terminal or outcome-unknown, return the exact current outcome with `waiting:false`.
3. For Codex, query the bound thread's native goal and pause an active goal with **only** `{threadId,status:"paused"}`. Never replace/clear the objective, reset its budget/accounting, issue `turn/interrupt`, or cancel the external run. Inactive goals remain unchanged; Claude has no corresponding native goal operation here.
4. Bound each native request to five seconds. Missing/unknown state, unsupported executors, rejected/unconfirmed responses and timeouts report **wait not confirmed**, never a false successful wait. An ambiguous timeout is not permission to retry a write blindly.
5. Re-read the run after acknowledgement to handle completion races, journal the result, and instruct the agent to end its turn without sleep/poll/report loops. Existing durable terminal delivery remains the single completion-wake path.

The goal remains paused. Genuine hub mail can request a normal `turn/start`; the app does **not** secretly reactivate the goal, which would recreate the polling loop or override an operator pause. Unfinished work must not be marked complete/blocked just to suppress continuation. This is an explicit own-run wait, not a heuristic that silently pauses all goals or generalizes to arbitrary child/CI waits.

The optional executor hook is implemented for both in-process and supervised-worker execution using the existing authenticated command channel. Cancellation's authority checks are unchanged; parking the caller's own continuation is also available on teammate turns. Manager/Overseer live contracts are bumped so existing conversations get the new instruction on their next app-managed turn.

The [official Codex app-server goal contract](https://learn.chatgpt.com/docs/app-server) documents status-only goal updates preserving the objective and accumulated usage, unlike setting a new objective. The installed 0.153.3 CLI's generated `ThreadGoalSetParams` schema also includes `paused`. Neither schema inspection nor mock tests constitutes a live-model proof of provider behavior during an in-flight tool call.

## Verification and rollout boundary

- Nine targeted suites: `codexGoalWait`, `agentToolCore`, `projectManager`, `overseer`, `workerExecutor`, `agentWorker`, `codexReasoningSummary`, `codexTurnError`, `codexSubagents`: **222 tests passed**. Initial failures were new test-fixture/matcher errors, corrected before this result.
- `npx tsc --noEmit` in `apps/hub`: passed.
- Coverage includes exact-thread binding, status-only pause, already-inactive goals, unknown state, bounded timeout/pending cleanup, worker ACK failures, unchanged run records, both providers, another actor/project rejection, terminal-during-pause races, one completion wake, and retained bus cancellation restrictions.
- No production database writes, model requests, service/app/OS restart, live goal mutation, cancellation, merge, release or installation was performed in this source pass. Generated schemas used an ignored diagnostic directory.

Before claiming deployment: ship the source patch, load the new tool contract, and qualify an explicitly authorized short durable run with a native goal. Confirm `run/wait-armed`, preserved goal objective/accounting, no automatic polling turns while waiting, and one useful continuation on completion. Failure to acknowledge parking must remain visible. No OS reboot is needed; any application update/restart is a separate live action.
