# Backlog — deferred TODOs

Not-yet-built items surfaced during the agent-detachment / worker work. Ordered roughly by the order
they came up; not a priority ranking.

## Critical-agent tier (requested 2026-07-24)

An opt-in per-agent designation for maximum restart durability, ON TOP of the Phase-2 worker model
(which already gives every agent hub-restart survival). A "critical" agent gets:
- **Never batch-restarted** — pinned out of any rolling/batch worker restart; only ever touched by an
  unavoidable crash.
- **Aggressive checkpointing** — its progress is flushed at every turn/tool boundary so a worker or
  machine restart resumes with minimal lost ground.
- **Auto-resume on boot** — restored + resumed on hub/machine boot instead of left idle.

Hard limit to document in the UI: this buys **turn-granular durability + never-batched**, NOT literal
mid-generation survival — a live LLM generation + its running subprocess cannot be frozen/thawed by
anyone across a worker/machine restart. See `docs/agent-worker-impl.md` (worker model) — this is a tier
above it. Storage: a `critical?: boolean` on the session/profile + a `pinnedWorker` grouping in hubctl.

## Per-agent restart ACL

"Only this agent/profile may call `restart_hub`" — a per-agent grant on top of the existing global
danger gate (`decideRestartGate`: today it's operator-approval-per-call by default, or
`autoApproveRestart` for all). Small addition: an allow-list checked before the gate.

## History viewer — "load older" button

The paging cursor + `store.loadOlderHistory()` are already wired (see the history-viewer commit); a long
imported chat currently shows the most-recent ~300 turns. Just needs a "load older" affordance at the top
of the thread when `historyOlderCursor != null`.

## Agents panel + Claude workflow visualization

Scoped in `docs/claude-workflow-viz.md`. Real data exists (165 `agent-*.jsonl` files across 7 `subagents/`
dirs). Reconstruct a `WorkflowRun` tree from the external subagent transcripts; node drill-in reuses the
history viewer. Land it with the port-inside work so it renders live orchestration data. Note: the
sub-agent tool is named `Agent`, not `Task`.

## Codex skill-sequence workflows

Scoped in `docs/codex-workflows.md`. A hub-owned `WorkflowStore` (JSON recipe) + `WorkflowRunner` that
drives one Codex turn per step with concrete gates + operator checkpoints, reusing `runCodexTurn`. Zero
new app-server protocol.

## Journal compaction / snapshot

The journal replays from seq 0 on every load and `usage/snapshot` events accumulate (they were 37% of the
journal when the "won't populate" freeze hit). Either stop journaling ephemeral usage snapshots or add
compaction/snapshotting so replay stays bounded as the journal grows.

## Agent `restart_hub` MCP tool

The gate (`restartGate.ts`) is built + tested; the operator `POST /api/restart` path ships. The agent MCP
tool (`restart_hub` in `agentTools.ts`, self-gating + bus-hard-deny, `searchHint`-deferred) is the "later"
path from `docs/agent-detachment-impl.md` §1.8 — wire it when the worker relays land.

## Worker-wiring hardening (from the slice-1-2 audit)

For the worker-attach slice: a `UNIQUE(session, wseq) WHERE wseq IS NOT NULL` index (+ `INSERT OR IGNORE`)
as defense-in-depth for exactly-once journaling; and ensure `stopSession → wseqBuffer.forget()` never
reuses a sessionId while the journal still holds higher `wseq` rows (else `lastJournaledWseq` returns a
stale high-water mark and drops the new turn's gap events).

## Transport audit — handle when wiring the worker (from the slice-3 audit)

- **M2 (draining release):** `WorkerServer.setDraining()` clears `draining` ONLY on a fresh `hello`. When
  I wire `RestartController.drain() → signalDraining()`, a ROLLED-BACK flip (blue re-listens via
  `abort()`, no new hello) would leave the worker stuck `draining=true` → every relay from the live turn
  rejects `HubUnavailableError` even though blue is healthy. Pair the drain pre-signal with a release:
  `abort()` drops+reconnects blue's `WorkerClient` (a fresh hello resets it), or add an un-drain push.
- **L4:** `WorkerServer.close()` can hang on a connected-but-never-`hello` socket (untracked) — track every
  accepted channel + destroy them all in `close()`.
- **L6:** a delivered `rpc` relay has no backstop; a hub that accepts but never replies hangs the tool
  Promise forever — add a generous backstop on delivered `rpc` relays (not `approvalRequest`), or document
  the hub's always-reply obligation as load-bearing.
- **L8:** `unref()` the reconnect/relay/call timers so a forgotten `close()` can't pin the event loop.

## Worker health signal (Phase 2 §5.2)

If a hub's `WorkerClient` exhausts a long reconnect budget (worker present but wedged), signal hubctl to
`killTree` + respawn the worker. Kept out of the first cut (failure-amplification risk); plain
respawn-on-exit covers the common case.
