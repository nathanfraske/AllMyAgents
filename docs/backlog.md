# Backlog — deferred TODOs

Not-yet-built items surfaced during the agent-detachment / worker work. Ordered roughly by the order
they came up; not a priority ranking.

## Alpha release (post-worker milestone) → docs/alpha-release-plan.md

After the always-on worker lands + is audited: package the full installable bundle as a real user would
get it (Tauri installer, `%APPDATA%` app-data layout, first-run setup), **dev harnesses enabled for
alpha**, and cut an initial **pre-release** GitHub alpha. Hard gate before any public artifact: ship
**template** profiles — never the operator's real credentials — and resolve the P0 connector default.
Full definition-of-parity, bundle scope, security gates, and sequence in `docs/alpha-release-plan.md`.

## Tooling gaps — from the T3Code + vendor-app research (docs/t3code-tooling-gaps.md, docs/vendor-app-tooling.md)

AllMyAgents already LEADS on the deep agent tooling (bus, scoped memory, practices, hooks,
browser/computer/visualization, auto-recall) — not gaps. The real gaps:

- **P0 — VERIFY live behaviors (security-relevant), then govern.** `profiles/claude-a/.claude.json` has
  `"tengu_claudeai_mcp_connectors": true` and the hub sets NO connector kill-switch, so the operator's
  claude.ai connectors may already reach hub Claude agents via the vendor cloud.
  - **Plain English:** "connectors" are the integrations you've linked to your Claude account through
    Anthropic's cloud — Google Drive, GitHub, Gmail, and the like. With this flag on, an agent running
    inside the hub may be able to call those integrations — i.e. reach into your linked accounts — via
    the vendor cloud, even though you never wired them into the hub yourself. The danger: an agent
    chewing on untrusted text (an imported chat, a scraped web page) could be talked into pulling data
    from, or pushing data to, one of those connected accounts.
  - **Decision (matches the safe-default + toggle philosophy):** default the connector kill-switch ON
    (connectors unreachable by agents), expose a Danger-Zone toggle to allow them. Make the same
    deliberate call for vendor auto-memory (which today runs in parallel with hub memory).
  - Also verify the installed Agent-SDK `settingSources` default and whether Codex's built-in `image_gen`
    is exposed to our unmanaged app-server client. (Verification agent running as of 2026-07-24.)
- **P1 — Claude skill asymmetry.** Codex agents auto-load their profile's bundled skills (imagegen,
  ~20 artifact-template docs, review-agent, github recipes); our Claude profiles ship NO skills / no
  plugins, so Claude agents get no skill library at all. Provision a scope-governed Claude skill set,
  materialized like practices (`instructions.ts`). **Harvest the public skills** (the vendor's open
  skills repo / community sets) rather than authoring from scratch — curate + scope-gate what we import.
- **G1 (P0) — review-feedback loop, exposed to agents.** Operator leaves PR-style inline comments on a
  turn's diff → thread as feedback.md/json (open/resolved). Leapfrog T3Code (their #345 "not planned")
  by making it an agent MCP tool the agent reads/resolves itself. **Gate behind a Settings toggle (hard
  off-switch):** when disabled, agents cannot arm a review-comment monitor at all. Prefer an event-driven
  push (operator submits → hub injects the comments into the thread on the next turn) over agent-side
  polling, so an armed monitor costs ~0 idle tokens; the toggle is the absolute off regardless.
- **G2 — per-turn diff + checkpoint/rollback.** Show a changed-files diff per turn; snapshot before a
  turn so the operator can roll back a bad one.
- **G3 — hub-owned git lifecycle.** Commit / push / open-PR driven from the hub (not only from inside the
  agent's shell), so the operator can act on a turn's output directly.
- **G4 — plan-then-execute gate.** An explicit plan step the operator approves before the agent executes
  (beyond the vendor plan-mode), surfaced in the hub UI.
- **G5 — quick-actions / project-scripts.** Per-project saved commands the operator can fire at a session
  (lint, test, build, deploy) without retyping.
- **P2:** self-hosted scheduler (scheduled-tasks equivalent); document-artifact rendering (pdf/docx/
  xlsx/pptx/dataviz); `$`-picker skill curation; outward-facing hub MCP server; per-session MCP passthrough.

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
