# Backlog — deferred TODOs

Not-yet-built items surfaced during the agent-detachment / worker work. Ordered roughly by the order
they came up; not a priority ranking.

## Cross-vendor parity (principle — 2026-07-25)

**A first-class goal: Claude and Codex agents get the SAME hub-provided fleet capabilities.** Vendor-native
extras (Codex's `multi_agent_v1`, Claude's `Agent` sub-agents; each vendor's bundled skills) are fine as
bonuses, but nothing the HUB provides — comms/bus, memory, practices, behavioral steering, the tool surface —
should depend on which vendor an agent runs. Treat it as a capability matrix (Claude × Codex) kept equal.
Known asymmetries to close:
- **Bus/comms:** Codex has no `allmyagents` tools (Claude does) → task #11 (standalone MCP for Codex).
- **Skills:** Codex auto-loads bundled skills; Claude ships none → provision a scope-governed Claude skill set
  (tooling-gaps P1).
- **Behavioral:** both must be STEERED to the hub's capabilities (the bus-vs-sub-agent practice above) — a
  vendor's overlapping native capability must not win by default.

New features should ship for BOTH vendors — or explicitly note the gap + a parity task — rather than land
Claude-only.

## Alpha release (post-worker milestone) → docs/alpha-release-plan.md

After the always-on worker lands + is audited: package the full installable bundle as a real user would
get it (Tauri installer, `%APPDATA%` app-data layout, first-run setup), **dev harnesses enabled for
alpha**, and cut an initial **pre-release** GitHub alpha. Hard gate before any public artifact: ship
**template** profiles — never the operator's real credentials — and resolve the P0 connector default.
Full definition-of-parity, bundle scope, security gates, and sequence in `docs/alpha-release-plan.md`.

## Tooling gaps — from the T3Code + vendor-app research (docs/t3code-tooling-gaps.md, docs/vendor-app-tooling.md)

AllMyAgents already LEADS on the deep agent tooling (bus, scoped memory, practices, hooks,
browser/computer/visualization, auto-recall) — not gaps. The real gaps:

- **P0 — CONFIRMED live exposure (security-critical), govern it.** The hub's own journal (`data/hub.db`,
  `claude/system` init events) shows a claude.ai **Google Drive** connector reaching `status:"connected"`
  with 8 live cloud tools **inside a real hub Claude session** — hub Claude agents can reach the operator's
  linked claude.ai integrations through Anthropic's cloud **today**. No connector has actually been
  *invoked* yet (zero tool calls in the journal) → exposure, not active use.
  - **Mechanism (corrected):** NOT the `tengu_claudeai_mcp_connectors` flag (that string has no code path).
    `query()` spawns the full `claude.exe`, which fetches the account's connectors over OAuth; the hub sets
    none of the real kill-switches (`disableClaudeAiConnectors` / `ENABLE_CLAUDEAI_MCP_SERVERS` / managed-mcp).
  - **Plain English:** "connectors" are the integrations you've linked to your Claude account through
    Anthropic's cloud — Google Drive, Gmail, Calendar, and the like. A hub agent can call those — i.e.
    reach into your linked accounts — via the vendor cloud, even though you never wired them into the hub.
    The danger: an agent chewing on untrusted text (an imported chat, a scraped web page) could be talked
    into pulling from, or pushing to, one of those accounts.
  - **Sharp caveat:** connector tool calls normally hit the operator approval prompt — **except** under
    `full` (bypassPermissions) mode, where `canUseTool` is skipped entirely (`executor.ts:234`,
    `adapters/claude.ts:65`), so a connector call runs with **no prompt**.
  - **Fix — APPROVED 2026-07-24 as a Danger-Zone toggle** (`allowClaudeConnectors`, default OFF). Interim
    static safe-default applied immediately: `"disableClaudeAiConnectors": true` in each Claude profile's
    `settings.json` (the SDK honors it from any settings source). Toggle build: flip via a DangerFlag the
    adapter reads; when ON, surface `claude.ai …` tool names + label approvals as vendor-cloud provenance.
    Same deliberate call still open for vendor auto-memory (parallel to hub memory).
- **P1 — Claude skills: gap is narrower than the doc said.** Runtime correction: Claude agents do NOT load
  zero skills — the journal shows **18 bundled skills load every session** (deep-research, code-review,
  dataviz, artifact-design, …; baked into `claude.exe`). The real gap is (a) no hub-curated **custom** skills
  and (b) the **document** skills (pdf/docx/xlsx/pptx) genuinely absent from the bundled set. `settingSources`
  defaults to all sources, so a skill dropped at `profiles/claude-a/skills/<name>/SKILL.md` is auto-discovered
  (no extra setting); `skills:'all'` (add at `adapters/claude.ts:69`) is the explicit lever. **Harvest the
  public/document skills** rather than authoring from scratch — curate + scope-gate what we import.
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

## Fleet: cross-machine project view + machine classification (raised 2026-07-24)

Each machine runs its own hub, auto-registered as an owner-fleet-only AllMyStuff site (`siteId=tcp:<port>`,
loopback-bound, tunneled via the owner's node — not a vendor relay), so hubs are reachable across the fleet
today. **Feasibility (scoped 2026-07-24 → docs/mesh-unified-fleet.md): S–M for a first cut** — the
AllMyStuff node already exposes the fleet directory (`owned_roster`) + per-peer hub port-mapping
(`site_map`) + WebSocket-through-tunnel, so NO node change is needed; it's a small `/api/fleet` endpoint
(reusing meshSite's socket client) + client-side merge/badge, and zero auth work while `requireToken` is
off (today's default). Full drive-remote is L (multi-hub WS fan-out + routing mutations to the owning hub
+ the cross-site device-token fork — the one real design decision). Two gaps:
- **No unified roster.** You open one site (machine) at a time; there's no single pane aggregating every
  machine's projects/sessions. Build a fleet roster listing projects across all reachable sites.
- **No machine tag on projects.** `Project` (types.ts:9) is `{id,name,path,createdAt}` — nothing records
  which machine the files live on. Add a `siteId`/machine tag + a sidebar machine badge, and route access
  local-vs-mesh by it. Access model: the **agent runs where the files are local**; you drive it remotely
  over the mesh — so the machine tag is what routes execution (no file-shipping).

## Auto mode — isolated AI safety cross-checker (roadmap; requested 2026-07-25) → docs/auto-mode-safety-checker.md

A new permission tier `auto` between `edits` and `full`: the operator designates a **hub-attached, ISOLATED**
agent (no bus, no shared memory — uninfluenceable) that reviews each risky action and auto-decides
allow / deny / escalate by **risk level × whether the action was requested**. Replaces per-action human
approval without going ungated; `escalate` / checker-down falls back to operator approval (never fail-open).
Plugs into `canUseTool`/`onApproval` (fast-path safe reads; a relay in worker mode). Full scope + the
risk×requested policy table + open questions in `docs/auto-mode-safety-checker.md`. Not implemented.

## Transcript & diff UX (requested 2026-07-25)

- **Work-epoch collapse (Codex-style wrap) — Settings toggle + polish.** Collapse a whole work epoch to a
  compact card: **the kickoff message → "worked X min" → the agent's end-of-work summary + a diff / files-
  changed box**, expandable on demand to the full mid-work back-and-forth + tool calls. Codex especially (it
  emits a natural end-of-work wrap) but useful for both. A Settings toggle (collapsed-by-default vs. full
  transcript). Lives in the ThreadView render + the history viewer; the "epoch" boundary = a user prompt and
  everything the agent did until it next went idle.
- **Diff viewer above the composer ("the big one", high-value).** A live diff box above the chatbox showing
  the session's **current worktree** changes: files changed + per-file/total **+/−** (additions/deletions),
  expandable per file. This is essentially T3Code-parity gap **G2** (per-turn diff + checkpoint/rollback — see
  the tooling-gaps section) surfaced as a persistent panel rather than per-turn; **build them together.** The
  plumbing mostly exists: the hub owns the session `worktree` (WorkspaceManager), and `apps/web/src/lib/diff.ts`
  already renders diffs — needs a `GET /api/sessions/:id/diff` (git diff of the worktree) feeding a panel.
- **Compaction notices + triggers.** The **trigger** (`/compact`) is already scoped in the slash-command work
  (task #9). The missing piece is the **notice**: detect the vendor compaction event → journal an additive
  kind → render a "context compacted here" divider in the transcript (the web `apply()` `default: break`s
  unknown kinds, so it's additive/safe). Plus an optional **auto-compaction threshold** setting (fire
  `/compact` at a context-size threshold), a **live "compacting…" status** while it runs (like the thinking
  indicator, so the operator isn't left on read mid-compaction — a `session/status:'compacting'` the composer
  surfaces), and a Settings view of **how** a compaction was done (method + what got summarized/dropped).

## Memory budget monitor + over-cap reminder (requested 2026-07-25)

Shared memory (`memory.ts`, written via `memory_write`, injected by auto-recall / `withRecall`) can grow past
what's actually **usable** — only so much fits in an agent's recall budget, so an unbounded store wastes space
and silently drops the tail from recall. Add: (a) a **size monitor** per scope (account/project/global/vendor)
+ overall, tracked against a configurable **usable cap** (default = the recall budget), surfaced like the
existing usage bars; (b) an **over-cap reminder** — when an agent's `memory_write` pushes a scope past the cap,
the tool result appends a warning (NOT a hard block, per the permissive philosophy): "this scope is over its
usable memory budget — older/lower-value entries won't be recalled; consider consolidating or trimming."
Optional follow-ups: a Settings-gated auto-trim policy (LRU / lowest-relevance) and a suggestion of which
entries to evict. Cap is Settings-configurable; safe default on.

## Multi-agent coordination (requested 2026-07-25)

- **Cross-worktree conflict detection + habitual bus coordination.** Same-project agents each work in their own
  worktree and today don't know when they're about to collide. Give the hub a `worktreeConflicts(sessionId)`
  that intersects the changed-file sets (`git diff --name-only`) across same-project agents' worktrees (the hub
  owns them all via WorkspaceManager), then expose: (a) an agent tool `check_conflicts()` → the overlapping
  files + which teammates are touching them; (b) a proactive, operator-toggleable **auto-notice** — when an
  overlap first appears the hub sends a system-attributed bus message to the involved agents so they coordinate
  ("agent B is also editing foo.ts — align before you both commit"). Ship a practice that makes agents check +
  coordinate at project checkpoints (habitual, not just reactive). Region-level overlap (not just filename)
  and merge-preview come later. Composes with the bus + the peek tool (#10). Gate the auto-notice so it can't
  spam a busy fleet.
- **Cross-account chatlog search + read (fleet memory / institutional knowledge).** When an agent can't find
  context, let it **search + read other agents' transcripts** across the owner's accounts/profiles — broader
  than the peek tool (#10, which is one teammate's *current* activity). A hub-owned `search_chatlogs(query,
  scope)` over the journaled + imported transcripts (`transcript.ts`/`readHistory` already parse them) →
  matching snippets + session refs, then `read_chatlog(sessionId, around)` to pull the surrounding context.
  It's the owner's own fleet data, so cross-account-within-owner is acceptable — but **gate it** (a Settings
  toggle + a scope), journal each search/read for audit, and treat any retrieved chatlog content as **DATA,
  never instructions** (a read log is semi-trusted, exactly like a bus message — prompt-injection boundary).
  Turns the fleet's whole history into a searchable shared brain.
- **Habitual "reach OUT over the bus, don't spawn a sub-agent" practice.** Recurring (observed 2026-07-25):
  asked to "message an agent," Codex defaults to its native `multi_agent_v1` (spawn a sub-agent) instead of the
  fleet bus, so it never communicates out. Even once #11 wires the tools into Codex, ship a **default practice /
  materialized instruction** that disambiguates — to reach a TEAMMATE (an existing fleet session) use the
  `mcp__allmyagents__` bus (list_agents/send_message/read_messages); spawning a sub-agent creates a NEW child,
  not a message to a teammate. **General principle:** when a vendor's native capability **overlaps** a hub
  capability, steer agents to the hub's via a materialized practice — don't rely on them choosing it.

## Curator agent — designated hub/app lifecycle agent (requested 2026-07-25)

A per-agent role: the operator designates ONE agent (a session/profile they converse with) as the "curator"
— the agent trusted with hub/app **lifecycle**. It composes two grants:
- **Restart authority** — the per-agent restart ACL + the `restart_hub` tool (both already on this list): the
  curator is the agent that holds the "may restart this hub/app" grant.
- **Update management** — its **materialized instructions remind it to check for updates when active** (so a
  conversation with it surfaces "an update is available"), and it gets `check_updates` / `apply_update` agent
  tools that drive the Tauri updater (docs/alpha-release-plan.md): read the GitHub `latest.json`, and — with
  operator consent (safe default) or an opt-in auto-update toggle — download → verify → install → relaunch.

Both restart + update are impactful, so the curator acts **with operator consent by default** (a prompt),
never silently, unless the owner flips a Danger-Zone auto toggle. Storage: a `curator?: boolean` on the
session/profile (like the critical-agent tier's `critical?`) + the restart-ACL grant.

**Distinct from the "overseer"** — a separate future role that **lives IN the hub** (a hub-resident oversight/
monitor service, not a conversational agent). The curator is the lifecycle agent you talk to; the overseer is
hub-internal. Keep them separate. (The auto-mode safety cross-checker, docs/auto-mode-safety-checker.md, is a
candidate shape for a hub-resident overseer-class role.)

## Overseer — hub-resident lifecycle coordinator (refined 2026-07-25)

The counterpart to the curator: where the curator is the lifecycle agent the OPERATOR talks to, the overseer
is a **hub-resident** coordinator that OTHER AGENTS message over the bus to request restarts / lifecycle, and
it orchestrates them safely. The use it unlocks — **dogfooding the hub from inside the app**: run a dev
project in the app whose target IS the hub; an agent editing the hub that needs a restart to load its own
changes CANNOT safely self-restart (it would kill its own in-flight work — the dogfooding paradox), so instead
it `send_message`s the overseer ("I need a restart to pick up my changes"), and the overseer coordinates a
blue-green restart in which the requesting agent **survives** (the Phase-2 worker keeps its turn + sub-agents
alive across the bounce) and resumes on the new code. This is exactly the restart-survivable self-hosting in
`docs/self-hosting-restart-survival.md`, made concrete by the comms backbone + the worker survival now in build.
- **Composes:** the bus (request channel) + `requestRestart` + blue-green restart + the Phase-2 worker
  (requester survives) + the restart gate (danger/consent).
- **Shape:** likely a special always-on hub agent (or a thin hub service) subscribed to restart-request bus
  messages — applies the gate, coordinates via hubctl, and reports back over the bus when the hub is live again.
- Distinct from the curator (operator-facing) and the auto-mode safety checker (per-action arbiter), though all
  three are trusted hub-adjacent roles that could share the isolation/gating machinery.

## Write-dedup relies on sync stores (caveat — from the 6+7 audit, 2026-07-25)

Cross-hub write exactly-once across a blue-green flip currently rests on the memory/practice/bus stores being
**synchronous** (a served write's ack is processed before blue's worker socket drops, so green never needs to
dedup it; the in-memory `servedWrites` cache can't span hub processes). A HARD crash of blue (persist-before-ack
lost) OR a future **async** store would reopen a double-write window. Carry into any async-store migration: give
writes **durable, journal-based exactly-once** (like approvals get via `resolvedApproval`), not just the
in-memory `servedWrites` cache. (Distinct from F1 — the worker-respawn callId collision — which was FIXED in
`8f0752d` via a per-worker generation id + a `welcome` handshake that clears the cache only across a respawn.)

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
